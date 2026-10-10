//! Bounded retry for transient JSON-RPC failures (feature `chain`).
//!
//! Proven necessary on public testnet RPCs: Tempo's moderato endpoint 429s
//! intermittently under load ("rate limited, try again in Nms"), and a single
//! failed call used to abort the CLOB's whole epoch proposal. Two policies:
//!
//! - [`RetryPolicy::READ`] retries rate-limits, 5xx, timeouts, and connection
//!   errors — reads are idempotent.
//! - [`RetryPolicy::SEND`] retries ONLY rate-limits and 5xx (the request was
//!   rejected before execution). A timeout/connection error on a send means the
//!   tx may have landed — never blind-retry it; the caller's nonce read on the
//!   next attempt makes a landed tx a no-op.
//!
//! When the server's body carries a hint ("try again in Nms"/"Ns") it is honored
//! (floored by the exponential backoff, capped by `cap` — it is untrusted input).

use std::time::Duration;

#[derive(Clone, Copy, Debug)]
pub struct RetryPolicy {
    /// Total attempts (1 = no retry).
    pub max_attempts: u32,
    /// First backoff; doubles each attempt.
    pub base: Duration,
    /// Ceiling for both the backoff and the server hint.
    pub cap: Duration,
    /// Send semantics: do not retry timeout/connection errors (the tx may be in).
    pub send: bool,
}

impl RetryPolicy {
    pub const READ: RetryPolicy = RetryPolicy {
        max_attempts: 6,
        base: Duration::from_millis(200),
        cap: Duration::from_secs(4),
        send: false,
    };
    pub const SEND: RetryPolicy = RetryPolicy {
        max_attempts: 6,
        base: Duration::from_millis(200),
        cap: Duration::from_secs(4),
        send: true,
    };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Class {
    RateLimited,
    Server,
    Timeout,
    Conn,
    Permanent,
}

/// Classify by the error's full chain text. alloy surfaces transport failures
/// as "HTTP error 429 with body: …" and reqwest failures as "error sending
/// request …"; there is no stable typed path through `ContractError`, and the
/// JSON-RPC code (-32005) only survives in the body text.
fn classify(text: &str) -> Class {
    let t = text.to_lowercase();
    if t.contains("429")
        || t.contains("rate limited")
        || t.contains("-32005")
        || t.contains("too many requests")
    {
        Class::RateLimited
    } else if t.contains("http error 5") {
        Class::Server
    } else if t.contains("timed out") || t.contains("timeout") {
        Class::Timeout
    } else if t.contains("error sending request")
        || t.contains("connection refused")
        || t.contains("connection reset")
        || t.contains("dns error")
    {
        Class::Conn
    } else {
        Class::Permanent
    }
}

/// Parse a server backoff hint: "try again in 42ms" / "try again in 3s".
pub fn parse_retry_hint(text: &str) -> Option<Duration> {
    let t = text.to_lowercase();
    let at = t.find("try again in ")? + "try again in ".len();
    let rest = &t[at..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let n: u64 = digits.parse().ok()?;
    let unit = rest[digits.len()..].trim_start();
    if unit.starts_with("ms") {
        Some(Duration::from_millis(n))
    } else if unit.starts_with('s') {
        Some(Duration::from_secs(n))
    } else {
        None
    }
}

/// The error's whole source chain as one haystack — the transport detail
/// (status, body) sits below the contract-call wrapper.
fn chain_text<E: std::error::Error>(e: &E) -> String {
    let mut s = e.to_string();
    let mut src = std::error::Error::source(e);
    let mut depth = 0;
    while let Some(c) = src {
        if depth >= 8 {
            break;
        }
        s.push_str(": ");
        s.push_str(&c.to_string());
        src = c.source();
        depth += 1;
    }
    s
}

/// Run `f` with bounded retries per `policy`. The final error carries the
/// attempt count and the original error chain.
pub async fn run<T, E, F, Fut>(policy: RetryPolicy, label: &str, mut f: F) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    E: std::error::Error + Send + Sync + 'static,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                attempt += 1;
                let text = chain_text(&e);
                let retryable = match classify(&text) {
                    Class::RateLimited | Class::Server => true,
                    // A send that timed out may have landed — do not resend.
                    Class::Timeout | Class::Conn => !policy.send,
                    Class::Permanent => false,
                };
                if !retryable || attempt >= policy.max_attempts {
                    return Err(anyhow::Error::new(e)
                        .context(format!("{label}: giving up after {attempt} attempt(s)")));
                }
                let exp = (policy.base * 2u32.saturating_pow(attempt - 1)).min(policy.cap);
                let wait = parse_retry_hint(&text)
                    .map(|h| h.max(exp))
                    .unwrap_or(exp)
                    .min(policy.cap);
                tokio::time::sleep(wait).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[derive(Debug)]
    struct TestErr(String);
    impl std::fmt::Display for TestErr {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(&self.0)
        }
    }
    impl std::error::Error for TestErr {}

    fn fast(send: bool, max_attempts: u32) -> RetryPolicy {
        RetryPolicy {
            max_attempts,
            base: Duration::from_millis(5),
            cap: Duration::from_secs(1),
            send,
        }
    }

    const RATE_LIMITED: &str = "HTTP error 429 with body: {\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32005,\"message\":\"rate limited, try again in 2ms\",\"data\":null}}";

    #[test]
    fn parses_server_hint() {
        assert_eq!(
            parse_retry_hint("rate limited, try again in 42ms"),
            Some(Duration::from_millis(42))
        );
        assert_eq!(
            parse_retry_hint("try again in 3s"),
            Some(Duration::from_secs(3))
        );
        assert_eq!(parse_retry_hint("execution reverted"), None);
        assert_eq!(parse_retry_hint("try again in a bit"), None);
    }

    #[tokio::test]
    async fn retries_429_then_succeeds() {
        let calls = AtomicU32::new(0);
        let v = run(fast(false, 5), "read", || async {
            calls.fetch_add(1, Ordering::Relaxed);
            if calls.load(Ordering::Relaxed) == 1 {
                Err(TestErr(RATE_LIMITED.into()))
            } else {
                Ok(7)
            }
        })
        .await
        .unwrap();
        assert_eq!(v, 7);
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn honors_server_hint() {
        // Two failures each carrying a 120ms hint; the policy's 5ms base must
        // not shrink the wait below the server's ask.
        let calls = AtomicU32::new(0);
        let err = TestErr(
            "HTTP error 429 with body: {\"error\":{\"message\":\"rate limited, try again in 120ms\"}}"
                .into(),
        );
        let start = std::time::Instant::now();
        let v = run(fast(false, 5), "read", || {
            let e = TestErr(err.0.clone());
            let calls = &calls;
            async move {
                if calls.fetch_add(1, Ordering::Relaxed) < 2 {
                    Err(e)
                } else {
                    Ok(1)
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(v, 1);
        assert_eq!(calls.load(Ordering::Relaxed), 3);
        assert!(
            start.elapsed() >= Duration::from_millis(180),
            "two 120ms hints must be honored: {:?}",
            start.elapsed()
        );
    }

    #[tokio::test]
    async fn gives_up_after_max_attempts() {
        let calls = AtomicU32::new(0);
        let err = run(fast(false, 4), "read", || async {
            calls.fetch_add(1, Ordering::Relaxed);
            Err::<(), _>(TestErr(RATE_LIMITED.into()))
        })
        .await
        .unwrap_err();
        assert_eq!(calls.load(Ordering::Relaxed), 4);
        assert!(format!("{err:#}").contains("giving up after 4 attempt"));
    }

    #[tokio::test]
    async fn permanent_errors_are_not_retried() {
        let calls = AtomicU32::new(0);
        let err = run(fast(false, 5), "read", || async {
            calls.fetch_add(1, Ordering::Relaxed);
            Err::<(), _>(TestErr("execution reverted: InsufficientBalance".into()))
        })
        .await
        .unwrap_err();
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert!(format!("{err:#}").contains("InsufficientBalance"));
    }

    #[tokio::test]
    async fn send_policy_never_retries_a_timeout() {
        let calls = AtomicU32::new(0);
        let _ = run(fast(true, 5), "send", || async {
            calls.fetch_add(1, Ordering::Relaxed);
            Err::<(), _>(TestErr("error sending request: operation timed out".into()))
        })
        .await
        .unwrap_err();
        assert_eq!(
            calls.load(Ordering::Relaxed),
            1,
            "a timed-out send may have landed"
        );
    }

    #[tokio::test]
    async fn read_policy_retries_a_timeout() {
        let calls = AtomicU32::new(0);
        let v = run(fast(false, 5), "read", || async {
            if calls.fetch_add(1, Ordering::Relaxed) == 0 {
                Err(TestErr("operation timed out".into()))
            } else {
                Ok(9)
            }
        })
        .await
        .unwrap();
        assert_eq!(v, 9);
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn send_policy_retries_429() {
        // A 429 rejected the request before execution — resending is safe.
        let calls = AtomicU32::new(0);
        let v = run(fast(true, 5), "send", || async {
            if calls.fetch_add(1, Ordering::Relaxed) == 0 {
                Err(TestErr(RATE_LIMITED.into()))
            } else {
                Ok("0xtx")
            }
        })
        .await
        .unwrap();
        assert_eq!(v, "0xtx");
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }
}
