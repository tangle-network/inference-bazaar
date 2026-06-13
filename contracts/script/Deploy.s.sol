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
///   CHALLENGE_WINDOW  — default 1 hour (holder window to contest an attestation)
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
            uint64(vm.envOr("CHALLENGE_WINDOW", uint256(1 hours))),
            uint16(vm.envOr("PENALTY_BPS", uint256(500))),
            uint16(vm.envOr("FEE_BPS", uint256(200))),
            vm.envOr("FEE_RECIPIENT", deployer)
        );
        console.log("SurplusSettlement:", address(settlement));

        SurplusBSM bsm = new SurplusBSM();
        console.log("SurplusBSM:", address(bsm));

        // Wire the manager so it is functional from block 0. In a Tangle
        // production deploy the runtime deploys + bootstraps the manager
        // (onBlueprintCreated) and the owner then calls setSettlement; this
        // mirrors that bootstrap for standalone/local/testnet deploys, where no
        // Tangle pallet is present to do it. onBlueprintCreated is a one-shot
        // binder with no caller gate, so the deployer can perform it here.
        uint64 blueprintId = uint64(vm.envOr("BLUEPRINT_ID", uint256(0)));
        address tangleCore = vm.envOr("TANGLE_CORE", deployer);
        bsm.onBlueprintCreated(blueprintId, deployer, tangleCore);
        bsm.setSettlement(settlement);
        console.log("SurplusBSM wired -> settlement; tangleCore:", tangleCore);

        // SP1 proven path: wire the verifier + the guest program's vkey so
        // settleBatchProven is live. On anvil with DEPLOY_DEV_VERIFIER, use the
        // strict mock. On real chains the owner supplies the SP1VerifierGateway
        // address + vkey via env (SP1_VERIFIER + SP1_VKEY); absent that the proven
        // path stays disabled (sp1Verifier == 0) until governance wires it.
        address sp1Verifier = vm.envOr("SP1_VERIFIER", address(0));
        bytes32 sp1Vkey = vm.envOr("SP1_VKEY", bytes32(0));
        if (vm.envOr("DEPLOY_DEV_VERIFIER", uint256(0)) == 1) {
            require(block.chainid == 31_337, "dev verifier only on anvil");
            sp1Verifier = address(new SP1MockVerifierStrict());
            console.log("SP1MockVerifierStrict:", sp1Verifier);
        }
        if (sp1Verifier != address(0)) {
            settlement.setSp1Verifier(sp1Verifier, sp1Vkey);
            console.log("SP1 verifier wired:", sp1Verifier);
        }

        // Register the initial settlement book (attester quorum) so the attested
        // AND proven batch paths work from block 0. Production governance registers
        // the real quorum post-deploy via the timelock; for dev/testnet (or when
        // REGISTER_BOOK=1) register a single-attester book owned by the deployer.
        if (vm.envOr("REGISTER_BOOK", uint256(0)) == 1 || block.chainid == 31_337) {
            bytes32 bookId = vm.envOr("BOOK_ID", keccak256("surplus.book.0"));
            address[] memory defaultAtt = new address[](1);
            defaultAtt[0] = deployer;
            address[] memory attesters = vm.envOr("BOOK_ATTESTERS", ",", defaultAtt);
            uint16 threshold = uint16(vm.envOr("BOOK_THRESHOLD", uint256(1)));
            settlement.registerBook(bookId, attesters, threshold, 0, address(0));
            console.log("book registered:", vm.toString(bookId));
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
