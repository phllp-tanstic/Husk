// Husk pay()-fixed — integration test suite against the local Midnight devnet.
//
// Tests contracts/husk.compact (compiled output in contracts/managed/husk): pay() requires amount == coin.value
// exactly (no partial payments, no change) and moves value via the verified
// receiveShielded + sendImmediateShielded pattern (verified on a real local
// devnet). The circuit takes a FRESH ShieldedCoinInfo descriptor (invented
// nonce, value anchored to a real committed coin the sender holds); the
// wallet balancer funds the contract-addressed output.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  deployContract,
  submitCallTx,
  type DeployedContract,
} from '@midnight-ntwrk/midnight-js-contracts';
import type {
  ContractAddress,
  ShieldedCoinInfo,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  encodeCoinPublicKey,
  encodeShieldedCoinInfo,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import pino from 'pino';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';

import { getConfig } from '../config.js';
import {
  MidnightWalletProvider,
  syncWallet,
} from '../wallet.js';
import { buildProviders, type HuskProviders } from '../providers.js';
import {
  makeCompiledHusk,
  zkAssetsPath,
  ledger as huskFixedLedger,
  type Witnesses,
} from '../../../contracts/index.js';
import { Contract } from '../../../contracts/index.js';

// Required for GraphQL subscriptions in Node.js
// @ts-expect-error WebSocket global assignment for apollo
globalThis.WebSocket = WebSocket;

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
  console.error('Promise:', promise);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

const ALICE_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';
const BOB_SEED =
  '0000000000000000000000000000000000000000000000000000000000000002';
const PRIVATE_STATE_ID = 'HuskPayFixedPrivateStateV1';

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: { target: 'pino-pretty' },
});

const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';
// `shieldedToken()` is the DUST-equivalent shielded token type.
const DUST_TYPE = ledger.shieldedToken().raw;

// New exact-value assert message (distinct from both the screening message
// and the OLD broken contract's 'amount exceeds coin value' message).
const EXACT_MSG = 'husk: partial payment not supported, amount must equal coin value';
const SCREEN_MSG = 'husk: recipient failed screening';
const OLD_EXCEEDS_MSG = 'husk: amount exceeds coin value';

// Placeholder claimed name for pay()'s 4th circuit argument
// (recipientName: Opaque<"string">). This file deliberately keeps the
// deterministic JS-controlled screeningPassed stub (NOT the real dilisense
// API — see pay-screening.test.ts for that), so this value never changes the
// verdict; it must merely be a syntactically valid Opaque<"string"> argument
// for the call to encode correctly.
const TEST_RECIPIENT_NAME = 'Husk Test Recipient';

function makeWitnesses(opts: { screening: boolean }): Witnesses<unknown> {
  return {
    // TEST-ONLY stand-in for the real off-chain sanctions/PEP oracle. The
    // production driver (see docs/architecture.md) queries the provider with
    // the recipient identity + amount off-chain and returns pass/fail; here
    // the decision is a JS boolean so both paths run against the real devnet.
    screeningPassed: (_ctx: unknown, _recipient: unknown, _amount: unknown) => [
      {},
      opts.screening,
    ],
    // Fresh uniform salt per payment (must be CSPRNG-sourced in production).
    screeningNonce: (_ctx: unknown) => [{}, randomBytes(32)],
  } as unknown as Witnesses<unknown>;
}

function makeCompiledFor(opts: { screening: boolean }) {
  return makeCompiledHusk(makeWitnesses({ screening: opts.screening }));
}

// Build a FRESH ShieldedCoinInfo descriptor (relay pattern): invented nonce,
// value anchored to a real committed coin the sender actually holds.
function freshDeposit(value: bigint): ShieldedCoinInfo {
  return {
    type: DUST_TYPE,
    nonce: randomBytes(32).toString('hex'),
    value,
  };
}
describe(`Husk pay()-fixed — local devnet (${network})`, () => {
  let alice: MidnightWalletProvider;
  let bob: MidnightWalletProvider;
  let providers: HuskProviders;
  let contractAddress: ContractAddress;

  const config = getConfig();
  const envConfig: EnvironmentConfiguration = {
    walletNetworkId: config.networkId,
    networkId: config.networkId,
    indexer: config.indexer,
    indexerWS: config.indexerWS,
    node: config.node,
    nodeWS: config.nodeWS,
    faucet: config.faucet,
    proofServer: config.proofServer,
  };

  async function screenedEntries(): Promise<Uint8Array[]> {
    const state =
      await providers.publicDataProvider.queryContractState(contractAddress);
    expect(state).not.toBeNull();
    return Array.from(huskFixedLedger(state!.data as never).screened);
  }

  async function syncedState(ref: MidnightWalletProvider) {
    return firstValueFrom(
      ref.wallet.state().pipe(filter((x) => x.isSynced)),
    );
  }

  async function aliceDustBalance(): Promise<bigint> {
    const s = await syncedState(alice);
    return s.shielded.balances[DUST_TYPE] ?? 0n;
  }

  async function aliceHasCoin(nonceHex: string): Promise<boolean> {
    const s = await syncedState(alice);
    return s.shielded.availableCoins.some(
      (c) => c.coin.type === DUST_TYPE && c.coin.nonce === nonceHex,
    );
  }

  async function largestAliceCoin(): Promise<{ value: bigint; nonce: string }> {
    const s = await syncedState(alice);
    const coins = s.shielded.availableCoins.filter((c) => c.coin.type === DUST_TYPE);
    expect(coins.length).toBeGreaterThan(0);
    const best = coins.reduce((a, b) => (a.coin.value >= b.coin.value ? a : b));
    return { value: best.coin.value, nonce: best.coin.nonce };
  }

  async function callPay(args: {
    screening: boolean;
    recipientName: string;
    coin: ShieldedCoinInfo;
    amount: bigint;
  }): Promise<string> {
    const compiled = makeCompiledFor({ screening: args.screening });
    const res = (await submitCallTx(
      providers,
      {
        compiledContract: compiled as never,
        contractAddress,
        privateStateId: PRIVATE_STATE_ID,
        circuitId: 'pay',
        args: [
          // Runtime CoinPublicKey (hex string) → Compact ZswapCoinPublicKey
          // { bytes: Uint8Array } via the official runtime encoder.
          { bytes: encodeCoinPublicKey(bob.getCoinPublicKey()) },
          // Fresh ShieldedCoinInfo { color, nonce: Uint8Array, value } via
          // the official runtime encoder (relay pattern — NO mt_index).
          encodeShieldedCoinInfo(args.coin),
          args.amount,
          // 4th circuit arg: the payer-supplied claimed name for the
          // recipient, Opaque<"string">. It is forwarded by the generated
          // runtime into the screeningPassed witness call only; the
          // deterministic stub above ignores its value.
          args.recipientName,
        ],
        // Resolve the recipient's Zswap encryption public key so the coin
        // ciphertexts created for Bob are decryptable by Bob's wallet.
        additionalCoinEncPublicKeyMappings: new Map([
          [bob.getCoinPublicKey(), bob.getEncryptionPublicKey()],
        ]),
      } as never,
    )) as unknown as { public: { txId: string } };
    // submitCallTx resolves to FinalizedCallTxData: the tx id lives at
    // `.public.txId` (same shape as relay.test.ts's callRelay).
    logger.info(`pay() tx submitted: ${res.public.txId}`);
    return res.public.txId;
  }

  beforeAll(async () => {
    setNetworkId(config.networkId);

    logger.info(`Building Alice (seed …${ALICE_SEED.slice(-4)})`);
    alice = await MidnightWalletProvider.build(logger, envConfig, {
      kind: 'seed',
      value: ALICE_SEED,
    });
    await alice.start();
    await syncWallet(logger, alice.wallet, 180_000);
    logger.info(`Alice shielded DUST balance: ${await aliceDustBalance()}`);

    logger.info(`Building Bob (seed …${BOB_SEED.slice(-4)})`);
    bob = await MidnightWalletProvider.build(logger, envConfig, {
      kind: 'seed',
      value: BOB_SEED,
    });
    await bob.start();
    await syncWallet(logger, bob.wallet, 180_000);

    providers = buildProviders(alice, zkAssetsPath, config);

    logger.info('Deploying Husk contract...');
    const deployed = (await deployContract(
      providers,
      {
        compiledContract: makeCompiledFor({ screening: true }) as never,
        privateStateId: PRIVATE_STATE_ID,
        initialPrivateState: {},
      } as never,
    )) as unknown as DeployedContract<Contract>;
    contractAddress = (
      deployed as unknown as {
        deployTxData: { public: { contractAddress: ContractAddress } };
      }
    ).deployTxData.public.contractAddress;
    logger.info(`Husk deployed at: ${contractAddress}`);
    expect(contractAddress.length).toBeGreaterThan(0);
    expect((await screenedEntries()).length).toBe(0);
  }, 600_000);

  afterAll(async () => {
    if (alice) {
      logger.info('Stopping Alice wallet...');
      await alice.stop().catch((e: unknown) => logger.warn(String(e)));
    }
    if (bob) {
      logger.info('Stopping Bob wallet...');
      await bob.stop().catch((e: unknown) => logger.warn(String(e)));
    }
  });
  it('PASS: screening passed, amount == coin.value → pay() succeeds, screened gains exactly one entry, recipient coin is real and spendable', async () => {
    // Anchor the deposit value to real ledger value Alice actually holds:
    // use her largest available committed coin as the funding source.
    const source = await largestAliceCoin();
    logger.info(`PASS funding source: value=${source.value} nonce=${source.nonce}`);
    const deposit = freshDeposit(source.value);
    const amount = deposit.value; // exact: amount == coin.value

    const aliceBefore = await aliceDustBalance();
    const bobStateBefore = await syncedState(bob);
    const bobBalanceBefore = bobStateBefore.shielded.balances[DUST_TYPE];

    const txId = await callPay({
      screening: true,
      recipientName: TEST_RECIPIENT_NAME,
      coin: deposit,
      amount,
    });
    expect(txId.length).toBeGreaterThan(0);

    // 1. screened ledger gained exactly one entry.
    const entries = await screenedEntries();
    expect(entries.length).toBe(1);

    // 2. Recipient (Bob) received a real, committed, spendable shielded coin.
    const received = await bob.findShieldedCoin(DUST_TYPE, amount, 120_000);
    expect(received).toBeDefined();
    expect(received!.value).toBe(amount);
    expect(received!.mt_index).toBeGreaterThan(0n);

    const bobStateAfterPay = await syncedState(bob);
    const bobBalanceAfterPay = bobStateAfterPay.shielded.balances[DUST_TYPE];
    expect(bobBalanceAfterPay - (bobBalanceBefore ?? 0n)).toBe(amount);
    logger.info(
      `PASS balances: alice ${aliceBefore} -> ${await aliceDustBalance()}, ` +
        `bob ${bobBalanceBefore} -> ${bobBalanceAfterPay}, txId=${txId}`,
    );

    // 3. The received coin is genuinely SPENDABLE: Bob sends his entire
    //    shielded DUST balance (which includes the received coin) back to
    //    Alice in one shielded transfer, then both wallets confirm the move.
    const bobTotal = bobStateAfterPay.shielded.balances[DUST_TYPE];
    const aliceShieldedAddress = await alice.getShieldedAddress();
    const outTx = await bob.transferShielded(
      aliceShieldedAddress,
      DUST_TYPE,
      bobTotal,
    );
    logger.info(`Bob→Alice shielded transfer submitted: ${outTx}`);
    expect(outTx.length).toBeGreaterThan(0);

    // Wait until the received coin is gone from Bob's wallet — it was
    // consumed as a spendable input of the transfer.
    const bobAfter = await bob.findShieldedCoin(DUST_TYPE, amount, 120_000);
    expect(bobAfter).toBeUndefined();
    const bobStateAfterSpend = await syncedState(bob);
    expect(bobStateAfterSpend.shielded.balances[DUST_TYPE] ?? 0n).toBe(0n);
  }, 600_000);

  it('FAIL: screening witness returns false → pay() reverts, screened Set unchanged, sender balance unchanged', async () => {
    const source = await largestAliceCoin();
    const deposit = freshDeposit(source.value);

    const balanceBefore = await aliceDustBalance();
    const entriesBefore = (await screenedEntries()).length;

    const err = await callPay({
      screening: false,
      recipientName: TEST_RECIPIENT_NAME,
      coin: deposit,
      amount: deposit.value,
    })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeTruthy();
    logger.error(`FAIL path error: ${err!.constructor.name}: ${err!.message}`);

    // Distinguishable from the exact-amount assert failure.
    expect(err!.message).toContain(SCREEN_MSG);
    expect(err!.message).not.toContain(EXACT_MSG);

    // No state change on-chain: screened unchanged, balance equal.
    expect((await screenedEntries()).length).toBe(entriesBefore);
    expect(await aliceDustBalance()).toBe(balanceBefore);
  }, 600_000);

  it('EDGE-exceeds: amount > coin.value → fails at the exact-amount assert, distinguishable from a screening failure', async () => {
    const source = await largestAliceCoin();
    const deposit = freshDeposit(source.value);

    const balanceBefore = await aliceDustBalance();
    const entriesBefore = (await screenedEntries()).length;

    // screeningPassed is TRUE here, so any failure cannot be the screening gate.
    const err = await callPay({
      screening: true,
      recipientName: TEST_RECIPIENT_NAME,
      coin: deposit,
      amount: deposit.value + 1n,
    })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeTruthy();
    logger.error(`EDGE-exceeds path error: ${err!.constructor.name}: ${err!.message}`);

    expect(err!.message).toContain(EXACT_MSG);
    expect(err!.message).not.toContain(SCREEN_MSG);
    // The old broken-contract message must be gone.
    expect(err!.message).not.toContain(OLD_EXCEEDS_MSG);

    // Again: no screened entry, sender balance unchanged.
    expect((await screenedEntries()).length).toBe(entriesBefore);
    expect(await aliceDustBalance()).toBe(balanceBefore);
  }, 600_000);

  it('EDGE-partial: amount < coin.value (genuine partial-payment attempt) → fails at the exact-amount assert', async () => {
    const source = await largestAliceCoin();
    const deposit = freshDeposit(source.value);
    expect(deposit.value).toBeGreaterThan(1n);
    const partial = deposit.value - 1n;

    const balanceBefore = await aliceDustBalance();
    const entriesBefore = (await screenedEntries()).length;

    // screeningPassed is TRUE here, so any failure cannot be the screening gate.
    const err = await callPay({
      screening: true,
      recipientName: TEST_RECIPIENT_NAME,
      coin: deposit,
      amount: partial,
    })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeTruthy();
    logger.error(`EDGE-partial path error: ${err!.constructor.name}: ${err!.message}`);

    expect(err!.message).toContain(EXACT_MSG);
    expect(err!.message).not.toContain(SCREEN_MSG);
    expect(err!.message).not.toContain(OLD_EXCEEDS_MSG);

    // Again: no screened entry, sender balance unchanged.
    expect((await screenedEntries()).length).toBe(entriesBefore);
    expect(await aliceDustBalance()).toBe(balanceBefore);
  }, 600_000);
});