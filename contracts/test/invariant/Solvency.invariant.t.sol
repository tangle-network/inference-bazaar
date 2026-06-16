// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { InferenceBazaarSettlement } from "../../src/InferenceBazaarSettlement.sol";
import { MockUSD } from "../../src/dev/Mocks.sol";
import { SettlementHandler } from "./SettlementHandler.sol";

/// Audit H8: the accounting was traced by hand; this proves it across thousands
/// of random deposit/fill/redeem/default/reclaim/spend sequences.
///
/// The iron property is SOLVENCY: the contract's payment-token balance always
/// equals exactly what it owes — every account's free cash plus every issuer's
/// bonded collateral. No sequence can make the contract hold less than it owes
/// (insolvency) or strand tokens it can't account for. Paired with
/// REFUNDABILITY (collateral >= liability per issuer), this is the core
/// guarantee the whole credit model rests on.
contract SolvencyInvariant is Test {
    MockUSD usd;
    InferenceBazaarSettlement settlement;
    SettlementHandler handler;
    address feeRecipient = address(0xFEE);
    bytes32 constant BOOK = keccak256("inv-book");

    function setUp() public {
        usd = new MockUSD();
        settlement =
            new InferenceBazaarSettlement(IERC20(address(usd)), 30 days, 6 hours, 1 hours, 500, 200, feeRecipient);
        // A registered book so the attested path exists (the handler uses the
        // trustless fill path, but registration keeps the surface realistic).
        address[] memory atts = new address[](1);
        atts[0] = address(0xA11CE);
        settlement.registerBook(BOOK, atts, 1, 0, address(0));

        handler = new SettlementHandler(settlement, usd, BOOK, feeRecipient);
        targetContract(address(handler));

        // Only the handler mutates; it owns the actor keys and signing.
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.withdraw.selector;
        selectors[2] = handler.depositCollateral.selector;
        selectors[3] = handler.withdrawCollateral.selector;
        selectors[4] = handler.settleFill.selector;
        selectors[5] = handler.requestAndSettleRedemption.selector;
        selectors[6] = handler.spend.selector;
        selectors[7] = handler.defaultOrReclaim.selector;
        selectors[8] = handler.warp.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
    }

    /// The contract holds exactly what it owes: token balance == Σbalances + Σcollateral.
    function invariant_solvency() public view {
        address[4] memory actors = handler.actorsAll();
        uint256 owed;
        for (uint256 i = 0; i < 4; i++) {
            owed += settlement.balances(actors[i]) + settlement.collateral(actors[i]);
        }
        assertEq(usd.balanceOf(address(settlement)), owed, "contract token balance != cash + collateral it owes");
    }

    /// Every issuer can always refund what it owes: collateral >= liability. The
    /// 5% penalty buffer minted in is exactly consumed by worst-case defaults,
    /// never overdrawn.
    function invariant_refundability() public view {
        address[4] memory actors = handler.actorsAll();
        for (uint256 i = 0; i < 4; i++) {
            assertGe(
                settlement.collateral(actors[i]),
                settlement.liability(actors[i]),
                "issuer collateral below its outstanding liability"
            );
        }
    }

    /// Cross-check: net tokens held == everything pulled in minus everything paid
    /// out. Catches any path that mints/burns the payment token off-book.
    function invariant_conservation() public view {
        assertEq(
            usd.balanceOf(address(settlement)),
            handler.ghostDeposited() - handler.ghostWithdrawn(),
            "token balance != deposited - withdrawn"
        );
    }
}
