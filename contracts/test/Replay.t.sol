// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { SettlementTestBase } from "./Base.t.sol";
import { InferenceBazaarSettlement } from "../src/InferenceBazaarSettlement.sol";

/// Double-spend / replay protection and batch atomicity. The contract has no
/// per-fill nonce: the cumulative `filled` map IS the replay guard for fills,
/// and terminal redemption/lot states guard the lifecycle paths.
contract ReplayTest is SettlementTestBase {
    bytes32 internal constant WORK = keccak256("served-work-commitment");

    function signReceipt(uint256 key, bytes32 redemptionId, uint64 served) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.receiptDigest(redemptionId, served, WORK));
        return abi.encodePacked(r, s, v);
    }

    function mintLot(bytes32 saltSeed) internal returns (bytes32 lotId) {
        InferenceBazaarSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        b.salt = keccak256(abi.encode("buy", saltSeed));
        InferenceBazaarSettlement.Order memory s = sellOrder(14_000_000, 50_000);
        s.salt = keccak256(abi.encode("sell", saltSeed));
        settlement.settleFills(fillInput(b, s, 50_000, 15_000_000));
        lotId = keccak256(abi.encode(settlement.hashOrder(b), settlement.hashOrder(s), uint64(0)));
    }

    function attest(InferenceBazaarSettlement.BatchFill[] memory fills) internal view returns (bytes[] memory) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                settlement.domainSeparator(),
                keccak256(
                    abi.encode(
                        settlement.BATCH_TYPEHASH(), BOOK, settlement.bookNonce(BOOK), keccak256(abi.encode(fills))
                    )
                )
            )
        );
        return quorumSign(digest);
    }

    // ── Fill replay: `filled` map is the guard ───────────────────────────────

    function test_exactFillReplayReverts() public {
        InferenceBazaarSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        InferenceBazaarSettlement.Order memory s = sellOrder(14_000_000, 50_000);
        InferenceBazaarSettlement.FillInput[] memory fills = fillInput(b, s, 50_000, 15_000_000);
        settlement.settleFills(fills);

        bytes32 buyHash = settlement.hashOrder(b);
        assertEq(settlement.filled(buyHash), 50_000);
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.Overfill.selector, buyHash, 0, 50_000));
        settlement.settleFills(fills);
    }

    function test_partialFillReplayCapped() public {
        InferenceBazaarSettlement.Order memory b = buyOrder(15_000_000, 100_000);
        InferenceBazaarSettlement.Order memory s = sellOrder(14_000_000, 100_000);
        InferenceBazaarSettlement.FillInput[] memory fills = fillInput(b, s, 60_000, 15_000_000);
        settlement.settleFills(fills);

        bytes32 buyHash = settlement.hashOrder(b);
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.Overfill.selector, buyHash, 40_000, 60_000));
        settlement.settleFills(fills);
    }

    // ── Batch atomicity: injected failure must roll back the whole call ──────

    function test_batchAllOrNothing_stateSnapshotUnchanged() public {
        uint256 buyer2Key = 0xB002;
        address buyer2 = vm.addr(buyer2Key);
        usd.mint(buyer2, 1000);
        vm.startPrank(buyer2);
        usd.approve(address(settlement), type(uint256).max);
        settlement.deposit(1000); // fill #2 costs 750_000 => guaranteed failure
        vm.stopPrank();

        InferenceBazaarSettlement.Order memory b1 = buyOrder(15_000_000, 50_000);
        b1.salt = keccak256("r3-b1");
        InferenceBazaarSettlement.Order memory s1 = sellOrder(14_000_000, 50_000);
        s1.salt = keccak256("r3-s1");
        InferenceBazaarSettlement.Order memory b2 = buyOrder(15_000_000, 50_000);
        b2.trader = buyer2;
        b2.salt = keccak256("r3-b2");
        InferenceBazaarSettlement.Order memory s2 = sellOrder(14_000_000, 50_000);
        s2.salt = keccak256("r3-s2");

        InferenceBazaarSettlement.FillInput[] memory fills = new InferenceBazaarSettlement.FillInput[](2);
        fills[0] = InferenceBazaarSettlement.FillInput({
            buy: b1,
            buySig: sign(buyerKey, b1),
            sell: s1,
            sellSig: sign(sellerKey, s1),
            qtyTokens: 50_000,
            execPriceMicroPerM: 15_000_000
        });
        fills[1] = InferenceBazaarSettlement.FillInput({
            buy: b2,
            buySig: sign(buyer2Key, b2),
            sell: s2,
            sellSig: sign(sellerKey, s2),
            qtyTokens: 50_000,
            execPriceMicroPerM: 15_000_000
        });

        bytes32 buyHash1 = settlement.hashOrder(b1);
        bytes32 sellHash1 = settlement.hashOrder(s1);
        bytes32 buyHash2 = settlement.hashOrder(b2);
        bytes32 sellHash2 = settlement.hashOrder(s2);
        bytes32 lotId1 = keccak256(abi.encode(buyHash1, sellHash1, uint64(0)));

        uint256 buyerBal = settlement.balances(buyer);
        uint256 buyer2Bal = settlement.balances(buyer2);
        uint256 sellerBal = settlement.balances(seller);
        uint256 feeBal = settlement.balances(feeRecipient);
        uint256 sellerColl = settlement.collateral(seller);
        uint256 sellerLiab = settlement.liability(seller);

        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.InsufficientBalance.selector, 1000, 750_000));
        settlement.settleFills(fills);

        // Fill #1 must not have applied even though it was valid on its own.
        assertEq(settlement.balances(buyer), buyerBal, "buyer balance unchanged");
        assertEq(settlement.balances(buyer2), buyer2Bal, "buyer2 balance unchanged");
        assertEq(settlement.balances(seller), sellerBal, "seller balance unchanged");
        assertEq(settlement.balances(feeRecipient), feeBal, "fee balance unchanged");
        assertEq(settlement.collateral(seller), sellerColl, "collateral unchanged");
        assertEq(settlement.liability(seller), sellerLiab, "liability unchanged");
        assertEq(settlement.filled(buyHash1), 0, "buy #1 fill rolled back");
        assertEq(settlement.filled(sellHash1), 0, "sell #1 fill rolled back");
        assertEq(settlement.filled(buyHash2), 0, "buy #2 never filled");
        assertEq(settlement.filled(sellHash2), 0, "sell #2 never filled");
        (address holder,,,,,,) = settlement.lots(lotId1);
        assertEq(holder, address(0), "no lot minted");
    }

    // ── Redemption lifecycle replay ───────────────────────────────────────────

    function test_settleRedemptionReplayReverts() public {
        bytes32 lotId = settleStandardFill();
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(lotId, 50_000);
        bytes memory sig = signReceipt(buyerKey, id, 50_000);
        settlement.settleRedemption(id, 50_000, WORK, sig);

        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.RedemptionNotOpen.selector, id));
        settlement.settleRedemption(id, 50_000, WORK, sig);
    }

    function test_receiptCrossRedemptionReplayReverts() public {
        bytes32 lotA = mintLot("A");
        bytes32 lotB = mintLot("B");
        vm.prank(buyer);
        bytes32 idA = settlement.requestRedemption(lotA, 50_000);
        vm.prank(buyer);
        bytes32 idB = settlement.requestRedemption(lotB, 50_000);

        // Receipt digest binds redemptionId: A's receipt cannot settle B.
        bytes memory sigA = signReceipt(buyerKey, idA, 50_000);
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.BadReceipt.selector, idB));
        settlement.settleRedemption(idB, 50_000, WORK, sigA);

        // Same signature is valid where it belongs.
        settlement.settleRedemption(idA, 50_000, WORK, sigA);
    }

    function test_claimDefaultReplayReverts() public {
        bytes32 lotId = settleStandardFill();
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(lotId, 50_000);
        vm.warp(block.timestamp + REDEMPTION_WINDOW + 1);
        settlement.claimDefault(id);

        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.RedemptionNotOpen.selector, id));
        settlement.claimDefault(id);
    }

    function test_reclaimExpiredReplayReverts() public {
        bytes32 lotId = settleStandardFill();
        vm.warp(block.timestamp + CREDIT_TTL + 1);
        settlement.reclaimExpired(lotId);

        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.LotNotFound.selector, lotId));
        settlement.reclaimExpired(lotId);
    }

    // ── Cancellation: a cancelled order poisons any batch containing it ──────

    function test_cancelThenSettleReverts() public {
        InferenceBazaarSettlement.Order memory b1 = buyOrder(15_000_000, 50_000);
        b1.salt = keccak256("r8-b1");
        InferenceBazaarSettlement.Order memory s1 = sellOrder(14_000_000, 50_000);
        s1.salt = keccak256("r8-s1");
        InferenceBazaarSettlement.Order memory b2 = buyOrder(15_000_000, 50_000);
        b2.salt = keccak256("r8-b2");
        InferenceBazaarSettlement.Order memory s2 = sellOrder(14_000_000, 50_000);
        s2.salt = keccak256("r8-s2");

        vm.prank(seller);
        settlement.cancelOrder(s2);
        bytes32 sellHash2 = settlement.hashOrder(s2);

        InferenceBazaarSettlement.FillInput[] memory lone = new InferenceBazaarSettlement.FillInput[](1);
        lone[0] = InferenceBazaarSettlement.FillInput({
            buy: b2,
            buySig: sign(buyerKey, b2),
            sell: s2,
            sellSig: sign(sellerKey, s2),
            qtyTokens: 50_000,
            execPriceMicroPerM: 15_000_000
        });
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.OrderIsCancelled.selector, sellHash2));
        settlement.settleFills(lone);

        // Batch [valid fill, cancelled fill] reverts entirely; the valid fill's
        // parties see no state change.
        InferenceBazaarSettlement.FillInput[] memory fills = new InferenceBazaarSettlement.FillInput[](2);
        fills[0] = InferenceBazaarSettlement.FillInput({
            buy: b1,
            buySig: sign(buyerKey, b1),
            sell: s1,
            sellSig: sign(sellerKey, s1),
            qtyTokens: 50_000,
            execPriceMicroPerM: 15_000_000
        });
        fills[1] = lone[0];

        uint256 buyerBal = settlement.balances(buyer);
        uint256 sellerBal = settlement.balances(seller);
        uint256 feeBal = settlement.balances(feeRecipient);
        uint256 sellerColl = settlement.collateral(seller);
        uint256 sellerLiab = settlement.liability(seller);

        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.OrderIsCancelled.selector, sellHash2));
        settlement.settleFills(fills);

        assertEq(settlement.balances(buyer), buyerBal, "buyer balance unchanged");
        assertEq(settlement.balances(seller), sellerBal, "seller balance unchanged");
        assertEq(settlement.balances(feeRecipient), feeBal, "fee balance unchanged");
        assertEq(settlement.collateral(seller), sellerColl, "collateral unchanged");
        assertEq(settlement.liability(seller), sellerLiab, "liability unchanged");
        assertEq(settlement.filled(settlement.hashOrder(b1)), 0, "valid fill rolled back");
        assertEq(settlement.filled(settlement.hashOrder(s1)), 0, "valid fill rolled back");
    }

    // ── Attested path: fill caps, not the nonce, are the double-spend guard ──

    function test_attestedFillReplayAcrossBatches() public {
        InferenceBazaarSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        InferenceBazaarSettlement.Order memory s = sellOrder(14_000_000, 50_000);
        InferenceBazaarSettlement.BatchFill[] memory fills = new InferenceBazaarSettlement.BatchFill[](1);
        fills[0] =
            InferenceBazaarSettlement.BatchFill({ buy: b, sell: s, qtyTokens: 50_000, execPriceMicroPerM: 15_000_000 });

        settlement.settleBatchAttested(BOOK, fills, attest(fills));
        assertEq(settlement.bookNonce(BOOK), 1);

        // Fresh quorum signatures over the new nonce: the attestation itself is
        // valid, but the orders are exhausted — the fill cap blocks the replay.
        bytes[] memory freshSigs = attest(fills);
        bytes32 buyHash = settlement.hashOrder(b);
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.Overfill.selector, buyHash, 0, 50_000));
        settlement.settleBatchAttested(BOOK, fills, freshSigs);
    }
}
