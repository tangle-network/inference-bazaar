//! The transport seam: how the epoch service reaches its peers (order/cancel
//! fanout + the proposer's co-signature round). [`HttpNet`] is the static
//! peer-URL implementation; `mesh::MeshNet` is the PKI-gated alternative.

use std::time::Duration;

use async_trait::async_trait;
use surplus_matcher::Attestation;
use surplus_settlement::core::alloy_primitives::{Address, B256};

use super::{ClobConfig, WireAttestation, WireCancel, WireOrder, WireProposal};

/// How the epoch service reaches its peers: order fanout and the proposer's
/// co-signature round. Two transports implement it — [`HttpNet`] (static peer
/// URL list, plain HTTP) and `mesh::MeshNet` (feature `mesh`):
/// blueprint-networking's PKI-gated gossip, where only the whitelisted bonded
/// operator set can complete a handshake, let alone speak. Consensus safety
/// never rests on the transport (signatures authenticate everything end to
/// end); the transport decides who can spam you.
#[async_trait]
pub trait ClobNet: Send + Sync {
    /// Best-effort one-hop fanout of an admitted order. Loss surfaces as a
    /// censorship verdict at verification time, never as silent divergence.
    fn gossip_order(&self, w: &WireOrder);

    /// Best-effort fanout of a signed cancel — same path as orders, so a cancel
    /// reaches every pool before the next epoch matches the order.
    fn gossip_cancel(&self, c: &WireCancel);

    /// Broadcast a proposal and collect peer co-signatures over `digest` until
    /// `want` arrive or the transport's deadline passes. Self-attestation is
    /// the caller's job; returned signatures are validated by
    /// `aggregate_attestation`, so the transport may return garbage safely.
    async fn collect_attestations(
        &self,
        wire: &WireProposal,
        digest: B256,
        want: usize,
    ) -> Vec<Attestation>;
}

/// The static peer-list HTTP transport (`SURPLUS_CLOB_OPERATORS`).
pub struct HttpNet {
    me: Address,
    operators: Vec<(Address, String)>,
    http: reqwest::Client,
}

impl HttpNet {
    pub fn new(cfg: &ClobConfig, me: Address) -> Self {
        HttpNet {
            me,
            operators: cfg.operators.clone(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
        }
    }

    async fn request_attestation(
        &self,
        peer_url: &str,
        wire: &WireProposal,
    ) -> anyhow::Result<Attestation> {
        let resp = self
            .http
            .post(format!("{peer_url}/clob/propose"))
            .json(wire)
            .send()
            .await?;
        anyhow::ensure!(
            resp.status().is_success(),
            "{}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        );
        let att: WireAttestation = resp.json().await?;
        Ok(Attestation {
            attester: att.attester,
            signature: surplus_settlement::core::hex::decode(
                att.signature.trim_start_matches("0x"),
            )?,
        })
    }
}

#[async_trait]
impl ClobNet for HttpNet {
    fn gossip_order(&self, w: &WireOrder) {
        for (addr, url) in &self.operators {
            if *addr == self.me {
                continue;
            }
            let http = self.http.clone();
            let url = format!("{url}/clob/gossip");
            let body = w.clone();
            tokio::spawn(async move {
                if let Err(e) = http.post(&url).json(&body).send().await {
                    crate::metrics::inc(crate::metrics::names::GOSSIP_SEND_FAILURES);
                    tracing::warn!(%url, "gossip relay failed: {e}");
                }
            });
        }
    }

    fn gossip_cancel(&self, c: &WireCancel) {
        for (addr, url) in &self.operators {
            if *addr == self.me {
                continue;
            }
            let http = self.http.clone();
            let url = format!("{url}/clob/cancel-gossip");
            let body = c.clone();
            tokio::spawn(async move {
                if let Err(e) = http.post(&url).json(&body).send().await {
                    tracing::warn!(%url, "cancel relay failed: {e}");
                }
            });
        }
    }

    async fn collect_attestations(
        &self,
        wire: &WireProposal,
        _digest: B256,
        want: usize,
    ) -> Vec<Attestation> {
        // EVERY peer gets the proposal, concurrently — never stop at threshold.
        // Co-signing has a side effect (the peer prunes the batch's orders from
        // its pool), so a peer that never sees a settling proposal keeps the
        // settled orders and, when it is next elected, re-proposes them into an
        // on-chain Overfill revert. Observed live the moment the quorum grew to
        // 3: the third attester's first elected epoch re-proposed an
        // already-settled batch. Quorum still only NEEDS `want` signatures; the
        // rest arrive (and prune) regardless. Parallel fan-out also bounds the
        // round at one peer-timeout instead of peers × timeout.
        let _ = want;
        let requests = self
            .operators
            .iter()
            .filter(|(addr, _)| *addr != self.me)
            .map(|(_, url)| async move {
                match self.request_attestation(url, wire).await {
                    Ok(att) => Some(att),
                    Err(e) => {
                        tracing::warn!(peer = %url, "attestation refused: {e}");
                        None
                    }
                }
            });
        futures::future::join_all(requests)
            .await
            .into_iter()
            .flatten()
            .collect()
    }
}
