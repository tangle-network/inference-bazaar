// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { CommonBase } from "forge-std/Base.sol";
import { StdCheats } from "forge-std/StdCheats.sol";
import { StdUtils } from "forge-std/StdUtils.sol";
import { SurplusSettlement } from "../../src/SurplusSettlement.sol";
import { MockUSD } from "../../src/dev/Mocks.sol";

/// Drives random but valid sequences across every money-moving path so the
/// invariants (solvency, refundability) are tested against state the fuzzer
/// builds, not hand-picked cases. Every action tolerates its own reverts —
/// an action that can't fire (no balance, wrong state) is a no-op, never a
/// failed run — so the fuzzer keeps composing deeper sequences.
contract SettlementHandler is CommonBase, StdCheats, StdUtils {
    SurplusSettlement public settlement;
    MockUSD public usd;
    bytes32 public immutable BOOK;
    bytes32 constant INSTRUMENT = keccak256("model:output");

    // A small fixed actor set — every address that can hold value, so the
    // invariant can sum the whole system. feeRecipient is included.
    uint256[3] internal keys = [uint256(0xA1), uint256(0xB2), uint256(0xC3)];
    address[4] public actors;
    address public immutable feeRecipient;

    // Open lots and redemptions the fuzzer has created, for the redeem/default/
    // reclaim/spend actions to target.
    bytes32[] public lots;
    bytes32[] public openRedemptions;

    // Ghost totals for an independent cross-check of conservation.
    uint256 public ghostDeposited; // payment-token ever pulled in
    uint256 public ghostWithdrawn; // payment-token ever paid out

    // Coverage counters — prove the deep paths actually fire (a fuzz run where
    // no lot ever minted would pass the invariants trivially).
    uint256 public fillsCreated;
    uint256 public redemptionsSettled;
    uint256 public spendsSettled;
    uint256 public reclaimsDone;

    constructor(SurplusSettlement _s, MockUSD _usd, bytes32 _book, address _feeRecipient) {
        settlement = _s;
        usd = _usd;
        BOOK = _book;
        feeRecipient = _feeRecipient;
        for (uint256 i = 0; i < 3; i++) {
            actors[i] = vm.addr(keys[i]);
        }
        actors[3] = _feeRecipient;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % 3];
    }

    function _key(uint256 seed) internal view returns (uint256) {
        return keys[seed % 3];
    }

    // ── Cash + collateral ────────────────────────────────────────────────────

    function deposit(uint256 who, uint96 amount) external {
        amount = uint96(bound(amount, 1, 1e24));
        address a = _actor(who);
        usd.mint(a, amount);
        vm.startPrank(a);
        usd.approve(address(settlement), amount);
        settlement.deposit(amount);
        vm.stopPrank();
        ghostDeposited += amount;
    }

    function withdraw(uint256 who, uint96 amount) external {
        address a = _actor(who);
        uint256 bal = settlement.balances(a);
        if (bal == 0) return;
        amount = uint96(bound(amount, 1, bal));
        vm.prank(a);
        try settlement.withdraw(amount) {
            ghostWithdrawn += amount;
        } catch { }
    }

    function depositCollateral(uint256 who, uint96 amount) external {
        amount = uint96(bound(amount, 1, 1e24));
        address a = _actor(who);
        usd.mint(a, amount);
        vm.startPrank(a);
        usd.approve(address(settlement), amount);
        settlement.depositCollateral(amount);
        vm.stopPrank();
        ghostDeposited += amount;
    }

    function withdrawCollateral(uint256 who, uint96 amount) external {
        address a = _actor(who);
        uint256 free = settlement.freeCollateral(a);
        if (free == 0) return;
        amount = uint96(bound(amount, 1, free));
        vm.prank(a);
        try settlement.withdrawCollateral(amount) {
            ghostWithdrawn += amount;
        } catch { }
    }

    // ── Mint a lot via the trustless fill path ───────────────────────────────

    function settleFill(uint256 buyerSeed, uint64 qty, uint64 price) external {
        // Guaranteed-distinct actors and a meaningful (non-rounding-to-zero)
        // cost so every call actually mints — the fuzzer's job is to vary the
        // POST-mint sequence, not to discover the mint preconditions.
        qty = uint64(bound(qty, 1e6, 1e9));
        price = uint64(bound(price, 1e3, 1e7));
        uint256 bi = buyerSeed % 3;
        address buyer = actors[bi];
        address seller = actors[(bi + 1) % 3];
        uint256 buyerKeySeed = buyerSeed;
        uint256 sellerKeySeed = buyerSeed + 1;

        // Self-fund the fill's preconditions so the path reliably reaches the
        // post-mint states (redeem/default/spend) where the invariants are
        // actually stressed — random deposits rarely line up cash-for-buyer
        // AND collateral-for-seller on the same two seeds. Tracked in
        // ghostDeposited so conservation still holds.
        uint256 cost = (uint256(price) * qty + 500_000) / 1_000_000;
        if (cost == 0) return;
        uint256 needCollat = cost + (cost * 500) / 10_000; // + penalty buffer
        usd.mint(buyer, cost);
        vm.startPrank(buyer);
        usd.approve(address(settlement), cost);
        settlement.deposit(cost);
        vm.stopPrank();
        usd.mint(seller, needCollat);
        vm.startPrank(seller);
        usd.approve(address(settlement), needCollat);
        settlement.depositCollateral(needCollat);
        vm.stopPrank();
        ghostDeposited += cost + needCollat;

        SurplusSettlement.Order memory buy = _order(0, price, qty, bytes32(0), buyer);
        SurplusSettlement.Order memory sell = _order(1, price, qty, bytes32(0), seller);
        SurplusSettlement.FillInput[] memory fills = new SurplusSettlement.FillInput[](1);
        fills[0] = SurplusSettlement.FillInput({
            buy: buy,
            buySig: _sign(_key(buyerKeySeed), buy),
            sell: sell,
            sellSig: _sign(_key(sellerKeySeed), sell),
            qtyTokens: qty,
            execPriceMicroPerM: price
        });
        try settlement.settleFills(fills) {
            bytes32 lotId = keccak256(abi.encode(settlement.hashOrder(buy), settlement.hashOrder(sell), uint64(0)));
            lots.push(lotId);
            fillsCreated++;
        } catch { }
    }

    // ── Consume / refund a lot ───────────────────────────────────────────────

    function requestAndSettleRedemption(uint256 lotSeed, uint64 served) external {
        if (lots.length == 0) return;
        bytes32 lotId = lots[lotSeed % lots.length];
        (address holder,,, uint64 qty, uint64 locked,,) = settlement.lots(lotId);
        if (holder == address(0) || qty - locked == 0) return;
        uint64 reqQty = uint64(bound(served, 1, qty - locked));
        uint256 hk = _keyFor(holder);
        if (hk == 0) return;
        vm.prank(holder);
        try settlement.requestRedemption(lotId, reqQty) returns (bytes32 rid) {
            uint64 serveQty = uint64(bound(served, 0, reqQty));
            bytes memory sig = _signDigest(hk, settlement.receiptDigest(rid, serveQty));
            try settlement.settleRedemption(rid, serveQty, sig) {
                redemptionsSettled++;
            }
                catch { }
        } catch { }
    }

    function spend(uint256 lotSeed, uint64 amount) external {
        if (lots.length == 0) return;
        bytes32 lotId = lots[lotSeed % lots.length];
        (address holder,,, uint64 qty, uint64 locked,,) = settlement.lots(lotId);
        if (holder == address(0) || qty - locked == 0) return;
        uint256 hk = _keyFor(holder);
        if (hk == 0) return;
        SurplusSettlement.SpendKeyAuth memory auth = SurplusSettlement.SpendKeyAuth({
            lotId: lotId,
            keyHash: keccak256(abi.encode(lotId, amount)),
            maxTokens: qty,
            expiry: uint64(block.timestamp + 1 days)
        });
        uint64 served = uint64(bound(amount, 1, qty - locked));
        bytes memory sig = _signDigest(hk, settlement.spendAuthDigest(auth));
        try settlement.settleSpend(auth, served, sig) {
            spendsSettled++;
        }
            catch { }
    }

    function defaultOrReclaim(uint256 seed) external {
        if (lots.length == 0) return;
        bytes32 lotId = lots[seed % lots.length];
        // Push past the redemption deadline / lot expiry, then try both.
        vm.warp(block.timestamp + 7 days);
        (,,,,,, uint128 notional) = _safeLot(lotId);
        if (notional == 0) return;
        try settlement.reclaimExpired(lotId) {
            reclaimsDone++;
        }
            catch { }
    }

    function warp(uint16 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 12 hours));
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _order(
        uint8 side,
        uint64 price,
        uint64 qty,
        bytes32 lotId,
        address trader
    )
        internal
        view
        returns (SurplusSettlement.Order memory)
    {
        return SurplusSettlement.Order({
            instrument: INSTRUMENT,
            side: side,
            priceMicroPerM: price,
            qtyTokens: qty,
            lotId: lotId,
            trader: trader,
            expiry: uint64(block.timestamp + 1 hours),
            salt: keccak256(abi.encode(trader, qty, price, block.timestamp, lots.length))
        });
    }

    function _sign(uint256 key, SurplusSettlement.Order memory o) internal view returns (bytes memory) {
        // orderDigest takes calldata; round-trip through an external view.
        return _signDigest(key, this.digestOf(o));
    }

    function digestOf(SurplusSettlement.Order calldata o) external view returns (bytes32) {
        return settlement.orderDigest(o);
    }

    function _signDigest(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _keyFor(address a) internal view returns (uint256) {
        for (uint256 i = 0; i < 3; i++) {
            if (actors[i] == a) return keys[i];
        }
        return 0;
    }

    function _safeLot(bytes32 lotId)
        internal
        view
        returns (address, address, bytes32, uint64, uint64, uint64, uint128)
    {
        return settlement.lots(lotId);
    }

    function actorsAll() external view returns (address[4] memory) {
        return actors;
    }

    function lotsLength() external view returns (uint256) {
        return lots.length;
    }
}
