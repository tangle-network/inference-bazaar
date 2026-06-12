// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { SettlementTestBase } from "./Base.t.sol";
import { SurplusSettlement } from "../src/SurplusSettlement.sol";

/// The spend-key rail: one holder signature turns a lot into a bearer API key
/// the issuer settles against cumulatively. These tests pin the protections
/// that replace per-request signatures: the cap, expiry (auth and lot),
/// on-chain revocation, current-holder binding (resale kills keys), cumulative
/// idempotence, and coexistence with the redemption lock.
contract SpendTest is SettlementTestBase {
    bytes32 internal lotId;
    bytes32 internal keyHash = keccak256("sk-surplus-test-key");

    function setUp() public override {
        super.setUp();
        lotId = settleStandardFill(); // buyer holds 50k tokens, notional 750_000, issuer = seller
    }

    function auth(uint64 maxTokens, uint64 expiry) internal view returns (SurplusSettlement.SpendKeyAuth memory) {
        return SurplusSettlement.SpendKeyAuth({ lotId: lotId, keyHash: keyHash, maxTokens: maxTokens, expiry: expiry });
    }

    function signAuth(uint256 key, SurplusSettlement.SpendKeyAuth memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.spendAuthDigest(a));
        return abi.encodePacked(r, s, v);
    }

    function test_cumulativeSettle_debitsProRata() public {
        SurplusSettlement.SpendKeyAuth memory a = auth(40_000, uint64(block.timestamp + 30 days));
        bytes memory sig = signAuth(buyerKey, a);
        uint256 liabilityBefore = settlement.liability(seller);

        // First flush: 10k of 50k tokens => 1/5 of 750_000 notional.
        settlement.settleSpend(a, 10_000, sig);
        (,,, uint64 qty,,, uint128 notional) = settlement.lots(lotId);
        assertEq(qty, 40_000);
        assertEq(notional, 600_000);
        assertEq(settlement.liability(seller), liabilityBefore - 150_000);

        // Second flush is cumulative: total 25k => delta 15k against 40k @ 600k.
        settlement.settleSpend(a, 25_000, sig);
        (,,, qty,,, notional) = settlement.lots(lotId);
        assertEq(qty, 25_000);
        assertEq(notional, 375_000);
        assertEq(settlement.liability(seller), liabilityBefore - 375_000);
    }

    function test_replayOldCumulativeReverts() public {
        SurplusSettlement.SpendKeyAuth memory a = auth(40_000, uint64(block.timestamp + 30 days));
        bytes memory sig = signAuth(buyerKey, a);
        settlement.settleSpend(a, 10_000, sig);
        vm.expectRevert(); // NothingToSettle
        settlement.settleSpend(a, 10_000, sig);
        vm.expectRevert(); // NothingToSettle (monotone)
        settlement.settleSpend(a, 5_000, sig);
    }

    function test_capIsEnforced() public {
        SurplusSettlement.SpendKeyAuth memory a = auth(20_000, uint64(block.timestamp + 30 days));
        bytes memory sig = signAuth(buyerKey, a);
        vm.expectRevert(
            abi.encodeWithSelector(SurplusSettlement.SpendCapExceeded.selector, uint64(20_000), uint64(20_001))
        );
        settlement.settleSpend(a, 20_001, sig);
        // Exactly the cap is fine.
        settlement.settleSpend(a, 20_000, sig);
    }

    function test_revocationKillsTheKey() public {
        SurplusSettlement.SpendKeyAuth memory a = auth(40_000, uint64(block.timestamp + 30 days));
        bytes memory sig = signAuth(buyerKey, a);
        settlement.settleSpend(a, 5_000, sig);

        vm.prank(buyer);
        settlement.revokeSpendKey(a);

        vm.expectRevert(); // SpendKeyIsRevoked
        settlement.settleSpend(a, 10_000, sig);
    }

    function test_onlyHolderCanRevoke() public {
        SurplusSettlement.SpendKeyAuth memory a = auth(40_000, uint64(block.timestamp + 30 days));
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.NotLotHolder.selector, lotId));
        settlement.revokeSpendKey(a);
    }

    function test_resaleInvalidatesOutstandingKeys() public {
        SurplusSettlement.SpendKeyAuth memory a = auth(40_000, uint64(block.timestamp + 30 days));
        bytes memory sig = signAuth(buyerKey, a);
        settlement.settleSpend(a, 5_000, sig);

        // Holder transfers the lot; the old holder's authorization must die.
        vm.prank(buyer);
        settlement.transferLot(lotId, vm.addr(0xCAFE));

        vm.expectRevert(); // BadSpendAuth — recovers to the OLD holder
        settlement.settleSpend(a, 10_000, sig);
    }

    function test_expiredAuthReverts() public {
        SurplusSettlement.SpendKeyAuth memory a = auth(40_000, uint64(block.timestamp + 1 hours));
        bytes memory sig = signAuth(buyerKey, a);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(); // SpendAuthExpired
        settlement.settleSpend(a, 10_000, sig);
    }

    function test_expiredLotReverts() public {
        SurplusSettlement.SpendKeyAuth memory a = auth(40_000, uint64(block.timestamp + 365 days));
        bytes memory sig = signAuth(buyerKey, a);
        vm.warp(block.timestamp + 31 days); // creditTtl is 30 days
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.LotIsExpired.selector, lotId));
        settlement.settleSpend(a, 10_000, sig);
    }

    function test_wrongSignerReverts() public {
        SurplusSettlement.SpendKeyAuth memory a = auth(40_000, uint64(block.timestamp + 30 days));
        bytes memory sig = signAuth(sellerKey, a); // issuer forging the holder's auth
        vm.expectRevert(); // BadSpendAuth
        settlement.settleSpend(a, 10_000, sig);
    }

    function test_redemptionLockIsRespected() public {
        // Holder locks 45k of 50k in an open redemption; spendable = 5k.
        vm.prank(buyer);
        settlement.requestRedemption(lotId, 45_000);

        SurplusSettlement.SpendKeyAuth memory a = auth(40_000, uint64(block.timestamp + 30 days));
        bytes memory sig = signAuth(buyerKey, a);
        vm.expectRevert(
            abi.encodeWithSelector(SurplusSettlement.LotQtyUnavailable.selector, uint64(5_000), uint64(10_000))
        );
        settlement.settleSpend(a, 10_000, sig);

        // Within the unlocked remainder it settles.
        settlement.settleSpend(a, 5_000, sig);
    }

    function test_fullDrawDeletesLot() public {
        SurplusSettlement.SpendKeyAuth memory a = auth(50_000, uint64(block.timestamp + 30 days));
        bytes memory sig = signAuth(buyerKey, a);
        uint256 liabilityBefore = settlement.liability(seller);
        settlement.settleSpend(a, 50_000, sig);
        (address holder,,,,,,) = settlement.lots(lotId);
        assertEq(holder, address(0), "lot deleted at zero");
        assertEq(settlement.liability(seller), liabilityBefore - 750_000, "full notional released");
    }

    /// The cross-stack pin: the operator's Rust spend_auth_digest must produce
    /// this exact digest for the same fields under the same domain. Mirrored in
    /// operator/src/spend.rs::tests::digest_matches_contract_pin.
    function test_spendDigestPin() public {
        vm.chainId(3799);
        SurplusSettlement impl =
            new SurplusSettlement(settlement.paymentToken(), 30 days, 6 hours, 500, 200, address(0xFEE));
        vm.etch(address(0x1111111111111111111111111111111111111111), address(impl).code);
        SurplusSettlement pinned = SurplusSettlement(address(0x1111111111111111111111111111111111111111));
        SurplusSettlement.SpendKeyAuth memory a = SurplusSettlement.SpendKeyAuth({
            lotId: keccak256("pin-lot"),
            keyHash: keccak256("pin-key"),
            maxTokens: 1_000_000,
            expiry: 1_800_000_000
        });
        assertEq(
            pinned.spendAuthDigest(a),
            0xa3d29fef51ab1cca2d7f1b9c763c6cca40d14f9dd9c9a967e217fbb844647d00,
            "spend digest pin"
        );
    }
}
