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
    let mut app = http::router(venue.clone());

    // Shared CLOB (opt-in via SURPLUS_CLOB_OPERATORS): gossip + epoch consensus.
    if let Some(cfg) = surplus_operator::clob::ClobConfig::from_env() {
        let clob = Arc::new(surplus_operator::clob::Clob::new(venue, cfg)?);
        surplus_operator::clob::spawn_epoch_loop(clob.clone());
        app = app.merge(surplus_operator::clob::router(clob));
        tracing::info!("shared CLOB epoch service enabled");
    }

    let addr = std::env::var("SURPLUS_OPERATOR_ADDR").unwrap_or_else(|_| "127.0.0.1:9100".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("surplus operator-lite listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
