// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { SettlementTestBase } from "./Base.t.sol";
import { SurplusSettlement } from "../src/SurplusSettlement.sol";

contract RedemptionTest is SettlementTestBase {
    bytes32 internal lotId;

    function setUp() public override {
        super.setUp();
        lotId = settleStandardFill(); // buyer holds 50k tokens, notional 750_000, issuer = seller
    }

    function signReceipt(uint256 key, bytes32 redemptionId, uint64 served) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.receiptDigest(redemptionId, served));
        return abi.encodePacked(r, s, v);
    }

    function test_redeemFull_withHolderReceipt() public {
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(lotId, 50_000);
        (,,, uint64 locked,,,) = lotFields();
        assertEq(locked, 50_000, "qty locked while open");

        settlement.settleRedemption(id, 50_000, signReceipt(buyerKey, id, 50_000));
        assertEq(settlement.liability(seller), 0, "liability extinguished");
        (address holder,,,,,,) = settlement.lots(lotId);
        assertEq(holder, address(0), "lot deleted when exhausted");

        // All collateral now free.
        vm.prank(seller);
        settlement.withdrawCollateral(100_000_000);
    }

    function test_partialServe_remainderStaysRedeemable() public {
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(lotId, 50_000);
        settlement.settleRedemption(id, 20_000, signReceipt(buyerKey, id, 20_000));

        // debit = 750_000 * 20k / 50k = 300_000
        assertEq(settlement.liability(seller), 450_000);
        (, , , uint64 qty, uint64 locked, , uint128 notional) = lotFieldsFull();
        assertEq(qty, 30_000, "unserved tokens back in the lot");
        assertEq(locked, 0);
        assertEq(notional, 450_000);

        // Can immediately redeem the rest.
        vm.prank(buyer);
        settlement.requestRedemption(lotId, 30_000);
    }

    function test_attestedSettle_disputePath() public {
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(lotId, 50_000);
        bytes[] memory sigs = quorumSign(settlement.receiptDigest(id, 50_000));
        settlement.settleRedemptionAttested(id, 50_000, sigs);
        assertEq(settlement.liability(seller), 0);
    }

    function test_wrongReceiptSignerReverts() public {
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(lotId, 50_000);
        bytes memory badSig = signReceipt(sellerKey, id, 50_000);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.BadReceipt.selector, id));
        settlement.settleRedemption(id, 50_000, badSig);
    }

    function test_claimDefault_paysHolderFromCollateralPlusPenalty() public {
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(lotId, 50_000);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.RedemptionDeadlineNotPassed.selector, id));
        settlement.claimDefault(id);

        vm.warp(block.timestamp + REDEMPTION_WINDOW + 1);
        uint256 buyerBefore = settlement.balances(buyer);
        uint256 collBefore = settlement.collateral(seller);
        uint256 payout = settlement.claimDefault(id);

        // refund 750_000 + 5% penalty = 787_500
        assertEq(payout, 787_500);
        assertEq(settlement.balances(buyer), buyerBefore + 787_500, "holder made whole + penalty");
        assertEq(settlement.collateral(seller), collBefore - 787_500);
        assertEq(settlement.liability(seller), 0);

        // Default recorded for the BSM.
        assertEq(settlement.defaultsCount(), 1);
        (address issuer, uint128 amount, bytes32 rid) = settlement.getDefault(0);
        assertEq(issuer, seller);
        assertEq(amount, 787_500);
        assertEq(rid, id);
    }

    function test_settleAfterDeadlineReverts_defaultIsTheOnlyPath() public {
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(lotId, 50_000);
        vm.warp(block.timestamp + REDEMPTION_WINDOW + 1);
        bytes memory sig = signReceipt(buyerKey, id, 50_000);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.RedemptionDeadlinePassed.selector, id));
        settlement.settleRedemption(id, 50_000, sig);
    }

    function test_oneOpenRedemptionPerLot() public {
        vm.prank(buyer);
        settlement.requestRedemption(lotId, 10_000);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.RedemptionAlreadyOpen.selector, lotId));
        settlement.requestRedemption(lotId, 10_000);
    }

    function test_lockedTokensNotResellable() public {
        vm.prank(buyer);
        settlement.requestRedemption(lotId, 45_000);

        // Try to resell 10k (only 5k unlocked) through the market.
        uint256 buyer2Key = 0xB002;
        address buyer2 = vm.addr(buyer2Key);
        usd.mint(buyer2, 10_000_000);
        vm.startPrank(buyer2);
        usd.approve(address(settlement), type(uint256).max);
        settlement.deposit(10_000_000);
        vm.stopPrank();

        SurplusSettlement.Order memory b2 = SurplusSettlement.Order({
            instrument: INSTRUMENT,
            side: 0,
            priceMicroPerM: 15_000_000,
            qtyTokens: 10_000,
            lotId: bytes32(0),
            trader: buyer2,
            expiry: uint64(block.timestamp + 300),
            salt: keccak256("b2")
        });
        SurplusSettlement.Order memory s2 = SurplusSettlement.Order({
            instrument: INSTRUMENT,
            side: 1,
            priceMicroPerM: 15_000_000,
            qtyTokens: 10_000,
            lotId: lotId,
            trader: buyer,
            expiry: uint64(block.timestamp + 300),
            salt: keccak256("s2")
        });
        SurplusSettlement.FillInput[] memory fills = new SurplusSettlement.FillInput[](1);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(buyer2Key, settlement.orderDigest(b2));
        bytes memory b2sig = abi.encodePacked(r, sg, v);
        (v, r, sg) = vm.sign(buyerKey, settlement.orderDigest(s2));
        fills[0] = SurplusSettlement.FillInput({
            buy: b2,
            buySig: b2sig,
            sell: s2,
            sellSig: abi.encodePacked(r, sg, v),
            qtyTokens: 10_000,
            execPriceMicroPerM: 15_000_000
        });
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.LotQtyUnavailable.selector, 5_000, 10_000));
        settlement.settleFills(fills);
    }

    function test_transferBlockedWhileRedemptionOpen() public {
        vm.prank(buyer);
        settlement.requestRedemption(lotId, 10_000);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.RedemptionAlreadyOpen.selector, lotId));
        settlement.transferLot(lotId, address(0xD00D));
    }

    function test_reclaimExpired_refundsUnredeemedValue() public {
        vm.warp(block.timestamp + CREDIT_TTL + 1);
        uint256 buyerBefore = settlement.balances(buyer);
        uint256 refund = settlement.reclaimExpired(lotId);
        assertEq(refund, 750_000);
        assertEq(settlement.balances(buyer), buyerBefore + 750_000, "paid, unserved spend returns as cash");
        assertEq(settlement.liability(seller), 0);
        assertEq(settlement.collateral(seller), 100_000_000 - 750_000, "no penalty on expiry reclaim");
    }

    function test_reclaimBeforeExpiryReverts() public {
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.LotNotExpired.selector, lotId));
        settlement.reclaimExpired(lotId);
    }

    function test_requestOnExpiredLotReverts() public {
        vm.warp(block.timestamp + CREDIT_TTL + 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.LotIsExpired.selector, lotId));
        settlement.requestRedemption(lotId, 10_000);
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    function lotFields()
        internal
        view
        returns (address holder, address issuer, uint64 qty, uint64 locked, uint64 expiry, uint128 notional, bytes32 inst)
    {
        (address h, address i, bytes32 ins, uint64 q, uint64 l, uint64 e, uint128 n) = settlement.lots(lotId);
        return (h, i, q, l, e, n, ins);
    }

    function lotFieldsFull()
        internal
        view
        returns (address h, address i, bytes32 ins, uint64 q, uint64 l, uint64 e, uint128 n)
    {
        return settlement.lots(lotId);
    }
}
