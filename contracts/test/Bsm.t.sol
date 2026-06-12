// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { SettlementTestBase } from "./Base.t.sol";
import { SurplusSettlement } from "../src/SurplusSettlement.sol";
import { SurplusBSM } from "../src/SurplusBSM.sol";

contract MockTangleCore {
    uint64 public nextSlashId = 1;

    struct Proposed {
        uint64 serviceId;
        address operator;
        uint16 slashBps;
        bytes32 evidence;
    }

    Proposed[] public proposals;

    function proposeSlash(
        uint64 serviceId,
        address operator,
        uint16 slashBps,
        bytes32 evidence
    )
        external
        returns (uint64 slashId)
    {
        proposals.push(Proposed(serviceId, operator, slashBps, evidence));
        return nextSlashId++;
    }

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }
}

contract BsmTest is SettlementTestBase {
    SurplusBSM internal bsm;
    MockTangleCore internal tangle;
    address internal blueprintOwner = address(0x0117);

    function setUp() public override {
        super.setUp();
        bsm = new SurplusBSM();
        tangle = new MockTangleCore();
        bsm.onBlueprintCreated(7, blueprintOwner, address(tangle));
        vm.prank(blueprintOwner);
        bsm.setSettlement(settlement);
    }

    function recordDefault() internal returns (uint256 defaultId) {
        bytes32 lotId = settleStandardFill();
        vm.prank(buyer);
        bytes32 id = settlement.requestRedemption(lotId, 50_000);
        vm.warp(block.timestamp + REDEMPTION_WINDOW + 1);
        settlement.claimDefault(id);
        return settlement.defaultsCount() - 1;
    }

    function test_bsmIsItsOwnSlashingOrigin() public view {
        assertEq(bsm.querySlashingOrigin(7), address(bsm));
    }

    function test_challengeDefault_proposesSlashOnTangle() public {
        uint256 defaultId = recordDefault();
        uint64 slashId = bsm.challengeDefault(7, defaultId);
        assertEq(slashId, 1);
        assertEq(tangle.proposalCount(), 1);
        (uint64 serviceId, address operator, uint16 slashBps,) = tangle.proposals(0);
        assertEq(serviceId, 7);
        assertEq(operator, seller, "defaulting issuer is the slash target");
        assertEq(slashBps, bsm.DEFAULT_SLASH_BPS());
    }

    function test_doubleChallengeReverts() public {
        uint256 defaultId = recordDefault();
        bsm.challengeDefault(7, defaultId);
        vm.expectRevert(abi.encodeWithSelector(SurplusBSM.AlreadyChallenged.selector, defaultId));
        bsm.challengeDefault(7, defaultId);
    }

    function test_challengeUnknownDefaultReverts() public {
        vm.expectRevert();
        bsm.challengeDefault(7, 99);
    }

    function test_settlementSetOnce_byBlueprintOwnerOnly() public {
        SurplusBSM fresh = new SurplusBSM();
        fresh.onBlueprintCreated(7, blueprintOwner, address(tangle));
        vm.expectRevert();
        fresh.setSettlement(settlement); // not the blueprint owner
        vm.prank(blueprintOwner);
        fresh.setSettlement(settlement);
        vm.prank(blueprintOwner);
        vm.expectRevert(SurplusBSM.SettlementAlreadySet.selector);
        fresh.setSettlement(settlement);
    }
}
