// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Canonical SP1 verifier interface (succinctlabs/sp1-contracts). On live
/// networks this is the SP1VerifierGateway, which routes by the proof's leading
/// 4-byte verifier selector to the circuit-version-matched verifier.
interface ISP1Verifier {
    /// @param programVKey The verification key for the RISC-V program.
    /// @param publicValues The public values encoded as bytes.
    /// @param proofBytes The proof of the program execution.
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}
