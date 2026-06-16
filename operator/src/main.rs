//! `inference-bazaar-operator-lite` — the HTTP venue with no Tangle substrate. For local
//! e2e and the first testnet smoke. The on-chain operator is `src/bin/blueprint.rs`.

use inference_bazaar_operator::http;
use inference_bazaar_operator::Venue;
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    inference_bazaar_operator::metrics::init();
    let venue = Arc::new(Venue::from_env());
    http::spawn_auto_flush(venue.clone());
    let mut app = http::router(venue.clone());

    // Shared CLOB (opt-in via INFERENCE_BAZAAR_CLOB_OPERATORS): gossip + epoch consensus.
    // Transport: PKI mesh when built with `mesh` + INFERENCE_BAZAAR_MESH_ADDR, else HTTP.
    if let Some((_clob, clob_router)) =
        inference_bazaar_operator::clob::start_from_env(venue.clone())?
    {
        app = app.merge(clob_router);
        tracing::info!("shared CLOB epoch service enabled");
    }
    // Spend channel: lots consumed via a delegated session key over the OpenAI
    // surface (the gateway signs vouchers; see docs/specs/spend-rail.md).
    let spend = std::sync::Arc::new(inference_bazaar_operator::spend::SpendSvc::new(venue));
    inference_bazaar_operator::spend::spawn_spend_flush(spend.clone());
    let app = app.merge(inference_bazaar_operator::spend::router(spend));

    // Rate limiting wraps the MERGED app — `merge` does not propagate layers.
    let app = http::rate_limited(app);

    let addr =
        std::env::var("INFERENCE_BAZAAR_OPERATOR_ADDR").unwrap_or_else(|_| "127.0.0.1:9100".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("inference-bazaar operator-lite listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
