import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OpenbookTwap } from "../target/types/openbook_twap";
import {
  OpenBookV2Client,
  PlaceOrderArgs,
  PlaceOrderPeggedArgs,
  Side,
  OrderType,
  SelfTradeBehavior,
} from "@openbook-dex/openbook-v2";

import { expect, assert } from "chai";
import { I80F48 } from "@blockworks-foundation/mango-client";

const { PublicKey, Keypair, SystemProgram } = anchor.web3;
const { BN } = anchor;

import { IDL, OpenbookV2 } from "./fixtures/openbook_v2";

import {
  createMint,
  createAccount,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  getMint,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const OPENBOOK_PROGRAM_ID = new PublicKey(
  "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb"
);

const META_UNIT = 10e9; // 9 digits
const USDC_UNIT = 10e6; // 6 digits

describe("openbook-twap", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const connection = provider.connection;
    // @ts-ignore
    const payer = provider.wallet.payer;
  
    const openbookTwap = anchor.workspace.OpenbookTwap as Program<OpenbookTwap>;
    const openbook = new OpenBookV2Client(provider);
    const openbookProgram = new Program(IDL, OPENBOOK_PROGRAM_ID);
  
    it("Is initialized!", async () => {
      let mintAuthority = Keypair.generate();
      let META = await createMint(
        connection,
        payer,
        mintAuthority.publicKey,
        null,
        9
      );
  
      let USDC = await createMint(
        connection,
        payer,
        mintAuthority.publicKey,
        null,
        6
      );
  
      let usdcAccount = await createAccount(
        connection,
        payer,
        USDC,
        payer.publicKey
      );
  
      let metaAccount = await createAccount(
        connection,
        payer,
        META,
        payer.publicKey
      );
  
      await mintTo(
        connection,
        payer,
        META,
        metaAccount,
        mintAuthority,
        META_UNIT * 50
      ); // mint 100 meta
  
      await mintTo(
        connection,
        payer,
        USDC,
        usdcAccount,
        mintAuthority,
        USDC_UNIT * 10e8
      ); // 100K usdc
  
      let marketKP = Keypair.generate();
  
      let [twapMarket] = PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode("twap_market"),
          marketKP.publicKey.toBuffer(),
        ],
        openbookTwap.programId
      );
  
      let market = await openbook.createMarket(
        payer,
        "META/USDC",
        USDC,
        META,
        new BN(100),
        new BN(1e9),
        new BN(0),
        new BN(0),
        new BN(0),
        null,
        null,
        twapMarket,
        null,
        twapMarket,
        { confFilter: 0.1, maxStalenessSlots: 100 },
        marketKP
      );
  
      await openbookTwap.methods
        .createTwapMarket(new BN(10e6)) // initial value of 1 usdc. 6 decimals
        .accounts({
          market,
          twapMarket,
        })
        .rpc();
  
      let storedTwapMarket = await openbookTwap.account.twapMarket.fetch(
        twapMarket
      );
  
      assert.ok(storedTwapMarket.market.equals(market));
  
      let storedMarket = await openbook.getMarket(market);
  
      let oos = [];

      for (let i = 0; i < 5; i++) {
        let openOrders = await openbook.createOpenOrders(
          market,
          new BN(i + 1),
          `oo${i}`
        );
        oos.push(openOrders);
        console.log(`Created oo${i}`);
        await openbook.deposit(
          oos[i],
          await openbook.getOpenOrders(oos[i]),
          storedMarket,
          metaAccount,
          usdcAccount,
          new BN(META_UNIT),
          new BN(USDC_UNIT)
        );
  
        console.log(`Deposited to oo${i}`);

        let buyArgs: PlaceOrderArgs = {
            side: Side.Bid,
            priceLots: new BN(500), // 1 META for 1 USDC
            maxBaseLots: new BN(1),
            maxQuoteLotsIncludingFees: new BN(500),
            clientOrderId: new BN(1),
            orderType: OrderType.Limit,
            expiryTimestamp: new BN(0),
            selfTradeBehavior: SelfTradeBehavior.DecrementTake,
            limit: 255,
        };

        for (let order of oos) {
            await openbookTwap.methods
            .placeOrder(buyArgs)
            .accounts({
              signer: payer.publicKey,
              asks: storedMarket.asks,
              bids: storedMarket.bids,
              marketVault: storedMarket.marketQuoteVault, // marketQuoteVault is USDC
              eventHeap: storedMarket.eventHeap,
              market,
              openOrdersAccount: order,
              userTokenAccount: usdcAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
              twapMarket,
              openbookProgram: OPENBOOK_PROGRAM_ID,
            })
            .rpc();
        }

      }
  
    })
})