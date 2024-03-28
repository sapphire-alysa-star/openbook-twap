import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider } from "anchor-bankrun";
import { startAnchor, BanksClient, Clock } from "solana-bankrun";
import { Program } from "@coral-xyz/anchor";
import { OpenbookTwap } from "../target/types/openbook_twap";
import {
  OpenBookV2Client,
  PlaceOrderArgs,
  Side,
  OrderType,
  SelfTradeBehavior,
  // PlaceTakeOrderArgs,
} from "@openbook-dex/openbook-v2";

import { expect, assert } from "chai";

const { PublicKey, Keypair, SystemProgram } = anchor.web3;
const { BN } = anchor;

import {
  createMint,
  createAccount,
  getAccount,
  mintTo,
} from "spl-token-bankrun";

const OPENBOOK_PROGRAM_ID = new PublicKey(
  "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb"
);

const OPENBOOK_TWAP_PROGRAM_ID = new PublicKey(
  "twAP5sArq2vDS1mZCT7f4qRLwzTfHvf5Ay5R5Q5df1m"
);

const OpenbookTwapIDL: OpenbookTwap = require("../target/idl/openbook_twap.json");

const META_AMOUNT = 100;
const USDC_AMOUNT = 1000;

const EXPECTED_VALUE = 50 * 10_000;
const MAX_UPDATE_LOTS = 1 * 10_000;

const META_DECIMALS = 9;
const USDC_DECIMALS = 6;

const QUOTE_LOT_SIZE = 100;
const BASE_LOT_SIZE = 1_000_000_000;

const META_AMOUNT_SCALED = META_AMOUNT * 10 ** META_DECIMALS;
const USDC_AMOUNT_SCALED = USDC_AMOUNT * 10 ** USDC_DECIMALS;

describe("openbook-twap", () => {
  let context,
    provider,
    banksClient: BanksClient,
    payer,
    openbookTwap,
    openbook: OpenBookV2Client;

  before(async () => {
    context = await startAnchor(
      "./",
      [
        {
          name: "openbook_v2",
          programId: OPENBOOK_PROGRAM_ID,
        },
      ],
      []
    );
    banksClient = context.banksClient;
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    payer = provider.wallet.payer;

    openbookTwap = new anchor.Program<OpenbookTwap>(
      OpenbookTwapIDL,
      OPENBOOK_TWAP_PROGRAM_ID,
      provider
    );

    openbook = new OpenBookV2Client(provider);
  });

  it("Is initialized!", async () => {
    let mintAuthority = Keypair.generate();
    let META = await createMint(
      banksClient,
      payer,
      mintAuthority.publicKey,
      null,
      META_DECIMALS
    );

    let USDC = await createMint(
      banksClient,
      payer,
      mintAuthority.publicKey,
      null,
      USDC_DECIMALS
    );

    let usdcAccount = await createAccount(
      banksClient,
      payer,
      USDC,
      payer.publicKey
    );

    let metaAccount = await createAccount(
      banksClient,
      payer,
      META,
      payer.publicKey
    );

    await mintTo(
      banksClient,
      payer,
      META,
      metaAccount,
      mintAuthority,
      META_AMOUNT_SCALED * 50
    );

    await mintTo(
      banksClient,
      payer,
      USDC,
      usdcAccount,
      mintAuthority,
      USDC_AMOUNT_SCALED * 50
    );

    let marketKP = Keypair.generate();
    let market = marketKP.publicKey;

    let [twapMarket] = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode("twap_market"),
        marketKP.publicKey.toBuffer(),
      ],
      openbookTwap.programId
    );

    const currentTimeInSeconds = Math.floor(Date.now() / 1000);
    const elevenDaysInSeconds = 11 * 24 * 60 * 60;
    const expiryTime = new BN(currentTimeInSeconds + elevenDaysInSeconds);

    let [createMarketIxs, createMarketSigners] = await openbook.createMarketIx(
      payer.publicKey,
      "META/USDC",
      USDC,
      META,
      new BN(QUOTE_LOT_SIZE),
      new BN(BASE_LOT_SIZE),
      new BN(0),
      new BN(0),
      expiryTime,
      null,
      null,
      twapMarket,
      null,
      twapMarket,
      { confFilter: 0.1, maxStalenessSlots: 100 },
      marketKP,
      payer.publicKey
    );

    let tx = new anchor.web3.Transaction().add(...createMarketIxs);
    [tx.recentBlockhash] = await banksClient.getLatestBlockhash();
    tx.feePayer = payer.publicKey;
    await provider.sendAndConfirm(tx, createMarketSigners);

    await openbookTwap.methods
      .createTwapMarket(new BN(EXPECTED_VALUE), new BN(MAX_UPDATE_LOTS))
      .accounts({
        market: marketKP.publicKey,
        twapMarket,
      })
      .rpc();

    let storedTwapMarket = await openbookTwap.account.twapMarket.fetch(
      twapMarket
    );

    assert.ok(storedTwapMarket.market.equals(market));

    let storedMarket = await openbook.deserializeMarketAccount(market);

    let oos = [];

    const NUM_ORDERS = 96;

    for (let i = 0; i < Math.floor(NUM_ORDERS / 24); i++) {
      let openOrders = await openbook.createOpenOrders(payer, market, `oo${i}`);
      oos.push(openOrders);
      await openbook.depositIx(
        oos[i],
        await openbook.deserializeOpenOrderAccount(oos[i]),
        storedMarket,
        metaAccount,
        usdcAccount,
        new BN(META_AMOUNT_SCALED),
        new BN(USDC_AMOUNT_SCALED)
      );
    }

    async function crank() {
      const crankArgs: PlaceOrderArgs = {
        side: Side.Bid,
        priceLots: new BN(540), // 1 META for 1 USDC
        maxBaseLots: new BN(0),
        maxQuoteLotsIncludingFees: new BN(0),
        clientOrderId: new BN(10000),
        orderType: OrderType.ImmediateOrCancel,
        expiryTimestamp: new BN(0),
        selfTradeBehavior: SelfTradeBehavior.DecrementTake,
        limit: 255,
      };

      await openbookTwap.methods
      .placeTakeOrder(crankArgs)
      .accounts({
        signer: payer.publicKey,
        market,
        asks: storedMarket.asks,
        bids: storedMarket.bids,
        eventHeap: storedMarket.eventHeap,
        marketAuthority: storedMarket.marketAuthority,
        marketBaseVault: storedMarket.marketBaseVault,
        marketQuoteVault: storedMarket.marketQuoteVault,
        userQuoteAccount: usdcAccount,
        userBaseAccount: metaAccount,
        twapMarket,
        openbookProgram: OPENBOOK_PROGRAM_ID,
      })
      .rpc();
    }

    async function placeOrder({
      side,
      priceLots,
      clientOrderId
    }) {
      // Determine marketVault and userTokenAccount based on the side of the order
      let marketVault, userTokenAccount;
      if (side === Side.Bid) {
        marketVault = storedMarket.marketQuoteVault;
        userTokenAccount = usdcAccount;
      } else if (side === Side.Ask) {
        marketVault = storedMarket.marketBaseVault;
        userTokenAccount = metaAccount;
      } else {
        throw new Error("Invalid order side");
      }
    
      await openbookTwap.methods
        .placeOrder({
          side: side,
          priceLots: new BN(priceLots),
          maxBaseLots: new BN(1),
          maxQuoteLotsIncludingFees: new BN(priceLots),
          clientOrderId: new BN(clientOrderId),
          orderType: OrderType.Limit,
          expiryTimestamp: new BN(0),
          selfTradeBehavior: SelfTradeBehavior.DecrementTake,
          limit: 255,
        })
        .accounts({
          signer: payer.publicKey,
          asks: storedMarket.asks,
          bids: storedMarket.bids,
          marketVault: marketVault,
          eventHeap: storedMarket.eventHeap,
          market: market,
          openOrdersAccount: oos[0],
          userTokenAccount: userTokenAccount,
          twapMarket: twapMarket,
          openbookProgram: OPENBOOK_PROGRAM_ID,
        })
        .rpc();
    }

    async function advanceSlots(slots: number) {
      let storedClock = await context.banksClient.getClock();
      context.setClock(
        new Clock(
          storedClock.slot + BigInt(slots),
          storedClock.epochStartTimestamp,
          storedClock.epoch,
          storedClock.leaderScheduleEpoch,
          storedClock.unixTimestamp
        )
      );
    };

    // first, place orders directly around the expected value ($50), expect that the last will equal that
    await placeOrder({side: Side.Bid, priceLots: 49 * 10_000, clientOrderId: 1});
    await placeOrder({side: Side.Ask, priceLots: 51 * 10_000, clientOrderId: 2});

    await advanceSlots(1);
    await crank();

    storedTwapMarket = await openbookTwap.account.twapMarket.fetch(twapMarket);
    assert(storedTwapMarket.twapOracle.lastObservation.eqn(50 * 10_000));

    await placeOrder({side: Side.Ask, priceLots: 50 * 10_000, clientOrderId: 2});

    // pre-crank, it should still be the same
    storedTwapMarket = await openbookTwap.account.twapMarket.fetch(twapMarket);
    assert(storedTwapMarket.twapOracle.lastObservation.eqn(50 * 10_000));

    // post-crank, it should go down to $49.5
    await advanceSlots(1);
    await crank();

    storedTwapMarket = await openbookTwap.account.twapMarket.fetch(twapMarket);
    assert(storedTwapMarket.twapOracle.lastObservation.eqn(495 * 1_000));

    return;


    let tradeArgs: PlaceOrderArgs = {
      side: Side.Bid,
      priceLots: new BN(540), // 1 META for 1 USDC
      maxBaseLots: new BN(1),
      maxQuoteLotsIncludingFees: new BN(540),
      clientOrderId: new BN(1),
      orderType: OrderType.Limit,
      expiryTimestamp: new BN(0),
      selfTradeBehavior: SelfTradeBehavior.DecrementTake,
      limit: 255,
    };

    let buyArgs: PlaceOrderArgs = {
      side: Side.Bid,
      priceLots: new BN(540), // 1 META for 1 USDC
      maxBaseLots: new BN(1),
      maxQuoteLotsIncludingFees: new BN(540),
      clientOrderId: new BN(1),
      orderType: OrderType.Limit,
      expiryTimestamp: new BN(0),
      selfTradeBehavior: SelfTradeBehavior.DecrementTake,
      limit: 255,
    };

    let sellArgs: PlaceOrderArgs = {
      side: Side.Ask,
      priceLots: new BN(550), // 1 META for 1.2 USDC
      maxBaseLots: new BN(1),
      maxQuoteLotsIncludingFees: new BN(550),
      clientOrderId: new BN(2),
      orderType: OrderType.Limit,
      expiryTimestamp: new BN(0),
      selfTradeBehavior: SelfTradeBehavior.DecrementTake,
      limit: 255,
    };

    let takeArgs: PlaceTakeOrderArgs = {
      side: Side.Bid,
      priceLots: new BN(500),
      maxBaseLots: new BN(1),
      maxQuoteLotsIncludingFees: new BN(500),
      orderType: OrderType.Market,
      limit: 255,
    };

    let manipulatedBuyArgs: PlaceOrderArgs = {
      side: Side.Bid,
      priceLots: new BN(1),
      maxBaseLots: new BN(1),
      maxQuoteLotsIncludingFees: new BN(500),
      clientOrderId: new BN(1),
      orderType: OrderType.Limit,
      expiryTimestamp: new BN(0),
      selfTradeBehavior: SelfTradeBehavior.DecrementTake,
      limit: 255,
    };

    let manipulatedSellArgs: PlaceOrderArgs = {
      side: Side.Ask,
      priceLots: new BN(100_000_000_000_000),
      maxBaseLots: new BN(1),
      maxQuoteLotsIncludingFees: new BN(550),
      clientOrderId: new BN(2),
      orderType: OrderType.Limit,
      expiryTimestamp: new BN(0),
      selfTradeBehavior: SelfTradeBehavior.DecrementTake,
      limit: 255,
    };

    for (let i = 0; i < oos.length; i++) {
      for (let j = 0; j < 12; j++) {
        let idx: number = j + i * 12;

        let currentClock = await context.banksClient.getClock();
        let newSlot = currentClock.slot + 216_000n; // 1 day
        context.setClock(
          new Clock(
            newSlot,
            currentClock.epochStartTimestamp,
            currentClock.epoch,
            currentClock.leaderScheduleEpoch,
            currentClock.unixTimestamp
          )
        );

        if (i > 0 && i % 2 == 0) {
          await openbookTwap.methods
            .placeOrder(manipulatedBuyArgs)
            .accounts({
              signer: payer.publicKey,
              asks: storedMarket.asks,
              bids: storedMarket.bids,
              marketVault: storedMarket.marketQuoteVault,
              eventHeap: storedMarket.eventHeap,
              market,
              openOrdersAccount: oos[i],
              userTokenAccount: usdcAccount,
              twapMarket,
              openbookProgram: OPENBOOK_PROGRAM_ID,
            })
            .rpc();

          await openbookTwap.methods
            .placeOrder(manipulatedSellArgs)
            .accounts({
              signer: payer.publicKey,
              asks: storedMarket.asks,
              bids: storedMarket.bids,
              marketVault: storedMarket.marketBaseVault,
              eventHeap: storedMarket.eventHeap,
              market,
              openOrdersAccount: oos[i],
              userTokenAccount: metaAccount,
              twapMarket,
              openbookProgram: OPENBOOK_PROGRAM_ID,
            })
            .rpc();

          let manipulatedMarket = await openbookTwap.account.twapMarket.fetch(
            twapMarket
          );
          console.log(
            "Manipulated observation: " +
              idx +
              " = " +
              manipulatedMarket.twapOracle.lastObservation.toNumber()
          );
        } else {
          await openbookTwap.methods
            .placeOrder(buyArgs)
            .accounts({
              signer: payer.publicKey,
              asks: storedMarket.asks,
              bids: storedMarket.bids,
              marketVault: storedMarket.marketQuoteVault,
              eventHeap: storedMarket.eventHeap,
              market,
              openOrdersAccount: oos[i],
              userTokenAccount: usdcAccount,
              twapMarket,
              openbookProgram: OPENBOOK_PROGRAM_ID,
            })
            .rpc();

          await openbookTwap.methods
            .placeOrder(sellArgs)
            .accounts({
              signer: payer.publicKey,
              asks: storedMarket.asks,
              bids: storedMarket.bids,
              marketVault: storedMarket.marketBaseVault,
              eventHeap: storedMarket.eventHeap,
              market,
              openOrdersAccount: oos[i],
              userTokenAccount: metaAccount,
              twapMarket,
              openbookProgram: OPENBOOK_PROGRAM_ID,
            })
            .rpc();

          let healthyMarket = await openbookTwap.account.twapMarket.fetch(
            twapMarket
          );
          console.log(
            "Healthy sell observation: " +
              idx +
              " = " +
              healthyMarket.twapOracle.lastObservation.toNumber()
          );
        }
      }
    }

    await openbookTwap.methods
      .placeTakeOrder(takeArgs)
      .accounts({
        signer: payer.publicKey,
        market,
        asks: storedMarket.asks,
        bids: storedMarket.bids,
        eventHeap: storedMarket.eventHeap,
        marketAuthority: storedMarket.marketAuthority,
        marketBaseVault: storedMarket.marketBaseVault,
        marketQuoteVault: storedMarket.marketQuoteVault,
        userQuoteAccount: usdcAccount,
        userBaseAccount: metaAccount,
        twapMarket,
        openbookProgram: OPENBOOK_PROGRAM_ID,
      })
      .rpc();

    let storedTwapMarket2 = await openbookTwap.account.twapMarket.fetch(
      twapMarket
    );
    console.log(
      "Final oracle observation = " +
        storedTwapMarket2.twapOracle.lastObservation.toNumber()
    );

    console.log("Jump ahead 11 days");
    let currentClock = await context.banksClient.getClock();
    let jumpAheadSlots = BigInt(elevenDaysInSeconds * 2.5);
    const newSlot = currentClock.slot + jumpAheadSlots;
    const newTime =
      currentClock.unixTimestamp + BigInt(elevenDaysInSeconds + 10);
    context.setClock(
      new Clock(
        newSlot,
        currentClock.epochStartTimestamp,
        currentClock.epoch,
        currentClock.leaderScheduleEpoch,
        newTime
      )
    );
    currentClock = await context.banksClient.getClock();

    for (let i = 0; i < oos.length; i++) {
      await openbookTwap.methods
        .pruneOrders(new BN(100))
        .accounts({
          twapMarket,
          openOrdersAccount: oos[i],
          market,
          bids: storedMarket.bids,
          asks: storedMarket.asks,
          openbookProgram: OPENBOOK_PROGRAM_ID,
        })
        .rpc();

      await openbookTwap.methods
        .settleFundsExpired()
        .accounts({
          twapMarket,
          openOrdersAccount: oos[i],
          market,
          marketAuthority: storedMarket.marketAuthority,
          marketBaseVault: storedMarket.marketBaseVault,
          marketQuoteVault: storedMarket.marketQuoteVault,
          userBaseAccount: metaAccount,
          userQuoteAccount: usdcAccount,
          openbookProgram: OPENBOOK_PROGRAM_ID,
        })
        .rpc();
    }
    // Fetch the current balance in lamports
    const balanceBefore = await banksClient.getBalance(
      provider.wallet.publicKey
    );

    try {
      // Try to retrieve rent with a random pubkey
      await openbookTwap.methods
        .closeMarket()
        .accounts({
          closeMarketRentReceiver: Keypair.generate().publicKey,
          twapMarket,
          market,
          bids: storedMarket.bids,
          asks: storedMarket.asks,
          eventHeap: storedMarket.eventHeap,
          openbookProgram: OPENBOOK_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Expected a ConstraintHasOne error");
    } catch (error) {
      if ("error" in error && error.error.errorCode) {
        assert.strictEqual(
          error.error.errorCode.code,
          "ConstraintHasOne",
          "The error code matches ConstraintHasOne."
        );
      } else {
        assert.fail(`Unexpected error structure: ${error}`);
      }
    }

    await openbookTwap.methods
      .closeMarket()
      .accounts({
        closeMarketRentReceiver: provider.publicKey,
        twapMarket,
        market,
        bids: storedMarket.bids,
        asks: storedMarket.asks,
        eventHeap: storedMarket.eventHeap,
        openbookProgram: OPENBOOK_PROGRAM_ID,
      })
      .rpc();

    const balanceAfter = await banksClient.getBalance(
      provider.wallet.publicKey
    );
    let balanceDifference = Number(balanceAfter - balanceBefore);
    assert(
      balanceDifference >= 1e9,
      "Balance should have increased by at least 1 SOL"
    );
    console.log(
      "Got back",
      balanceDifference / 1e9,
      "SOL after closing the market"
    );
  });
});
