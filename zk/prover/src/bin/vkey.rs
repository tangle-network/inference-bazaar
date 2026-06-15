//! Print the batch program's verification key for
//! `InferenceBazaarSettlement.setSp1Verifier(verifier, vkey)`.
//! `bytes32()` already returns a 0x-prefixed string — printed as-is (do NOT
//! hex-encode it again).

use sp1_sdk::blocking::{Prover, ProverClient};
use sp1_sdk::{include_elf, HashableKey, ProvingKey};

const ELF: sp1_sdk::Elf = include_elf!("inference-bazaar-batch-program");

fn main() -> anyhow::Result<()> {
    let client = ProverClient::from_env();
    let pk = client.setup(ELF)?;
    println!("{}", pk.verifying_key().bytes32());
    Ok(())
}
