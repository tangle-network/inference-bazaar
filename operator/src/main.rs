//! `surplus-operator-lite` — the HTTP venue with no Tangle substrate. For local
//! e2e and the first testnet smoke. The on-chain operator is `src/bin/blueprint.rs`.

use std::sync::Arc;
use surplus_operator::http;
use surplus_operator::Venue;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let venue = Arc::new(Venue::from_env());
    http::spawn_auto_flush(venue.clone());
    let app = http::router(venue);

    let addr = std::env::var("SURPLUS_OPERATOR_ADDR").unwrap_or_else(|_| "127.0.0.1:9100".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("surplus operator-lite listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
