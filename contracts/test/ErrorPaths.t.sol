// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { SettlementTestBase } from "./Base.t.sol";
import { InferenceBazaarSettlement } from "../src/InferenceBazaarSettlement.sol";

/// Audit H8 named these custom errors as having ZERO coverage — the theft guard
/// (NotLotHolder), the zero-amount guards, and the over-serve dispute guard
/// (ServedExceedsRequested). One test per revert, so a regression that drops
/// the check fails CI.
contract ErrorPathsTest is SettlementTestBase {
    bytes32 internal lotId;
    bytes32 internal constant WORK = keccak256("served-work-commitment");

    function setUp() public override {
        super.setUp();
        lotId = settleStandardFill(); // buyer holds 50k tokens, issuer = seller
    }

    function test_transferLot_byNonHolderReverts() public {
        vm.prank(seller); // seller issued it but the buyer holds it
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.NotLotHolder.selector, lotId));
        settlement.transferLot(lotId, address(0xBEEF));
    }

    function test_requestRedemption_byNonHolderReverts() public {
        vm.prank(address(0xD00D));
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.NotLotHolder.selector, lotId));
        settlement.requestRedemption(lotId, 10_000);
    }

    function test_deposit_zeroReverts() public {
        vm.prank(buyer);
        vm.expectRevert(InferenceBazaarSettlement.ZeroAmount.selector);
        settlement.deposit(0);
    }

    function test_depositCollateral_zeroReverts() public {
        vm.prank(seller);
        vm.expectRevert(InferenceBazaarSettlement.ZeroAmount.selector);
        settlement.depositCollateral(0);
    }

    function test_requestRedemption_zeroReverts() public {
        vm.prank(buyer);
        vm.expectRevert(InferenceBazaarSettlement.ZeroAmount.selector);
        settlement.requestRedemption(lotId, 0);
    }

    function test_transferLot_toZeroReverts() public {
        vm.prank(buyer);
        vm.expectRevert(InferenceBazaarSettlement.ZeroAmount.selector);
        settlement.transferLot(lotId, address(0));
    }

    function test_settleRedemption_overServeReverts() public {
        vm.prank(buyer);
        bytes32 rid = settlement.requestRedemption(lotId, 20_000);
        // The issuer claims it served MORE than the holder requested.
        uint64 over = 20_001;
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(buyerKey, settlement.receiptDigest(rid, over, WORK));
        vm.expectRevert(
            abi.encodeWithSelector(InferenceBazaarSettlement.ServedExceedsRequested.selector, over, uint64(20_000))
        );
        settlement.settleRedemption(rid, over, WORK, abi.encodePacked(r, ss, v));
    }

    function test_withdraw_aboveBalanceReverts() public {
        vm.startPrank(buyer);
        uint256 bal = settlement.balances(buyer);
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarSettlement.InsufficientBalance.selector, bal, bal + 1));
        settlement.withdraw(bal + 1);
        vm.stopPrank();
    }
}
