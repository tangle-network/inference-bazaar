use serde::{Deserialize, Serialize};

/// Order side. `Buy` lifts asks; `Sell` hits bids.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn opposite(self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
}

/// A limit order. Units are integers, fixed across the whole system:
/// `price` = micro-tsUSD per 1M tokens; `qty` = tokens; `ts` = caller-supplied
/// epoch ms (the time-priority key — nothing here reads a clock).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Order {
    pub id: String,
    pub instrument_id: String,
    pub side: Side,
    pub price: i64,
    pub qty: i64,
    pub owner: String,
    pub ts: i64,
}

/// One match print. Execution price is the maker's resting price.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fill {
    pub instrument_id: String,
    pub maker_order_id: String,
    pub taker_order_id: String,
    pub maker_owner: String,
    pub taker_owner: String,
    pub price: i64,
    pub qty: i64,
    pub taker_side: Side,
    pub ts: i64,
}

impl Fill {
    /// Notional in micro-tsUSD for this fill (rounded half-up).
    pub fn notional_micro(&self) -> i64 {
        ((self.price as i128 * self.qty as i128 + 500_000) / 1_000_000) as i64
    }
}

/// Result of placing one order: prints produced, plus the remainder that rested.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlaceOutcome {
    pub fills: Vec<Fill>,
    /// The unfilled remainder now resting on the book, if any.
    pub resting: Option<Order>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BookLevel {
    pub price: i64,
    pub qty: i64,
    pub orders: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BookSnapshot {
    pub instrument_id: String,
    /// Descending by price.
    pub bids: Vec<BookLevel>,
    /// Ascending by price.
    pub asks: Vec<BookLevel>,
    pub last_trade_price: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MatchError {
    WrongInstrument { expected: String, got: String },
    InvalidPrice(i64),
    OffTick { price: i64, tick: i64 },
    BelowMinQty { qty: i64, min: i64 },
    DuplicateId(String),
}

impl std::fmt::Display for MatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MatchError::WrongInstrument { expected, got } => {
                write!(f, "order for {got} sent to book {expected}")
            }
            MatchError::InvalidPrice(p) => write!(f, "invalid price: {p}"),
            MatchError::OffTick { price, tick } => write!(f, "price {price} off tick {tick}"),
            MatchError::BelowMinQty { qty, min } => write!(f, "qty {qty} below minQty {min}"),
            MatchError::DuplicateId(id) => write!(f, "duplicate order id: {id}"),
        }
    }
}

impl std::error::Error for MatchError {}
