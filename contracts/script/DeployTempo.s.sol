// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script, console } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { InferenceBazaarSettlement } from "../src/InferenceBazaarSettlement.sol";
import { InferenceBazaarBSM } from "../src/InferenceBazaarBSM.sol";

/// @title DeployTempo
/// @notice Tempo (chain 42431) deploy of the inference-bazaar settlement spine + BSM, wired for the
///         live tnt-core 0.19 Tangle. This is the script used to bring inference-bazaar up on Tempo
///         (blueprint 7, service 2). It differs from `Deploy.s.sol` in two Tempo-specific ways:
///
///         1. The BSM is deployed **UNBOUND** — it does NOT call `bsm.onBlueprintCreated(...)`.
///            `onBlueprintCreated` is a one-shot binder; on a real Tangle chain the runtime binds it
///            during `cargo tangle blueprint deploy` / `createBlueprint`. Pre-binding it here makes
///            Tangle's createBlueprint revert with `AlreadyInitialized`. So we leave it unbound and
///            let cargo-tangle bind it to the real Tangle (`0xff137b9c879c47c28ce389e84501925438ab4cda`).
///            The blueprint owner then calls `bsm.setSettlement(settlement)` AFTER the bind
///            (a separate post-deploy step, not done here).
///
///         2. The payment token defaults to Tempo's predeployed **PathUSD** stablecoin
///            (`0x20c0000000000000000000000000000000000000`, 6-dec) instead of a MockUSD — Tempo's
///            faucet mints it, so no mock/duplicate is deployed.
///
///         Env:
///           PRIVATE_KEY     — deployer (the tnt-core Tempo admin/deployer)
///           PAYMENT_TOKEN   — override the USD token (default: PathUSD on Tempo)
///           FEE_RECIPIENT   — default: deployer
///           CREDIT_TTL / REDEMPTION_WINDOW / CHALLENGE_WINDOW / PENALTY_BPS / FEE_BPS — as Deploy.s.sol
///           REGISTER_BOOK   — "1" => register a single-attester book (deployer) for the attested path
///
///         Reconstructed from `Deploy.s.sol` + the recorded Tempo bring-up after the original working
///         copy was lost pre-commit; the live deploy it produced: settlement
///         `0x83084C8cD2282F6126e25089f0FD26b145eCa597`, BSM `0x6141DA46e2e19Af20d5f4932e4bE973319e40091`.
contract DeployTempo is Script {
    /// @dev Tempo's predeployed PathUSD stablecoin (6 decimals). Used as the settlement USD token.
    address internal constant TEMPO_PATH_USD = 0x20C0000000000000000000000000000000000000;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        vm.startBroadcast(deployerKey);

        address token = vm.envOr("PAYMENT_TOKEN", TEMPO_PATH_USD);
        console.log("Payment token (PathUSD on Tempo):", token);

        InferenceBazaarSettlement settlement = new InferenceBazaarSettlement(
            IERC20(token),
            uint64(vm.envOr("CREDIT_TTL", uint256(30 days))),
            uint64(vm.envOr("REDEMPTION_WINDOW", uint256(6 hours))),
            uint64(vm.envOr("CHALLENGE_WINDOW", uint256(1 hours))),
            uint16(vm.envOr("PENALTY_BPS", uint256(500))),
            uint16(vm.envOr("FEE_BPS", uint256(200))),
            vm.envOr("FEE_RECIPIENT", deployer)
        );
        console.log("InferenceBazaarSettlement:", address(settlement));

        // Deploy the BSM UNBOUND. Do NOT call onBlueprintCreated here — cargo-tangle binds it to the
        // Tangle during blueprint deploy; the owner calls setSettlement after the bind.
        InferenceBazaarBSM bsm = new InferenceBazaarBSM();
        console.log("InferenceBazaarBSM (unbound):", address(bsm));
        console.log("Next: cargo tangle blueprint deploy (binds BSM -> Tangle), then bsm.setSettlement(settlement)");

        // Register the initial single-attester book (deployer) so the attested batch path works,
        // matching how the base script bootstraps testnet.
        if (vm.envOr("REGISTER_BOOK", uint256(1)) == 1) {
            bytes32 bookId = vm.envOr("BOOK_ID", keccak256("inference-bazaar.book.0"));
            address[] memory attesters = new address[](1);
            attesters[0] = deployer;
            settlement.registerBook(bookId, attesters, uint16(1), 0, address(0));
            console.log("book registered:", vm.toString(bookId));
        }

        vm.stopBroadcast();
    }
}
