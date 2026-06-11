//! Per-client token-bucket rate limiting for the venue HTTP surface (G7).
//!
//! Keyed on the first `X-Forwarded-For` hop — the venue runs behind Caddy,
//! which always sets it for external traffic. Requests WITHOUT the header are
//! local operations (the quoter timer, ops scripts on the box) and bypass the
//! limiter; the box itself is trusted. Routes carry costs so the expensive
//! surfaces (`/redeem` spends router money, `/rfq` burns a sidecar quote and a
//! signature) are throttled much harder than book reads.

use axum::http::{Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::Instant;

pub struct RateLimiter {
    buckets: Mutex<HashMap<IpAddr, Bucket>>,
    capacity: f64,
    refill_per_sec: f64,
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

impl RateLimiter {
    pub fn from_env() -> Self {
        let capacity = std::env::var("SURPLUS_RL_CAPACITY")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|v: &f64| *v > 0.0)
            .unwrap_or(60.0);
        let refill_per_sec = std::env::var("SURPLUS_RL_REFILL")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|v: &f64| *v > 0.0)
            .unwrap_or(6.0);
        RateLimiter { buckets: Mutex::new(HashMap::new()), capacity, refill_per_sec }
    }

    #[cfg(test)]
    fn new(capacity: f64, refill_per_sec: f64) -> Self {
        RateLimiter { buckets: Mutex::new(HashMap::new()), capacity, refill_per_sec }
    }

    /// Spend `cost` tokens for `ip`. Returns seconds to wait when denied.
    pub fn check(&self, ip: IpAddr, cost: f64, now: Instant) -> Result<(), u64> {
        let mut buckets = self.buckets.lock().unwrap();
        // Memory bound: drop buckets that have fully refilled (idle clients).
        if buckets.len() > 4096 {
            let full_after = self.capacity / self.refill_per_sec;
            buckets.retain(|_, b| now.duration_since(b.last).as_secs_f64() < full_after);
        }
        let b = buckets
            .entry(ip)
            .or_insert(Bucket { tokens: self.capacity, last: now });
        b.tokens = (b.tokens + now.duration_since(b.last).as_secs_f64() * self.refill_per_sec)
            .min(self.capacity);
        b.last = now;
        if b.tokens >= cost {
            b.tokens -= cost;
            Ok(())
        } else {
            Err(((cost - b.tokens) / self.refill_per_sec).ceil() as u64)
        }
    }
}

/// Route cost: expensive surfaces pay more from the same bucket.
fn route_cost(path: &str) -> f64 {
    match path {
        "/redeem" => 10.0,
        "/rfq" | "/rfq/fill" | "/redeem/receipt" | "/settlement/flush" => 3.0,
        "/health" => 0.0,
        _ => 1.0,
    }
}

fn client_ip<B>(req: &Request<B>) -> Option<IpAddr> {
    req.headers()
        .get("x-forwarded-for")?
        .to_str()
        .ok()?
        .split(',')
        .next()?
        .trim()
        .parse()
        .ok()
}

pub async fn limit(
    axum::extract::State(limiter): axum::extract::State<std::sync::Arc<RateLimiter>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let cost = route_cost(req.uri().path());
    if cost > 0.0 {
        if let Some(ip) = client_ip(&req) {
            if let Err(retry_after) = limiter.check(ip, cost, Instant::now()) {
                return (
                    StatusCode::TOO_MANY_REQUESTS,
                    [("retry-after", retry_after.to_string())],
                    "rate limited",
                )
                    .into_response();
            }
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const IP: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 7));

    #[test]
    fn burst_then_throttle_then_refill() {
        let rl = RateLimiter::new(20.0, 2.0);
        let t0 = Instant::now();
        // Burst: two /redeem calls drain the bucket.
        assert!(rl.check(IP, 10.0, t0).is_ok());
        assert!(rl.check(IP, 10.0, t0).is_ok());
        let wait = rl.check(IP, 10.0, t0).unwrap_err();
        assert_eq!(wait, 5); // 10 tokens at 2/s
        // After 5s the bucket holds exactly the cost again.
        assert!(rl.check(IP, 10.0, t0 + Duration::from_secs(5)).is_ok());
    }

    #[test]
    fn per_ip_isolation() {
        let rl = RateLimiter::new(10.0, 1.0);
        let other = IpAddr::V4(std::net::Ipv4Addr::new(198, 51, 100, 9));
        let t0 = Instant::now();
        assert!(rl.check(IP, 10.0, t0).is_ok());
        assert!(rl.check(IP, 1.0, t0).is_err());
        assert!(rl.check(other, 10.0, t0).is_ok());
    }

    #[test]
    fn cheap_routes_outlast_expensive_ones() {
        let rl = RateLimiter::new(60.0, 6.0);
        let t0 = Instant::now();
        for _ in 0..6 {
            assert!(rl.check(IP, route_cost("/redeem"), t0).is_ok());
        }
        assert!(rl.check(IP, route_cost("/redeem"), t0).is_err());
        // The same client can still read the book (cost 1 refills fast).
        assert!(rl.check(IP, route_cost("/book"), t0 + Duration::from_secs(1)).is_ok());
    }
}
