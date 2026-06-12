// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { ISP1Verifier } from "./interfaces/ISP1Verifier.sol";

/// @title SurplusSettlement — atomic settlement + redemption guarantee for inference-token credits.
///
/// The market trades EIP-712 *firm orders*: a CLOB order and an RFQ quote are the
/// same signed struct, so one settlement path serves both. Settlement is atomic by
/// construction — there is no escrow limbo: a fill debits the buyer, pays the
/// seller, and mints/transfers the credit lot in ONE transaction, or reverts with
/// no state change. The buyer's "definitely get the spend" guarantee is the lot:
///
///  1. A lot is a claim on a bonded ISSUER (the operator who minted it). Minting
///     requires payment-token collateral covering the lot's refund value plus the
///     default penalty, so every outstanding lot is fully cash-backed on-chain.
///  2. The holder redeems by opening a redemption (deadline = redemptionWindow).
///     The issuer serves inference off-chain (through the router) and settles
///     with the holder's signed receipt — or, in dispute, an attester quorum.
///  3. If the issuer misses the deadline, anyone triggers the default: the holder
///     is refunded the lot's paid value plus a penalty, straight from the
///     issuer's collateral. The default is recorded for the BSM to slash restake
///     on top (deterrence; compensation never depends on slash routing).
///  4. An expired lot's unredeemed value is likewise refundable — paid, unserved
///     spend always comes back as cash.
///
/// Two settlement paths share one fill-application core:
///  - `settleFills`: full orders + signatures, contract verifies everything.
///    Trustless; the default path.
///  - `settleBatch*`: signature-free fills, signature validity vouched by an
///    attester quorum (`Attested`) or an SP1 proof of the same statement
///    (`Proven`, public values `(domainSeparator, bookId, batchNonce,
///    fillsHash)`). Everything except signature validity (limits, crossing,
///    cumulative fill caps, balance/collateral invariants) is still enforced
///    here, so the quorum cannot invent balances. But be precise about what it
///    CAN do: "vouch for signatures that were never made" IS the power to forge
///    any order from any funded trader (drain their cash into a lot, or round-
///    trip a rival issuer's collateral via claimDefault). The attested path's
///    entire authenticity rests on quorum honesty; the proven path replaces that
///    trust with a proof. Redemption attestation is bound to the lot's own
///    issuing book (`lotBook`) so no foreign quorum can confiscate a credit.
contract SurplusSettlement is EIP712, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ═══════════════════════════════════ Types ═══════════════════════════════════

    /// A firm commitment to trade. side 0 = buy (pay cash, receive credit),
    /// side 1 = sell (deliver credit). A sell with lotId == 0 mints a fresh lot
    /// backed by the seller's collateral; lotId != 0 resells an existing lot.
    struct Order {
        bytes32 instrument; // keccak256(instrumentId string), e.g. "anthropic/claude-opus-4-8:output"
        uint8 side;
        uint64 priceMicroPerM; // limit price, micro-tsUSD per 1M tokens
        uint64 qtyTokens;
        bytes32 lotId;
        address trader;
        uint64 expiry; // unix seconds; the firm-quote TTL
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

    /// A fill whose signatures were verified off-chain (quorum- or proof-vouched).
    struct BatchFill {
        Order buy;
        Order sell;
        uint64 qtyTokens;
        uint64 execPriceMicroPerM;
    }

    struct Lot {
        address holder;
        address issuer;
        bytes32 instrument;
        uint64 qtyTokens; // remaining redeemable (includes locked)
        uint64 lockedTokens; // reserved by the open redemption
        uint64 expiry;
        uint128 notionalMicro; // remaining refund value (what the holder paid)
    }

    enum RedemptionState {
        None,
        Open,
        Settled,
        Defaulted
    }

    struct Redemption {
        bytes32 lotId;
        address holder;
        uint64 qtyTokens;
        uint64 deadline;
        RedemptionState state;
    }

    /// One wallet signature that turns a lot into an API key: the holder
    /// authorizes the key whose keccak256 is `keyHash` to draw down `lotId`,
    /// up to `maxTokens` cumulative, until `expiry`. The issuer serves plain
    /// bearer-authenticated requests off-chain and presents this authorization
    /// to settle what it served — no per-request signatures, no receipts. The
    /// holder's protections are the cap, on-chain revocation, the issuer's
    /// collateral + slashable bond, and that the signature binds to the
    /// CURRENT holder (reselling the lot invalidates every outstanding key).
    struct SpendKeyAuth {
        bytes32 lotId;
        bytes32 keyHash;
        uint64 maxTokens;
        uint64 expiry;
    }

    struct DefaultRecord {
        address issuer;
        uint128 amountMicro;
        bytes32 redemptionId;
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(bytes32 instrument,uint8 side,uint64 priceMicroPerM,uint64 qtyTokens,bytes32 lotId,address trader,uint64 expiry,bytes32 salt)"
    );
    bytes32 public constant RECEIPT_TYPEHASH = keccak256("RedemptionReceipt(bytes32 redemptionId,uint64 servedTokens)");
    bytes32 public constant SPEND_TYPEHASH =
        keccak256("SpendKeyAuth(bytes32 lotId,bytes32 keyHash,uint64 maxTokens,uint64 expiry)");
    bytes32 public constant BATCH_TYPEHASH =
        keccak256("SettlementBatch(bytes32 bookId,uint64 batchNonce,bytes32 fillsHash)");

    // ═══════════════════════════════════ Config ══════════════════════════════════

    IERC20 public immutable paymentToken; // tsUSD, 6 decimals (micro = base unit)
    uint64 public immutable creditTtl; // seconds a minted lot stays redeemable
    uint64 public immutable redemptionWindow; // seconds an issuer has to serve
    uint16 public immutable defaultPenaltyBps; // holder bonus on issuer default
    uint16 public immutable feeBps; // platform take on fill notional
    address public immutable feeRecipient;

    ISP1Verifier public sp1Verifier; // zero => proven path disabled
    bytes32 public batchProgramVKey;

    /// One matching domain: a shared order book run by one service instance's
    /// operator set. Each book has its OWN attester quorum (instance #2's
    /// operators get no signing power over instance #1's batches), its OWN
    /// nonce (instances settle in parallel — concurrent quorums on different
    /// books never race or invalidate each other), and its OWN fee cut (the
    /// party that funds the instance earns from its flow). The protocol-level
    /// `feeBps`/`feeRecipient` stay global and unchanged.
    struct Book {
        uint16 threshold; // 0 => book not registered
        uint16 feeBps; // book sponsor's take on fill notional, on top of the protocol fee
        uint64 nonce; // per-book batch nonce — scopes every quorum signature
        address feeRecipient;
        EnumerableSet.AddressSet attesters;
    }

    mapping(bytes32 => Book) private _books;

    // ═══════════════════════════════════ State ═══════════════════════════════════

    mapping(address => uint256) public balances; // free cash, micro-tsUSD
    mapping(address => uint256) public collateral; // issuer bond backing minted lots
    mapping(address => uint256) public liability; // outstanding refund value of issued lots

    mapping(bytes32 => uint64) public filled; // order digest => cumulative filled qty
    mapping(bytes32 => bool) public cancelled;

    mapping(bytes32 => Lot) public lots;
    /// lotId => the book whose attester quorum may attest service for this lot.
    /// A lot minted through a book batch records that book; a lot minted on the
    /// trustless `settleFills` path has no instance quorum and records `NO_BOOK`,
    /// which is never a registrable book — so its only redemption paths are the
    /// holder's own signed receipt and `claimDefault`. This binding is what stops
    /// an UNRELATED book's quorum (another instance, or an owner-minted 1-of-1
    /// book) from attesting away a holder's credit: `settleRedemptionAttested`
    /// requires the passed book to equal the lot's issuing book.
    mapping(bytes32 => bytes32) public lotBook;
    mapping(bytes32 => Redemption) public redemptions;
    mapping(bytes32 => bytes32) public openRedemptionOf; // lotId => open redemption id

    mapping(bytes32 => uint64) public spendSettled; // spend-auth digest => cumulative tokens settled
    mapping(bytes32 => bool) public spendRevoked; // spend-auth digest => holder killed the key

    /// Sentinel issuing-book for lots minted outside any book (the `settleFills`
    /// path). `registerBook` rejects it, so no quorum can ever match it.
    bytes32 public constant NO_BOOK = bytes32(type(uint256).max);

    DefaultRecord[] private _defaults;
    uint64 private _redemptionNonce;

    // ═══════════════════════════════════ Events ══════════════════════════════════

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event CollateralDeposited(address indexed issuer, uint256 amount);
    event CollateralWithdrawn(address indexed issuer, uint256 amount);
    event OrderCancelled(bytes32 indexed orderHash, address indexed trader);
    event FillSettled(
        bytes32 indexed buyOrderHash,
        bytes32 indexed sellOrderHash,
        bytes32 instrument,
        uint64 qtyTokens,
        uint64 execPriceMicroPerM,
        uint256 costMicro,
        bytes32 lotId
    );
    event BatchSettled(
        bytes32 indexed bookId, uint64 indexed batchNonce, bytes32 fillsHash, uint256 fillCount, bool proven
    );
    event RedemptionRequested(
        bytes32 indexed redemptionId,
        bytes32 indexed lotId,
        address indexed issuer,
        address holder,
        uint64 qtyTokens,
        uint64 deadline
    );
    event SpendSettled(
        bytes32 indexed authDigest, bytes32 indexed lotId, uint64 deltaTokens, uint64 cumulativeTokens, uint256 debitMicro
    );
    event SpendKeyRevoked(bytes32 indexed authDigest, bytes32 indexed lotId);
    event RedemptionSettled(bytes32 indexed redemptionId, uint64 servedTokens, uint256 notionalDebitMicro);
    event RedemptionDefaulted(
        uint256 indexed defaultId,
        bytes32 indexed redemptionId,
        address indexed issuer,
        address holder,
        uint256 payoutMicro
    );
    event LotExpiredReclaimed(bytes32 indexed lotId, address indexed holder, uint256 refundMicro);
    event LotTransferred(bytes32 indexed lotId, address indexed from, address indexed to);
    event BookRegistered(
        bytes32 indexed bookId, address[] attesters, uint16 threshold, uint16 feeBps, address feeRecipient
    );
    event AttestersRotated(bytes32 indexed bookId, address[] attesters, uint16 threshold);
    event Sp1VerifierSet(address verifier, bytes32 vkey);

    // ═══════════════════════════════════ Errors ══════════════════════════════════

    error InsufficientBalance(uint256 available, uint256 required);
    error InsufficientCollateral(uint256 available, uint256 required);
    error InvalidOrderPair();
    error OrderExpired(bytes32 orderHash);
    error OrderIsCancelled(bytes32 orderHash);
    error Overfill(bytes32 orderHash, uint64 remaining, uint64 requested);
    error BadSignature(bytes32 orderHash);
    error PriceOutsideLimits(uint64 execPrice, uint64 buyLimit, uint64 sellLimit);
    error SelfFill();
    error NotTrader();
    error LotNotFound(bytes32 lotId);
    error NotLotHolder(bytes32 lotId);
    error LotIsExpired(bytes32 lotId);
    error LotNotExpired(bytes32 lotId);
    error LotQtyUnavailable(uint64 available, uint64 requested);
    error RedemptionAlreadyOpen(bytes32 lotId);
    error RedemptionNotOpen(bytes32 redemptionId);
    error RedemptionDeadlineNotPassed(bytes32 redemptionId);
    error RedemptionDeadlinePassed(bytes32 redemptionId);
    error ServedExceedsRequested(uint64 served, uint64 requested);
    error BadReceipt(bytes32 redemptionId);
    error BadSpendAuth(bytes32 authDigest);
    error SpendAuthExpired(bytes32 authDigest);
    error SpendKeyIsRevoked(bytes32 authDigest);
    error SpendCapExceeded(uint64 cap, uint64 requested);
    error NothingToSettle(bytes32 authDigest);
    error BadQuorum();
    error UnknownBook(bytes32 bookId);
    error InvalidThreshold();
    error InvalidFee();
    error ProvenPathDisabled();
    error ZeroAmount();
    error BookAlreadyRegistered(bytes32 bookId);
    error ReservedBookId();
    error RedemptionBookMismatch(bytes32 lotBookId, bytes32 attestedBookId);

    constructor(
        IERC20 _paymentToken,
        uint64 _creditTtl,
        uint64 _redemptionWindow,
        uint16 _defaultPenaltyBps,
        uint16 _feeBps,
        address _feeRecipient
    )
        EIP712("SurplusSettlement", "1")
        Ownable(msg.sender)
    {
        if (_feeBps > 10_000 || _defaultPenaltyBps > 10_000) revert InvalidFee();
        paymentToken = _paymentToken;
        creditTtl = _creditTtl;
        redemptionWindow = _redemptionWindow;
        defaultPenaltyBps = _defaultPenaltyBps;
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
    }

    // ═══════════════════════════════ Cash + collateral ═══════════════════════════

    function deposit(uint256 amount) external {
        depositFor(msg.sender, amount);
    }

    /// Fund another account's balance (on-ramp adapters: an operator claiming a
    /// ShieldedCredits SpendAuth deposits the proceeds for the buyer here).
    function depositFor(address account, uint256 amount) public nonReentrant {
        if (amount == 0) revert ZeroAmount();
        paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        balances[account] += amount;
        emit Deposited(account, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        uint256 bal = balances[msg.sender];
        if (bal < amount) revert InsufficientBalance(bal, amount);
        balances[msg.sender] = bal - amount;
        paymentToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function depositCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        collateral[msg.sender] += amount;
        emit CollateralDeposited(msg.sender, amount);
    }

    /// Withdraw collateral not backing outstanding lots (incl. penalty headroom).
    function withdrawCollateral(uint256 amount) external nonReentrant {
        uint256 free = collateral[msg.sender] - requiredCollateral(msg.sender);
        if (free < amount) revert InsufficientCollateral(free, amount);
        collateral[msg.sender] -= amount;
        paymentToken.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    /// Collateral an issuer must hold: outstanding refund value plus the default
    /// penalty on all of it — so a full default on every lot is always payable.
    function requiredCollateral(address issuer) public view returns (uint256) {
        uint256 liab = liability[issuer];
        return liab + (liab * defaultPenaltyBps) / 10_000;
    }

    // ═══════════════════════════════ Order lifecycle ═════════════════════════════

    function hashOrder(Order calldata o) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH, o.instrument, o.side, o.priceMicroPerM, o.qtyTokens, o.lotId, o.trader, o.expiry, o.salt
            )
        );
    }

    function orderDigest(Order calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(hashOrder(o));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function cancelOrder(Order calldata o) external {
        if (msg.sender != o.trader) revert NotTrader();
        bytes32 h = hashOrder(o);
        cancelled[h] = true;
        emit OrderCancelled(h, o.trader);
    }

    // ═══════════════════════════════ Fill settlement ═════════════════════════════

    /// Trustless path: full orders + signatures; the contract verifies everything.
    /// Anyone may submit (the venue is just a relayer; a fill cannot be forged).
    function settleFills(FillInput[] calldata fills) external {
        for (uint256 i = 0; i < fills.length; i++) {
            FillInput calldata f = fills[i];
            bytes32 buyHash = _verifySig(f.buy, f.buySig);
            bytes32 sellHash = _verifySig(f.sell, f.sellSig);
            // Trustless path: no book context, so any minted lot is `NO_BOOK`
            // and not attestable by any quorum.
            _applyFill(f.buy, buyHash, f.sell, sellHash, f.qtyTokens, f.execPriceMicroPerM, 0, address(0), NO_BOOK);
        }
    }

    /// Compressed path, quorum-vouched signatures. The attestation covers
    /// (bookId, the book's nonce, fillsHash) under this contract's EIP-712
    /// domain, so a quorum signature is single-use within its own book and
    /// meaningless in any other — books settle in parallel, never racing.
    function settleBatchAttested(bytes32 bookId, BatchFill[] calldata fills, bytes[] calldata sigs) external {
        Book storage book = _books[bookId];
        if (book.threshold == 0) revert UnknownBook(bookId);
        bytes32 fillsHash = keccak256(abi.encode(fills));
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(BATCH_TYPEHASH, bookId, book.nonce, fillsHash)));
        _verifyQuorum(book, digest, sigs);
        _applyBatch(bookId, book, fills, fillsHash, false);
    }

    /// Compressed path, proof-vouched signatures. The SP1 program re-derives every
    /// order digest under this domain separator, recovers each signer, and commits
    /// (domainSeparator, bookId, batchNonce, fillsHash) as public values — so a
    /// proof binds to exactly this contract on exactly this chain, this book, at
    /// this nonce, for these fills. The book+nonce binding stops a proof from
    /// being replayed under another (e.g. higher-fee) book or re-submitted after
    /// the book's nonce advances (a partial-fill proof would otherwise replay).
    function settleBatchProven(bytes32 bookId, BatchFill[] calldata fills, bytes calldata proof) external {
        if (address(sp1Verifier) == address(0)) revert ProvenPathDisabled();
        Book storage book = _books[bookId];
        if (book.threshold == 0) revert UnknownBook(bookId);
        bytes32 fillsHash = keccak256(abi.encode(fills));
        sp1Verifier.verifyProof(
            batchProgramVKey, abi.encode(_domainSeparatorV4(), bookId, book.nonce, fillsHash), proof
        );
        _applyBatch(bookId, book, fills, fillsHash, true);
    }

    function _applyBatch(
        bytes32 bookId,
        Book storage book,
        BatchFill[] calldata fills,
        bytes32 fillsHash,
        bool proven
    )
        internal
    {
        for (uint256 i = 0; i < fills.length; i++) {
            BatchFill calldata f = fills[i];
            _applyFill(
                f.buy,
                _hashOrderMem(f.buy),
                f.sell,
                _hashOrderMem(f.sell),
                f.qtyTokens,
                f.execPriceMicroPerM,
                book.feeBps,
                book.feeRecipient,
                bookId
            );
        }
        emit BatchSettled(bookId, book.nonce, fillsHash, fills.length, proven);
        book.nonce++;
    }

    function _verifySig(Order calldata o, bytes calldata sig) internal view returns (bytes32 structHash) {
        structHash = hashOrder(o);
        if (ECDSA.recover(_hashTypedDataV4(structHash), sig) != o.trader) revert BadSignature(structHash);
    }

    function _hashOrderMem(Order calldata o) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH, o.instrument, o.side, o.priceMicroPerM, o.qtyTokens, o.lotId, o.trader, o.expiry, o.salt
            )
        );
    }

    /// The atomic core. Debits the buyer, pays the seller (minus fee), and
    /// delivers the credit lot — all or nothing. No external calls.
    function _applyFill(
        Order calldata buy,
        bytes32 buyHash,
        Order calldata sell,
        bytes32 sellHash,
        uint64 qty,
        uint64 execPrice,
        uint16 bookFeeBps,
        address bookFeeRecipient,
        bytes32 bookId
    )
        internal
    {
        if (buy.side != 0 || sell.side != 1 || buy.instrument != sell.instrument || buy.lotId != bytes32(0)) {
            revert InvalidOrderPair();
        }
        if (buy.trader == sell.trader) revert SelfFill();
        if (qty == 0 || execPrice == 0) revert ZeroAmount();
        if (block.timestamp > buy.expiry) revert OrderExpired(buyHash);
        if (block.timestamp > sell.expiry) revert OrderExpired(sellHash);
        if (cancelled[buyHash]) revert OrderIsCancelled(buyHash);
        if (cancelled[sellHash]) revert OrderIsCancelled(sellHash);
        if (execPrice > buy.priceMicroPerM || execPrice < sell.priceMicroPerM) {
            revert PriceOutsideLimits(execPrice, buy.priceMicroPerM, sell.priceMicroPerM);
        }
        uint64 buyFilled = filled[buyHash];
        uint64 sellFilled = filled[sellHash];
        if (buy.qtyTokens - buyFilled < qty) revert Overfill(buyHash, buy.qtyTokens - buyFilled, qty);
        if (sell.qtyTokens - sellFilled < qty) revert Overfill(sellHash, sell.qtyTokens - sellFilled, qty);
        filled[buyHash] = buyFilled + qty;
        filled[sellHash] = sellFilled + qty;

        // Notional, micro-tsUSD, rounded half-up — mirrors Fill::notional_micro in Rust.
        uint256 cost = (uint256(execPrice) * qty + 500_000) / 1_000_000;
        uint256 buyerBal = balances[buy.trader];
        if (buyerBal < cost) revert InsufficientBalance(buyerBal, cost);
        balances[buy.trader] = buyerBal - cost;
        uint256 fee = (cost * feeBps) / 10_000;
        uint256 bookFee = (cost * bookFeeBps) / 10_000;
        balances[sell.trader] += cost - fee - bookFee;
        balances[feeRecipient] += fee;
        if (bookFee > 0) balances[bookFeeRecipient] += bookFee;

        bytes32 newLotId = keccak256(abi.encode(buyHash, sellHash, sellFilled));
        if (sell.lotId == bytes32(0)) {
            // Primary mint: seller is the issuer; the lot must be cash-backed.
            uint256 newLiab = liability[sell.trader] + cost;
            uint256 needed = newLiab + (newLiab * defaultPenaltyBps) / 10_000;
            if (collateral[sell.trader] < needed) revert InsufficientCollateral(collateral[sell.trader], needed);
            liability[sell.trader] = newLiab;
            lots[newLotId] = Lot({
                holder: buy.trader,
                issuer: sell.trader,
                instrument: sell.instrument,
                qtyTokens: qty,
                lockedTokens: 0,
                expiry: uint64(block.timestamp) + creditTtl,
                notionalMicro: uint128(cost)
            });
            // Only this book's quorum may later attest service for the lot.
            lotBook[newLotId] = bookId;
        } else {
            // Resale: carve qty out of the seller's lot. The buyer's refund value
            // is what they paid, capped at the carved pro-rata value, so issuer
            // liability can only shrink after mint.
            Lot storage src = lots[sell.lotId];
            if (src.holder == address(0)) revert LotNotFound(sell.lotId);
            if (src.holder != sell.trader) revert NotLotHolder(sell.lotId);
            // The delivered lot's instrument MUST equal the one the buyer signed.
            // Line above already pins buy.instrument == sell.instrument, so this
            // closes the path where a seller delivers a cheap/under-backed lot at
            // an expensive instrument's price (the buyer cannot pin lotId — it is
            // forced to 0 — so the contract must guarantee the match).
            if (src.instrument != sell.instrument) revert InvalidOrderPair();
            if (block.timestamp > src.expiry) revert LotIsExpired(sell.lotId);
            uint64 avail = src.qtyTokens - src.lockedTokens;
            if (avail < qty) revert LotQtyUnavailable(avail, qty);
            uint256 prorata = (uint256(src.notionalMicro) * qty) / src.qtyTokens;
            uint256 newNotional = cost < prorata ? cost : prorata;
            src.qtyTokens -= qty;
            src.notionalMicro -= uint128(prorata);
            liability[src.issuer] -= (prorata - newNotional);
            lots[newLotId] = Lot({
                holder: buy.trader,
                issuer: src.issuer,
                instrument: src.instrument,
                qtyTokens: qty,
                lockedTokens: 0,
                expiry: src.expiry,
                notionalMicro: uint128(newNotional)
            });
            // Resale inherits the source lot's issuing book — the issuer's
            // instance does not change, so its quorum's attestation rights carry.
            lotBook[newLotId] = lotBook[sell.lotId];
            if (src.qtyTokens == 0) {
                delete lots[sell.lotId];
                delete lotBook[sell.lotId];
            }
        }
        emit FillSettled(buyHash, sellHash, buy.instrument, qty, execPrice, cost, newLotId);
    }

    // ═══════════════════════════════ Lot lifecycle ═══════════════════════════════

    /// Plain transfer (gifting / custody moves). Selling through the market uses
    /// a signed sell order instead, so price and refund value stay enforced.
    function transferLot(bytes32 lotId, address to) external {
        if (to == address(0)) revert ZeroAmount();
        Lot storage lot = lots[lotId];
        if (lot.holder == address(0)) revert LotNotFound(lotId);
        if (lot.holder != msg.sender) revert NotLotHolder(lotId);
        if (openRedemptionOf[lotId] != bytes32(0)) revert RedemptionAlreadyOpen(lotId);
        lot.holder = to;
        emit LotTransferred(lotId, msg.sender, to);
    }

    function requestRedemption(bytes32 lotId, uint64 qty) external returns (bytes32 redemptionId) {
        Lot storage lot = lots[lotId];
        if (lot.holder == address(0)) revert LotNotFound(lotId);
        if (lot.holder != msg.sender) revert NotLotHolder(lotId);
        if (block.timestamp > lot.expiry) revert LotIsExpired(lotId);
        if (openRedemptionOf[lotId] != bytes32(0)) revert RedemptionAlreadyOpen(lotId);
        uint64 avail = lot.qtyTokens - lot.lockedTokens;
        if (qty == 0) revert ZeroAmount();
        if (avail < qty) revert LotQtyUnavailable(avail, qty);
        lot.lockedTokens += qty;
        redemptionId = keccak256(abi.encode(lotId, _redemptionNonce++));
        redemptions[redemptionId] = Redemption({
            lotId: lotId,
            holder: msg.sender,
            qtyTokens: qty,
            deadline: uint64(block.timestamp) + redemptionWindow,
            state: RedemptionState.Open
        });
        openRedemptionOf[lotId] = redemptionId;
        emit RedemptionRequested(
            redemptionId, lotId, lot.issuer, msg.sender, qty, uint64(block.timestamp) + redemptionWindow
        );
    }

    function receiptDigest(bytes32 redemptionId, uint64 servedTokens) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RECEIPT_TYPEHASH, redemptionId, servedTokens)));
    }

    /// Happy path: the holder's signed receipt acknowledges service. Unserved
    /// quantity returns to the lot, still redeemable.
    function settleRedemption(bytes32 redemptionId, uint64 servedTokens, bytes calldata holderSig) external {
        Redemption storage r = _openRedemption(redemptionId);
        if (ECDSA.recover(receiptDigest(redemptionId, servedTokens), holderSig) != r.holder) {
            revert BadReceipt(redemptionId);
        }
        _settleRedemption(r, redemptionId, servedTokens);
    }

    /// Dispute path: an attester quorum vouches the service happened (validators
    /// check the router's usage records). Same digest, m-of-n instead of holder.
    function settleRedemptionAttested(
        bytes32 bookId,
        bytes32 redemptionId,
        uint64 servedTokens,
        bytes[] calldata sigs
    )
        external
    {
        Book storage book = _books[bookId];
        if (book.threshold == 0) revert UnknownBook(bookId);
        Redemption storage r = _openRedemption(redemptionId);
        // Only the lot's OWN issuing book may attest its service. Without this,
        // any registered book's quorum — another instance, or an owner-minted
        // 1-of-1 book — could mark the redemption Settled with servedTokens=qty
        // and confiscate the holder's prepaid credit (and block claimDefault).
        // A `settleFills`-minted lot records NO_BOOK and so has no attested path.
        bytes32 issuingBook = lotBook[r.lotId];
        if (issuingBook != bookId) revert RedemptionBookMismatch(issuingBook, bookId);
        _verifyQuorum(book, receiptDigest(redemptionId, servedTokens), sigs);
        _settleRedemption(r, redemptionId, servedTokens);
    }

    function _openRedemption(bytes32 redemptionId) internal view returns (Redemption storage r) {
        r = redemptions[redemptionId];
        if (r.state != RedemptionState.Open) revert RedemptionNotOpen(redemptionId);
        if (block.timestamp > r.deadline) revert RedemptionDeadlinePassed(redemptionId);
    }

    function _settleRedemption(Redemption storage r, bytes32 redemptionId, uint64 servedTokens) internal {
        if (servedTokens > r.qtyTokens) revert ServedExceedsRequested(servedTokens, r.qtyTokens);
        Lot storage lot = lots[r.lotId];
        uint256 debit = (uint256(lot.notionalMicro) * servedTokens) / lot.qtyTokens;
        lot.qtyTokens -= servedTokens;
        lot.lockedTokens -= r.qtyTokens;
        lot.notionalMicro -= uint128(debit);
        liability[lot.issuer] -= debit;
        r.state = RedemptionState.Settled;
        openRedemptionOf[r.lotId] = bytes32(0);
        if (lot.qtyTokens == 0) delete lots[r.lotId];
        emit RedemptionSettled(redemptionId, servedTokens, debit);
    }

    function spendAuthDigest(SpendKeyAuth calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(SPEND_TYPEHASH, a.lotId, a.keyHash, a.maxTokens, a.expiry)));
    }

    /// Settle the cumulative tokens served against a spend-key authorization.
    /// Cumulative semantics make this idempotent and monotone: replaying an old
    /// total is a no-op revert, and the issuer can flush at any cadence. The
    /// signature must recover to the lot's CURRENT holder, so a resold lot's
    /// outstanding keys die at the transfer. Settlement must land before the
    /// lot (and the auth) expire — after expiry the remaining value is the
    /// holder's to reclaim, so an issuer that serves without flushing eats it.
    function settleSpend(SpendKeyAuth calldata a, uint64 servedCumulative, bytes calldata holderSig) external {
        Lot storage lot = lots[a.lotId];
        if (lot.holder == address(0)) revert LotNotFound(a.lotId);
        if (block.timestamp > lot.expiry) revert LotIsExpired(a.lotId);
        bytes32 digest = spendAuthDigest(a);
        if (spendRevoked[digest]) revert SpendKeyIsRevoked(digest);
        if (block.timestamp > a.expiry) revert SpendAuthExpired(digest);
        if (ECDSA.recover(digest, holderSig) != lot.holder) revert BadSpendAuth(digest);
        if (servedCumulative > a.maxTokens) revert SpendCapExceeded(a.maxTokens, servedCumulative);
        uint64 settled = spendSettled[digest];
        if (servedCumulative <= settled) revert NothingToSettle(digest);
        uint64 delta = servedCumulative - settled;
        uint64 avail = lot.qtyTokens - lot.lockedTokens;
        if (delta > avail) revert LotQtyUnavailable(avail, delta);
        spendSettled[digest] = servedCumulative;
        uint256 debit = (uint256(lot.notionalMicro) * delta) / lot.qtyTokens;
        lot.qtyTokens -= delta;
        lot.notionalMicro -= uint128(debit);
        liability[lot.issuer] -= debit;
        if (lot.qtyTokens == 0) delete lots[a.lotId];
        emit SpendSettled(digest, a.lotId, delta, servedCumulative, debit);
    }

    /// Emergency brake for a leaked key: the holder kills the authorization
    /// on-chain. Anything the issuer already served but has not yet settled is
    /// the issuer's loss — revocation is immediate and total.
    function revokeSpendKey(SpendKeyAuth calldata a) external {
        Lot storage lot = lots[a.lotId];
        if (lot.holder == address(0)) revert LotNotFound(a.lotId);
        if (lot.holder != msg.sender) revert NotLotHolder(a.lotId);
        bytes32 digest = spendAuthDigest(a);
        spendRevoked[digest] = true;
        emit SpendKeyRevoked(digest, a.lotId);
    }

    /// The "definitely": deadline missed → the holder is made whole in cash from
    /// the issuer's collateral, plus the penalty. Permissionless (keeper-friendly);
    /// the payout always goes to the redemption's holder.
    function claimDefault(bytes32 redemptionId) external returns (uint256 payout) {
        Redemption storage r = redemptions[redemptionId];
        if (r.state != RedemptionState.Open) revert RedemptionNotOpen(redemptionId);
        if (block.timestamp <= r.deadline) revert RedemptionDeadlineNotPassed(redemptionId);
        Lot storage lot = lots[r.lotId];
        uint256 refundBase = (uint256(lot.notionalMicro) * r.qtyTokens) / lot.qtyTokens;
        uint256 penalty = (refundBase * defaultPenaltyBps) / 10_000;
        payout = refundBase + penalty;
        address issuer = lot.issuer;
        collateral[issuer] -= payout; // covered by the mint-time invariant
        liability[issuer] -= refundBase;
        lot.qtyTokens -= r.qtyTokens;
        lot.lockedTokens -= r.qtyTokens;
        lot.notionalMicro -= uint128(refundBase);
        balances[r.holder] += payout;
        r.state = RedemptionState.Defaulted;
        openRedemptionOf[r.lotId] = bytes32(0);
        if (lot.qtyTokens == 0) delete lots[r.lotId];
        uint256 defaultId = _defaults.length;
        _defaults.push(DefaultRecord({ issuer: issuer, amountMicro: uint128(payout), redemptionId: redemptionId }));
        emit RedemptionDefaulted(defaultId, redemptionId, issuer, r.holder, payout);
    }

    /// Paid, unserved spend comes back as cash once the lot expires.
    function reclaimExpired(bytes32 lotId) external returns (uint256 refund) {
        Lot storage lot = lots[lotId];
        if (lot.holder == address(0)) revert LotNotFound(lotId);
        if (block.timestamp <= lot.expiry) revert LotNotExpired(lotId);
        if (openRedemptionOf[lotId] != bytes32(0)) revert RedemptionAlreadyOpen(lotId);
        refund = lot.notionalMicro;
        address holder = lot.holder;
        collateral[lot.issuer] -= refund;
        liability[lot.issuer] -= refund;
        balances[holder] += refund;
        delete lots[lotId];
        emit LotExpiredReclaimed(lotId, holder, refund);
    }

    // ═══════════════════════════════ Attesters + SP1 ═════════════════════════════

    /// Register a matching domain ONCE: its attester quorum, threshold, and the
    /// fee cut routed to whoever funds/operates the instance behind it. Owner-
    /// gated for the same reason the old global set was: an attester quorum can
    /// vouch for order signatures the contract never sees, so book membership is
    /// exactly as trust-critical as the old `setAttesters`. The proven (SP1) path
    /// is what eventually makes this permissionless.
    ///
    /// First-registration-only: a book's fee/recipient are write-once. Re-pricing
    /// an already-registered book would skim a fee a seller never signed for off
    /// already-resting orders (the order carries no fee commitment and the fee is
    /// outside the attested digest), so it is forbidden — change economics by
    /// registering a NEW bookId and migrating the matcher to it. Operator churn
    /// goes through `rotateAttesters`, which never touches fee/recipient.
    function registerBook(
        bytes32 bookId,
        address[] calldata signers,
        uint16 threshold,
        uint16 bookFeeBps,
        address bookFeeRecipient
    )
        external
        onlyOwner
    {
        if (bookId == NO_BOOK) revert ReservedBookId();
        Book storage book = _books[bookId];
        if (book.threshold != 0) revert BookAlreadyRegistered(bookId);
        if (bookFeeBps > 1000 || (bookFeeBps > 0 && bookFeeRecipient == address(0))) revert InvalidFee();
        for (uint256 i = 0; i < signers.length; i++) {
            book.attesters.add(signers[i]);
        }
        if (threshold < 1 || threshold > book.attesters.length()) revert InvalidThreshold();
        book.threshold = threshold;
        book.feeBps = bookFeeBps;
        book.feeRecipient = bookFeeRecipient;
        emit BookRegistered(bookId, signers, threshold, bookFeeBps, bookFeeRecipient);
    }

    /// Rotate a registered book's attester set + threshold for operator churn.
    /// Deliberately CANNOT change the book's fee/recipient (those are write-once
    /// in `registerBook`). Still owner-gated; the durable answer is registry-
    /// driven membership projected from the bonded operator set, with the owner
    /// behind a timelock + multisig (see deploy).
    function rotateAttesters(bytes32 bookId, address[] calldata signers, uint16 threshold) external onlyOwner {
        Book storage book = _books[bookId];
        if (book.threshold == 0) revert UnknownBook(bookId);
        uint256 n = book.attesters.length();
        for (uint256 i = n; i > 0; i--) {
            book.attesters.remove(book.attesters.at(i - 1));
        }
        for (uint256 i = 0; i < signers.length; i++) {
            book.attesters.add(signers[i]);
        }
        if (threshold < 1 || threshold > book.attesters.length()) revert InvalidThreshold();
        book.threshold = threshold;
        emit AttestersRotated(bookId, signers, threshold);
    }

    function setSp1Verifier(address verifier, bytes32 vkey) external onlyOwner {
        sp1Verifier = ISP1Verifier(verifier);
        batchProgramVKey = vkey;
        emit Sp1VerifierSet(verifier, vkey);
    }

    function bookAttesters(bytes32 bookId) external view returns (address[] memory) {
        return _books[bookId].attesters.values();
    }

    function bookNonce(bytes32 bookId) external view returns (uint64) {
        return _books[bookId].nonce;
    }

    function bookThreshold(bytes32 bookId) external view returns (uint16) {
        return _books[bookId].threshold;
    }

    function bookFee(bytes32 bookId) external view returns (uint16 feeBps_, address recipient) {
        Book storage book = _books[bookId];
        return (book.feeBps, book.feeRecipient);
    }

    /// m-of-n over `digest`: recovered signers strictly ascending (no duplicates),
    /// each in the attester set, count >= threshold.
    function _verifyQuorum(Book storage book, bytes32 digest, bytes[] calldata sigs) internal view {
        uint16 threshold = book.threshold;
        if (threshold == 0 || sigs.length < threshold) revert BadQuorum();
        address last = address(0);
        for (uint256 i = 0; i < sigs.length; i++) {
            address signer = ECDSA.recover(digest, sigs[i]);
            if (signer <= last || !book.attesters.contains(signer)) revert BadQuorum();
            last = signer;
        }
    }

    // ═══════════════════════════════════ Views ═══════════════════════════════════

    function hashFills(BatchFill[] calldata fills) external pure returns (bytes32) {
        return keccak256(abi.encode(fills));
    }

    function defaultsCount() external view returns (uint256) {
        return _defaults.length;
    }

    function getDefault(uint256 defaultId)
        external
        view
        returns (address issuer, uint128 amountMicro, bytes32 redemptionId)
    {
        DefaultRecord storage d = _defaults[defaultId];
        return (d.issuer, d.amountMicro, d.redemptionId);
    }

    function freeCollateral(address issuer) external view returns (uint256) {
        return collateral[issuer] - requiredCollateral(issuer);
    }
}
