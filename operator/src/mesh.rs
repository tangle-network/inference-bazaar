//! blueprint-networking transport for the shared-CLOB epoch service.
//!
//! Replaces the HTTP peer list with the PKI-gated gossip mesh: the whitelist is
//! the bonded attester set itself (`AllowedKeys::EvmAddresses`), every handshake
//! is signed with the peer's operator key and verified by address recovery, and
//! the topic is scoped per deployment (`/surplus-clob/{chain}-{contract}`) — so
//! only the configured operator set can join, speak, or even complete a
//! connection. Consensus safety still rides on signatures end to end (trader
//! sigs on orders, attester sigs over the batch digest); the mesh upgrades who
//! can reach you from "anyone with the URL" to "the bonded set".
//!
//! Message flow on one topic: orders are broadcast as they are admitted;
//! the elected proposer broadcasts its [`WireProposal`]; peers verify
//! ([`Clob::attest`]) and broadcast their co-signature; the proposer correlates
//! attestations to its pending round by the batch digest. gossipsub does not
//! self-deliver, so a node never re-processes its own broadcast.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use bincode::Options;
use blueprint_crypto::k256::K256Ecdsa;
use blueprint_crypto::BytesEncoding;
use blueprint_networking::service::NetworkCommandMessage;
use blueprint_networking::service_handle::NetworkServiceHandle;
use blueprint_networking::types::{MessageRouting, ProtocolMessage};
use blueprint_networking::{AllowedKeys, NetworkConfig, NetworkService};
use serde::{Deserialize, Serialize};
use surplus_matcher::Attestation;
use surplus_settlement::core::alloy_primitives::{Address, B256};
use surplus_settlement::core::batch_digest;
use tokio::sync::mpsc;

use crate::clob::{
    spawn_epoch_loop, Clob, ClobConfig, ClobNet, SharedClob, WireCancel, WireOrder, WireProposal,
};
use crate::venue::Venue;

pub type MeshHandle = NetworkServiceHandle<K256Ecdsa>;

/// How long a proposer waits for peer co-signatures before settling for what it
/// has (quorum-or-carry is decided by `aggregate_attestation` either way).
const ATTEST_TIMEOUT: Duration = Duration::from_secs(8);

/// Everything that travels the mesh, on one topic.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum MeshWire {
    Order(WireOrder),
    Cancel(WireCancel),
    Proposal(WireProposal),
    Attestation(WireAttestationMsg),
}

/// A co-signature broadcast back to the mesh, carrying enough context
/// (`batch_nonce`, `fills_hash`) for the proposer to rebuild the digest it is
/// collecting for. The signature itself is what `aggregate_attestation`
/// validates — a forged or replayed message simply fails recovery.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireAttestationMsg {
    batch_nonce: u64,
    fills_hash: B256,
    attester: Address,
    /// 65-byte r||s||v signature, 0x-hex.
    signature: String,
}

/// The mesh transport: broadcast-only fanout plus a pending-round registry that
/// routes inbound co-signatures to the awaiting proposer task.
pub struct MeshNet {
    handle: MeshHandle,
    msg_id: AtomicU64,
    pending: Mutex<HashMap<B256, mpsc::UnboundedSender<Attestation>>>,
}

impl MeshNet {
    pub fn new(handle: MeshHandle) -> Arc<Self> {
        Arc::new(MeshNet {
            handle,
            msg_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        })
    }

    fn broadcast(&self, msg: &MeshWire) {
        let payload = serde_json::to_vec(msg).expect("mesh wire serializes");
        let routing = MessageRouting {
            message_id: self.msg_id.fetch_add(1, Ordering::Relaxed),
            round_id: 0,
            sender: self.handle.local_peer_id,
            recipient: None, // gossip to the whole whitelisted topic
        };
        // Encode the ProtocolMessage envelope with bincode VARINT options —
        // matching what the receive paths decode (`bincode::options()` in
        // behaviour.rs/handler.rs). The handle's own `send()` encodes with
        // plain `bincode::serialize` (FIXINT), which no receiver in
        // blueprint-networking 0.2.0-alpha.7 can decode — the reason upstream's
        // own gossip tests are `#[ignore]`d as "CI-flaky". Bypass it via the
        // public command channel until the fix lands upstream.
        let envelope = ProtocolMessage {
            protocol: self.handle.blueprint_protocol_name.to_string(),
            routing,
            payload,
        };
        let raw = match bincode::options().serialize(&envelope) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("mesh envelope encode failed: {e}");
                return;
            }
        };
        if let Err(e) = self
            .handle
            .send_network_message(NetworkCommandMessage::GossipMessage {
                source: self.handle.local_peer_id,
                topic: self.handle.blueprint_protocol_name.to_string(),
                message: raw,
            })
        {
            tracing::warn!("mesh broadcast failed: {e}");
        }
    }
}

#[async_trait]
impl ClobNet for MeshNet {
    fn gossip_order(&self, w: &WireOrder) {
        self.broadcast(&MeshWire::Order(w.clone()));
    }

    fn gossip_cancel(&self, c: &WireCancel) {
        self.broadcast(&MeshWire::Cancel(c.clone()));
    }

    async fn collect_attestations(
        &self,
        wire: &WireProposal,
        digest: B256,
        want: usize,
    ) -> Vec<Attestation> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        self.pending.lock().unwrap().insert(digest, tx);
        self.broadcast(&MeshWire::Proposal(wire.clone()));

        let mut out = Vec::new();
        let deadline = tokio::time::Instant::now() + ATTEST_TIMEOUT;
        while out.len() < want {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(att)) => out.push(att),
                _ => break, // deadline, or the channel closed
            }
        }
        self.pending.lock().unwrap().remove(&digest);
        out
    }
}

/// Inbound pump: decode mesh traffic and feed the epoch service. One per node,
/// owning its own reader clone (the handle's receivers are competing consumers,
/// so exactly one task drains a given clone).
pub fn spawn_mesh_loop(clob: SharedClob, net: Arc<MeshNet>, mut reader: MeshHandle) {
    tokio::spawn(async move {
        loop {
            let Some(msg) = reader.next_protocol_message() else {
                tokio::time::sleep(Duration::from_millis(25)).await;
                continue;
            };
            let wire: MeshWire = match serde_json::from_slice(&msg.payload) {
                Ok(w) => w,
                Err(e) => {
                    tracing::debug!("undecodable mesh payload: {e}");
                    continue;
                }
            };
            match wire {
                // Admission re-validates everything (signature, expiry,
                // instrument), so a hostile payload can at worst be refused.
                // No re-relay: gossipsub already floods the topic.
                MeshWire::Order(w) => {
                    if let Err((_, e)) = clob.admit(w.into()) {
                        tracing::debug!("mesh order refused: {e}");
                    }
                }
                MeshWire::Cancel(c) => {
                    if let Err((_, e)) = clob.admit_cancel(c) {
                        tracing::debug!("mesh cancel refused: {e}");
                    }
                }
                MeshWire::Proposal(p) => {
                    let (nonce, fills_hash) = (p.batch_nonce, p.fills_hash);
                    match clob.attest(p) {
                        Ok(att) => net.broadcast(&MeshWire::Attestation(WireAttestationMsg {
                            batch_nonce: nonce,
                            fills_hash,
                            attester: att.attester,
                            signature: att.signature,
                        })),
                        Err((status, verdict)) => {
                            tracing::warn!(%status, %verdict, "refused mesh proposal");
                        }
                    }
                }
                MeshWire::Attestation(a) => {
                    let Ok(signature) =
                        surplus_settlement::core::hex::decode(a.signature.trim_start_matches("0x"))
                    else {
                        continue;
                    };
                    let digest =
                        batch_digest(clob.book_id(), a.batch_nonce, a.fills_hash, clob.domain());
                    if let Some(tx) = net.pending.lock().unwrap().get(&digest) {
                        let _ = tx.send(Attestation {
                            attester: a.attester,
                            signature,
                        });
                    }
                }
            }
        }
    });
}

/// Boot the epoch service on the PKI mesh from env:
///   - `SURPLUS_MESH_ADDR`      listen multiaddr (e.g. `/ip4/0.0.0.0/tcp/9530`)
///   - `SURPLUS_MESH_BOOTNODES` comma-separated peer multiaddrs (optional; mDNS
///     covers single-host fleets)
/// The handshake whitelist is the configured bonded set itself — no extra key
/// distribution: peers prove their operator address by signature recovery.
pub fn start(venue: Arc<Venue>, cfg: ClobConfig) -> anyhow::Result<(SharedClob, axum::Router)> {
    let ctx = venue
        .settle
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("mesh CLOB requires settlement config"))?;
    let operator_key = ctx
        .operator_key
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("mesh CLOB requires SURPLUS_OPERATOR_KEY"))?;
    let chain_id = ctx.domain.chain_id.unwrap_or_default();
    let contract = ctx.contract;

    let listen: libp2p::Multiaddr = std::env::var("SURPLUS_MESH_ADDR")
        .unwrap_or_else(|_| "/ip4/0.0.0.0/tcp/9530".into())
        .parse()
        .map_err(|e| anyhow::anyhow!("SURPLUS_MESH_ADDR: {e}"))?;
    let bootstrap_peers: Vec<libp2p::Multiaddr> = std::env::var("SURPLUS_MESH_BOOTNODES")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.parse().map_err(|e| anyhow::anyhow!("bootnode {s}: {e}")))
        .collect::<anyhow::Result<_>>()?;

    let key_bytes = surplus_settlement::core::hex::decode(operator_key.trim_start_matches("0x"))?;
    let instance_key_pair = blueprint_crypto::k256::K256SigningKey::from_bytes(&key_bytes)
        .map_err(|e| anyhow::anyhow!("operator key as K256 secret: {e}"))?;

    let allowed: HashSet<Address> = cfg.operators.iter().map(|(a, _)| *a).collect();
    let network_config = NetworkConfig::<K256Ecdsa> {
        network_name: "surplus-clob".into(),
        // Per-deployment topic scoping: one mesh per (chain, settlement contract).
        instance_id: format!("{chain_id}-{contract:#x}"),
        instance_key_pair,
        local_key: libp2p::identity::Keypair::generate_ed25519(),
        listen_addr: listen,
        target_peer_count: cfg.operators.len() as u32,
        bootstrap_peers,
        enable_mdns: std::env::var("SURPLUS_MESH_MDNS").as_deref() == Ok("1"),
        enable_kademlia: true,
        using_evm_address_for_handshake_verification: true,
    };
    // The whitelist is static per boot (it mirrors the contract's attester set);
    // the updater channel is parked until BSM-driven operator churn lands.
    let (_allowed_tx, allowed_rx) = crossbeam_channel::unbounded();
    let service = NetworkService::new(
        network_config,
        AllowedKeys::<K256Ecdsa>::EvmAddresses(allowed),
        allowed_rx,
    )
    .map_err(|e| anyhow::anyhow!("mesh service: {e}"))?;
    let handle = service.start();

    let net = MeshNet::new(handle.clone());
    let clob = Arc::new(Clob::with_net(venue, cfg, net.clone())?);
    spawn_mesh_loop(clob.clone(), net, handle);
    crate::clob::spawn_membership_reconciler(clob.clone());
    spawn_epoch_loop(clob.clone());
    let router = crate::clob::router(clob.clone());
    tracing::info!(instance = %format!("{chain_id}-{contract:#x}"), "shared CLOB on PKI mesh");
    Ok((clob, router))
}
