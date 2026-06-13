// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { SettlementTestBase } from "./Base.t.sol";
import { SurplusSettlement } from "../src/SurplusSettlement.sol";

/// The spend rail as a one-way payment channel (see docs/specs/spend-rail.md).
/// The holder signs ONE SpendPermit delegating a session key; the session key
/// signs SpendVouchers acknowledging cumulative served tokens. settleSpend can
/// only settle up to a voucher the session key signed — so the operator CANNOT
/// over-bill. These tests pin that core property plus the cap, monotonicity,
/// revocation, current-holder binding (resale kills the channel), expiry, and
/// coexistence with the redemption lock.
contract SpendTest is SettlementTestBase {
    bytes32 internal lotId;
    uint256 internal sessionKey = 0x5E5510; // the consumer gateway's ephemeral key
    address internal session;

    function setUp() public override {
        super.setUp();
        lotId = settleStandardFill(); // buyer holds 50k tokens, notional 750_000, issuer = seller
        session = vm.addr(sessionKey);
    }

    function permit(uint64 maxTokens, uint64 expiry) internal view returns (SurplusSettlement.SpendPermit memory) {
        return
            SurplusSettlement.SpendPermit({ lotId: lotId, sessionKey: session, maxTokens: maxTokens, expiry: expiry });
    }

    /// Holder authorizes the session key (the one wallet signature).
    function signPermit(uint256 key, SurplusSettlement.SpendPermit memory p) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.spendPermitDigest(p));
        return abi.encodePacked(r, s, v);
    }

    /// Session key acknowledges cumulative served (what the gateway signs per request).
    function signVoucher(uint256 key, uint64 served) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.spendVoucherDigest(lotId, session, served));
        return abi.encodePacked(r, s, v);
    }

    function test_cumulativeSettle_debitsProRata() public {
        SurplusSettlement.SpendPermit memory p = permit(40_000, uint64(block.timestamp + 30 days));
        bytes memory holderSig = signPermit(buyerKey, p);
        uint256 liabilityBefore = settlement.liability(seller);

        // First voucher: consumer acknowledges 10k of 50k => 1/5 of 750_000.
        settlement.settleSpend(p, holderSig, 10_000, signVoucher(sessionKey, 10_000));
        (,,, uint64 qty,,, uint128 notional) = settlement.lots(lotId);
        assertEq(qty, 40_000);
        assertEq(notional, 600_000);
        assertEq(settlement.liability(seller), liabilityBefore - 150_000);

        // Second voucher is cumulative: total 25k => delta 15k against 40k @ 600k.
        settlement.settleSpend(p, holderSig, 25_000, signVoucher(sessionKey, 25_000));
        (,,, qty,,, notional) = settlement.lots(lotId);
        assertEq(qty, 25_000);
        assertEq(notional, 375_000);
        assertEq(settlement.liability(seller), liabilityBefore - 375_000);
    }

    /// THE central property: the operator cannot bill ANY amount the consumer's
    /// session key did not sign. A voucher signed by the seller (or anyone but
    /// the session key) is rejected — over-billing is impossible by construction.
    function test_overBillImpossible_withoutSessionVoucher() public {
        SurplusSettlement.SpendPermit memory p = permit(50_000, uint64(block.timestamp + 30 days));
        bytes memory holderSig = signPermit(buyerKey, p);
        // The issuer holds the holderSig (from registration) and tries to settle
        // the full cap, forging the voucher with its OWN key. It does not hold the
        // session key, so the voucher recovers to the wrong address.
        bytes memory forgedVoucher = signVoucher(sellerKey, 50_000);
        bytes32 pd = settlement.spendPermitDigest(p);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.BadSpendAuth.selector, pd));
        settlement.settleSpend(p, holderSig, 50_000, forgedVoucher);
        // Even a real session voucher for a DIFFERENT amount cannot be inflated:
        // settling 50k needs a voucher over 50k, not over 10k.
        bytes memory voucher10k = signVoucher(sessionKey, 10_000);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.BadSpendAuth.selector, pd));
        settlement.settleSpend(p, holderSig, 50_000, voucher10k);
    }

    function test_capIsEnforced() public {
        SurplusSettlement.SpendPermit memory p = permit(20_000, uint64(block.timestamp + 30 days));
        bytes memory holderSig = signPermit(buyerKey, p);
        bytes memory over = signVoucher(sessionKey, 20_001);
        bytes memory atCap = signVoucher(sessionKey, 20_000);
        vm.expectRevert(
            abi.encodeWithSelector(SurplusSettlement.SpendCapExceeded.selector, uint64(20_000), uint64(20_001))
        );
        settlement.settleSpend(p, holderSig, 20_001, over);
        // Exactly the cap is fine.
        settlement.settleSpend(p, holderSig, 20_000, atCap);
    }

    function test_replayOldCumulativeReverts() public {
        SurplusSettlement.SpendPermit memory p = permit(40_000, uint64(block.timestamp + 30 days));
        bytes memory holderSig = signPermit(buyerKey, p);
        bytes memory v10k = signVoucher(sessionKey, 10_000);
        bytes memory v5k = signVoucher(sessionKey, 5000);
        settlement.settleSpend(p, holderSig, 10_000, v10k);
        bytes32 pd = settlement.spendPermitDigest(p);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.NothingToSettle.selector, pd));
        settlement.settleSpend(p, holderSig, 10_000, v10k);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.NothingToSettle.selector, pd));
        settlement.settleSpend(p, holderSig, 5000, v5k);
    }

    function test_revocationKillsTheChannel() public {
        SurplusSettlement.SpendPermit memory p = permit(40_000, uint64(block.timestamp + 30 days));
        bytes memory holderSig = signPermit(buyerKey, p);
        settlement.settleSpend(p, holderSig, 5000, signVoucher(sessionKey, 5000));

        vm.prank(buyer);
        settlement.revokeSpendKey(p);

        bytes32 pd = settlement.spendPermitDigest(p);
        bytes memory v10k = signVoucher(sessionKey, 10_000);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.SpendKeyIsRevoked.selector, pd));
        settlement.settleSpend(p, holderSig, 10_000, v10k);
    }

    function test_onlyHolderCanRevoke() public {
        SurplusSettlement.SpendPermit memory p = permit(40_000, uint64(block.timestamp + 30 days));
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.NotLotHolder.selector, lotId));
        settlement.revokeSpendKey(p);
    }

    function test_resaleInvalidatesTheChannel() public {
        SurplusSettlement.SpendPermit memory p = permit(40_000, uint64(block.timestamp + 30 days));
        bytes memory holderSig = signPermit(buyerKey, p);
        settlement.settleSpend(p, holderSig, 5000, signVoucher(sessionKey, 5000));

        // Holder transfers the lot; the old holder's permit must die.
        vm.prank(buyer);
        settlement.transferLot(lotId, vm.addr(0xCAFE));

        bytes32 pd = settlement.spendPermitDigest(p);
        bytes memory v10k = signVoucher(sessionKey, 10_000);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.BadSpendAuth.selector, pd));
        settlement.settleSpend(p, holderSig, 10_000, v10k);
    }

    function test_expiredPermitReverts() public {
        SurplusSettlement.SpendPermit memory p = permit(40_000, uint64(block.timestamp + 1 hours));
        bytes memory holderSig = signPermit(buyerKey, p);
        bytes32 pd = settlement.spendPermitDigest(p);
        bytes memory v10k = signVoucher(sessionKey, 10_000);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.SpendAuthExpired.selector, pd));
        settlement.settleSpend(p, holderSig, 10_000, v10k);
    }

    function test_expiredLotReverts() public {
        SurplusSettlement.SpendPermit memory p = permit(40_000, uint64(block.timestamp + 365 days));
        bytes memory holderSig = signPermit(buyerKey, p);
        bytes memory v10k = signVoucher(sessionKey, 10_000);
        vm.warp(block.timestamp + 31 days); // creditTtl is 30 days
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.LotIsExpired.selector, lotId));
        settlement.settleSpend(p, holderSig, 10_000, v10k);
    }

    function test_wrongHolderSigReverts() public {
        SurplusSettlement.SpendPermit memory p = permit(40_000, uint64(block.timestamp + 30 days));
        bytes memory badPermitSig = signPermit(sellerKey, p); // not the holder
        bytes32 pd = settlement.spendPermitDigest(p);
        bytes memory v10k = signVoucher(sessionKey, 10_000);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.BadSpendAuth.selector, pd));
        settlement.settleSpend(p, badPermitSig, 10_000, v10k);
    }

    function test_redemptionLockIsRespected() public {
        // Holder locks 45k of 50k in an open redemption; spendable = 5k.
        vm.prank(buyer);
        settlement.requestRedemption(lotId, 45_000);

        SurplusSettlement.SpendPermit memory p = permit(40_000, uint64(block.timestamp + 30 days));
        bytes memory holderSig = signPermit(buyerKey, p);
        bytes memory v10k = signVoucher(sessionKey, 10_000);
        bytes memory v5k = signVoucher(sessionKey, 5000);
        vm.expectRevert(
            abi.encodeWithSelector(SurplusSettlement.LotQtyUnavailable.selector, uint64(5000), uint64(10_000))
        );
        settlement.settleSpend(p, holderSig, 10_000, v10k);

        // Within the unlocked remainder it settles.
        settlement.settleSpend(p, holderSig, 5000, v5k);
    }

    function test_fullDrawDeletesLot() public {
        SurplusSettlement.SpendPermit memory p = permit(50_000, uint64(block.timestamp + 30 days));
        bytes memory holderSig = signPermit(buyerKey, p);
        uint256 liabilityBefore = settlement.liability(seller);
        settlement.settleSpend(p, holderSig, 50_000, signVoucher(sessionKey, 50_000));
        (address holder,,,,,,) = settlement.lots(lotId);
        assertEq(holder, address(0), "lot deleted at zero");
        assertEq(settlement.liability(seller), liabilityBefore - 750_000, "full notional released");
    }

    /// Cross-stack pin: the operator's Rust spend_permit_digest / spend_voucher_digest
    /// must produce these exact digests for the same fields under the same domain.
    /// Mirrored in operator/src/spend.rs::tests::digests_match_contract_pin.
    function test_spendDigestPins() public {
        vm.chainId(3799);
        SurplusSettlement impl =
            new SurplusSettlement(settlement.paymentToken(), 30 days, 6 hours, 1 hours, 500, 200, address(0xFEE));
        vm.etch(address(0x1111111111111111111111111111111111111111), address(impl).code);
        SurplusSettlement pinned = SurplusSettlement(address(0x1111111111111111111111111111111111111111));
        SurplusSettlement.SpendPermit memory p = SurplusSettlement.SpendPermit({
            lotId: keccak256("pin-lot"),
            sessionKey: 0x2222222222222222222222222222222222222222,
            maxTokens: 1_000_000,
            expiry: 1_800_000_000
        });
        assertEq(pinned.spendPermitDigest(p), PERMIT_PIN, "permit digest drifted from operator");
        assertEq(
            pinned.spendVoucherDigest(keccak256("pin-lot"), 0x2222222222222222222222222222222222222222, 12_345),
            VOUCHER_PIN,
            "voucher digest drifted from operator"
        );
    }

    bytes32 internal constant PERMIT_PIN = 0xd72728151c11d0185dc7253e7463f04a3e0294ff367a2c6b56f90679aba68209;
    bytes32 internal constant VOUCHER_PIN = 0xa75906fa000d678d16c687c32cb65cc2a65cd27e8809c56d9bdf092b92f7d0df;
}
