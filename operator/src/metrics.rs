//! One metrics source, two consumers.
//!
//! Every load-bearing event the operator handles increments a counter or sets a
//! gauge in a tiny dependency-free registry. That registry serves:
//!
//!   1. **Operations** — `GET /metrics` renders Prometheus text so we can scrape
//!      and alert (audit H6: today "batches stopped landing" is invisible
//!      without journalctl). Pull-based, internal.
//!   2. **Reputation** — the attributable subset (work this operator did:
//!      batches settled, tokens served, quorum participation) is exposed as
//!      `(name, u64)` pairs through the blueprint QoS `MetricsSource`, which the
//!      heartbeat service ABI-encodes and submits ON-CHAIN. That on-chain QoS
//!      record is what reputation, reward, and slashing read — and what the UI
//!      can eventually surface as per-operator trust.
//!
//! The split is deliberate: SELF-reported metrics only ever prove *positive*
//! work (you can't be trusted to report your own censorship). Adversarial
//! signals — a proposer that forged or censored — are reported by PEERS through
//! the fraud-claim/slashing path, never self-attested here. So this module is
//! the "good behavior" half of reputation; the BSM challenge path is the other.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// A monotonic counter, optionally with one `verdict`/`kind` label dimension.
#[derive(Default)]
struct Counter {
    /// Unlabeled total, plus per-label totals.
    total: AtomicU64,
    labeled: Mutex<BTreeMap<String, u64>>,
}

pub struct Metrics {
    counters: Mutex<BTreeMap<&'static str, Counter>>,
    gauges: Mutex<BTreeMap<&'static str, AtomicI64>>,
}

static METRICS: OnceLock<Metrics> = OnceLock::new();

pub fn metrics() -> &'static Metrics {
    METRICS.get_or_init(|| Metrics {
        counters: Mutex::new(BTreeMap::new()),
        gauges: Mutex::new(BTreeMap::new()),
    })
}

/// `metrics::inc("inference_bazaar_clob_quorum_reached_total")`.
pub fn inc(name: &'static str) {
    inc_by(name, 1);
}

pub fn inc_by(name: &'static str, n: u64) {
    let mut map = metrics().counters.lock().unwrap();
    map.entry(name)
        .or_default()
        .total
        .fetch_add(n, Ordering::Relaxed);
}

/// `metrics::inc_labeled("inference_bazaar_clob_attestations_refused_total", "forged")`.
pub fn inc_labeled(name: &'static str, label: &str) {
    let m = metrics();
    let mut map = m.counters.lock().unwrap();
    let c = map.entry(name).or_default();
    c.total.fetch_add(1, Ordering::Relaxed);
    *c.labeled
        .lock()
        .unwrap()
        .entry(label.to_string())
        .or_insert(0) += 1;
}

/// Absolute value (pool depth, outbox depth). Last writer wins.
pub fn set_gauge(name: &'static str, value: i64) {
    let m = metrics();
    let mut map = m.gauges.lock().unwrap();
    map.entry(name).or_default().store(value, Ordering::Relaxed);
}

/// Register every known series at 0 so `/metrics` exposes the full set from
/// boot (a counter at 0 is a real datapoint; a missing series breaks `rate()`
/// and "flatlined to zero" alerts). Call once at operator startup.
pub fn init() {
    use names::*;
    for c in [
        EPOCHS_RUN,
        QUORUM_REACHED,
        QUORUM_FAILED,
        ATTEST_SIGNED,
        ATTEST_REFUSED,
        BATCHES_SUBMITTED,
        SUBMIT_REVERTS,
        GOSSIP_SEND_FAILURES,
        FILLS,
        SPEND_KEYS,
        SPEND_SERVED_TOKENS,
        SPEND_SETTLED_TOKENS,
        REDEEM_SERVED_TOKENS,
    ] {
        inc_by(c, 0);
    }
    set_gauge(POOL_SIZE, 0);
}

impl Metrics {
    /// Prometheus text exposition. One HELP/TYPE per metric; labeled series get
    /// a `{verdict="…"}` line plus the unlabeled total.
    pub fn render_prometheus(&self) -> String {
        let mut out = String::new();
        for (name, c) in self.counters.lock().unwrap().iter() {
            out.push_str(&format!("# TYPE {name} counter\n"));
            out.push_str(&format!("{name} {}\n", c.total.load(Ordering::Relaxed)));
            for (label, v) in c.labeled.lock().unwrap().iter() {
                out.push_str(&format!("{name}{{verdict=\"{label}\"}} {v}\n"));
            }
        }
        for (name, g) in self.gauges.lock().unwrap().iter() {
            out.push_str(&format!("# TYPE {name} gauge\n"));
            out.push_str(&format!("{name} {}\n", g.load(Ordering::Relaxed)));
        }
        out
    }

    /// The reputation-relevant subset, as the `(name, u64)` pairs the blueprint
    /// QoS `MetricsSource` submits on-chain. Only positive, self-provable work —
    /// the operator's contribution to liveness and service. Gauges and
    /// adversarial counters are intentionally excluded (a gauge isn't a
    /// cumulative reputation signal; censorship is peer-reported, not
    /// self-reported).
    pub fn reputation_pairs(&self) -> Vec<(String, u64)> {
        const REPUTABLE: &[&str] = &[
            "inference_bazaar_clob_batches_submitted_total",
            "inference_bazaar_clob_attestations_signed_total",
            "inference_bazaar_settlement_fills_total",
            "inference_bazaar_spend_served_tokens_total",
            "inference_bazaar_redeem_served_tokens_total",
        ];
        let map = self.counters.lock().unwrap();
        REPUTABLE
            .iter()
            .filter_map(|&name| {
                map.get(name)
                    .map(|c| (name.to_string(), c.total.load(Ordering::Relaxed)))
            })
            .collect()
    }
}

// ─────────────────────────── Metric name constants ───────────────────────────
// Referenced from the hot paths so a typo is a compile error, not a silent
// missing series.

pub mod names {
    // Shared CLOB consensus.
    pub const EPOCHS_RUN: &str = "inference_bazaar_clob_epochs_run_total";
    pub const QUORUM_REACHED: &str = "inference_bazaar_clob_quorum_reached_total";
    pub const QUORUM_FAILED: &str = "inference_bazaar_clob_quorum_failed_total";
    pub const ATTEST_SIGNED: &str = "inference_bazaar_clob_attestations_signed_total";
    pub const ATTEST_REFUSED: &str = "inference_bazaar_clob_attestations_refused_total";
    pub const BATCHES_SUBMITTED: &str = "inference_bazaar_clob_batches_submitted_total";
    pub const SUBMIT_REVERTS: &str = "inference_bazaar_clob_submit_reverts_total";
    pub const GOSSIP_SEND_FAILURES: &str = "inference_bazaar_clob_gossip_send_failures_total";
    pub const POOL_SIZE: &str = "inference_bazaar_clob_pool_size";
    // Settlement + consumption.
    pub const FILLS: &str = "inference_bazaar_settlement_fills_total";
    pub const SPEND_KEYS: &str = "inference_bazaar_spend_keys_total";
    pub const SPEND_SERVED_TOKENS: &str = "inference_bazaar_spend_served_tokens_total";
    pub const SPEND_SETTLED_TOKENS: &str = "inference_bazaar_spend_settled_tokens_total";
    pub const REDEEM_SERVED_TOKENS: &str = "inference_bazaar_redeem_served_tokens_total";
}

// ─────────────────────── On-chain reputation (QoS) ───────────────────────────
//
// The blueprint QoS heartbeat reads `MetricsSource::get_custom_metrics`,
// ABI-encodes the pairs, and submits them on-chain with each heartbeat — that
// record is what reputation/reward/slashing consume and what the UI can render
// as per-operator trust. We feed it `reputation_pairs()` (positive work only).
//
// Wire it in the blueprint runner via `QoSServiceBuilder::with_metrics_source`.
// `clear_custom_metrics` is a deliberate no-op: our counters are cumulative
// totals (lifetime work), not a per-interval delta to drain — the on-chain
// consumer reads them as running totals, the way an odometer reads.
#[cfg(feature = "blueprint")]
mod qos {
    use super::metrics;
    use std::future::Future;
    use std::pin::Pin;

    pub struct InferenceBazaarMetricsSource;

    impl blueprint_sdk::qos::heartbeat::MetricsSource for InferenceBazaarMetricsSource {
        fn get_custom_metrics(
            &self,
        ) -> Pin<Box<dyn Future<Output = Vec<(String, u64)>> + Send + '_>> {
            Box::pin(async { metrics().reputation_pairs() })
        }

        fn clear_custom_metrics(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            Box::pin(async {})
        }
    }
}

#[cfg(feature = "blueprint")]
pub use qos::InferenceBazaarMetricsSource;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_counters_gauges_and_labels() {
        inc(names::BATCHES_SUBMITTED);
        inc(names::BATCHES_SUBMITTED);
        inc_labeled(names::ATTEST_REFUSED, "forged");
        inc_labeled(names::ATTEST_REFUSED, "censored");
        set_gauge(names::POOL_SIZE, 7);
        let text = metrics().render_prometheus();
        assert!(text.contains("inference_bazaar_clob_batches_submitted_total 2"));
        assert!(text.contains("inference_bazaar_clob_attestations_refused_total{verdict=\"forged\"} 1"));
        assert!(text.contains("inference_bazaar_clob_pool_size 7"));
    }

    #[test]
    fn reputation_is_positive_work_only() {
        inc_by(names::SPEND_SERVED_TOKENS, 137);
        let pairs = metrics().reputation_pairs();
        let served = pairs.iter().find(|(k, _)| k == names::SPEND_SERVED_TOKENS);
        assert_eq!(served.map(|(_, v)| *v), Some(137).map(|v| v as u64));
        // Adversarial / gauge series never appear in the on-chain reputation set.
        assert!(!pairs
            .iter()
            .any(|(k, _)| k == names::ATTEST_REFUSED || k == names::POOL_SIZE));
    }
}
