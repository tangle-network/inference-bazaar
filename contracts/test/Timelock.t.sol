// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { InferenceBazaarSettlement } from "../src/InferenceBazaarSettlement.sol";
import { MockUSD } from "../src/dev/Mocks.sol";

/// Audit C2: no single EOA can rotate attesters or set the SP1 verifier
/// instantly. The production deploy hands ownership to a TimelockController, so
/// every privileged call must be publicly scheduled and wait out the delay.
/// This pins the bootstrap the deploy script performs and the resulting
/// security properties, so a regression fails CI rather than mainnet.
contract TimelockTest is Test {
    InferenceBazaarSettlement settlement;
    TimelockController timelock;
    address admin = address(0x5AFE); // a Gnosis Safe in production
    address deployer = address(this);
    uint256 constant DELAY = 24 hours;
    bytes32 constant BOOK = bytes32(0);

    function setUp() public {
        vm.warp(1_000_000); // forge default block.timestamp is 1 == OZ _DONE_TIMESTAMP
        settlement = new InferenceBazaarSettlement(new MockUSD(), 30 days, 6 hours, 1 hours, 500, 200, deployer);
        // A book must exist before ownership moves (registerBook is owner-only).
        address[] memory atts = new address[](1);
        atts[0] = address(0xA11CE);
        settlement.registerBook(BOOK, atts, 1, 0, address(0));

        // Mirror Deploy.s.sol::_ownByTimelock: bootstrap with delay 0, accept,
        // raise the delay, drop the deployer from every role.
        address[] memory holders = new address[](2);
        holders[0] = admin;
        holders[1] = deployer;
        timelock = new TimelockController(0, holders, holders, deployer);
        settlement.transferOwnership(address(timelock));
        _exec(address(settlement), abi.encodeCall(settlement.acceptOwnership, ()));
        _exec(address(timelock), abi.encodeCall(timelock.updateDelay, (DELAY)));
        timelock.renounceRole(timelock.PROPOSER_ROLE(), deployer);
        timelock.renounceRole(timelock.EXECUTOR_ROLE(), deployer);
        timelock.renounceRole(timelock.CANCELLER_ROLE(), deployer);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), deployer);
    }

    function _exec(address target, bytes memory data) internal {
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), 0);
        timelock.execute(target, 0, data, bytes32(0), bytes32(0));
    }

    function test_ownershipIsTheTimelockWithProductionDelay() public view {
        assertEq(settlement.owner(), address(timelock), "owner is the timelock");
        assertEq(timelock.getMinDelay(), DELAY, "delay raised to production value");
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), deployer), "deployer admin renounced");
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), deployer), "deployer proposer renounced");
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), admin), "admin (Safe) is proposer");
    }

    function test_eoaCannotRotateAttestersDirectly() public {
        address[] memory atts = new address[](1);
        atts[0] = address(0xBEEF);
        // Neither the deployer nor the Safe is the OWNER — only the timelock is.
        vm.expectRevert();
        settlement.rotateAttesters(BOOK, atts, 1);
        vm.prank(admin);
        vm.expectRevert();
        settlement.rotateAttesters(BOOK, atts, 1);
    }

    function test_privilegedCallRequiresScheduleAndDelay() public {
        address[] memory atts = new address[](1);
        atts[0] = address(0xBEEF);
        bytes memory data = abi.encodeCall(settlement.rotateAttesters, (BOOK, atts, 1));

        vm.startPrank(admin);
        timelock.schedule(address(settlement), 0, data, bytes32(0), bytes32(uint256(1)), DELAY);
        // Executing before the delay must revert (TimelockUnexpectedOperationState).
        vm.expectRevert();
        timelock.execute(address(settlement), 0, data, bytes32(0), bytes32(uint256(1)));

        vm.warp(block.timestamp + DELAY + 1);
        timelock.execute(address(settlement), 0, data, bytes32(0), bytes32(uint256(1)));
        vm.stopPrank();

        address[] memory got = settlement.bookAttesters(BOOK);
        assertEq(got[0], address(0xBEEF), "rotation applied only after the delay, via the timelock");
    }
}
