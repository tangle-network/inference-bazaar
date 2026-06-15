// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { SettlementTestBase } from "./Base.t.sol";
import { InferenceBazaarSettlement } from "../src/InferenceBazaarSettlement.sol";
import { InferenceBazaarBSM } from "../src/InferenceBazaarBSM.sol";

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
    InferenceBazaarBSM internal bsm;
    MockTangleCore internal tangle;
    address internal blueprintOwner = address(0x0117);
    uint64 internal constant SVC = 7;

    function setUp() public override {
        super.setUp();
        bsm = new InferenceBazaarBSM();
        tangle = new MockTangleCore();
        bsm.onBlueprintCreated(7, blueprintOwner, address(tangle));
        vm.prank(blueprintOwner);
        bsm.setSettlement(settlement);
        // The issuer (`seller`) is an operator of the service its lots belong to,
        // delivered via the fixed-membership path (approve -> initialize).
        initServiceWith(SVC, seller);
    }

    /// Bring up a service instance through the fixed-membership flow: one operator
    /// approves the request, then the instance initializes (requestId == SVC here).
    function initServiceWith(uint64 serviceId, address operator) internal {
        address[] memory callers = new address[](0);
        vm.startPrank(address(tangle));
        bsm.onApprove(operator, serviceId, 50);
        bsm.onServiceInitialized(7, serviceId, serviceId, blueprintOwner, callers, uint64(block.timestamp + 1 days));
        vm.stopPrank();
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
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarBSM.AlreadyChallenged.selector, defaultId));
        bsm.challengeDefault(7, defaultId);
    }

    function test_challengeUnknownDefaultReverts() public {
        vm.expectRevert();
        bsm.challengeDefault(7, 99);
    }

    function test_settlementSetOnce_byBlueprintOwnerOnly() public {
        InferenceBazaarBSM fresh = new InferenceBazaarBSM();
        fresh.onBlueprintCreated(7, blueprintOwner, address(tangle));
        vm.expectRevert();
        fresh.setSettlement(settlement); // not the blueprint owner
        vm.prank(blueprintOwner);
        fresh.setSettlement(settlement);
        vm.prank(blueprintOwner);
        vm.expectRevert(InferenceBazaarBSM.SettlementAlreadySet.selector);
        fresh.setSettlement(settlement);
    }

    // ── Membership: fixed (approve -> initialize) ────────────────────────────────

    function test_fixedMembership_frozenAtInit() public {
        // SVC was initialized with `seller` in setUp.
        assertTrue(bsm.isServiceActive(SVC));
        assertTrue(bsm.isServiceOperator(SVC, seller));
        assertEq(bsm.serviceOperatorCount(SVC), 1);
        assertEq(bsm.serviceOwnerOf(SVC), blueprintOwner);
    }

    function test_rejectedApprovalIsNotAMember() public {
        uint64 svc = 8;
        address[] memory callers = new address[](0);
        vm.startPrank(address(tangle));
        bsm.onApprove(seller, svc, 50);
        bsm.onApprove(buyer, svc, 50);
        bsm.onReject(buyer, svc); // buyer pulled out before init
        bsm.onServiceInitialized(7, svc, svc, blueprintOwner, callers, uint64(block.timestamp + 1 days));
        vm.stopPrank();
        assertTrue(bsm.isServiceOperator(svc, seller));
        assertFalse(bsm.isServiceOperator(svc, buyer));
        assertEq(bsm.serviceOperatorCount(svc), 1);
    }

    // ── Membership: dynamic (join / leave a running instance) ────────────────────

    function test_dynamicJoinAndLeave() public {
        address newOp = address(0xBEEF);
        assertFalse(bsm.isServiceOperator(SVC, newOp));

        vm.prank(address(tangle));
        bsm.onOperatorJoined(SVC, newOp, 750);
        assertTrue(bsm.isServiceOperator(SVC, newOp));
        assertEq(bsm.operatorExposureBps(SVC, newOp), 750);
        assertEq(bsm.serviceOperatorCount(SVC), 2);

        vm.prank(address(tangle));
        bsm.onOperatorLeft(SVC, newOp);
        assertFalse(bsm.isServiceOperator(SVC, newOp));
        assertEq(bsm.serviceOperatorCount(SVC), 1);
        // Exposure + a grace deadline are retained so a pre-exit default stays slashable.
        assertEq(bsm.operatorExposureBps(SVC, newOp), 750, "exposure retained as slash telemetry");
        assertGt(bsm.slashableUntil(SVC, newOp), block.timestamp);
    }

    function test_canJoinAndLeaveAreOpen() public view {
        assertTrue(bsm.canJoin(SVC, address(0xCAFE)));
        assertTrue(bsm.canLeave(SVC, seller));
    }

    function test_membershipHooksAreTangleOnly() public {
        vm.expectRevert();
        bsm.onOperatorJoined(SVC, address(0xBEEF), 1);
        vm.expectRevert();
        bsm.onServiceInitialized(7, 9, 9, blueprintOwner, new address[](0), 1);
    }

    // ── Slashing is gated on real membership ─────────────────────────────────────

    function test_challengeDefault_revertsForNonMemberService() public {
        uint256 defaultId = recordDefault();
        // Service 9 exists but `seller` (the defaulter) is not in it.
        initServiceWith(9, address(0xD00D));
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarBSM.NotServiceOperator.selector, uint64(9), seller));
        bsm.challengeDefault(9, defaultId);
    }

    function test_challengeDefault_stillWorksWithinGraceAfterTermination() public {
        uint256 defaultId = recordDefault();
        vm.prank(address(tangle));
        bsm.onServiceTermination(SVC, blueprintOwner);
        assertFalse(bsm.isServiceActive(SVC));
        assertFalse(bsm.isServiceOperator(SVC, seller));
        // Within the exit grace window the departed issuer is still slashable.
        uint64 slashId = bsm.challengeDefault(SVC, defaultId);
        assertEq(slashId, 1);
        assertEq(tangle.proposalCount(), 1);
    }

    function test_challengeDefault_revertsAfterGraceExpires() public {
        uint256 defaultId = recordDefault();
        vm.prank(address(tangle));
        bsm.onOperatorLeft(SVC, seller);
        vm.warp(block.timestamp + bsm.SLASH_GRACE_WINDOW() + 1);
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarBSM.NotServiceOperator.selector, SVC, seller));
        bsm.challengeDefault(SVC, defaultId);
    }

    function test_challengeDefault_worksAfterLeaveWithinGrace() public {
        uint256 defaultId = recordDefault();
        vm.prank(address(tangle));
        bsm.onOperatorLeft(SVC, seller);
        assertFalse(bsm.isServiceOperator(SVC, seller));
        uint64 slashId = bsm.challengeDefault(SVC, defaultId); // still in grace
        assertEq(slashId, 1);
        assertEq(bsm.slashToDefault(slashId), defaultId);
    }

    function test_resetChallenge_allowsReChallenge() public {
        uint256 defaultId = recordDefault();
        bsm.challengeDefault(SVC, defaultId);
        // A second challenge is blocked until governance clears the consumed one-shot.
        vm.expectRevert(abi.encodeWithSelector(InferenceBazaarBSM.AlreadyChallenged.selector, defaultId));
        bsm.challengeDefault(SVC, defaultId);
        vm.expectRevert(); // not the blueprint owner
        bsm.resetChallenge(defaultId);
        vm.prank(blueprintOwner);
        bsm.resetChallenge(defaultId);
        uint64 slashId = bsm.challengeDefault(SVC, defaultId);
        assertEq(slashId, 2, "re-challenge proposes a fresh slash");
    }

    function test_slashLifecycleHooksEmit() public {
        bytes memory offender = abi.encode(seller);
        vm.expectEmit(true, false, false, true, address(bsm));
        emit InferenceBazaarBSM.SlashWindowOpened(SVC, offender, 5);
        vm.prank(address(tangle));
        bsm.onUnappliedSlash(SVC, offender, 5);
        vm.expectEmit(true, false, false, true, address(bsm));
        emit InferenceBazaarBSM.SlashApplied(SVC, offender, 5);
        vm.prank(address(tangle));
        bsm.onSlash(SVC, offender, 5);
    }

    function test_onJobResult_emitsAttribution() public {
        vm.expectEmit(true, true, false, true, address(bsm));
        emit InferenceBazaarBSM.JobResulted(SVC, 30, 1, seller);
        vm.prank(address(tangle));
        bsm.onJobResult(SVC, 30, 1, seller, "", "");
    }
}
