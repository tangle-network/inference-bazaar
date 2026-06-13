// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { SettlementTestBase } from "./Base.t.sol";
import { SurplusSettlement } from "../src/SurplusSettlement.sol";

/// The transfer-by-sale (resale) path is the one place total notional is not
/// conserved across a fill: when the buyer pays LESS than the carved pro-rata,
/// the issuer's liability and the lot's notional both shrink by the shortfall.
/// This pins the invariant that matters — issuer liability always equals the sum
/// of their outstanding lots' notional — so the resale accounting can't drift.
contract ResaleTest is SettlementTestBase {
    function _order(
        uint8 side,
        uint64 price,
        uint64 qty,
        bytes32 lotId,
        address trader,
        string memory salt
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
            expiry: uint64(block.timestamp + 300),
            salt: keccak256(bytes(salt))
        });
    }

    function test_resale_belowProrata_conservesLiability() public {
        // Primary mint: seller (issuer) -> buyer holds 50k @ exec $15/M, notional 750_000.
        bytes32 lotId = settleStandardFill();
        assertEq(settlement.liability(seller), 750_000, "liability == minted notional");
        (,,, uint64 qty0,,, uint128 notional0) = settlement.lots(lotId);
        assertEq(uint256(notional0), 750_000);
        assertEq(uint256(qty0), 50_000);

        // Resale of 20k BELOW pro-rata: holder (`buyer`) sells to buyer2 @ exec $10/M.
        //   prorata = 750_000 * 20_000 / 50_000 = 300_000
        //   cost    = 10_000_000 * 20_000 / 1e6 = 200_000  (< prorata)
        //   => issuer liability and src notional each shrink by 100_000.
        uint256 buyer2Key = uint256(keccak256("buyer2"));
        address buyer2 = vm.addr(buyer2Key);
        usd.mint(buyer2, 1_000_000_000);
        vm.startPrank(buyer2);
        usd.approve(address(settlement), type(uint256).max);
        settlement.deposit(100_000_000);
        vm.stopPrank();

        SurplusSettlement.Order memory b = _order(0, 10_000_000, 20_000, bytes32(0), buyer2, "resale-buy");
        SurplusSettlement.Order memory s = _order(1, 10_000_000, 20_000, lotId, buyer, "resale-sell");
        SurplusSettlement.FillInput[] memory fills = new SurplusSettlement.FillInput[](1);
        fills[0] = SurplusSettlement.FillInput({
            buy: b,
            buySig: sign(buyer2Key, b),
            sell: s,
            sellSig: sign(buyerKey, s), // the lot HOLDER signs the resale
            qtyTokens: 20_000,
            execPriceMicroPerM: 10_000_000
        });
        settlement.settleFills(fills);

        bytes32 newLotId = keccak256(abi.encode(settlement.hashOrder(b), settlement.hashOrder(s), uint64(0)));
        (,,,,,, uint128 notionalSrc) = settlement.lots(lotId);
        (,,,,,, uint128 notionalNew) = settlement.lots(newLotId);

        assertEq(uint256(notionalSrc), 450_000, "src notional carved by full prorata");
        assertEq(uint256(notionalNew), 200_000, "new lot notional = cash paid (capped at prorata)");
        // The invariant: issuer liability == sum of their outstanding lot notional.
        assertEq(
            settlement.liability(seller),
            uint256(notionalSrc) + uint256(notionalNew),
            "liability == sum of issuer lot notional after resale"
        );
        assertEq(settlement.liability(seller), 650_000, "liability dropped by exactly the shortfall");
    }
}
