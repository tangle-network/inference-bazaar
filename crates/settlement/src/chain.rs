//! Submission client for the `SurplusSettlement` contract (feature `chain`).
//!
//! Mirrors the inference blueprints' BillingClient shape: an alloy HTTP
//! provider with a local wallet, typed `sol!` bindings, and small async
//! wrappers per entry point. The venue uses this to clear its outbox.

use crate::{Batch, SignedFill};
use alloy::network::EthereumWallet;
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use alloy_primitives::{Address, B256, U256};

sol! {
    #[sol(rpc)]
    contract ISurplusSettlement {
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
        function settleBatchAttested(BatchFill[] calldata fills, bytes[] calldata sigs) external;
        function settleBatchProven(BatchFill[] calldata fills, bytes calldata proof) external;
        function deposit(uint256 amount) external;
        function depositFor(address account, uint256 amount) external;
        function depositCollateral(uint256 amount) external;
        function requestRedemption(bytes32 lotId, uint64 qty) external returns (bytes32);
        function settleRedemption(bytes32 redemptionId, uint64 servedTokens, bytes calldata holderSig) external;
        function claimDefault(bytes32 redemptionId) external returns (uint256);
        function setAttesters(address[] calldata signers, uint16 threshold) external;
        function setSp1Verifier(address verifier, bytes32 vkey) external;
        function batchNonce() external view returns (uint64);
        function domainSeparator() external view returns (bytes32);
        function balances(address account) external view returns (uint256);
        function collateral(address issuer) external view returns (uint256);
        function liability(address issuer) external view returns (uint256);
        function filled(bytes32 orderHash) external view returns (uint64);
        function defaultsCount() external view returns (uint256);
        function lots(bytes32 lotId) external view returns (
            address holder, address issuer, bytes32 instrument,
            uint64 qtyTokens, uint64 lockedTokens, uint64 expiry, uint128 notionalMicro
        );
        function redemptions(bytes32 redemptionId) external view returns (
            bytes32 lotId, address holder, uint64 qtyTokens, uint64 deadline, uint8 state
        );
        function receiptDigest(bytes32 redemptionId, uint64 servedTokens) external view returns (bytes32);
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

fn to_abi_order(o: &crate::Order) -> ISurplusSettlement::Order {
    ISurplusSettlement::Order {
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

fn to_fill_input(f: &SignedFill) -> ISurplusSettlement::FillInput {
    ISurplusSettlement::FillInput {
        buy: to_abi_order(&f.buy.order),
        buySig: f.buy.signature.clone().into(),
        sell: to_abi_order(&f.sell.order),
        sellSig: f.sell.signature.clone().into(),
        qtyTokens: f.qty_tokens,
        execPriceMicroPerM: f.exec_price_micro_per_m,
    }
}

fn to_batch_fill(f: &crate::BatchFill) -> ISurplusSettlement::BatchFill {
    ISurplusSettlement::BatchFill {
        buy: to_abi_order(&f.buy),
        sell: to_abi_order(&f.sell),
        qtyTokens: f.qtyTokens,
        execPriceMicroPerM: f.execPriceMicroPerM,
    }
}

pub struct SettlementClient {
    contract: ISurplusSettlement::ISurplusSettlementInstance<DynProvider>,
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
        let chain_id = provider.get_chain_id().await?;
        Ok(SettlementClient {
            contract: ISurplusSettlement::new(contract_address, provider),
            chain_id,
            address: contract_address,
        })
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
        let receipt = self.contract.settleFills(inputs).send().await?.get_receipt().await?;
        anyhow::ensure!(receipt.status(), "settleFills reverted: {:?}", receipt.transaction_hash);
        let lots = receipt
            .logs()
            .iter()
            .filter_map(|log| {
                log.log_decode::<ISurplusSettlement::FillSettled>().ok().map(|l| l.inner.lotId)
            })
            .collect();
        Ok((receipt.transaction_hash, lots))
    }

    pub async fn deposit(&self, amount: U256) -> anyhow::Result<()> {
        let r = self.contract.deposit(amount).send().await?.get_receipt().await?;
        anyhow::ensure!(r.status(), "deposit reverted");
        Ok(())
    }

    pub async fn deposit_collateral(&self, amount: U256) -> anyhow::Result<()> {
        let r = self.contract.depositCollateral(amount).send().await?.get_receipt().await?;
        anyhow::ensure!(r.status(), "depositCollateral reverted");
        Ok(())
    }

    /// Open a redemption; returns the redemption id from the event.
    pub async fn request_redemption(&self, lot_id: B256, qty: u64) -> anyhow::Result<B256> {
        let receipt =
            self.contract.requestRedemption(lot_id, qty).send().await?.get_receipt().await?;
        anyhow::ensure!(receipt.status(), "requestRedemption reverted");
        receipt
            .logs()
            .iter()
            .find_map(|log| {
                log.log_decode::<ISurplusSettlement::RedemptionRequested>()
                    .ok()
                    .map(|l| l.inner.redemptionId)
            })
            .ok_or_else(|| anyhow::anyhow!("RedemptionRequested event missing"))
    }

    /// Open-redemption + lot reads for the serving side.
    pub async fn get_redemption(
        &self,
        redemption_id: B256,
    ) -> anyhow::Result<ISurplusSettlement::redemptionsReturn> {
        Ok(self.contract.redemptions(redemption_id).call().await?)
    }

    pub async fn get_lot(&self, lot_id: B256) -> anyhow::Result<ISurplusSettlement::lotsReturn> {
        Ok(self.contract.lots(lot_id).call().await?)
    }

    pub async fn receipt_digest(&self, redemption_id: B256, served: u64) -> anyhow::Result<B256> {
        Ok(self.contract.receiptDigest(redemption_id, served).call().await?)
    }

    pub async fn settle_redemption(
        &self,
        redemption_id: B256,
        served: u64,
        holder_sig: Vec<u8>,
    ) -> anyhow::Result<()> {
        let r = self
            .contract
            .settleRedemption(redemption_id, served, holder_sig.into())
            .send()
            .await?
            .get_receipt()
            .await?;
        anyhow::ensure!(r.status(), "settleRedemption reverted");
        Ok(())
    }

    pub async fn claim_default(&self, redemption_id: B256) -> anyhow::Result<U256> {
        let receipt =
            self.contract.claimDefault(redemption_id).send().await?.get_receipt().await?;
        anyhow::ensure!(receipt.status(), "claimDefault reverted");
        let payout = receipt
            .logs()
            .iter()
            .find_map(|log| {
                log.log_decode::<ISurplusSettlement::RedemptionDefaulted>()
                    .ok()
                    .map(|l| l.inner.payoutMicro)
            })
            .ok_or_else(|| anyhow::anyhow!("RedemptionDefaulted event missing"))?;
        Ok(payout)
    }

    pub async fn set_attesters(&self, signers: Vec<Address>, threshold: u16) -> anyhow::Result<()> {
        let r = self.contract.setAttesters(signers, threshold).send().await?.get_receipt().await?;
        anyhow::ensure!(r.status(), "setAttesters reverted");
        Ok(())
    }

    pub async fn set_sp1_verifier(&self, verifier: Address, vkey: B256) -> anyhow::Result<()> {
        let r = self.contract.setSp1Verifier(verifier, vkey).send().await?.get_receipt().await?;
        anyhow::ensure!(r.status(), "setSp1Verifier reverted");
        Ok(())
    }

    pub async fn liability_of(&self, issuer: Address) -> anyhow::Result<U256> {
        Ok(self.contract.liability(issuer).call().await?)
    }

    pub async fn collateral_of(&self, issuer: Address) -> anyhow::Result<U256> {
        Ok(self.contract.collateral(issuer).call().await?)
    }

    pub async fn defaults_count(&self) -> anyhow::Result<U256> {
        Ok(self.contract.defaultsCount().call().await?)
    }

    pub async fn settle_batch_attested(
        &self,
        batch: &Batch,
        sigs: Vec<Vec<u8>>,
    ) -> anyhow::Result<B256> {
        let fills: Vec<_> = batch.batch_fills().iter().map(to_batch_fill).collect();
        let sigs: Vec<alloy_primitives::Bytes> = sigs.into_iter().map(Into::into).collect();
        let receipt = self
            .contract
            .settleBatchAttested(fills, sigs)
            .send()
            .await?
            .get_receipt()
            .await?;
        anyhow::ensure!(receipt.status(), "settleBatchAttested reverted");
        Ok(receipt.transaction_hash)
    }

    pub async fn settle_batch_proven(&self, batch: &Batch, proof: Vec<u8>) -> anyhow::Result<B256> {
        let fills: Vec<_> = batch.batch_fills().iter().map(to_batch_fill).collect();
        let receipt = self
            .contract
            .settleBatchProven(fills, proof.into())
            .send()
            .await?
            .get_receipt()
            .await?;
        anyhow::ensure!(receipt.status(), "settleBatchProven reverted");
        Ok(receipt.transaction_hash)
    }

    pub async fn batch_nonce(&self) -> anyhow::Result<u64> {
        Ok(self.contract.batchNonce().call().await?)
    }

    pub async fn balance_of(&self, account: Address) -> anyhow::Result<U256> {
        Ok(self.contract.balances(account).call().await?)
    }

    pub async fn filled(&self, order_hash: B256) -> anyhow::Result<u64> {
        Ok(self.contract.filled(order_hash).call().await?)
    }

    pub async fn free_collateral(&self, issuer: Address) -> anyhow::Result<U256> {
        Ok(self.contract.freeCollateral(issuer).call().await?)
    }

    pub async fn default_penalty_bps(&self) -> anyhow::Result<u16> {
        Ok(self.contract.defaultPenaltyBps().call().await?)
    }

    /// Sanity check: the deployed contract's domain separator must equal the
    /// one this client signs against. Call once at startup; a mismatch means
    /// wrong chain id or wrong contract address, and every signature would fail.
    pub async fn assert_domain(&self) -> anyhow::Result<()> {
        let on_chain = self.contract.domainSeparator().call().await?;
        let local = crate::domain(self.chain_id, self.address).separator();
        anyhow::ensure!(
            on_chain == local,
            "domain separator mismatch: chain {on_chain} != local {local}"
        );
        Ok(())
    }
}
