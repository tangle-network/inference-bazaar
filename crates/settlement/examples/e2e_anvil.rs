//! Live end-to-end of the whole guarantee loop against a real chain (anvil):
//!
//!   deposit cash → deposit collateral → settleFills (trustless) → lot minted
//!   → redemption + holder receipt → liability freed
//!   → second lot → redemption ignored → claimDefault pays holder + penalty
//!   → attested batch (2-of-3 quorum) → proven batch (strict mock verifier,
//!     real publicValues binding)
//!
//! Run via scripts/settlement-e2e.sh, or manually:
//!   anvil &
//!   (cd contracts && PRIVATE_KEY=<anvil#0> DEPLOY_DEV_VERIFIER=1 \
//!      forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast)
//!   cargo run -p surplus-settlement --features chain --example e2e_anvil -- \
//!      <settlement> <mockUSD> <verifier>

use alloy::providers::{Provider, ProviderBuilder};
use alloy::sol;
use alloy_primitives::{keccak256, Address, B256, U256};
use surplus_settlement::chain::SettlementClient;
use surplus_settlement::{
    domain, instrument_hash, Batch, Order, SignedFill, Signer, SIDE_BUY, SIDE_SELL,
};

sol! {
    #[sol(rpc)]
    contract IMockUSD {
        function mint(address to, uint256 amount) external;
        function approve(address spender, uint256 amount) external returns (bool);
    }

    #[sol(rpc)]
    contract IStrictVerifier {
        function expect(bytes32 vkey, bytes calldata publicValues) external;
    }
}

const RPC: &str = "http://127.0.0.1:8545";
// anvil's default funded key #0 — the "operator"/deployer.
const OPERATOR_KEY: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SELLER_KEY: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const BUYER_KEY: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";

fn order(side: u8, price: u64, qty: u64, trader: Address, salt: u8) -> Order {
    Order {
        instrument: instrument_hash("anthropic/claude-opus-4-8:output"),
        side,
        priceMicroPerM: price,
        qtyTokens: qty,
        lotId: B256::ZERO,
        trader,
        expiry: 4_000_000_000,
        salt: B256::with_last_byte(salt),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let settlement_addr: Address = args.next().expect("settlement address").parse()?;
    let usd_addr: Address = args.next().expect("mockUSD address").parse()?;
    let verifier_addr: Address = args.next().expect("strict verifier address").parse()?;

    let operator = SettlementClient::connect(RPC, OPERATOR_KEY, settlement_addr).await?;
    let seller_client = SettlementClient::connect(RPC, SELLER_KEY, settlement_addr).await?;
    let buyer_client = SettlementClient::connect(RPC, BUYER_KEY, settlement_addr).await?;
    operator.assert_domain().await?;
    println!("domain ok on chain {}", operator.chain_id());

    let seller = Signer::from_hex(SELLER_KEY)?;
    let buyer = Signer::from_hex(BUYER_KEY)?;
    let dom = domain(operator.chain_id(), settlement_addr);

    // ── Funding: ETH for gas, USD for cash + collateral ──────────────────────
    let raw = ProviderBuilder::new().connect_http(RPC.parse()?);
    for who in [seller.address(), buyer.address()] {
        raw.raw_request::<_, bool>("anvil_setBalance".into(), (who, U256::from(10u128.pow(19))))
            .await
            .ok();
    }
    let op_wallet = ProviderBuilder::new()
        .wallet(alloy::network::EthereumWallet::from(
            OPERATOR_KEY.parse::<alloy::signers::local::PrivateKeySigner>()?,
        ))
        .connect_http(RPC.parse()?);
    let usd_op = IMockUSD::new(usd_addr, &op_wallet);
    usd_op
        .mint(seller.address(), U256::from(1_000_000_000u64))
        .send()
        .await?
        .get_receipt()
        .await?;
    usd_op
        .mint(buyer.address(), U256::from(1_000_000_000u64))
        .send()
        .await?
        .get_receipt()
        .await?;

    for key in [SELLER_KEY, BUYER_KEY] {
        let wallet = ProviderBuilder::new()
            .wallet(alloy::network::EthereumWallet::from(
                key.parse::<alloy::signers::local::PrivateKeySigner>()?,
            ))
            .connect_http(RPC.parse()?);
        IMockUSD::new(usd_addr, &wallet)
            .approve(settlement_addr, U256::MAX)
            .send()
            .await?
            .get_receipt()
            .await?;
    }
    buyer_client.deposit(U256::from(100_000_000u64)).await?; // $100 cash
    seller_client
        .deposit_collateral(U256::from(100_000_000u64))
        .await?; // $100 bond
    println!("funded: buyer cash $100, seller collateral $100");

    // ── 1. Trustless settleFills: mint a lot atomically ──────────────────────
    let fill = SignedFill::pair(
        seller.sign_order(
            &order(SIDE_SELL, 14_000_000, 50_000, seller.address(), 1),
            &dom,
        ),
        buyer.sign_order(
            &order(SIDE_BUY, 15_000_000, 50_000, buyer.address(), 2),
            &dom,
        ),
        50_000,
        4_000_000_000 - 1,
        &dom,
    )?;
    let (_tx, lots) = operator.settle_fills_with_lots(&[fill]).await?;
    let lot1 = lots[0];
    // cost = 14e6 * 50k / 1e6 = 700_000 micro
    assert_eq!(
        buyer_client.balance_of(buyer.address()).await?,
        U256::from(99_300_000u64)
    );
    assert_eq!(
        operator.liability_of(seller.address()).await?,
        U256::from(700_000u64)
    );
    println!("fill settled atomically: lot {lot1:#x}, buyer debited $0.70, liability $0.70");

    // ── 2. Redemption happy path: holder receipt (with work commitment) ──────
    let redemption = buyer_client.request_redemption(lot1, 50_000).await?;
    let work = surplus_settlement::work_commitment(
        surplus_settlement::core::alloy_primitives::keccak256(b"anthropic/claude-opus-4-8:output"),
        surplus_settlement::core::alloy_primitives::keccak256(
            br#"[{"role":"user","content":"hi"}]"#,
        ),
        surplus_settlement::core::alloy_primitives::keccak256(b"served output"),
    );
    let receipt_sig = buyer.sign_receipt(redemption, 50_000, work, &dom).to_vec();
    seller_client
        .settle_redemption(redemption, 50_000, work, receipt_sig)
        .await?;
    assert_eq!(operator.liability_of(seller.address()).await?, U256::ZERO);
    println!("redemption served + receipted: liability back to $0");

    // ── 3. Default path: deadline passes → holder paid from collateral ───────
    let fill2 = SignedFill::pair(
        seller.sign_order(
            &order(SIDE_SELL, 14_000_000, 50_000, seller.address(), 3),
            &dom,
        ),
        buyer.sign_order(
            &order(SIDE_BUY, 15_000_000, 50_000, buyer.address(), 4),
            &dom,
        ),
        50_000,
        4_000_000_000 - 1,
        &dom,
    )?;
    let (_tx, lots2) = operator.settle_fills_with_lots(&[fill2]).await?;
    let redemption2 = buyer_client.request_redemption(lots2[0], 50_000).await?;
    raw.raw_request::<_, serde_json::Value>("evm_increaseTime".into(), (6 * 3600 + 60,))
        .await?;
    raw.raw_request::<_, serde_json::Value>("evm_mine".into(), ())
        .await?;
    let balance_before = buyer_client.balance_of(buyer.address()).await?;
    let payout = buyer_client.claim_default(redemption2).await?;
    // refund 700_000 + 5% penalty = 735_000
    assert_eq!(payout, U256::from(735_000u64));
    assert_eq!(
        buyer_client.balance_of(buyer.address()).await?,
        balance_before + U256::from(735_000u64)
    );
    assert_eq!(operator.defaults_count().await?, U256::from(1u64));
    println!("default claimed: holder repaid $0.735 (incl. 5% penalty) from issuer collateral");

    // ── 4. Attested batch: 2-of-3 quorum vouches signatures for one book ─────
    let book_id = B256::with_last_byte(0xb0);
    let attesters: Vec<Signer> = [0xA1u8, 0xA2, 0xA3]
        .iter()
        .map(|b| Signer::from_hex(&format!("{:02x}", b).repeat(32)).unwrap())
        .collect();
    let mut addrs: Vec<Address> = attesters.iter().map(Signer::address).collect();
    addrs.sort();
    operator
        .register_book(book_id, addrs.clone(), 2, 0, Address::ZERO)
        .await?;
    let mut batch = Batch::default();
    batch.push(SignedFill::pair(
        seller.sign_order(
            &order(SIDE_SELL, 14_000_000, 40_000, seller.address(), 5),
            &dom,
        ),
        buyer.sign_order(
            &order(SIDE_BUY, 15_000_000, 40_000, buyer.address(), 6),
            &dom,
        ),
        40_000,
        4_000_000_000 - 1,
        &dom,
    )?);
    let nonce = operator.book_nonce(book_id).await?;
    let digest = batch.attestation_digest(book_id, nonce, &dom);
    let sigs = surplus_settlement::sort_quorum_sigs(
        digest,
        attesters
            .iter()
            .map(|a| a.sign_digest(digest).to_vec())
            .collect(),
    );
    let (_btx, batch_lots) = operator
        .settle_batch_attested_with_lots(book_id, &batch, sigs[..2].to_vec())
        .await?;
    let att_lot = batch_lots[0];
    println!(
        "attested batch settled (2-of-3 quorum), book nonce -> {}, lot {att_lot:#x}",
        nonce + 1
    );

    // ── 5. Proven batch: strict mock pins the match-in-circuit public values
    //       (domainSeparator, bookId, nonce, ordersCommitment, fillsHash) ──
    let vkey = B256::with_last_byte(0x42);
    operator.set_sp1_verifier(verifier_addr, vkey).await?;
    let sell_o = order(SIDE_SELL, 14_000_000, 30_000, seller.address(), 7);
    let buy_o = order(SIDE_BUY, 15_000_000, 30_000, buyer.address(), 8);
    let mut batch2 = Batch::default();
    batch2.push(SignedFill::pair(
        seller.sign_order(&sell_o, &dom),
        buyer.sign_order(&buy_o, &dom),
        30_000,
        4_000_000_000 - 1,
        &dom,
    )?);
    let orders_commitment = surplus_settlement::orders_commitment(&[sell_o, buy_o], &dom);
    let proven_nonce = operator.book_nonce(book_id).await?;
    let public_values = surplus_settlement::batch_public_values(
        dom.separator(),
        book_id,
        proven_nonce,
        orders_commitment,
        batch2.fills_hash(),
    );
    // expect() is permissionless; use a key no other provider here shares so
    // cached nonce managers never fight (anvil funded key #1).
    let primer_wallet = ProviderBuilder::new()
        .wallet(alloy::network::EthereumWallet::from(
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
                .parse::<alloy::signers::local::PrivateKeySigner>()?,
        ))
        .connect_http(RPC.parse()?);
    IStrictVerifier::new(verifier_addr, &primer_wallet)
        .expect(vkey, public_values.into())
        .send()
        .await?
        .get_receipt()
        .await?;
    operator
        .settle_batch_proven(book_id, orders_commitment, &batch2, vec![0xde, 0xad])
        .await?;
    println!("proven batch settled against strict verifier (match-in-circuit publicValues bound)");

    // ── 6. Attested redemption: the holder consumes a batch-minted lot but won't
    //       sign the receipt. The issuing book's quorum vouches service; after the
    //       challenge window the operator finalizes and is paid — NO unjust default
    //       or slash (this is the anti-grief capability the operator pump drives). ─
    let red3 = buyer_client.request_redemption(att_lot, 40_000).await?;
    let liab_before = operator.liability_of(seller.address()).await?;
    let defaults_before = operator.defaults_count().await?;
    let work3 = surplus_settlement::work_commitment(
        keccak256(b"anthropic/claude-opus-4-8:output"),
        keccak256(br#"[{"role":"user","content":"hi"}]"#),
        keccak256(b"attested output"),
    );
    // The book quorum signs the receipt digest — the holder never does.
    let rdigest = surplus_settlement::receipt_digest(red3, 40_000, work3, &dom);
    let rsigs = surplus_settlement::sort_quorum_sigs(
        rdigest,
        attesters
            .iter()
            .map(|a| a.sign_digest(rdigest).to_vec())
            .collect(),
    );
    operator
        .settle_redemption_attested(book_id, red3, 40_000, work3, rsigs[..2].to_vec())
        .await?;
    // Advance past the challenge window (deploy default 1h), then finalize.
    raw.raw_request::<_, serde_json::Value>("evm_increaseTime".into(), (3600 + 60,))
        .await?;
    raw.raw_request::<_, serde_json::Value>("evm_mine".into(), ())
        .await?;
    operator.finalize_attested(red3).await?;
    let liab_after = operator.liability_of(seller.address()).await?;
    assert!(
        liab_after < liab_before,
        "attested redemption must free the served liability"
    );
    assert_eq!(
        operator.defaults_count().await?,
        defaults_before,
        "no default: the operator was paid via attestation, not defaulted+slashed"
    );
    println!("attested redemption: quorum vouched, window passed, finalized — liability freed, no default");

    println!("\nE2E PASS: fill, receipt redemption, default, attested + proven batches, attested redemption");
    Ok(())
}
