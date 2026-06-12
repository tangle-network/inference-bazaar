// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { SettlementTestBase } from "./Base.t.sol";
import { SP1MockVerifierAccept, SP1MockVerifierStrict } from "../src/dev/Mocks.sol";
import { SurplusSettlement } from "../src/SurplusSettlement.sol";

contract BatchTest is SettlementTestBase {
    function batchFills() internal view returns (SurplusSettlement.BatchFill[] memory fills) {
        fills = new SurplusSettlement.BatchFill[](2);
        SurplusSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        SurplusSettlement.Order memory s = sellOrder(14_000_000, 50_000);
        fills[0] = SurplusSettlement.BatchFill({ buy: b, sell: s, qtyTokens: 30_000, execPriceMicroPerM: 15_000_000 });
        fills[1] = SurplusSettlement.BatchFill({ buy: b, sell: s, qtyTokens: 20_000, execPriceMicroPerM: 14_500_000 });
    }

    function attestBatch(SurplusSettlement.BatchFill[] memory fills) internal view returns (bytes[] memory) {
        bytes32 fillsHash = keccak256(abi.encode(fills));
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                settlement.domainSeparator(),
                keccak256(abi.encode(settlement.BATCH_TYPEHASH(), BOOK, settlement.bookNonce(BOOK), fillsHash))
            )
        );
        return quorumSign(digest);
    }

    function test_attestedBatchApplies_bothFills() public {
        SurplusSettlement.BatchFill[] memory fills = batchFills();
        uint256 buyerBefore = settlement.balances(buyer);
        settlement.settleBatchAttested(BOOK, fills, attestBatch(fills));

        // fill 1: (15e6 * 30k + 5e5)/1e6 = 450_000; fill 2: (14.5e6 * 20k)/1e6 = 290_000
        assertEq(settlement.balances(buyer), buyerBefore - 740_000);
        assertEq(settlement.bookNonce(BOOK), 1, "nonce advanced");
        bytes32 buyHash = settlement.hashOrder(fills[0].buy);
        assertEq(settlement.filled(buyHash), 50_000, "fill caps enforced in batch path too");
    }

    function test_attestationReplayRejected_nonceAdvanced() public {
        SurplusSettlement.BatchFill[] memory fills = batchFills();
        bytes[] memory sigs = attestBatch(fills);
        settlement.settleBatchAttested(BOOK, fills, sigs);
        // Same signatures again: digest now embeds nonce 1, recovery yields non-attesters.
        vm.expectRevert(SurplusSettlement.BadQuorum.selector);
        settlement.settleBatchAttested(BOOK, fills, sigs);
    }

    function test_belowThresholdRejected() public {
        SurplusSettlement.BatchFill[] memory fills = batchFills();
        bytes[] memory sigs = attestBatch(fills);
        bytes[] memory one = new bytes[](1);
        one[0] = sigs[0];
        vm.expectRevert(SurplusSettlement.BadQuorum.selector);
        settlement.settleBatchAttested(BOOK, fills, one);
    }

    function test_nonAttesterSignatureRejected() public {
        SurplusSettlement.BatchFill[] memory fills = batchFills();
        bytes32 fillsHash = keccak256(abi.encode(fills));
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                settlement.domainSeparator(),
                keccak256(abi.encode(settlement.BATCH_TYPEHASH(), BOOK, settlement.bookNonce(BOOK), fillsHash))
            )
        );
        bytes[] memory sigs = new bytes[](2);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        sigs[0] = abi.encodePacked(r, s, v);
        (v, r, s) = vm.sign(0xBAD2, digest);
        sigs[1] = abi.encodePacked(r, s, v);
        vm.expectRevert(SurplusSettlement.BadQuorum.selector);
        settlement.settleBatchAttested(BOOK, fills, sigs);
    }

    function test_duplicateSignerRejected_byStrictOrdering() public {
        SurplusSettlement.BatchFill[] memory fills = batchFills();
        bytes[] memory sigs = attestBatch(fills);
        bytes[] memory dup = new bytes[](2);
        dup[0] = sigs[0];
        dup[1] = sigs[0];
        vm.expectRevert(SurplusSettlement.BadQuorum.selector);
        settlement.settleBatchAttested(BOOK, fills, dup);
    }

    function test_attestedBatchStillEnforcesLimits() public {
        // Quorum cannot push a fill past the signed order's quantity.
        SurplusSettlement.BatchFill[] memory fills = new SurplusSettlement.BatchFill[](1);
        SurplusSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        SurplusSettlement.Order memory s = sellOrder(14_000_000, 50_000);
        fills[0] = SurplusSettlement.BatchFill({ buy: b, sell: s, qtyTokens: 60_000, execPriceMicroPerM: 15_000_000 });
        bytes[] memory sigs = attestBatch(fills);
        vm.expectRevert(
            abi.encodeWithSelector(SurplusSettlement.Overfill.selector, settlement.hashOrder(b), 50_000, 60_000)
        );
        settlement.settleBatchAttested(BOOK, fills, sigs);
    }

    function test_provenPathDisabledByDefault() public {
        SurplusSettlement.BatchFill[] memory fills = batchFills();
        vm.expectRevert(SurplusSettlement.ProvenPathDisabled.selector);
        settlement.settleBatchProven(BOOK, fills, hex"");
    }

    function test_provenBatch_bindsDomainAndFillsHash() public {
        SP1MockVerifierStrict verifier = new SP1MockVerifierStrict();
        bytes32 vkey = keccak256("surplus-batch-program-vkey");
        settlement.setSp1Verifier(address(verifier), vkey);

        SurplusSettlement.BatchFill[] memory fills = batchFills();
        bytes32 fillsHash = keccak256(abi.encode(fills));
        verifier.expect(vkey, abi.encode(settlement.domainSeparator(), BOOK, settlement.bookNonce(BOOK), fillsHash));

        uint256 buyerBefore = settlement.balances(buyer);
        settlement.settleBatchProven(BOOK, fills, hex"deadbeef");
        assertEq(settlement.balances(buyer), buyerBefore - 740_000);
    }

    /// A proof's public values bind the bookId: the same proof cannot settle
    /// under a different (e.g. higher-fee) book, so a prover cannot re-route a
    /// batch's fee or steal another book's finality.
    function test_provenBatch_bindsBookId() public {
        bytes32 OTHER = keccak256("other-book");
        address[] memory atts = new address[](3);
        atts[0] = vm.addr(att1Key);
        atts[1] = vm.addr(att2Key);
        atts[2] = vm.addr(att3Key);
        settlement.registerBook(OTHER, atts, 2, 0, address(0));

        SP1MockVerifierStrict verifier = new SP1MockVerifierStrict();
        bytes32 vkey = keccak256("surplus-batch-program-vkey");
        settlement.setSp1Verifier(address(verifier), vkey);

        SurplusSettlement.BatchFill[] memory fills = batchFills();
        bytes32 fillsHash = keccak256(abi.encode(fills));
        // Proof was made for BOOK at nonce 0.
        verifier.expect(vkey, abi.encode(settlement.domainSeparator(), BOOK, uint64(0), fillsHash));
        // Submitting it under OTHER recomputes publicValues with OTHER => mismatch.
        vm.expectRevert("publicValues");
        settlement.settleBatchProven(OTHER, fills, hex"deadbeef");
    }

    function test_provenBatch_rejectsWrongPublicValues() public {
        SP1MockVerifierStrict verifier = new SP1MockVerifierStrict();
        bytes32 vkey = keccak256("surplus-batch-program-vkey");
        settlement.setSp1Verifier(address(verifier), vkey);

        SurplusSettlement.BatchFill[] memory fills = batchFills();
        // Verifier expects different fills => the contract-computed publicValues mismatch.
        verifier.expect(vkey, abi.encode(settlement.domainSeparator(), BOOK, settlement.bookNonce(BOOK), keccak256("other")));
        vm.expectRevert("publicValues");
        settlement.settleBatchProven(BOOK, fills, hex"deadbeef");
    }

    function test_provenReplaySafe_fillCapsBlockDoubleApply() public {
        SurplusSettlement.BatchFill[] memory fills = batchFills();
        settlement.setSp1Verifier(address(new SP1MockVerifierAccept()), bytes32("vk"));
        settlement.settleBatchProven(BOOK, fills, hex"");
        // Orders are now fully filled; re-applying the same proof/batch reverts.
        vm.expectRevert();
        settlement.settleBatchProven(BOOK, fills, hex"");
    }

    // ── Book governance: write-once economics, rotatable membership ──────────────

    function test_registerBook_isWriteOnce() public {
        address[] memory atts = new address[](3);
        atts[0] = vm.addr(att1Key);
        atts[1] = vm.addr(att2Key);
        atts[2] = vm.addr(att3Key);
        // BOOK is already registered in setUp; re-registering (the retroactive
        // fee-skim vector) must revert.
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.BookAlreadyRegistered.selector, BOOK));
        settlement.registerBook(BOOK, atts, 2, 1000, address(0xFEE));
    }

    function test_registerBook_rejectsReservedBookId() public {
        address[] memory atts = new address[](1);
        atts[0] = vm.addr(att1Key);
        bytes32 noBook = settlement.NO_BOOK();
        vm.expectRevert(SurplusSettlement.ReservedBookId.selector);
        settlement.registerBook(noBook, atts, 1, 0, address(0));
    }

    function test_rotateAttesters_changesQuorumKeepsFee() public {
        bytes32 FEEBOOK = keccak256("fee-book");
        address[] memory atts = new address[](3);
        atts[0] = vm.addr(att1Key);
        atts[1] = vm.addr(att2Key);
        atts[2] = vm.addr(att3Key);
        settlement.registerBook(FEEBOOK, atts, 2, 750, address(0xFEE));
        (uint16 feeBefore, address recBefore) = settlement.bookFee(FEEBOOK);

        // Rotate to a new 1-of-1 set; fee/recipient must be untouched.
        address[] memory rot = new address[](1);
        rot[0] = vm.addr(att1Key);
        settlement.rotateAttesters(FEEBOOK, rot, 1);

        (uint16 feeAfter, address recAfter) = settlement.bookFee(FEEBOOK);
        assertEq(feeAfter, feeBefore, "fee unchanged by rotation");
        assertEq(recAfter, recBefore, "recipient unchanged by rotation");
        assertEq(settlement.bookThreshold(FEEBOOK), 1, "threshold rotated");
        assertEq(settlement.bookAttesters(FEEBOOK).length, 1, "attester set rotated");
    }

    function test_rotateAttesters_unknownBookReverts() public {
        bytes32 GHOST = keccak256("ghost");
        address[] memory rot = new address[](1);
        rot[0] = vm.addr(att1Key);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.UnknownBook.selector, GHOST));
        settlement.rotateAttesters(GHOST, rot, 1);
    }

    function test_hashFillsMatchesAbiEncode() public view {
        SurplusSettlement.BatchFill[] memory fills = batchFills();
        assertEq(settlement.hashFills(toCalldataish(fills)), keccak256(abi.encode(fills)));
    }

    function toCalldataish(SurplusSettlement.BatchFill[] memory fills)
        internal
        pure
        returns (SurplusSettlement.BatchFill[] memory)
    {
        return fills;
    }
}
