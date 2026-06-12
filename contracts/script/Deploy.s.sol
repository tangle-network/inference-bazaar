// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script, console } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { SurplusSettlement } from "../src/SurplusSettlement.sol";
import { SurplusBSM } from "../src/SurplusBSM.sol";
import { MockUSD, SP1MockVerifierStrict } from "../src/dev/Mocks.sol";

/// Deploys the settlement spine.
///
/// Env:
///   PAYMENT_TOKEN   — existing tsUSD address; unset => deploy MockUSD (dev)
///   FEE_RECIPIENT   — default: deployer
///   CREDIT_TTL      — default 30 days
///   REDEMPTION_WINDOW — default 6 hours
///   PENALTY_BPS     — default 500 (5%)
///   FEE_BPS         — default 200 (2%)
///   OWNER           — if set and != deployer, ownership is transferred to it
///                     (Ownable2Step: the new owner must acceptOwnership()).
///   USE_TIMELOCK    — "1" => deploy a TimelockController and make IT the owner,
///                     born by construction (audit C2: no single EOA can rotate
///                     attesters / set the SP1 verifier instantly — every
///                     privileged call must be publicly scheduled and wait out
///                     TIMELOCK_DELAY). Bootstraps the Ownable2Step accept and
///                     the delay inline, then renounces the deployer's admin so
///                     the timelock is self-secured.
///   TIMELOCK_DELAY  — seconds (default 86400 = 24h); the public reaction window.
///   TIMELOCK_ADMIN  — the proposer/executor: a Gnosis Safe (multisig) in
///                     production; defaults to the deployer for dev/testnet.
///   DEPLOY_DEV_VERIFIER — "1" => deploy SP1MockVerifierStrict. HARD-GATED to
///                     anvil (chainid 31337): a mock verifier whose expect() is
///                     permissionless must never sit on a chain that holds value.
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        vm.startBroadcast(deployerKey);

        address token = vm.envOr("PAYMENT_TOKEN", address(0));
        if (token == address(0)) {
            token = address(new MockUSD());
            console.log("MockUSD:", token);
        }

        SurplusSettlement settlement = new SurplusSettlement(
            IERC20(token),
            uint64(vm.envOr("CREDIT_TTL", uint256(30 days))),
            uint64(vm.envOr("REDEMPTION_WINDOW", uint256(6 hours))),
            uint16(vm.envOr("PENALTY_BPS", uint256(500))),
            uint16(vm.envOr("FEE_BPS", uint256(200))),
            vm.envOr("FEE_RECIPIENT", deployer)
        );
        console.log("SurplusSettlement:", address(settlement));

        SurplusBSM bsm = new SurplusBSM();
        console.log("SurplusBSM:", address(bsm));

        if (vm.envOr("DEPLOY_DEV_VERIFIER", uint256(0)) == 1) {
            require(block.chainid == 31_337, "dev verifier only on anvil");
            SP1MockVerifierStrict verifier = new SP1MockVerifierStrict();
            console.log("SP1MockVerifierStrict:", address(verifier));
        }

        if (vm.envOr("USE_TIMELOCK", uint256(0)) == 1) {
            _ownByTimelock(settlement, deployer);
        } else {
            address owner = vm.envOr("OWNER", address(0));
            if (owner != address(0) && owner != deployer) {
                settlement.transferOwnership(owner);
                console.log("ownership transfer initiated to:", owner);
            }
        }

        vm.stopBroadcast();
    }

    /// Hand ownership to a fresh TimelockController, fully bootstrapped so the
    /// contract is born owned-by-timelock with the production delay. The admin
    /// (a multisig in prod) is the sole proposer + executor; the deployer's
    /// bootstrap admin role is renounced at the end, so from that block forward
    /// every owner action goes schedule -> wait TIMELOCK_DELAY -> execute, with
    /// no EOA shortcut and no way to shorten the delay except through the
    /// timelock itself.
    function _ownByTimelock(SurplusSettlement settlement, address deployer) internal {
        uint256 delay = vm.envOr("TIMELOCK_DELAY", uint256(24 hours));
        address admin = vm.envOr("TIMELOCK_ADMIN", deployer);

        // Bootstrap with delay 0 and the deployer as a temporary admin so the
        // accept + delay-raise land in this same deploy; the real proposer/
        // executor is `admin`.
        address[] memory roleHolders = new address[](2);
        roleHolders[0] = admin;
        roleHolders[1] = deployer;
        TimelockController timelock = new TimelockController(0, roleHolders, roleHolders, deployer);
        console.log("TimelockController:", address(timelock));

        settlement.transferOwnership(address(timelock));
        _exec(timelock, address(settlement), abi.encodeCall(settlement.acceptOwnership, ()));
        require(settlement.owner() == address(timelock), "timelock did not accept ownership");

        // Raise the delay to the production value and drop the deployer from
        // every role, leaving only `admin` as proposer/executor and the
        // timelock as its own administrator.
        _exec(timelock, address(timelock), abi.encodeCall(timelock.updateDelay, (delay)));
        bytes32 PROPOSER = timelock.PROPOSER_ROLE();
        bytes32 EXECUTOR = timelock.EXECUTOR_ROLE();
        bytes32 CANCELLER = timelock.CANCELLER_ROLE();
        bytes32 ADMIN = timelock.DEFAULT_ADMIN_ROLE();
        if (deployer != admin) {
            timelock.renounceRole(PROPOSER, deployer);
            timelock.renounceRole(EXECUTOR, deployer);
            timelock.renounceRole(CANCELLER, deployer);
        }
        timelock.renounceRole(ADMIN, deployer);
        console.log("owner is TimelockController; delay (s):", delay);
        console.log("timelock proposer/executor:", admin);
    }

    /// Schedule + immediately execute a call through a delay-0 timelock (used
    /// only during the bootstrap, before the delay is raised).
    function _exec(TimelockController timelock, address target, bytes memory data) internal {
        timelock.schedule(target, 0, data, bytes32(0), bytes32(0), 0);
        timelock.execute(target, 0, data, bytes32(0), bytes32(0));
    }
}
