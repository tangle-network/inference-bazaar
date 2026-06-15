// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { InferenceBazaarSettlement } from "../src/InferenceBazaarSettlement.sol";

/// Cross-stack parity pin. The constants below are derived independently by
/// crates/settlement/tests/parity.rs (the Rust mirror) and asserted here from
/// the contract's own hashing. If either side changes a struct, a domain
/// field, or the batch encoding, both tests fail and point at the drift.
/// Regenerate with:
///   cargo test -p inference-bazaar-settlement --test parity print_fixture_values -- --nocapture
contract Eip712ParityTest is Test {
    bytes32 constant DOMAIN_SEPARATOR_PIN = 0xc67b5358a9a9d13922a738ee1200fa32b6d032e18e552410766ee7c3da4d020b;
    bytes32 constant BUY_DIGEST_PIN = 0x61fa3867c8944a9b0c4bd08bcde2ec0f8e32a60b6a4ed95297cdb902fd03bd48;
    bytes32 constant SELL_DIGEST_PIN = 0xcc986c6927f2274a04ed697bc9d4b624cb32fd433f41cf756464e5e5cffe3766;
    bytes32 constant FILLS_HASH_PIN = 0x54d57a43d09d15471f4f864443bc63e10a0d05a12fa203f81941d036aa5ad334;
    bytes32 constant RECEIPT_DIGEST_PIN = 0x53d4416fa58999e8515e4a695711f2e8c5e1c9801e99a1b9d983b94e969919ec;
    bytes32 constant BATCH_DIGEST_PIN = 0xf6fa2ab8e1c2e9090ac39e20712ac33852b12a05f7492b97ef65b61054e7b8b1;
    // The work commitment fixed in the receipt parity fixture (shared with Rust).
    bytes32 constant WORK = bytes32(uint256(0x77));

    uint64 constant CHAIN_ID = 3799; // Tangle testnet
    address constant VERIFYING = 0x1111111111111111111111111111111111111111;

    InferenceBazaarSettlement settlement;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        // The Rust fixture pins verifyingContract = 0x1111…; deploy there.
        InferenceBazaarSettlement impl =
            new InferenceBazaarSettlement(IERC20(address(0xDEAD)), 30 days, 6 hours, 1 hours, 500, 200, address(0xFEE));
        vm.etch(VERIFYING, address(impl).code);
        settlement = InferenceBazaarSettlement(VERIFYING);
        // EIP712 caches the domain separator with the ORIGINAL deploy address;
        // OZ 5 recomputes when address(this) differs, so etching works.
    }

    function buyOrder() internal pure returns (InferenceBazaarSettlement.Order memory) {
        return InferenceBazaarSettlement.Order({
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

    function sellOrder() internal pure returns (InferenceBazaarSettlement.Order memory) {
        return InferenceBazaarSettlement.Order({
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

    function fills() internal pure returns (InferenceBazaarSettlement.BatchFill[] memory f) {
        f = new InferenceBazaarSettlement.BatchFill[](1);
        f[0] = InferenceBazaarSettlement.BatchFill({
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
        assertEq(settlement.receiptDigest(bytes32(uint256(1)), 20_000, WORK), RECEIPT_DIGEST_PIN);
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
