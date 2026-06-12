// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SurplusSettlement } from "../src/SurplusSettlement.sol";

/// Cross-stack parity pin. The constants below are derived independently by
/// crates/settlement/tests/parity.rs (the Rust mirror) and asserted here from
/// the contract's own hashing. If either side changes a struct, a domain
/// field, or the batch encoding, both tests fail and point at the drift.
/// Regenerate with:
///   cargo test -p surplus-settlement --test parity print_fixture_values -- --nocapture
contract Eip712ParityTest is Test {
    bytes32 constant DOMAIN_SEPARATOR_PIN = 0x0de24ff3d7a13aaf2d2f45a220740d46c8e4f672e6ec27ec07f887383aec631e;
    bytes32 constant BUY_DIGEST_PIN = 0x42429ee1902dced9a55e9d57665f224d30760bf116a4a5fb433667bd411da720;
    bytes32 constant SELL_DIGEST_PIN = 0x68a403f61ba389d67aaeb883f03a9e441dc347b3b0ec9f47dca89cb5be0fc2aa;
    bytes32 constant FILLS_HASH_PIN = 0x54d57a43d09d15471f4f864443bc63e10a0d05a12fa203f81941d036aa5ad334;
    bytes32 constant RECEIPT_DIGEST_PIN = 0xfdd98e90c60c3ff8de5ea5b9b3f80fb9bfaddd19c4829c2eed440e883a33b6b7;
    bytes32 constant BATCH_DIGEST_PIN = 0xbf7f321f498636d52728a1ea71a7fac4116795252c2299103f4d989278b36dbd;

    uint64 constant CHAIN_ID = 3799; // Tangle testnet
    address constant VERIFYING = 0x1111111111111111111111111111111111111111;

    SurplusSettlement settlement;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        // The Rust fixture pins verifyingContract = 0x1111…; deploy there.
        SurplusSettlement impl =
            new SurplusSettlement(IERC20(address(0xDEAD)), 30 days, 6 hours, 500, 200, address(0xFEE));
        vm.etch(VERIFYING, address(impl).code);
        settlement = SurplusSettlement(VERIFYING);
        // EIP712 caches the domain separator with the ORIGINAL deploy address;
        // OZ 5 recomputes when address(this) differs, so etching works.
    }

    function buyOrder() internal pure returns (SurplusSettlement.Order memory) {
        return SurplusSettlement.Order({
            instrument: keccak256("anthropic/claude-opus-4-8:output"),
            side: 0,
            priceMicroPerM: 15_000_000,
            qtyTokens: 50_000,
            lotId: bytes32(0),
            trader: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
            expiry: 1_900_000_000,
            salt: bytes32(uint256(0xaa))
        });
    }

    function sellOrder() internal pure returns (SurplusSettlement.Order memory) {
        return SurplusSettlement.Order({
            instrument: keccak256("anthropic/claude-opus-4-8:output"),
            side: 1,
            priceMicroPerM: 14_000_000,
            qtyTokens: 50_000,
            lotId: bytes32(0),
            trader: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
            expiry: 1_900_000_000,
            salt: bytes32(uint256(0xbb))
        });
    }

    function fills() internal pure returns (SurplusSettlement.BatchFill[] memory f) {
        f = new SurplusSettlement.BatchFill[](1);
        f[0] = SurplusSettlement.BatchFill({
            buy: buyOrder(), sell: sellOrder(), qtyTokens: 50_000, execPriceMicroPerM: 15_000_000
        });
    }

    function test_domainSeparatorMatchesRust() public view {
        assertEq(settlement.domainSeparator(), DOMAIN_SEPARATOR_PIN);
    }

    function test_orderDigestsMatchRust() public view {
        assertEq(settlement.orderDigest(buyOrder()), BUY_DIGEST_PIN);
        assertEq(settlement.orderDigest(sellOrder()), SELL_DIGEST_PIN);
    }

    function test_fillsHashMatchesRust() public view {
        assertEq(settlement.hashFills(fills()), FILLS_HASH_PIN);
    }

    function test_receiptDigestMatchesRust() public view {
        assertEq(settlement.receiptDigest(bytes32(uint256(1)), 20_000), RECEIPT_DIGEST_PIN);
    }

    function test_batchDigestMatchesRust() public view {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                settlement.domainSeparator(),
                keccak256(abi.encode(settlement.BATCH_TYPEHASH(), bytes32(0), uint64(0), FILLS_HASH_PIN))
            )
        );
        assertEq(digest, BATCH_DIGEST_PIN);
    }
}
