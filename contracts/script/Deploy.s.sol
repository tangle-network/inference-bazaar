// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script, console } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
///                     Use a TimelockController + multisig in production so no
///                     single EOA can rotate attesters / set the SP1 verifier.
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
            require(block.chainid == 31337, "dev verifier only on anvil");
            SP1MockVerifierStrict verifier = new SP1MockVerifierStrict();
            console.log("SP1MockVerifierStrict:", address(verifier));
        }

        address owner = vm.envOr("OWNER", address(0));
        if (owner != address(0) && owner != deployer) {
            settlement.transferOwnership(owner);
            console.log("ownership transfer initiated to:", owner);
        }

        vm.stopBroadcast();
    }
}
