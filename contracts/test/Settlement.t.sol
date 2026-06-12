// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { SettlementTestBase } from "./Base.t.sol";
import { SurplusSettlement } from "../src/SurplusSettlement.sol";

contract SettlementTest is SettlementTestBase {
    function test_atomicMintFill() public {
        uint256 buyerBefore = settlement.balances(buyer);
        bytes32 lotId = settleStandardFill();

        // cost = (15_000_000 * 50_000 + 500_000) / 1_000_000 = 750_000
        assertEq(settlement.balances(buyer), buyerBefore - 750_000, "buyer debited");
        uint256 fee = (750_000 * uint256(FEE_BPS)) / 10_000;
        assertEq(settlement.balances(seller), 750_000 - fee, "seller paid minus fee");
        assertEq(settlement.balances(feeRecipient), fee, "fee accrued");
        assertEq(settlement.liability(seller), 750_000, "issuer liability = paid value");

        (
            address holder,
            address issuer,
            bytes32 instrument,
            uint64 qty,
            uint64 locked,
            uint64 expiry,
            uint128 notional
        ) = settlement.lots(lotId);
        assertEq(holder, buyer);
        assertEq(issuer, seller);
        assertEq(instrument, INSTRUMENT);
        assertEq(qty, 50_000);
        assertEq(locked, 0);
        assertEq(expiry, uint64(block.timestamp) + CREDIT_TTL);
        assertEq(notional, 750_000);
    }

    function test_notionalRoundsHalfUp() public {
        // price 1_000, qty 1_500 => raw 1_500_000 / 1e6 with +500_000 => 2 micro (1.5 rounds up)
        SurplusSettlement.Order memory b = buyOrder(1000, 1_500_000);
        SurplusSettlement.Order memory s = sellOrder(1000, 1_500_000);
        uint256 before = settlement.balances(buyer);
        settlement.settleFills(fillInput(b, s, 1500, 1000));
        assertEq(before - settlement.balances(buyer), 2, "half-up rounding");
    }

    function test_partialFillsAccumulate_thenOverfillReverts() public {
        SurplusSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        SurplusSettlement.Order memory s = sellOrder(14_000_000, 50_000);
        settlement.settleFills(fillInput(b, s, 30_000, 15_000_000));
        settlement.settleFills(fillInput(b, s, 20_000, 15_000_000));
        assertEq(settlement.filled(settlement.hashOrder(b)), 50_000);
        SurplusSettlement.FillInput[] memory overfill = fillInput(b, s, 1000, 15_000_000);
        bytes32 buyHash = settlement.hashOrder(b);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.Overfill.selector, buyHash, 0, 1000));
        settlement.settleFills(overfill);
    }

    function test_badSignatureReverts() public {
        SurplusSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        SurplusSettlement.Order memory s = sellOrder(14_000_000, 50_000);
        SurplusSettlement.FillInput[] memory fills = fillInput(b, s, 50_000, 15_000_000);
        fills[0].buySig = sign(sellerKey, b); // wrong signer
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.BadSignature.selector, settlement.hashOrder(b)));
        settlement.settleFills(fills);
    }

    function test_tamperedOrderAfterSigningReverts() public {
        SurplusSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        SurplusSettlement.Order memory s = sellOrder(14_000_000, 50_000);
        SurplusSettlement.FillInput[] memory fills = fillInput(b, s, 50_000, 15_000_000);
        fills[0].buy.qtyTokens = 500_000; // venue inflates the buyer's order
        vm.expectRevert(); // digest changes => recovery mismatch
        settlement.settleFills(fills);
    }

    function test_expiredOrderReverts() public {
        SurplusSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        SurplusSettlement.Order memory s = sellOrder(14_000_000, 50_000);
        SurplusSettlement.FillInput[] memory fills = fillInput(b, s, 50_000, 15_000_000);
        vm.warp(block.timestamp + 301);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.OrderExpired.selector, settlement.hashOrder(b)));
        settlement.settleFills(fills);
    }

    function test_cancelledOrderReverts() public {
        SurplusSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        SurplusSettlement.Order memory s = sellOrder(14_000_000, 50_000);
        vm.prank(buyer);
        settlement.cancelOrder(b);
        SurplusSettlement.FillInput[] memory fills = fillInput(b, s, 50_000, 15_000_000);
        bytes32 buyHash = settlement.hashOrder(b);
        vm.expectRevert(abi.encodeWithSelector(SurplusSettlement.OrderIsCancelled.selector, buyHash));
        settlement.settleFills(fills);
    }

    function test_onlyTraderCancels() public {
        SurplusSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        vm.expectRevert(SurplusSettlement.NotTrader.selector);
        settlement.cancelOrder(b);
    }

    function test_priceOutsideLimitsReverts() public {
        SurplusSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        SurplusSettlement.Order memory s = sellOrder(14_000_000, 50_000);
        SurplusSettlement.FillInput[] memory above = fillInput(b, s, 50_000, 15_000_001);
        SurplusSettlement.FillInput[] memory below = fillInput(b, s, 50_000, 13_999_999);
        vm.expectRevert(
            abi.encodeWithSelector(SurplusSettlement.PriceOutsideLimits.selector, 15_000_001, 15_000_000, 14_000_000)
        );
        settlement.settleFills(above);
        vm.expectRevert(
            abi.encodeWithSelector(SurplusSettlement.PriceOutsideLimits.selector, 13_999_999, 15_000_000, 14_000_000)
        );
        settlement.settleFills(below);
    }

    function test_insufficientBuyerBalanceReverts() public {
        // 8M tokens at $15/M = $120 > buyer's $100 deposit.
        SurplusSettlement.Order memory b = buyOrder(15_000_000, 8_000_000);
        SurplusSettlement.Order memory s = sellOrder(14_000_000, 8_000_000);
        // seller needs collateral for $120 too; top up so the buyer is the binding constraint
        vm.prank(seller);
        settlement.depositCollateral(900_000_000);
        SurplusSettlement.FillInput[] memory fills = fillInput(b, s, 8_000_000, 15_000_000);
        vm.expectRevert(
            abi.encodeWithSelector(SurplusSettlement.InsufficientBalance.selector, 100_000_000, 120_000_000)
        );
        settlement.settleFills(fills);
    }

    function test_mintBlockedWithoutCollateralHeadroom() public {
        // Liability would be $90; required = $90 * 1.05 = $94.5 <= $100 OK.
        // Second mint pushing liability to $180 must revert (requires $189).
        SurplusSettlement.Order memory b = buyOrder(15_000_000, 6_000_000);
        SurplusSettlement.Order memory s = sellOrder(14_000_000, 6_000_000);
        vm.prank(buyer);
        settlement.deposit(100_000_000); // cash for both fills so collateral binds
        settlement.settleFills(fillInput(b, s, 6_000_000, 15_000_000));
        assertEq(settlement.liability(seller), 90_000_000);

        SurplusSettlement.Order memory b2 = buyOrder(15_000_000, 6_000_000);
        b2.salt = keccak256("buy-2");
        SurplusSettlement.Order memory s2 = sellOrder(14_000_000, 6_000_000);
        s2.salt = keccak256("sell-2");
        SurplusSettlement.FillInput[] memory fills = fillInput(b2, s2, 6_000_000, 15_000_000);
        vm.expectRevert(
            abi.encodeWithSelector(SurplusSettlement.InsufficientCollateral.selector, 100_000_000, 189_000_000)
        );
        settlement.settleFills(fills);
    }

    function test_selfFillReverts() public {
        SurplusSettlement.Order memory b = buyOrder(15_000_000, 50_000);
        b.trader = seller;
        SurplusSettlement.Order memory s = sellOrder(14_000_000, 50_000);
        SurplusSettlement.FillInput[] memory fills = fillInput(b, s, 50_000, 15_000_000);
        fills[0].buySig = sign(sellerKey, b);
        vm.expectRevert(SurplusSettlement.SelfFill.selector);
        settlement.settleFills(fills);
    }

    function test_resaleSplitsLot_andShrinksLiabilityWhenCheaper() public {
        bytes32 srcLot = settleStandardFill(); // buyer holds 50k tokens, notional 750_000

        // Buyer resells 20k tokens to buyer2 at a LOWER price ($10/M => cost 200_000).
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
            priceMicroPerM: 10_000_000,
            qtyTokens: 20_000,
            lotId: bytes32(0),
            trader: buyer2,
            expiry: uint64(block.timestamp + 300),
            salt: keccak256("b2")
        });
        SurplusSettlement.Order memory s2 = SurplusSettlement.Order({
            instrument: INSTRUMENT,
            side: 1,
            priceMicroPerM: 10_000_000,
            qtyTokens: 20_000,
            lotId: srcLot,
            trader: buyer, // the original buyer is now the seller
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
            qtyTokens: 20_000,
            execPriceMicroPerM: 10_000_000
        });
        settlement.settleFills(fills);

        // prorata carve = 750_000 * 20k / 50k = 300_000; buyer2 paid 200_000.
        // New lot refund value = min(200_000, 300_000) = 200_000; issuer liability
        // shrinks by the 100_000 difference.
        (,,, uint64 srcQty,,, uint128 srcNotional) = settlement.lots(srcLot);
        assertEq(srcQty, 30_000);
        assertEq(srcNotional, 450_000);
        assertEq(settlement.liability(seller), 650_000, "750k - 100k released");

        bytes32 newLot = keccak256(abi.encode(settlement.hashOrder(b2), settlement.hashOrder(s2), uint64(0)));
        (address h2, address i2,, uint64 q2,, uint64 e2, uint128 n2) = settlement.lots(newLot);
        assertEq(h2, buyer2);
        assertEq(i2, seller, "issuer follows the lot");
        assertEq(q2, 20_000);
        assertEq(n2, 200_000);
        (,,,,, uint64 srcExpiry,) = settlement.lots(srcLot);
        assertEq(e2, srcExpiry, "expiry inherited");
    }

    function test_resaleInstrumentMismatchReverts() public {
        // Seller mints a lot of the cheap instrument Y...
        bytes32 instrY = keccak256("anthropic/claude-haiku-4-5:output");
        SurplusSettlement.Order memory by = SurplusSettlement.Order({
            instrument: instrY,
            side: 0,
            priceMicroPerM: 250_000,
            qtyTokens: 50_000,
            lotId: bytes32(0),
            trader: buyer,
            expiry: uint64(block.timestamp + 300),
            salt: keccak256("by")
        });
        SurplusSettlement.Order memory sy = SurplusSettlement.Order({
            instrument: instrY,
            side: 1,
            priceMicroPerM: 250_000,
            qtyTokens: 50_000,
            lotId: bytes32(0),
            trader: seller,
            expiry: uint64(block.timestamp + 300),
            salt: keccak256("sy")
        });
        settlement.settleFills(fillInput(by, sy, 50_000, 250_000));
        bytes32 lotY = keccak256(abi.encode(settlement.hashOrder(by), settlement.hashOrder(sy), uint64(0)));

        // ...then tries to resell lot Y at the EXPENSIVE instrument X's price.
        // buyer here is the resale buyer (buyer2); use a fresh trader.
        uint256 buyer2Key = 0xB002;
        address buyer2 = vm.addr(buyer2Key);
        usd.mint(buyer2, 100_000_000);
        vm.startPrank(buyer2);
        usd.approve(address(settlement), type(uint256).max);
        settlement.deposit(100_000_000);
        vm.stopPrank();

        SurplusSettlement.Order memory bx = SurplusSettlement.Order({
            instrument: INSTRUMENT, // X — expensive
            side: 0,
            priceMicroPerM: 15_000_000,
            qtyTokens: 50_000,
            lotId: bytes32(0),
            trader: buyer2,
            expiry: uint64(block.timestamp + 300),
            salt: keccak256("bx")
        });
        SurplusSettlement.Order memory sx = SurplusSettlement.Order({
            instrument: INSTRUMENT, // X — but delivers lot Y
            side: 1,
            priceMicroPerM: 15_000_000,
            qtyTokens: 50_000,
            lotId: lotY,
            trader: buyer, // original buyer is the reseller / lot holder
            expiry: uint64(block.timestamp + 300),
            salt: keccak256("sx")
        });
        SurplusSettlement.FillInput[] memory fills = new SurplusSettlement.FillInput[](1);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(buyer2Key, settlement.orderDigest(bx));
        bytes memory bxSig = abi.encodePacked(r, sg, v);
        (v, r, sg) = vm.sign(buyerKey, settlement.orderDigest(sx));
        fills[0] = SurplusSettlement.FillInput({
            buy: bx,
            buySig: bxSig,
            sell: sx,
            sellSig: abi.encodePacked(r, sg, v),
            qtyTokens: 50_000,
            execPriceMicroPerM: 15_000_000
        });
        // The contract must reject delivering instrument Y for an X-priced order.
        vm.expectRevert(SurplusSettlement.InvalidOrderPair.selector);
        settlement.settleFills(fills);
    }

    function test_withdrawProceeds() public {
        settleStandardFill();
        uint256 proceeds = settlement.balances(seller);
        uint256 walletBefore = usd.balanceOf(seller);
        vm.prank(seller);
        settlement.withdraw(proceeds);
        assertEq(usd.balanceOf(seller), walletBefore + proceeds);
    }

    function test_collateralLockedWhileLotOutstanding() public {
        settleStandardFill(); // liability 750_000, penalty headroom 37_500
        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(
                SurplusSettlement.InsufficientCollateral.selector, 100_000_000 - 787_500, 100_000_000
            )
        );
        settlement.withdrawCollateral(100_000_000);
        vm.prank(seller);
        settlement.withdrawCollateral(100_000_000 - 787_500); // free part withdraws fine
        assertEq(settlement.collateral(seller), 787_500);
    }
}
