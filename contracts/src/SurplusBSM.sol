// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { BlueprintServiceManagerBase } from "tnt-core/BlueprintServiceManagerBase.sol";
import { ITangleSlashing } from "tnt-core/interfaces/ITangleSlashing.sol";
import { SurplusSettlement } from "./SurplusSettlement.sol";

/// @title SurplusBSM — slashing-backed deterrence for redemption defaults.
///
/// Compensation is the settlement contract's job (defaults pay the holder from
/// issuer collateral); this BSM adds the restake consequence. A default recorded
/// on-chain by SurplusSettlement is objective evidence, so anyone may challenge:
/// the BSM — the blueprint's slashing origin (BlueprintServiceManagerBase
/// defaults querySlashingOrigin to address(this)) — proposes a slash against the
/// defaulting operator through the Tangle core, which then runs its dispute
/// window before permissionless execution against MultiAssetDelegation stake.
contract SurplusBSM is BlueprintServiceManagerBase {
    /// Restake slashed per redemption default, in basis points of exposed stake.
    uint16 public constant DEFAULT_SLASH_BPS = 500;

    SurplusSettlement public settlement;
    mapping(uint256 => bool) public defaultChallenged;

    event SettlementSet(address settlement);
    event DefaultChallenged(
        uint256 indexed defaultId, uint64 indexed serviceId, address indexed issuer, uint64 slashId
    );

    error SettlementAlreadySet();
    error SettlementNotSet();
    error AlreadyChallenged(uint256 defaultId);

    function setSettlement(SurplusSettlement _settlement) external onlyBlueprintOwner {
        if (address(settlement) != address(0)) revert SettlementAlreadySet();
        settlement = _settlement;
        emit SettlementSet(address(_settlement));
    }

    /// Permissionless: the default record is on-chain fact. One slash per default.
    function challengeDefault(uint64 serviceId, uint256 defaultId) external returns (uint64 slashId) {
        if (address(settlement) == address(0)) revert SettlementNotSet();
        if (defaultChallenged[defaultId]) revert AlreadyChallenged(defaultId);
        defaultChallenged[defaultId] = true;
        (address issuer, uint128 amountMicro, bytes32 redemptionId) = settlement.getDefault(defaultId);
        bytes32 evidence = keccak256(abi.encode("surplus_redemption_default", defaultId, issuer, amountMicro, redemptionId));
        slashId = ITangleSlashing(tangleCore).proposeSlash(serviceId, issuer, DEFAULT_SLASH_BPS, evidence);
        emit DefaultChallenged(defaultId, serviceId, issuer, slashId);
    }
}
