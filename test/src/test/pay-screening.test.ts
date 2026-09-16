// Husk — REAL dilisense screening × real devnet integration test.
//
// SEPARATE from pay.test.ts (which deliberately stays on its deterministic
// JS-controlled stub witness to exercise contract FAIL/EDGE/PASS logic with
// zero API usage). THIS file wires the REAL screening oracle
// (src/screening.ts → dilisense checkIndividual) into the real `pay()`
// circuit on the real running local devnet.
//
// QUOTA DISCIPLINE: dilisense free tier = 100 calls/month. This suite spends
// AT MOST one real API call per claimed name, EVER (3 total): the first run
// makes the live call and records the FULL genuine response in
// test/logs/screening-verdicts.cache.json (gitignored); later runs replay the
// recorded verdict with ZERO API calls, logging it clearly labeled CACHED:
//   1. a PEP-only flagged individual ("Angela Merkel" — canonical PEP;
//      note: "Vladimir Putin" was tried first and is NOT PEP-only on
//      dilisense — heads of state carry SANCTION records),
//   2. a sanctioned individual ("Igor Sechin" — OFAC/EU-listed),
//   3. a clean, invented, unlisted name ("Ferdinand Bricklemeister").
// No loops, no retries, no per-test re-fetches: pay() consumes the verdicts.
// Every raw API response (live or recorded) is logged in full below.
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
import { MidnightWalletProvider, syncWallet } from '../wallet.js';
import { buildProviders, type HuskProviders } from '../providers.js';
import {
  makeCompiledHusk,
  zkAssetsPath,
  ledger as huskLedger,
  type Witnesses,
} from '../../../contracts/index.js';
import type { Contract } from '../../../contracts/index.js';
import {
  makeScreeningWitness,
  screenRecipientName,
  resolveDilisenseApiKey,
  type ScreeningVerdict,
} from '../screening.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Required for GraphQL subscriptions in Node.js
// @ts-expect-error WebSocket global assignment for apollo
globalThis.WebSocket = WebSocket;

const ALICE_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';
const BOB_SEED =
  '0000000000000000000000000000000000000000000000000000000000000002';
const PRIVATE_STATE_ID = 'HuskPayScreeningRealV1';

const logger = pino(
  { level: process.env['LOG_LEVEL'] ?? 'info' },
  // Synchronous stdout destination: the real-API responses must never be
  // lost to an async transport buffer if the process exits quickly.
  pino.destination({ sync: true, dest: 1 }),
);

const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';
const DUST_TYPE = ledger.shieldedToken().raw;
const SCREEN_MSG = 'husk: recipient failed screening';

// --- The three policy branches, one real API call each (see header) -------
// NOTE: dilisense reality-check (first run): "Vladimir Putin" returns
// SANCTION records (14 SANCTION/CRIMINAL hits) — heads of state are
// sanction-listed, so he is NOT a PEP-only case there. A canonical PEP-only
// individual is used instead.
const PEP_NAME = 'Angela Merkel';
const SANCTIONED_NAME = 'Igor Sechin';
const CLEAN_NAME = 'Ferdinand Bricklemeister';

const verdicts = new Map<string, ScreeningVerdict>();
let apiCallsMade = 0;

// QUOTA RECORD/REPLAY: dilisense's free tier is 100 calls/month and devnet
// infrastructure can force a rerun. The FIRST run per claimed name spends a
// real API call and records the FULL genuine response here (gitignored logs/
// dir); reruns reuse the recorded verdict and make ZERO API calls, logging
// the recorded response clearly labeled CACHED. The file also records which
// run produced it, so live-vs-replay is always explicit.
const VERDICT_CACHE_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../logs/screening-verdicts.cache.json',
);

type VerdictCacheEntry = { recorded_at: string; recorded_by: string; verdict: ScreeningVerdict };

function loadVerdictCache(): Record<string, VerdictCacheEntry> {
  if (!existsSync(VERDICT_CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(VERDICT_CACHE_PATH, 'utf8')) as Record<string, VerdictCacheEntry>;
  } catch {
    return {};
  }
}

function saveVerdictCache(cache: Record<string, VerdictCacheEntry>): void {
  mkdirSync(path.dirname(VERDICT_CACHE_PATH), { recursive: true });
  writeFileSync(VERDICT_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
}

function witnessesFor(): Witnesses<unknown> {
  return {
    // REAL oracle bridge: verdicts were pre-fetched from dilisense (one call
    // per name, see header); the witness maps the claimed name (the same
    // Opaque<"string"> value the circuit forwards) to its verdict and
    // FAILS CLOSED on any name that was never screened.
    screeningPassed: makeScreeningWitness(verdicts, logger) as unknown as (
      ...args: never[]
    ) => unknown,
    // Fresh uniform salt per payment (CSPRNG).
    screeningNonce: (_ctx: unknown) => [{}, randomBytes(32)],
  } as unknown as Witnesses<unknown>;
}

function freshDeposit(value: bigint): ShieldedCoinInfo {
  return {
    type: DUST_TYPE,
    nonce: randomBytes(32).toString('hex'),
    value,
  };
}

// SKIP GATE: if no API key is available, skip (don't fail) the whole file.
// Evaluated at collection time, BEFORE beforeAll runs, so the 3 tests report
// as skipped and the file passes the suite with zero API calls.
const HAS_DILISENSE_KEY = Boolean(resolveDilisenseApiKey());
if (!HAS_DILISENSE_KEY) {
  console.warn(
    'DILISENSE_API_KEY not set -- skipping real-API screening tests. Set it in .env to run these.',
  );
}

describe.skipIf(!HAS_DILISENSE_KEY)(
  `Husk pay() × REAL dilisense screening — local devnet (${network})`,
  () => {
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
    return Array.from(huskLedger(state!.data as never).screened);
  }

  async function syncedState(ref: MidnightWalletProvider) {
    return firstValueFrom(ref.wallet.state().pipe(filter((x) => x.isSynced)));
  }

  async function aliceDustBalance(): Promise<bigint> {
    const s = await syncedState(alice);
    return s.shielded.balances[DUST_TYPE] ?? 0n;
  }

  async function largestAliceCoin(): Promise<{ value: bigint; nonce: string }> {
    const s = await syncedState(alice);
    const coins = s.shielded.availableCoins.filter((c) => c.coin.type === DUST_TYPE);
    expect(coins.length).toBeGreaterThan(0);
    const best = coins.reduce((a, b) => (a.coin.value >= b.coin.value ? a : b));
    return { value: best.coin.value, nonce: best.coin.nonce };
  }

  /** Real pay() call with the payer-supplied claimed name (4th circuit arg). */
  async function callPay(args: {
    recipientName: string;
    coin: ShieldedCoinInfo;
    amount: bigint;
  }): Promise<string> {
    const compiled = makeCompiledHusk(witnessesFor());
    const res = (await submitCallTx(
      providers,
      {
        compiledContract: compiled as never,
        contractAddress,
        privateStateId: PRIVATE_STATE_ID,
        circuitId: 'pay',
        args: [
          { bytes: encodeCoinPublicKey(bob.getCoinPublicKey()) },
          encodeShieldedCoinInfo(args.coin),
          args.amount,
          // Opaque<"string"> claimed name — flows into the witness call only.
          args.recipientName,
        ],
        additionalCoinEncPublicKeyMappings: new Map([
          [bob.getCoinPublicKey(), bob.getEncryptionPublicKey()],
        ]),
      } as never,
    )) as unknown as { public: { txId: string } };
    logger.info(`pay() tx submitted: ${res.public.txId}`);
    return res.public.txId;
  }

  /** After a successful pay: hand all received value back so Alice can fund the next pay. */
  async function sweepBobBackToAlice(amount: bigint) {
    const received = await bob.findShieldedCoin(DUST_TYPE, amount, 120_000);
    expect(received).toBeDefined();
    const bobState = await syncedState(bob);
    const bobTotal = bobState.shielded.balances[DUST_TYPE];
    const aliceShieldedAddress = await alice.getShieldedAddress();
    await bob.transferShielded(aliceShieldedAddress, DUST_TYPE, bobTotal);
    const bobAfter = await bob.findShieldedCoin(DUST_TYPE, amount, 120_000);
    expect(bobAfter).toBeUndefined();
    logger.info(`Swept ${bobTotal} back to Alice after pay for "${amount}"`);
  }

  beforeAll(async () => {
    setNetworkId(config.networkId);

    // Key presence was already gated at collection time by the
    // describe.skipIf(HAS_DILISENSE_KEY) guard above: if this hook runs at
    // all, a key resolved. No hard assertion here — absent key means skip,
    // never fail.

    // --- Real API calls: AT MOST one per claimed name, EVER (record/replay).
    // First execution of a name = 1 live dilisense call, recorded; later runs
    // replay the recorded genuine response with ZERO API calls. This run's
    // live-call count is asserted at the end of the loop.
    const cache = loadVerdictCache();
    for (const [label, name] of [
      ['PEP-only', PEP_NAME],
      ['sanctioned', SANCTIONED_NAME],
      ['clean', CLEAN_NAME],
    ] as const) {
      const cached = cache[name];
      const verdict: ScreeningVerdict = cached
        ? (() => {
            logger.warn(
              {
                event: 'DILISENSE_CACHED_RESPONSE',
                branch: label,
                claimed_name: name,
                recorded_at: cached.recorded_at,
                recorded_by: cached.recorded_by,
                raw_response: cached.verdict.raw,
              },
              `using CACHED verdict for ${label} name "${name}" (recorded ${cached.recorded_at}) — NO API call spent this run`,
            );
            return cached.verdict;
          })()
        : await (async () => {
            const live = await screenRecipientName(name, logger);
            apiCallsMade += 1;
            logger.info(
              {
                event: 'DILISENSE_RAW_RESPONSE',
                branch: label,
                claimed_name: name,
                http_status: live.httpStatus,
                raw_response: live.raw,
              },
              `dilisense raw response for ${label} name "${name}": ${JSON.stringify(live.raw)}`,
            );
            cache[name] = {
              recorded_at: new Date().toISOString(),
              recorded_by: 'dilisense checkIndividual (live call by pay-screening.test.ts)',
              verdict: live,
            };
            saveVerdictCache(cache);
            return live;
          })();
      verdicts.set(name, verdict);
    }
    logger.info(`Live dilisense API calls made by THIS run: ${apiCallsMade} (hard budget: 3)`);
    expect(apiCallsMade).toBeLessThanOrEqual(3);

    // Branch sanity (policy classification of the real responses):
    expect(verdicts.get(SANCTIONED_NAME)!.passed).toBe(false);
    expect(verdicts.get(SANCTIONED_NAME)!.blockingHits.length).toBeGreaterThan(0);
    expect(verdicts.get(CLEAN_NAME)!.passed).toBe(true);
    expect(verdicts.get(CLEAN_NAME)!.pepFlagged).toBe(false);
    expect(verdicts.get(PEP_NAME)!.passed).toBe(true);
    expect(verdicts.get(PEP_NAME)!.pepFlagged).toBe(true);

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

    logger.info('Deploying Husk contract (real-screening wiring)...');
    const deployed = (await deployContract(providers, {
      compiledContract: makeCompiledHusk(witnessesFor()) as never,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: {},
    } as never)) as unknown as DeployedContract<Contract>;
    contractAddress = (
      deployed as unknown as {
        deployTxData: { public: { contractAddress: ContractAddress } };
      }
    ).deployTxData.public.contractAddress;
    logger.info(`Husk deployed at: ${contractAddress}`);
    expect(contractAddress.length).toBeGreaterThan(0);
  }, 900_000);

  afterAll(async () => {
    if (alice) await alice.stop().catch((e: unknown) => logger.warn(String(e)));
    if (bob) await bob.stop().catch((e: unknown) => logger.warn(String(e)));
  });

  it(
    'CLEAN name → real screening PASSES → pay() succeeds, screened gains an entry, recipient coin real',
    async () => {
      const verdict = verdicts.get(CLEAN_NAME)!;
      expect(verdict.passed).toBe(true);
      expect(verdict.pepFlagged).toBe(false);
      expect(verdict.raw?.total_hits).toBe(0);

      const source = await largestAliceCoin();
      const deposit = freshDeposit(source.value);
      const balanceBefore = await aliceDustBalance();
      const entriesBefore = (await screenedEntries()).length;

      const txId = await callPay({ recipientName: CLEAN_NAME, coin: deposit, amount: deposit.value });
      expect(txId.length).toBeGreaterThan(0);

      expect((await screenedEntries()).length).toBe(entriesBefore + 1);
      await sweepBobBackToAlice(deposit.value);
      expect(await aliceDustBalance()).toBe(balanceBefore);
    },
    600_000,
  );

  it(
    'PEP-only name → real screening PASSES with PEP flag logged → pay() succeeds',
    async () => {
      const verdict = verdicts.get(PEP_NAME)!;
      expect(verdict.passed).toBe(true);
      expect(verdict.pepFlagged).toBe(true);
      expect(verdict.pepHits.length).toBeGreaterThan(0);
      expect(verdict.blockingHits.length).toBe(0);
      // The structured PEP flag line (SCREENING_PEP_FLAG) is emitted by
      // screening.ts above; its payload is reproducible from the verdict:
      logger.warn(
        {
          event: 'SCREENING_PEP_FLAG_VERIFIED',
          claimed_name: PEP_NAME,
          pep_hits: verdict.pepHits.map((r) => ({ source_type: r.source_type, source_id: r.source_id, name: r.name })),
        },
        `PEP flag verified for "${PEP_NAME}": pay() proceeds, flag was logged (not silent)`,
      );

      const source = await largestAliceCoin();
      const deposit = freshDeposit(source.value);
      const balanceBefore = await aliceDustBalance();
      const entriesBefore = (await screenedEntries()).length;

      const txId = await callPay({ recipientName: PEP_NAME, coin: deposit, amount: deposit.value });
      expect(txId.length).toBeGreaterThan(0);

      expect((await screenedEntries()).length).toBe(entriesBefore + 1);
      await sweepBobBackToAlice(deposit.value);
      expect(await aliceDustBalance()).toBe(balanceBefore);
    },
    600_000,
  );

  it(
    'SANCTIONED name → real screening FAILS → pay() reverts with screening error, no state change',
    async () => {
      const verdict = verdicts.get(SANCTIONED_NAME)!;
      expect(verdict.passed).toBe(false);
      expect(verdict.blockingHits.length).toBeGreaterThan(0);

      const source = await largestAliceCoin();
      const deposit = freshDeposit(source.value);
      const balanceBefore = await aliceDustBalance();
      const entriesBefore = (await screenedEntries()).length;

      const err = await callPay({
        recipientName: SANCTIONED_NAME,
        coin: deposit,
        amount: deposit.value,
      })
        .then(() => null)
        .catch((e: unknown) => e as Error);
      expect(err).toBeTruthy();
      logger.error(`SANCTIONED path error: ${err!.constructor.name}: ${err!.message}`);
      expect(err!.message).toContain(SCREEN_MSG);

      expect((await screenedEntries()).length).toBe(entriesBefore);
      expect(await aliceDustBalance()).toBe(balanceBefore);
    },
    600_000,
  );
});
