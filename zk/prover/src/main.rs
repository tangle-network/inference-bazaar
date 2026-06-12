//! Prove (or just execute) a settlement batch — the match-in-circuit proven path.
//!
//! Input is the gossiped epoch ORDER SET for one instrument (a JSON array of
//! signed orders, or `{ "orders": [...] }`). The guest verifies every signature,
//! runs `match_epoch` over the set, and commits
//! `(domainSeparator, bookId, batchNonce, ordersCommitment, fillsHash)`. The host
//! runs the same match to compute the expected public values AND the `BatchFill[]`
//! calldata `settleBatchProven` needs.
//!
//!   prove --orders set.json --instrument anthropic/claude-opus-4-8:output \
//!         --tick 1 --min-qty 1 --chain-id 3799 --contract 0x… \
//!         --book-id 0x… [--batch-nonce N] [--mode execute|groth16] [--out proof.json]
//!
//! SP1_PROVER=mock|cpu|cuda selects the prover backend (groth16 mode needs
//! docker for the gnark wrapper when run locally).

use anyhow::{bail, Context, Result};
use sp1_sdk::blocking::{ProveRequest, Prover, ProverClient};
use sp1_sdk::{include_elf, HashableKey, ProvingKey, SP1Stdin};
use surplus_batch_types::{ProgramInput, ProvenOrder};
use surplus_matcher::{match_epoch, orders_commitment};
use surplus_settlement::SignedOrder;
use surplus_settlement_core::alloy_primitives::{hex, Address, B256};
use surplus_settlement_core::{batch_public_values, domain};

const ELF: sp1_sdk::Elf = include_elf!("surplus-batch-program");

struct Args {
    orders: String,
    instrument: String,
    tick_size: i64,
    min_qty: i64,
    chain_id: u64,
    contract: Address,
    book_id: B256,
    batch_nonce: u64,
    mode: String,
    out: String,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        orders: String::new(),
        instrument: String::new(),
        tick_size: 1,
        min_qty: 1,
        chain_id: 0,
        contract: Address::ZERO,
        book_id: B256::ZERO,
        batch_nonce: 0,
        mode: "execute".into(),
        out: "proof.json".into(),
    };
    let mut book_id_set = false;
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().context(format!("missing value for {flag}"));
        match flag.as_str() {
            "--orders" => args.orders = value()?,
            "--instrument" => args.instrument = value()?,
            "--tick" => args.tick_size = value()?.parse()?,
            "--min-qty" => args.min_qty = value()?.parse()?,
            "--chain-id" => args.chain_id = value()?.parse()?,
            "--contract" => args.contract = value()?.parse()?,
            "--book-id" => {
                args.book_id = value()?.parse()?;
                book_id_set = true;
            }
            "--batch-nonce" => args.batch_nonce = value()?.parse()?,
            "--mode" => args.mode = value()?,
            "--out" => args.out = value()?,
            other => bail!("unknown flag {other}"),
        }
    }
    if args.orders.is_empty()
        || args.instrument.is_empty()
        || args.chain_id == 0
        || args.contract == Address::ZERO
        || !book_id_set
    {
        bail!("required: --orders <json> --instrument <id> --chain-id <id> --contract <address> --book-id <bytes32> [--tick N] [--min-qty N] [--batch-nonce N]");
    }
    Ok(args)
}

fn load_orders(path: &str) -> Result<Vec<SignedOrder>> {
    let raw = std::fs::read_to_string(path).with_context(|| format!("reading {path}"))?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    let orders = value.get("orders").cloned().unwrap_or(value);
    Ok(serde_json::from_value(orders)?)
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let signed = load_orders(&args.orders)?;
    if signed.is_empty() {
        bail!("no orders to match");
    }

    let input = ProgramInput {
        chain_id: args.chain_id,
        verifying_contract: args.contract,
        book_id: args.book_id,
        batch_nonce: args.batch_nonce,
        instrument_id: args.instrument.clone(),
        tick_size: args.tick_size,
        min_qty: args.min_qty,
        orders: signed
            .iter()
            .map(|so| ProvenOrder {
                order: so.order.clone(),
                sig: so.signature.clone(),
            })
            .collect(),
    };

    // Run the SAME match on the host: the expected public values the guest must
    // commit, and the BatchFill[] calldata the submitter sends to the contract.
    let dom = domain(args.chain_id, args.contract);
    let inner: Vec<_> = signed.iter().map(|so| so.order.clone()).collect();
    let batch = match_epoch(&args.instrument, args.tick_size, args.min_qty, &dom, &inner);
    if batch.fills.is_empty() {
        bail!("order set produces no crossing fills");
    }
    let oc = orders_commitment(&inner, &dom);
    let expected = batch_public_values(
        dom.separator(),
        args.book_id,
        args.batch_nonce,
        oc,
        batch.fills_hash,
    );

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
            println!(
                "execute ok: {} orders -> {} fills, {} cycles",
                signed.len(),
                batch.fills.len(),
                report.total_instruction_count()
            );
            println!("ordersCommitment: {oc:#x}");
            println!("fillsHash: {:#x}", batch.fills_hash);
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
                "bookId": format!("{:#x}", args.book_id),
                "batchNonce": args.batch_nonce,
                "ordersCommitment": format!("{oc:#x}"),
                "fillsHash": format!("{:#x}", batch.fills_hash),
                "fills": batch.fills,
                "orders": signed.len(),
            });
            std::fs::write(&args.out, serde_json::to_string_pretty(&out)?)?;
            println!("proof written to {} ({} fills)", args.out, batch.fills.len());
        }
        other => bail!("unknown mode {other} (execute|groth16)"),
    }
    Ok(())
}
