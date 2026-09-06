# Inference Bazaar

For architecture, read [ARCHITECTURE.md](ARCHITECTURE.md) and [BLUEPRINT.md](BLUEPRINT.md).
For deployment, read [OPERATOR_ONBOARDING.md](docs/OPERATOR_ONBOARDING.md) and [testnet-release.md](docs/testnet-release.md).
Use current deployment records for networks, addresses, credentials, and running artifacts.

## Operator lifecycle

Deploy the off-chain Blueprint Manager daemon for production lifecycle management.
The operator registers, a user requests service, operators approve, and the manager starts the assigned service instance.
[operator/src/bin/blueprint.rs](operator/src/bin/blueprint.rs) is that managed instance, not a substitute daemon.
Do not bypass this lifecycle by launching an operator with a hardcoded service ID or test mode.
The on-chain Blueprint Service Manager contract owns lifecycle hooks and slashing; it is distinct from the daemon.
Read the installed manager's command help and maintained deployment scripts before choosing flags.

## Backend and verification

[venue.rs](operator/src/venue.rs) rejects router-mode inference for a bonded issuer.
An explicit external inference backend must satisfy the configured endpoint and authorization contract; a router fallback is insufficient.
Check current configuration before claiming which network or inference service the operator uses.
Use [Cargo.toml](Cargo.toml), the toolchain file, and CI for build requirements and checks.
Blueprint-feature builds require a working `protoc`; resolve its installed path instead of assuming a host-specific location.
