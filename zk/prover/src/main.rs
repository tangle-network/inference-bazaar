//! Prove (or just execute) a settlement batch.
//!
//! Input is the operator's outbox JSON (`GET /settlement/outbox`) or a bare
//! array of SignedFills. Output (groth16 mode) is proof.json with the three
//! fields `settleBatchProven` needs: vkey, publicValues, proofBytes.
//!
//!   prove --fills outbox.json --chain-id 3799 --contract 0x… \
//!         [--mode execute|groth16] [--out proof.json]
//!
//! SP1_PROVER=mock|cpu|cuda selects the prover backend (groth16 mode needs
//! docker for the gnark wrapper when run locally).

use anyhow::{bail, Context, Result};
use sp1_sdk::blocking::{ProveRequest, Prover, ProverClient};
use sp1_sdk::{include_elf, HashableKey, ProvingKey, SP1Stdin};
use surplus_batch_types::{ProgramInput, ProvenFill};
use surplus_settlement::SignedFill;
use surplus_settlement_core::alloy_primitives::{hex, Address};
use surplus_settlement_core::{batch_public_values, domain, fills_hash};

const ELF: sp1_sdk::Elf = include_elf!("surplus-batch-program");

struct Args {
    fills: String,
    chain_id: u64,
    contract: Address,
    mode: String,
    out: String,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        fills: String::new(),
        chain_id: 0,
        contract: Address::ZERO,
        mode: "execute".into(),
        out: "proof.json".into(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().context(format!("missing value for {flag}"));
        match flag.as_str() {
            "--fills" => args.fills = value()?,
            "--chain-id" => args.chain_id = value()?.parse()?,
            "--contract" => args.contract = value()?.parse()?,
            "--mode" => args.mode = value()?,
            "--out" => args.out = value()?,
            other => bail!("unknown flag {other}"),
        }
    }
    if args.fills.is_empty() || args.chain_id == 0 || args.contract == Address::ZERO {
        bail!("required: --fills <json> --chain-id <id> --contract <address>");
    }
    Ok(args)
}

fn load_fills(path: &str) -> Result<Vec<SignedFill>> {
    let raw = std::fs::read_to_string(path).with_context(|| format!("reading {path}"))?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    let fills = value.get("fills").cloned().unwrap_or(value);
    Ok(serde_json::from_value(fills)?)
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let signed = load_fills(&args.fills)?;
    if signed.is_empty() {
        bail!("no fills to prove");
    }

    let input = ProgramInput {
        chain_id: args.chain_id,
        verifying_contract: args.contract,
        fills: signed
            .iter()
            .map(|f| ProvenFill {
                buy: f.buy.order.clone(),
                buy_sig: f.buy.signature.clone(),
                sell: f.sell.order.clone(),
                sell_sig: f.sell.signature.clone(),
                qty_tokens: f.qty_tokens,
                exec_price_micro_per_m: f.exec_price_micro_per_m,
            })
            .collect(),
    };

    // What the program MUST commit, computed independently on the host.
    let dom = domain(args.chain_id, args.contract);
    let batch_fills: Vec<_> = signed.iter().map(SignedFill::batch_fill).collect();
    let expected = batch_public_values(dom.separator(), fills_hash(&batch_fills));

    let mut stdin = SP1Stdin::new();
    stdin.write(&input);
    let client = ProverClient::from_env();

    match args.mode.as_str() {
        "execute" => {
            let (public_values, report) = client.execute(ELF, stdin).run()?;
            anyhow::ensure!(
                public_values.as_slice() == expected.as_slice(),
                "program committed unexpected public values: got 0x{}, want 0x{}",
                hex::encode(public_values.as_slice()),
                hex::encode(&expected)
            );
            println!("execute ok: {} fills, {} cycles", signed.len(), report.total_instruction_count());
            println!("publicValues: {}", hex::encode_prefixed(public_values.as_slice()));
        }
        "groth16" => {
            let pk = client.setup(ELF)?;
            let proof = client.prove(&pk, stdin).groth16().run()?;
            client.verify(&proof, pk.verifying_key(), None)?;
            anyhow::ensure!(
                proof.public_values.as_slice() == expected.as_slice(),
                "proof committed unexpected public values"
            );
            let out = serde_json::json!({
                "vkey": pk.verifying_key().bytes32(),
                "publicValues": hex::encode_prefixed(proof.public_values.as_slice()),
                "proofBytes": hex::encode_prefixed(proof.bytes()),
                "fills": signed.len(),
            });
            std::fs::write(&args.out, serde_json::to_string_pretty(&out)?)?;
            println!("proof written to {}", args.out);
        }
        other => bail!("unknown mode {other} (execute|groth16)"),
    }
    Ok(())
}
