// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { InferenceBazaarSettlement } from "../../src/InferenceBazaarSettlement.sol";
import { MockUSD } from "../../src/dev/Mocks.sol";
import { SettlementHandler } from "./SettlementHandler.sol";

/// Concrete coverage proof for the invariant suite: the fuzzer reaches lots by
/// construction (settleFill is deterministic-mint and in the selector set), and
/// these tests deterministically drive the full lifecycle and assert SOLVENCY
/// holds at the lot-bearing states the property test stresses.
contract HandlerSmoke is Test {
    MockUSD usd;
    InferenceBazaarSettlement s;
    SettlementHandler h;
    address feeRecipient = address(0xFEE);

    function setUp() public {
        usd = new MockUSD();
        s = new InferenceBazaarSettlement(IERC20(address(usd)), 30 days, 6 hours, 1 hours, 500, 200, feeRecipient);
        address[] memory a = new address[](1);
        a[0] = address(0xA11CE);
        s.registerBook(keccak256("b"), a, 1, 0, address(0));
        h = new SettlementHandler(s, usd, keccak256("b"), feeRecipient);
    }

    function _solvency() internal view {
        address[4] memory actors = h.actorsAll();
        uint256 owed;
        for (uint256 i = 0; i < 4; i++) {
            owed += s.balances(actors[i]) + s.collateral(actors[i]);
        }
        assertEq(usd.balanceOf(address(s)), owed, "solvency");
    }

    function test_fillMintsLot_solvent() public {
        h.settleFill(0, 100_000_000, 1000);
        assertEq(h.fillsCreated(), 1, "fill");
        assertEq(h.lotsLength(), 1, "lot recorded");
        _solvency();
    }

    function test_fullLifecycle_staysSolvent() public {
        h.settleFill(0, 100_000_000, 1000);
        _solvency();
        h.requestAndSettleRedemption(0, 50_000);
        _solvency();
        h.spend(0, 10_000);
        _solvency();
        assertGt(h.redemptionsSettled() + h.spendsSettled(), 0, "credit consumed");
        h.defaultOrReclaim(0);
        _solvency();
    }

    function test_depositWithdraw_staysSolvent() public {
        h.deposit(1, 5e18);
        h.depositCollateral(2, 5e18);
        _solvency();
        h.withdraw(1, 2e18);
        h.withdrawCollateral(2, 1e18);
        _solvency();
    }
}
