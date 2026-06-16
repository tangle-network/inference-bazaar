// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { SettlementTestBase } from "./Base.t.sol";
import { InferenceBazaarSettlement } from "../src/InferenceBazaarSettlement.sol";

contract RedemptionTest is SettlementTestBase {
    bytes32 internal lotId;
    bytes32 internal constant WORK = keccak256("served-work-commitment");

    function setUp() public override {
        super.setUp();
        lotId = settleStandardFill(); // buyer holds 50k tokens, notional 750_000, issuer = seller
    }

    function signReceipt(uint256 key, bytes32 redemptionId, uint64 served) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.receiptDigest(redemptionId, served, WORK));
        return abi.encodePacked(r, s, v);
    }

    function test_redeemFull_withHolderReceipt() public {
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(lotId, 50_000);
        (,,, uint64 locked,,,) = lotFields();
        assertEq(locked, 50_000, "qty locked while open");

        settlement.settleRedemption(id, 50_000, WORK, signReceipt(buyerKey, id, 50_000));
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
        settlement.settleRedemption(id, 20_000, WORK, signReceipt(buyerKey, id, 20_000));

        // debit = 750_000 * 20k / 50k = 300_000
        assertEq(settlement.liability(seller), 450_000);
        (,,, uint64 qty, uint64 locked,, uint128 notional) = lotFieldsFull();
        assertEq(qty, 30_000, "unserved tokens back in the lot");
        assertEq(locked, 0);
        assertEq(notional, 450_000);

        // Can immediately redeem the rest.
        vm.prank(buyer);
        settlement.requestRedemption(lotId, 30_000);
    }

    /// A lot minted through a BOOK batch records that book, so its own quorum may
    /// attest service — but the attestation now opens a challenge window and only
    /// finalizes after it passes unchallenged.
    function test_attestedSettle_disputePath() public {
        bytes32 bookLot = settleBatchMint();
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(bookLot, 50_000);
        bytes[] memory sigs = quorumSign(settlement.receiptDigest(id, 50_000, WORK));
        settlement.settleRedemptionAttested(BOOK, id, 50_000, WORK, sigs);
        // Not yet final — within the challenge window finalize reverts.
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.ChallengeWindowOpen.selector, id));
        settlement.finalizeAttested(id);
        // After the window, anyone finalizes the unchallenged attestation.
        uint256 liabBefore = settlement.liability(seller);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        settlement.finalizeAttested(id);
        // The batch lot (notional 750_000) is extinguished; the setUp lot remains.
        assertEq(settlement.liability(seller), liabBefore - 750_000, "batch lot liability extinguished");
    }

    /// The holder contests a bogus attestation within the window: it voids,
    /// returning the redemption to Open so a default becomes claimable.
    function test_attestedSettle_holderChallengeVoids() public {
        bytes32 bookLot = settleBatchMint();
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(bookLot, 50_000);
        bytes[] memory sigs = quorumSign(settlement.receiptDigest(id, 50_000, WORK));
        settlement.settleRedemptionAttested(BOOK, id, 50_000, WORK, sigs);

        vm.prank(buyer);
        settlement.challengeAttested(id);

        // Voided: finalize no longer possible, and after the redemption deadline
        // the holder claims a default (the issuer never proved real service).
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.RedemptionNotContested.selector, id));
        settlement.finalizeAttested(id);
        vm.warp(block.timestamp + REDEMPTION_WINDOW + 1);
        uint256 payout = settlement.claimDefault(id);
        assertGt(payout, 0, "holder made whole on default after challenge");
    }

    function test_challengeAfterWindowReverts() public {
        bytes32 bookLot = settleBatchMint();
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(bookLot, 50_000);
        bytes[] memory sigs = quorumSign(settlement.receiptDigest(id, 50_000, WORK));
        settlement.settleRedemptionAttested(BOOK, id, 50_000, WORK, sigs);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.ChallengeWindowClosed.selector, id));
        settlement.challengeAttested(id);
    }

    function test_onlyHolderChallenges() public {
        bytes32 bookLot = settleBatchMint();
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(bookLot, 50_000);
        bytes[] memory sigs = quorumSign(settlement.receiptDigest(id, 50_000, WORK));
        settlement.settleRedemptionAttested(BOOK, id, 50_000, WORK, sigs);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.NotLotHolder.selector, bookLot));
        settlement.challengeAttested(id);
    }

    /// THE confiscation regression: a `settleFills`-minted lot has no issuing
    /// book (NO_BOOK), so NO quorum can attest it away. Only the holder's signed
    /// receipt or claimDefault can move it.
    function test_attestedSettle_revertsForBooklessLot() public {
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(lotId, 50_000); // lotId is a settleFills lot
        bytes[] memory sigs = quorumSign(settlement.receiptDigest(id, 50_000, WORK));
        vm.expectRevert(
            abi.encodeWithSelector(
                InferenceBazaarSettlement.RedemptionBookMismatch.selector, settlement.NO_BOOK(), BOOK
            )
        );
        settlement.settleRedemptionAttested(BOOK, id, 50_000, WORK, sigs);
    }

    /// Cross-instance confiscation is blocked: a DIFFERENT registered book's
    /// quorum cannot attest a lot minted under BOOK — even though that other book
    /// is fully registered with a valid quorum.
    function test_attestedSettle_revertsForForeignBook() public {
        bytes32 OTHER = keccak256("other-instance-book");
        address[] memory atts = new address[](3);
        atts[0] = vm.addr(att1Key);
        atts[1] = vm.addr(att2Key);
        atts[2] = vm.addr(att3Key);
        settlement.registerBook(OTHER, atts, 2, 0, address(0));

        bytes32 bookLot = settleBatchMint(); // minted under BOOK
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(bookLot, 50_000);
        bytes[] memory sigs = quorumSign(settlement.receiptDigest(id, 50_000, WORK));
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.RedemptionBookMismatch.selector, BOOK, OTHER));
        settlement.settleRedemptionAttested(OTHER, id, 50_000, WORK, sigs);
    }

    function test_wrongReceiptSignerReverts() public {
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(lotId, 50_000);
        bytes memory badSig = signReceipt(sellerKey, id, 50_000);
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.BadReceipt.selector, id));
        settlement.settleRedemption(id, 50_000, WORK, badSig);
    }

    function test_claimDefault_paysHolderFromCollateralPlusPenalty() public {
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(lotId, 50_000);
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.RedemptionDeadlineNotPassed.selector, id));
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
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.RedemptionDeadlinePassed.selector, id));
        settlement.settleRedemption(id, 50_000, WORK, sig);
    }

    function test_oneOpenRedemptionPerLot() public {
        vm.prank(buyer);
        settlement.requestRedemption(lotId, 10_000);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.RedemptionAlreadyOpen.selector, lotId));
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

        InferenceBazaarSettlement.Order memory b2 = InferenceBazaarSettlement.Order({
            instrument: INSTRUMENT,
            side: 0,
            priceMicroPerM: 15_000_000,
            qtyTokens: 10_000,
            lotId: bytes32(0),
            trader: buyer2,
            expiry: uint64(block.timestamp + 300),
            salt: keccak256("b2")
        });
        InferenceBazaarSettlement.Order memory s2 = InferenceBazaarSettlement.Order({
            instrument: INSTRUMENT,
            side: 1,
            priceMicroPerM: 15_000_000,
            qtyTokens: 10_000,
            lotId: lotId,
            trader: buyer,
            expiry: uint64(block.timestamp + 300),
            salt: keccak256("s2")
        });
        InferenceBazaarSettlement.FillInput[] memory fills = new InferenceBazaarSettlement.FillInput[](1);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(buyer2Key, settlement.orderDigest(b2));
        bytes memory b2sig = abi.encodePacked(r, sg, v);
        (v, r, sg) = vm.sign(buyerKey, settlement.orderDigest(s2));
        fills[0] = InferenceBazaarSettlement.FillInput({
            buy: b2,
            buySig: b2sig,
            sell: s2,
            sellSig: abi.encodePacked(r, sg, v),
            qtyTokens: 10_000,
            execPriceMicroPerM: 15_000_000
        });
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.LotQtyUnavailable.selector, 5000, 10_000));
        settlement.settleFills(fills);
    }

    function test_transferBlockedWhileRedemptionOpen() public {
        vm.prank(buyer);
        settlement.requestRedemption(lotId, 10_000);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.RedemptionAlreadyOpen.selector, lotId));
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
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.LotNotExpired.selector, lotId));
        settlement.reclaimExpired(lotId);
    }

    function test_requestOnExpiredLotReverts() public {
        vm.warp(block.timestamp + CREDIT_TTL + 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.LotIsExpired.selector, lotId));
        settlement.requestRedemption(lotId, 10_000);
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    /// Mint a fresh 50k-token lot UNDER `BOOK` via the attested batch path, so
    /// `lotBook[lot] == BOOK`. Fresh salts keep it distinct from the setUp fill.
    function settleBatchMint() internal returns (bytes32 mintedLotId) {
        InferenceBazaarSettlement.Order memory b = InferenceBazaarSettlement.Order({
            instrument: INSTRUMENT,
            side: 0,
            priceMicroPerM: 15_000_000,
            qtyTokens: 50_000,
            lotId: bytes32(0),
            trader: buyer,
            expiry: uint64(block.timestamp + 300),
            salt: keccak256("batch-buy")
        });
        InferenceBazaarSettlement.Order memory s = InferenceBazaarSettlement.Order({
            instrument: INSTRUMENT,
            side: 1,
            priceMicroPerM: 14_000_000,
            qtyTokens: 50_000,
            lotId: bytes32(0),
            trader: seller,
            expiry: uint64(block.timestamp + 300),
            salt: keccak256("batch-sell")
        });
        InferenceBazaarSettlement.BatchFill[] memory fills = new InferenceBazaarSettlement.BatchFill[](1);
        fills[0] =
            InferenceBazaarSettlement.BatchFill({ buy: b, sell: s, qtyTokens: 50_000, execPriceMicroPerM: 15_000_000 });
        bytes32 fillsHash = keccak256(abi.encode(fills));
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                settlement.domainSeparator(),
                keccak256(abi.encode(settlement.BATCH_TYPEHASH(), BOOK, settlement.bookNonce(BOOK), fillsHash))
            )
        );
        settlement.settleBatchAttested(BOOK, fills, quorumSign(digest));
        mintedLotId = keccak256(abi.encode(settlement.hashOrder(b), settlement.hashOrder(s), uint64(0)));
    }

    function lotFields()
        internal
        view
        returns (
            address holder,
            address issuer,
            uint64 qty,
            uint64 locked,
            uint64 expiry,
            uint128 notional,
            bytes32 inst
        )
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
