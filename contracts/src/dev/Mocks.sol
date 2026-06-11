// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Dev/test payment token — open mint, 6 decimals like tsUSD. NEVER mainnet.
contract MockUSD is ERC20 {
    constructor() ERC20("tsUSD", "tsUSD") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Accepts every proof. Wiring tests only.
contract SP1MockVerifierAccept {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure { }
}

/// Asserts the exact public values the settlement contract must bind to —
/// proves the (domainSeparator, fillsHash) commitment end to end without a
/// real SP1 verifier. Prime with expect() before each settleBatchProven.
contract SP1MockVerifierStrict {
    bytes32 public expectedVKey;
    bytes public expectedPublicValues;

    function expect(bytes32 vkey, bytes calldata publicValues) external {
        expectedVKey = vkey;
        expectedPublicValues = publicValues;
    }

    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata) external view {
        require(programVKey == expectedVKey, "vkey");
        require(keccak256(publicValues) == keccak256(expectedPublicValues), "publicValues");
    }
}
