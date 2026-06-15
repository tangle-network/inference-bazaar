// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { InferenceBazaarSettlement } from "../src/InferenceBazaarSettlement.sol";
import { MockUSD, SP1MockVerifierAccept, SP1MockVerifierStrict } from "../src/dev/Mocks.sol";

contract SettlementTestBase is Test {
    /// The matching domain every base-fixture batch settles through.
    bytes32 internal constant BOOK = keccak256("test-book");

    uint64 internal constant CREDIT_TTL = 30 days;
    uint64 internal constant REDEMPTION_WINDOW = 6 hours;
    uint64 internal constant CHALLENGE_WINDOW = 1 hours;
    uint16 internal constant PENALTY_BPS = 500; // 5%
    uint16 internal constant FEE_BPS = 200; // 2%

    MockUSD internal usd;
    InferenceBazaarSettlement internal settlement;

    uint256 internal buyerKey = 0xB001;
    uint256 internal sellerKey = 0x5E11;
    uint256 internal att1Key = 0xA001;
    uint256 internal att2Key = 0xA002;
    uint256 internal att3Key = 0xA003;

    address internal buyer;
    address internal seller;
    address internal feeRecipient = address(0xFEE);

    bytes32 internal constant INSTRUMENT = keccak256("anthropic/claude-opus-4-8:output");

    function setUp() public virtual {
        usd = new MockUSD();
        settlement = new InferenceBazaarSettlement(
            IERC20(address(usd)), CREDIT_TTL, REDEMPTION_WINDOW, CHALLENGE_WINDOW, PENALTY_BPS, FEE_BPS, feeRecipient
        );
        buyer = vm.addr(buyerKey);
        seller = vm.addr(sellerKey);

        usd.mint(buyer, 1_000_000_000); // $1,000
        usd.mint(seller, 1_000_000_000);
        vm.startPrank(buyer);
        usd.approve(address(settlement), type(uint256).max);
        settlement.deposit(100_000_000); // $100 trading cash
        vm.stopPrank();
        vm.startPrank(seller);
        usd.approve(address(settlement), type(uint256).max);
        settlement.depositCollateral(100_000_000); // $100 bond
        vm.stopPrank();

        // One matching domain ("book") with a 2-of-3 attester quorum.
        address[] memory atts = new address[](3);
        atts[0] = vm.addr(att1Key);
        atts[1] = vm.addr(att2Key);
        atts[2] = vm.addr(att3Key);
        settlement.registerBook(BOOK, atts, 2, 0, address(0));
    }

    // ── Order helpers ─────────────────────────────────────────────────────────

    function buyOrder(uint64 price, uint64 qty) internal view returns (InferenceBazaarSettlement.Order memory) {
        return InferenceBazaarSettlement.Order({
            instrument: INSTRUMENT,
            side: 0,
            priceMicroPerM: price,
            qtyTokens: qty,
            lotId: bytes32(0),
            trader: buyer,
            expiry: uint64(block.timestamp + 300),
            salt: keccak256("buy-salt")
        });
    }

    function sellOrder(uint64 price, uint64 qty) internal view returns (InferenceBazaarSettlement.Order memory) {
        return sellFromLot(price, qty, bytes32(0));
    }

    function sellFromLot(
        uint64 price,
        uint64 qty,
        bytes32 lotId
    )
        internal
        view
        returns (InferenceBazaarSettlement.Order memory)
    {
        return InferenceBazaarSettlement.Order({
            instrument: INSTRUMENT,
            side: 1,
            priceMicroPerM: price,
            qtyTokens: qty,
            lotId: lotId,
            trader: seller,
            expiry: uint64(block.timestamp + 300),
            salt: keccak256("sell-salt")
        });
    }

    function sign(uint256 key, InferenceBazaarSettlement.Order memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.orderDigest(o));
        return abi.encodePacked(r, s, v);
    }

    function fillInput(
        InferenceBazaarSettlement.Order memory b,
        InferenceBazaarSettlement.Order memory s,
        uint64 qty,
        uint64 px
    )
        internal
        view
        returns (InferenceBazaarSettlement.FillInput[] memory fills)
    {
        fills = new InferenceBazaarSettlement.FillInput[](1);
        fills[0] = InferenceBazaarSettlement.FillInput({
            buy: b,
            buySig: sign(buyerKey, b),
            sell: s,
            sellSig: sign(sellerKey, s),
            qtyTokens: qty,
            execPriceMicroPerM: px
        });
    }

    /// One standard mint: 50k tokens at $15/M => cost 750_000 micro ($0.75).
    function settleStandardFill() internal returns (bytes32 lotId) {
        InferenceBazaarSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        InferenceBazaarSettlement.Order memory s = sellOrder(14_000_000, 50_000);
        vm.recordLogs();
        settlement.settleFills(fillInput(b, s, 50_000, 15_000_000));
        lotId = keccak256(abi.encode(settlement.hashOrder(b), settlement.hashOrder(s), uint64(0)));
    }

    function quorumSign(bytes32 digest) internal view returns (bytes[] memory sigs) {
        // Recovered signers must be strictly ascending.
        uint256[3] memory keys = [att1Key, att2Key, att3Key];
        // selection sort addresses
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = i + 1; j < 3; j++) {
                if (vm.addr(keys[j]) < vm.addr(keys[i])) {
                    (keys[i], keys[j]) = (keys[j], keys[i]);
                }
            }
        }
        sigs = new bytes[](2);
        for (uint256 i = 0; i < 2; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], digest);
            sigs[i] = abi.encodePacked(r, s, v);
        }
    }
}
