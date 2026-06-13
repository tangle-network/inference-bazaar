// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { BlueprintServiceManagerBase } from "tnt-core/BlueprintServiceManagerBase.sol";
import { ITangleSlashing } from "tnt-core/interfaces/ITangleSlashing.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { SurplusSettlement } from "./SurplusSettlement.sol";

/// @title SurplusBSM — the Surplus blueprint's on-chain manager.
///
/// Two jobs:
///
///  1. MEMBERSHIP. The manager tracks, per service instance, the operator set and
///     each operator's stake exposure. This is populated the same way regardless
///     of the instance's membership model, so BOTH are first-class:
///       - fixed:   operators approve a request (`onApprove`); the set is frozen
///                  when the instance initializes (`onServiceInitialized`).
///       - dynamic: same initialization, plus `onOperatorJoined`/`onOperatorLeft`
///                  mutate the live set as operators churn.
///     The manager never blocks a join/leave (the Tangle core enforces stake and
///     timing) — it records, so the rest of the system has an authoritative set.
///
///  2. SLASHING. Compensation is the settlement contract's job (a redemption
///     default pays the holder from issuer collateral); this manager adds the
///     restake consequence. A default recorded on-chain by SurplusSettlement is
///     objective evidence, so `challengeDefault` is permissionless — but it can
///     only target an operator that is actually a member of the named service.
///     The manager is the blueprint's slashing origin (the base defaults
///     `querySlashingOrigin` to `address(this)`); it proposes the slash through
///     the Tangle core, which runs its dispute window before permissionless
///     execution against MultiAssetDelegation stake.
///
/// Job hooks (`onJobCall`/`onJobResult`) accept by default (as the base does) and
/// emit attribution events: the on-chain jobs are market-making control/telemetry
/// (list instrument, status, tick), not value transfer, so the manager records
/// who produced what rather than adjudicating results on-chain.
contract SurplusBSM is BlueprintServiceManagerBase {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// Restake slashed per redemption default, in basis points of exposed stake.
    uint16 public constant DEFAULT_SLASH_BPS = 500;
    /// After an operator leaves, their stake is still exposed through the exit
    /// queue, so a default they caused stays slashable for this long past their
    /// exit — closing the "leave between default and challenge" dodge. Matches the
    /// protocol's default exitQueueDuration (BlueprintServiceManagerBase: 7 days).
    uint64 public constant SLASH_GRACE_WINDOW = 7 days;

    SurplusSettlement public settlement;
    mapping(uint256 => bool) public defaultChallenged;
    /// slashId (from proposeSlash) => the defaultId it was raised for — lets
    /// governance map a disputed/cancelled core slash back to its challenge.
    mapping(uint64 => uint256) public slashToDefault;
    /// serviceId => operator => unix time until which a departed operator remains
    /// slashable (set on leave/termination; current members are always slashable).
    mapping(uint64 => mapping(address => uint64)) public slashableUntil;

    /// One service instance's membership. The EnumerableSet lets us both check
    /// membership in O(1) (slashing guard) and enumerate it (off-chain projection
    /// of the attester quorum). Lives in a struct-in-mapping, same pattern the
    /// base uses for permitted assets.
    struct Service {
        bool active;
        address owner;
        EnumerableSet.AddressSet operators;
    }

    mapping(uint64 => Service) private _services; // serviceId => membership
    /// requestId => operators that approved, before the instance initializes.
    mapping(uint64 => EnumerableSet.AddressSet) private _pendingApprovals;
    /// serviceId => operator => stake exposure (bps), as reported on join.
    mapping(uint64 => mapping(address => uint16)) public operatorExposureBps;

    event SettlementSet(address settlement);
    event OperatorRegistered(address indexed operator, bytes registrationInputs);
    event OperatorApproved(uint64 indexed requestId, address indexed operator, uint8 restakingPercent);
    event OperatorRejected(uint64 indexed requestId, address indexed operator);
    event ServiceInitialized(
        uint64 indexed serviceId, uint64 indexed requestId, address indexed owner, uint256 operatorCount
    );
    event ServiceTerminated(uint64 indexed serviceId);
    event OperatorJoined(uint64 indexed serviceId, address indexed operator, uint16 exposureBps);
    event OperatorLeft(uint64 indexed serviceId, address indexed operator);
    event JobCalled(uint64 indexed serviceId, uint8 indexed job, uint64 jobCallId);
    event JobResulted(uint64 indexed serviceId, uint8 indexed job, uint64 jobCallId, address indexed operator);
    event DefaultChallenged(
        uint256 indexed defaultId, uint64 indexed serviceId, address indexed issuer, uint64 slashId, uint16 exposureBps
    );
    /// The Tangle core opened the dispute window on a slash (queued, not applied).
    event SlashWindowOpened(uint64 indexed serviceId, bytes offender, uint8 slashPercent);
    /// The Tangle core finalized and applied a slash.
    event SlashApplied(uint64 indexed serviceId, bytes offender, uint8 slashPercent);
    /// Governance cleared a consumed challenge so its default can be re-challenged.
    event ChallengeReset(uint256 indexed defaultId);

    error SettlementAlreadySet();
    error SettlementNotSet();
    error AlreadyChallenged(uint256 defaultId);
    error NotServiceOperator(uint64 serviceId, address operator);

    function setSettlement(SurplusSettlement _settlement) external onlyBlueprintOwner {
        if (address(settlement) != address(0)) revert SettlementAlreadySet();
        settlement = _settlement;
        emit SettlementSet(address(_settlement));
    }

    // ═══════════════════════════════ Operator lifecycle ══════════════════════════

    function onRegister(address operator, bytes calldata registrationInputs) external payable override onlyFromTangle {
        emit OperatorRegistered(operator, registrationInputs);
    }

    // ═══════════════════════════ Service request → init ══════════════════════════

    /// An operator accepted a pending service request. Stage them until the
    /// instance initializes, so a fixed-membership set is exactly the approvers.
    function onApprove(
        address operator,
        uint64 requestId,
        uint8 restakingPercent
    )
        external
        payable
        override
        onlyFromTangle
    {
        _pendingApprovals[requestId].add(operator);
        emit OperatorApproved(requestId, operator, restakingPercent);
    }

    function onReject(address operator, uint64 requestId) external override onlyFromTangle {
        _pendingApprovals[requestId].remove(operator);
        emit OperatorRejected(requestId, operator);
    }

    /// The instance is live: freeze the approved set as its initial membership.
    /// (Dynamic instances then mutate it via onOperatorJoined/onOperatorLeft.)
    function onServiceInitialized(
        uint64, // blueprintId
        uint64 requestId,
        uint64 serviceId,
        address owner,
        address[] calldata, // permittedCallers
        uint64 // ttl
    )
        external
        override
        onlyFromTangle
    {
        Service storage s = _services[serviceId];
        s.active = true;
        s.owner = owner;
        EnumerableSet.AddressSet storage approved = _pendingApprovals[requestId];
        uint256 n = approved.length();
        for (uint256 i = 0; i < n; i++) {
            s.operators.add(approved.at(i));
        }
        // Drain the staging set — swap-and-pop, so always remove index 0.
        while (approved.length() > 0) {
            approved.remove(approved.at(0));
        }
        emit ServiceInitialized(serviceId, requestId, owner, s.operators.length());
    }

    function onServiceTermination(
        uint64 serviceId,
        address /*owner*/
    )
        external
        override
        onlyFromTangle
    {
        Service storage s = _services[serviceId];
        s.active = false;
        uint64 until = uint64(block.timestamp) + SLASH_GRACE_WINDOW;
        while (s.operators.length() > 0) {
            address op = s.operators.at(0);
            s.operators.remove(op);
            // Keep them slashable through the exit window; exposure stays as the
            // slash-context telemetry until then.
            slashableUntil[serviceId][op] = until;
        }
        emit ServiceTerminated(serviceId);
    }

    // ═══════════════════════════════ Dynamic membership ══════════════════════════

    /// Never block a join — the Tangle core enforces stake/eligibility; we record.
    function canJoin(uint64, address) external view override returns (bool) {
        return true;
    }

    function onOperatorJoined(uint64 serviceId, address operator, uint16 exposureBps) external override onlyFromTangle {
        _services[serviceId].operators.add(operator);
        operatorExposureBps[serviceId][operator] = exposureBps;
        emit OperatorJoined(serviceId, operator, exposureBps);
    }

    /// Leaving is always allowed: a departing operator's outstanding credit lots
    /// stay collateral-backed in the settlement contract (freeCollateral can't be
    /// withdrawn below outstanding liability), so holders are never stranded.
    function canLeave(uint64, address) external view override returns (bool) {
        return true;
    }

    function onOperatorLeft(uint64 serviceId, address operator) external override onlyFromTangle {
        _services[serviceId].operators.remove(operator);
        // Stay slashable through the exit window — a default caused before leaving
        // must remain challengeable. Exposure is retained as slash-context telemetry.
        slashableUntil[serviceId][operator] = uint64(block.timestamp) + SLASH_GRACE_WINDOW;
        emit OperatorLeft(serviceId, operator);
    }

    // ═══════════════════════════════ Job observability ═══════════════════════════

    function onJobCall(
        uint64 serviceId,
        uint8 job,
        uint64 jobCallId,
        bytes calldata /*inputs*/
    )
        external
        payable
        override
        onlyFromTangle
    {
        emit JobCalled(serviceId, job, jobCallId);
    }

    function onJobResult(
        uint64 serviceId,
        uint8 job,
        uint64 jobCallId,
        address operator,
        bytes calldata, // inputs
        bytes calldata // outputs
    )
        external
        payable
        override
        onlyFromTangle
    {
        emit JobResulted(serviceId, job, jobCallId, operator);
    }

    // ═══════════════════════════════════ Slashing ════════════════════════════════

    /// Permissionless: the default record is on-chain fact. One slash per default,
    /// and only against an operator that belongs (or recently belonged, within the
    /// exit grace window) to `serviceId` — so a caller cannot point a default's
    /// slash at an address outside the service, and an operator cannot dodge it by
    /// leaving between the default and the challenge.
    function challengeDefault(uint64 serviceId, uint256 defaultId) external returns (uint64 slashId) {
        if (address(settlement) == address(0)) revert SettlementNotSet();
        if (defaultChallenged[defaultId]) revert AlreadyChallenged(defaultId);
        (address issuer, uint128 amountMicro, bytes32 redemptionId) = settlement.getDefault(defaultId);
        bool member = _services[serviceId].operators.contains(issuer);
        bool inGrace = block.timestamp <= slashableUntil[serviceId][issuer];
        if (!member && !inGrace) revert NotServiceOperator(serviceId, issuer);
        defaultChallenged[defaultId] = true;
        bytes32 evidence =
            keccak256(abi.encode("surplus_redemption_default", defaultId, issuer, amountMicro, redemptionId));
        slashId = ITangleSlashing(tangleCore).proposeSlash(serviceId, issuer, DEFAULT_SLASH_BPS, evidence);
        slashToDefault[slashId] = defaultId;
        emit DefaultChallenged(defaultId, serviceId, issuer, slashId, operatorExposureBps[serviceId][issuer]);
    }

    /// Slash-lifecycle attribution: the Tangle core opens a dispute window, then
    /// either applies or (off-hook) cancels the slash. We record both so off-chain
    /// watchers can reconcile a default-slash with its outcome. `offender` is the
    /// core's operator encoding, emitted raw to avoid assuming its layout.
    function onUnappliedSlash(
        uint64 serviceId,
        bytes calldata offender,
        uint8 slashPercent
    )
        external
        override
        onlyFromTangle
    {
        emit SlashWindowOpened(serviceId, offender, slashPercent);
    }

    function onSlash(uint64 serviceId, bytes calldata offender, uint8 slashPercent) external override onlyFromTangle {
        emit SlashApplied(serviceId, offender, slashPercent);
    }

    /// Governance recovery: the core has no manager hook for a cancelled/disputed
    /// slash, so a challenge whose proposal was thrown out would otherwise stay
    /// permanently consumed. The blueprint owner can clear it to allow a re-challenge.
    function resetChallenge(uint256 defaultId) external onlyBlueprintOwner {
        defaultChallenged[defaultId] = false;
        emit ChallengeReset(defaultId);
    }

    // ═══════════════════════════════════ Views ═══════════════════════════════════

    function isServiceActive(uint64 serviceId) external view returns (bool) {
        return _services[serviceId].active;
    }

    function serviceOwnerOf(uint64 serviceId) external view returns (address) {
        return _services[serviceId].owner;
    }

    function isServiceOperator(uint64 serviceId, address operator) external view returns (bool) {
        return _services[serviceId].operators.contains(operator);
    }

    function serviceOperators(uint64 serviceId) external view returns (address[] memory) {
        return _services[serviceId].operators.values();
    }

    function serviceOperatorCount(uint64 serviceId) external view returns (uint256) {
        return _services[serviceId].operators.length();
    }
}
