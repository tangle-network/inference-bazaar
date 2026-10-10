//! Submission client for the `InferenceBazaarSettlement` contract (feature `chain`).
//!
//! Mirrors the inference blueprints' BillingClient shape: an alloy HTTP
//! provider with a local wallet, typed `sol!` bindings, and small async
//! wrappers per entry point. The venue uses this to clear its outbox.

use crate::retry::{self, RetryPolicy};
use crate::{Batch, SignedFill};
use alloy::network::EthereumWallet;
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use alloy_primitives::{Address, B256, U256};

sol! {
    #[sol(rpc)]
    contract IInferenceBazaarSettlement {
        struct Order {
            bytes32 instrument;
            uint8 side;
            uint64 priceMicroPerM;
            uint64 qtyTokens;
            bytes32 lotId;
            address trader;
            uint64 expiry;
            bytes32 salt;
        }

        struct FillInput {
            Order buy;
            bytes buySig;
            Order sell;
            bytes sellSig;
            uint64 qtyTokens;
            uint64 execPriceMicroPerM;
        }

        struct BatchFill {
            Order buy;
            Order sell;
            uint64 qtyTokens;
            uint64 execPriceMicroPerM;
        }

        function settleFills(FillInput[] calldata fills) external;
        function settleBatchAttested(bytes32 bookId, BatchFill[] calldata fills, bytes[] calldata sigs) external;
        function settleBatchProven(bytes32 bookId, bytes32 ordersCommitment, BatchFill[] calldata fills, bytes calldata proof) external;
        function deposit(uint256 amount) external;
        function depositFor(address account, uint256 amount) external;
        function depositCollateral(uint256 amount) external;
        function requestRedemption(bytes32 lotId, uint64 qty) external returns (bytes32);
        function settleRedemption(bytes32 redemptionId, uint64 servedTokens, bytes32 workCommitment, bytes calldata holderSig) external;
        function settleRedemptionAttested(bytes32 bookId, bytes32 redemptionId, uint64 servedTokens, bytes32 workCommitment, bytes[] calldata sigs) external;
        function finalizeAttested(bytes32 redemptionId) external;
        function lotBook(bytes32 lotId) external view returns (bytes32);
        function challengeAttested(bytes32 redemptionId) external;
        struct SpendPermit {
            bytes32 lotId;
            address sessionKey;
            uint64 maxTokens;
            uint64 expiry;
        }
        function settleSpend(SpendPermit calldata permit, bytes calldata holderSig, uint64 servedCumulative, bytes calldata voucherSig) external;
        function spendSettled(bytes32 permitDigest) external view returns (uint64);
        function spendRevoked(bytes32 permitDigest) external view returns (bool);
        function claimDefault(bytes32 redemptionId) external returns (uint256);
        function registerBook(bytes32 bookId, address[] calldata signers, uint16 threshold, uint16 bookFeeBps, address bookFeeRecipient) external;
        function rotateAttesters(bytes32 bookId, address[] calldata signers, uint16 threshold) external;
        function bookAttesters(bytes32 bookId) external view returns (address[] memory);
        function bookThreshold(bytes32 bookId) external view returns (uint16);
        function setSp1Verifier(address verifier, bytes32 vkey) external;
        function bookNonce(bytes32 bookId) external view returns (uint64);
        function domainSeparator() external view returns (bytes32);
        function balances(address account) external view returns (uint256);
        function collateral(address issuer) external view returns (uint256);
        function liability(address issuer) external view returns (uint256);
        function filled(bytes32 orderHash) external view returns (uint64);
        function cancelled(bytes32 orderHash) external view returns (bool);
        function defaultsCount() external view returns (uint256);
        function lots(bytes32 lotId) external view returns (
            address holder, address issuer, bytes32 instrument,
            uint64 qtyTokens, uint64 lockedTokens, uint64 expiry, uint128 notionalMicro
        );
        function redemptions(bytes32 redemptionId) external view returns (
            bytes32 lotId, address holder, uint64 qtyTokens, uint64 deadline, uint8 state,
            uint64 challengeDeadline, uint64 attestedServed, bytes32 attestedWork
        );
        function receiptDigest(bytes32 redemptionId, uint64 servedTokens, bytes32 workCommitment) external view returns (bytes32);
        function freeCollateral(address issuer) external view returns (uint256);
        function defaultPenaltyBps() external view returns (uint16);

        event FillSettled(
            bytes32 indexed buyOrderHash,
            bytes32 indexed sellOrderHash,
            bytes32 instrument,
            uint64 qtyTokens,
            uint64 execPriceMicroPerM,
            uint256 costMicro,
            bytes32 lotId
        );
        event RedemptionRequested(
            bytes32 indexed redemptionId,
            bytes32 indexed lotId,
            address indexed issuer,
            address holder,
            uint64 qtyTokens,
            uint64 deadline
        );
        event RedemptionDefaulted(
            uint256 indexed defaultId,
            bytes32 indexed redemptionId,
            address indexed issuer,
            address holder,
            uint256 payoutMicro
        );
    }
}

fn to_abi_order(o: &crate::Order) -> IInferenceBazaarSettlement::Order {
    IInferenceBazaarSettlement::Order {
        instrument: o.instrument,
        side: o.side,
        priceMicroPerM: o.priceMicroPerM,
        qtyTokens: o.qtyTokens,
        lotId: o.lotId,
        trader: o.trader,
        expiry: o.expiry,
        salt: o.salt,
    }
}

fn to_fill_input(f: &SignedFill) -> IInferenceBazaarSettlement::FillInput {
    IInferenceBazaarSettlement::FillInput {
        buy: to_abi_order(&f.buy.order),
        buySig: f.buy.signature.clone().into(),
        sell: to_abi_order(&f.sell.order),
        sellSig: f.sell.signature.clone().into(),
        qtyTokens: f.qty_tokens,
        execPriceMicroPerM: f.exec_price_micro_per_m,
    }
}

fn to_batch_fill(f: &crate::BatchFill) -> IInferenceBazaarSettlement::BatchFill {
    IInferenceBazaarSettlement::BatchFill {
        buy: to_abi_order(&f.buy),
        sell: to_abi_order(&f.sell),
        qtyTokens: f.qtyTokens,
        execPriceMicroPerM: f.execPriceMicroPerM,
    }
}

pub struct SettlementClient {
    contract: IInferenceBazaarSettlement::IInferenceBazaarSettlementInstance<DynProvider>,
    chain_id: u64,
    address: Address,
}

impl SettlementClient {
    pub async fn connect(
        rpc_url: &str,
        private_key_hex: &str,
        contract_address: Address,
    ) -> anyhow::Result<Self> {
        let signer: PrivateKeySigner = private_key_hex.trim_start_matches("0x").parse()?;
        let wallet = EthereumWallet::from(signer);
        let provider = ProviderBuilder::new()
            .wallet(wallet)
            .connect_http(rpc_url.parse()?)
            .erased();
        let chain_id = {
            let p = &provider;
            retry::run(RetryPolicy::READ, "getChainId", || async move {
                p.get_chain_id().await
            })
            .await?
        };
        Ok(SettlementClient {
            contract: IInferenceBazaarSettlement::new(contract_address, provider),
            chain_id,
            address: contract_address,
        })
    }

    /// Reads and receipt polls are idempotent: full transient retry.
    async fn read<T, E, F, Fut>(&self, label: &str, f: F) -> anyhow::Result<T>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<T, E>>,
        E: std::error::Error + Send + Sync + 'static,
    {
        retry::run(RetryPolicy::READ, label, f).await
    }

    /// Sends retry only pre-execution rejections (429/5xx) — a send that timed
    /// out may have landed, and a blind resend could double-settle.
    async fn send<T, E, F, Fut>(&self, label: &str, f: F) -> anyhow::Result<T>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<T, E>>,
        E: std::error::Error + Send + Sync + 'static,
    {
        retry::run(RetryPolicy::SEND, label, f).await
    }

    /// Wait for a sent tx's mined receipt, polling by hash. The pending
    /// builder's own watcher fails hard on one transient RPC error; polling
    /// through `read` retries instead of losing the call. `PendingTransactionBuilder`
    /// is not `Clone` and `get_receipt` consumes it, hence the hash poll.
    async fn confirm(
        &self,
        label: &str,
        pending: &alloy::providers::PendingTransactionBuilder<alloy::network::Ethereum>,
    ) -> anyhow::Result<alloy::rpc::types::TransactionReceipt> {
        let hash = *pending.tx_hash();
        let mut polls = 0u32;
        loop {
            match self
                .read(label, || async move {
                    self.contract.provider().get_transaction_receipt(hash).await
                })
                .await?
            {
                Some(r) => return Ok(r),
                None => {
                    polls += 1;
                    anyhow::ensure!(polls <= 120, "{label}: receipt never landed for {hash:#x}");
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
        }
    }

    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }

    pub fn address(&self) -> Address {
        self.address
    }

    pub fn domain(&self) -> alloy_sol_types::Eip712Domain {
        crate::domain(self.chain_id, self.address)
    }

    /// Trustless path: signatures inline, the contract verifies everything.
    /// Returns (tx hash, lot ids minted/transferred per fill).
    pub async fn settle_fills(&self, fills: &[SignedFill]) -> anyhow::Result<B256> {
        Ok(self.settle_fills_with_lots(fills).await?.0)
    }

    pub async fn settle_fills_with_lots(
        &self,
        fills: &[SignedFill],
    ) -> anyhow::Result<(B256, Vec<B256>)> {
        let inputs: Vec<_> = fills.iter().map(to_fill_input).collect();
        let pending = self
            .send("settleFills", || {
                let inputs = inputs.clone();
                async move { self.contract.settleFills(inputs).send().await }
            })
            .await?;
        let receipt = self.confirm("settleFills receipt", &pending).await?;
        anyhow::ensure!(
            receipt.status(),
            "settleFills reverted: {:?}",
            receipt.transaction_hash
        );
        let lots = receipt
            .logs()
            .iter()
            .filter_map(|log| {
                log.log_decode::<IInferenceBazaarSettlement::FillSettled>()
                    .ok()
                    .map(|l| l.inner.lotId)
            })
            .collect();
        Ok((receipt.transaction_hash, lots))
    }

    pub async fn deposit(&self, amount: U256) -> anyhow::Result<()> {
        let pending = self
            .send("deposit", || async move {
                self.contract.deposit(amount).send().await
            })
            .await?;
        let r = self.confirm("deposit receipt", &pending).await?;
        anyhow::ensure!(r.status(), "deposit reverted");
        Ok(())
    }

    pub async fn deposit_collateral(&self, amount: U256) -> anyhow::Result<()> {
        let pending = self
            .send("depositCollateral", || async move {
                self.contract.depositCollateral(amount).send().await
            })
            .await?;
        let r = self.confirm("depositCollateral receipt", &pending).await?;
        anyhow::ensure!(r.status(), "depositCollateral reverted");
        Ok(())
    }

    /// Settle the cumulative tokens the consumer's session key acknowledged on a
    /// spend channel. `served_cumulative` MUST be covered by `voucher_sig` (signed
    /// by `session_key`), so the operator cannot settle more than the consumer
    /// signed — over-billing is impossible.
    #[allow(clippy::too_many_arguments)]
    pub async fn settle_spend(
        &self,
        lot_id: B256,
        session_key: Address,
        max_tokens: u64,
        expiry: u64,
        holder_sig: Vec<u8>,
        served_cumulative: u64,
        voucher_sig: Vec<u8>,
    ) -> anyhow::Result<B256> {
        let permit = IInferenceBazaarSettlement::SpendPermit {
            lotId: lot_id,
            sessionKey: session_key,
            maxTokens: max_tokens,
            expiry,
        };
        let pending = self
            .send("settleSpend", || {
                let permit = permit.clone();
                let holder_sig = holder_sig.clone();
                let voucher_sig = voucher_sig.clone();
                async move {
                    self.contract
                        .settleSpend(
                            permit,
                            holder_sig.into(),
                            served_cumulative,
                            voucher_sig.into(),
                        )
                        .send()
                        .await
                }
            })
            .await?;
        let receipt = self.confirm("settleSpend receipt", &pending).await?;
        anyhow::ensure!(receipt.status(), "settleSpend reverted");
        Ok(receipt.transaction_hash)
    }

    pub async fn spend_settled(&self, permit_digest: B256) -> anyhow::Result<u64> {
        self.read("spendSettled", || async move {
            self.contract.spendSettled(permit_digest).call().await
        })
        .await
    }

    pub async fn spend_revoked(&self, permit_digest: B256) -> anyhow::Result<bool> {
        self.read("spendRevoked", || async move {
            self.contract.spendRevoked(permit_digest).call().await
        })
        .await
    }

    /// Open a redemption; returns the redemption id from the event.
    pub async fn request_redemption(&self, lot_id: B256, qty: u64) -> anyhow::Result<B256> {
        let pending = self
            .send("requestRedemption", || async move {
                self.contract.requestRedemption(lot_id, qty).send().await
            })
            .await?;
        let receipt = self.confirm("requestRedemption receipt", &pending).await?;
        anyhow::ensure!(receipt.status(), "requestRedemption reverted");
        receipt
            .logs()
            .iter()
            .find_map(|log| {
                log.log_decode::<IInferenceBazaarSettlement::RedemptionRequested>()
                    .ok()
                    .map(|l| l.inner.redemptionId)
            })
            .ok_or_else(|| anyhow::anyhow!("RedemptionRequested event missing"))
    }

    /// Open-redemption + lot reads for the serving side.
    pub async fn get_redemption(
        &self,
        redemption_id: B256,
    ) -> anyhow::Result<IInferenceBazaarSettlement::redemptionsReturn> {
        self.read("redemptions", || async move {
            self.contract.redemptions(redemption_id).call().await
        })
        .await
    }

    pub async fn get_lot(
        &self,
        lot_id: B256,
    ) -> anyhow::Result<IInferenceBazaarSettlement::lotsReturn> {
        self.read(
            "lots",
            || async move { self.contract.lots(lot_id).call().await },
        )
        .await
    }

    /// Every credit lot `issuer` minted that is CURRENTLY held by `holder`,
    /// read from on-chain state — not an off-chain index. Lots are minted in
    /// `FillSettled`, so we scan that event from `from_block`, dedup by lotId,
    /// and read each lot, keeping only those whose live `holder`/`issuer` match
    /// (a resold lot drops out because its holder changed). The returned lots
    /// are the raw on-chain tuples; the caller filters by instrument/expiry.
    pub async fn lots_issued_to(
        &self,
        issuer: Address,
        holder: Address,
        from_block: u64,
    ) -> anyhow::Result<Vec<(B256, IInferenceBazaarSettlement::lotsReturn)>> {
        let logs = self
            .read("FillSettled scan", || async move {
                self.contract
                    .FillSettled_filter()
                    .from_block(from_block)
                    .query()
                    .await
            })
            .await?;
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for (ev, _log) in logs {
            let lot_id = ev.lotId;
            if lot_id == B256::ZERO || !seen.insert(lot_id) {
                continue;
            }
            let lot = self
                .read(
                    "lots",
                    || async move { self.contract.lots(lot_id).call().await },
                )
                .await?;
            if lot.holder == holder && lot.issuer == issuer {
                out.push((lot_id, lot));
            }
        }
        Ok(out)
    }

    pub async fn receipt_digest(
        &self,
        redemption_id: B256,
        served: u64,
        work_commitment: B256,
    ) -> anyhow::Result<B256> {
        self.read("receiptDigest", || async move {
            self.contract
                .receiptDigest(redemption_id, served, work_commitment)
                .call()
                .await
        })
        .await
    }

    pub async fn settle_redemption(
        &self,
        redemption_id: B256,
        served: u64,
        work_commitment: B256,
        holder_sig: Vec<u8>,
    ) -> anyhow::Result<()> {
        let pending = self
            .send("settleRedemption", || {
                let holder_sig = holder_sig.clone();
                async move {
                    self.contract
                        .settleRedemption(redemption_id, served, work_commitment, holder_sig.into())
                        .send()
                        .await
                }
            })
            .await?;
        let r = self.confirm("settleRedemption receipt", &pending).await?;
        anyhow::ensure!(r.status(), "settleRedemption reverted");
        Ok(())
    }

    /// The book a lot was minted into (NO_BOOK for trustless `settleFills` lots,
    /// which cannot be attested). Needed to drive `settleRedemptionAttested`.
    pub async fn lot_book(&self, lot_id: B256) -> anyhow::Result<B256> {
        self.read("lotBook", || async move {
            self.contract.lotBook(lot_id).call().await
        })
        .await
    }

    /// Attest service for a redemption the holder won't receipt: the issuing
    /// book's quorum signs `receiptDigest(rid, served, work)`, posting a
    /// challengeable claim. Saves the operator from an unjust default+slash.
    pub async fn settle_redemption_attested(
        &self,
        book_id: B256,
        redemption_id: B256,
        served: u64,
        work_commitment: B256,
        sigs: Vec<Vec<u8>>,
    ) -> anyhow::Result<B256> {
        let pending = self
            .send("settleRedemptionAttested", || {
                let sigs: Vec<alloy_primitives::Bytes> =
                    sigs.iter().cloned().map(Into::into).collect();
                async move {
                    self.contract
                        .settleRedemptionAttested(
                            book_id,
                            redemption_id,
                            served,
                            work_commitment,
                            sigs,
                        )
                        .send()
                        .await
                }
            })
            .await?;
        let r = self
            .confirm("settleRedemptionAttested receipt", &pending)
            .await?;
        anyhow::ensure!(r.status(), "settleRedemptionAttested reverted");
        Ok(r.transaction_hash)
    }

    /// Finalize an unchallenged attestation once its window has passed (anyone
    /// may call; the settlement is exactly what the quorum vouched).
    pub async fn finalize_attested(&self, redemption_id: B256) -> anyhow::Result<B256> {
        let pending = self
            .send("finalizeAttested", || async move {
                self.contract.finalizeAttested(redemption_id).send().await
            })
            .await?;
        let r = self.confirm("finalizeAttested receipt", &pending).await?;
        anyhow::ensure!(r.status(), "finalizeAttested reverted");
        Ok(r.transaction_hash)
    }

    pub async fn claim_default(&self, redemption_id: B256) -> anyhow::Result<U256> {
        let pending = self
            .send("claimDefault", || async move {
                self.contract.claimDefault(redemption_id).send().await
            })
            .await?;
        let receipt = self.confirm("claimDefault receipt", &pending).await?;
        anyhow::ensure!(receipt.status(), "claimDefault reverted");
        let payout = receipt
            .logs()
            .iter()
            .find_map(|log| {
                log.log_decode::<IInferenceBazaarSettlement::RedemptionDefaulted>()
                    .ok()
                    .map(|l| l.inner.payoutMicro)
            })
            .ok_or_else(|| anyhow::anyhow!("RedemptionDefaulted event missing"))?;
        Ok(payout)
    }

    pub async fn register_book(
        &self,
        book_id: B256,
        signers: Vec<Address>,
        threshold: u16,
        book_fee_bps: u16,
        book_fee_recipient: Address,
    ) -> anyhow::Result<()> {
        let pending = self
            .send("registerBook", || {
                let signers = signers.clone();
                async move {
                    self.contract
                        .registerBook(
                            book_id,
                            signers,
                            threshold,
                            book_fee_bps,
                            book_fee_recipient,
                        )
                        .send()
                        .await
                }
            })
            .await?;
        let r = self.confirm("registerBook receipt", &pending).await?;
        anyhow::ensure!(r.status(), "registerBook reverted");
        Ok(())
    }

    /// Rotate a book's attester set + threshold for operator churn. Cannot touch
    /// the book's fee/recipient (write-once in `registerBook`).
    pub async fn rotate_attesters(
        &self,
        book_id: B256,
        signers: Vec<Address>,
        threshold: u16,
    ) -> anyhow::Result<()> {
        let pending = self
            .send("rotateAttesters", || {
                let signers = signers.clone();
                async move {
                    self.contract
                        .rotateAttesters(book_id, signers, threshold)
                        .send()
                        .await
                }
            })
            .await?;
        let r = self.confirm("rotateAttesters receipt", &pending).await?;
        anyhow::ensure!(r.status(), "rotateAttesters reverted");
        Ok(())
    }

    pub async fn book_attesters(&self, book_id: B256) -> anyhow::Result<Vec<Address>> {
        self.read("bookAttesters", || async move {
            self.contract.bookAttesters(book_id).call().await
        })
        .await
    }

    pub async fn book_threshold(&self, book_id: B256) -> anyhow::Result<u16> {
        self.read("bookThreshold", || async move {
            self.contract.bookThreshold(book_id).call().await
        })
        .await
    }

    pub async fn set_sp1_verifier(&self, verifier: Address, vkey: B256) -> anyhow::Result<()> {
        let pending = self
            .send("setSp1Verifier", || async move {
                self.contract.setSp1Verifier(verifier, vkey).send().await
            })
            .await?;
        let r = self.confirm("setSp1Verifier receipt", &pending).await?;
        anyhow::ensure!(r.status(), "setSp1Verifier reverted");
        Ok(())
    }

    pub async fn liability_of(&self, issuer: Address) -> anyhow::Result<U256> {
        self.read("liability", || async move {
            self.contract.liability(issuer).call().await
        })
        .await
    }

    pub async fn collateral_of(&self, issuer: Address) -> anyhow::Result<U256> {
        self.read("collateral", || async move {
            self.contract.collateral(issuer).call().await
        })
        .await
    }

    pub async fn defaults_count(&self) -> anyhow::Result<U256> {
        self.read("defaultsCount", || async move {
            self.contract.defaultsCount().call().await
        })
        .await
    }

    pub async fn settle_batch_attested(
        &self,
        book_id: B256,
        batch: &Batch,
        sigs: Vec<Vec<u8>>,
    ) -> anyhow::Result<B256> {
        self.settle_batch_fills_attested(book_id, &batch.batch_fills(), sigs)
            .await
    }

    /// Attested submit of pre-matched `BatchFill`s exactly as produced by the
    /// epoch matcher — no `SignedFill` reconstruction, so the calldata (and the
    /// fillsHash the contract recomputes) is byte-for-byte what the quorum signed.
    pub async fn settle_batch_fills_attested(
        &self,
        book_id: B256,
        fills: &[crate::BatchFill],
        sigs: Vec<Vec<u8>>,
    ) -> anyhow::Result<B256> {
        let pending = self
            .send("settleBatchAttested", || {
                let fills: Vec<_> = fills.iter().map(to_batch_fill).collect();
                let sigs: Vec<alloy_primitives::Bytes> =
                    sigs.iter().cloned().map(Into::into).collect();
                async move {
                    self.contract
                        .settleBatchAttested(book_id, fills, sigs)
                        .send()
                        .await
                }
            })
            .await?;
        let receipt = self
            .confirm("settleBatchAttested receipt", &pending)
            .await?;
        anyhow::ensure!(receipt.status(), "settleBatchAttested reverted");
        Ok(receipt.transaction_hash)
    }

    /// Attested submit returning the minted lot ids (FillSettled events), so a
    /// caller can drive an attested redemption of a batch-minted lot.
    pub async fn settle_batch_attested_with_lots(
        &self,
        book_id: B256,
        batch: &Batch,
        sigs: Vec<Vec<u8>>,
    ) -> anyhow::Result<(B256, Vec<B256>)> {
        let pending = self
            .send("settleBatchAttested", || {
                let fills: Vec<_> = batch.batch_fills().iter().map(to_batch_fill).collect();
                let sigs: Vec<alloy_primitives::Bytes> =
                    sigs.iter().cloned().map(Into::into).collect();
                async move {
                    self.contract
                        .settleBatchAttested(book_id, fills, sigs)
                        .send()
                        .await
                }
            })
            .await?;
        let receipt = self
            .confirm("settleBatchAttested receipt", &pending)
            .await?;
        anyhow::ensure!(receipt.status(), "settleBatchAttested reverted");
        let lots = receipt
            .logs()
            .iter()
            .filter_map(|log| {
                log.log_decode::<IInferenceBazaarSettlement::FillSettled>()
                    .ok()
                    .map(|l| l.inner.lotId)
            })
            .filter(|l| *l != B256::ZERO)
            .collect();
        Ok((receipt.transaction_hash, lots))
    }

    pub async fn settle_batch_proven(
        &self,
        book_id: B256,
        orders_commitment: B256,
        batch: &Batch,
        proof: Vec<u8>,
    ) -> anyhow::Result<B256> {
        self.settle_batch_fills_proven(book_id, orders_commitment, &batch.batch_fills(), proof)
            .await
    }

    /// Proven submit of pre-matched `BatchFill`s exactly as the epoch matcher
    /// produced them (same shape the prover commits to via `fillsHash`), so the
    /// calldata the contract recomputes matches the proof's public values.
    pub async fn settle_batch_fills_proven(
        &self,
        book_id: B256,
        orders_commitment: B256,
        fills: &[crate::BatchFill],
        proof: Vec<u8>,
    ) -> anyhow::Result<B256> {
        let pending = self
            .send("settleBatchProven", || {
                let fills: Vec<_> = fills.iter().map(to_batch_fill).collect();
                let proof = proof.clone();
                async move {
                    self.contract
                        .settleBatchProven(book_id, orders_commitment, fills, proof.into())
                        .send()
                        .await
                }
            })
            .await?;
        let receipt = self.confirm("settleBatchProven receipt", &pending).await?;
        anyhow::ensure!(receipt.status(), "settleBatchProven reverted");
        Ok(receipt.transaction_hash)
    }

    pub async fn book_nonce(&self, book_id: B256) -> anyhow::Result<u64> {
        self.read("bookNonce", || async move {
            self.contract.bookNonce(book_id).call().await
        })
        .await
    }

    pub async fn balance_of(&self, account: Address) -> anyhow::Result<U256> {
        self.read("balances", || async move {
            self.contract.balances(account).call().await
        })
        .await
    }

    pub async fn filled(&self, order_hash: B256) -> anyhow::Result<u64> {
        self.read("filled", || async move {
            self.contract.filled(order_hash).call().await
        })
        .await
    }

    pub async fn cancelled(&self, order_hash: B256) -> anyhow::Result<bool> {
        self.read("cancelled", || async move {
            self.contract.cancelled(order_hash).call().await
        })
        .await
    }

    pub async fn free_collateral(&self, issuer: Address) -> anyhow::Result<U256> {
        self.read("freeCollateral", || async move {
            self.contract.freeCollateral(issuer).call().await
        })
        .await
    }

    pub async fn default_penalty_bps(&self) -> anyhow::Result<u16> {
        self.read("defaultPenaltyBps", || async move {
            self.contract.defaultPenaltyBps().call().await
        })
        .await
    }

    /// Sanity check: the deployed contract's domain separator must equal the
    /// one this client signs against. Call once at startup; a mismatch means
    /// wrong chain id or wrong contract address, and every signature would fail.
    pub async fn assert_domain(&self) -> anyhow::Result<()> {
        let on_chain = self
            .read("domainSeparator", || async move {
                self.contract.domainSeparator().call().await
            })
            .await?;
        let local = crate::domain(self.chain_id, self.address).separator();
        anyhow::ensure!(
            on_chain == local,
            "domain separator mismatch: chain {on_chain} != local {local}"
        );
        Ok(())
    }
}
