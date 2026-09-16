# Husk

A private compliance layer for AI agent-to-agent payments: a payment can prove it passed sanctions/PEP screening without revealing who paid whom, how much, or when.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Network: Midnight](https://img.shields.io/badge/network-Midnight-6a4fa3.svg)
![Buildathon: Wave 1](https://img.shields.io/badge/buildathon-Wave%201-1f6feb.svg)
![Node: >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

Notes on the badges (all four are static — this repo has no CI service that could report a dynamic build status):

- **License: Apache 2.0** — backed by the `LICENSE` file at the repo root (the standard Apache License 2.0 text).
- **Network: Midnight** — backed by `contracts/husk.compact` (Compact, Midnight's contract language), the `@midnight-ntwrk/*` dependencies in `test/package.json`, and the Midnight services pinned in `test/compose.yml`.
- **Buildathon: Wave 1** — "Wave 1" is the scope this repo is written against: `docs/husk-blueprint.md` §6 (roadmap) and §7 ("What's intentionally out of scope for Wave 1"), and `docs/architecture.md` ("Screening oracle — real, from Wave 1", "Demo agent (Wave 1)").
- **Node >= 22** — backed by the `engines` field in `test/package.json`.

> This README was checked against `main` at commit `68bfb88`. Commands marked as run were executed in a fresh clone (clean `git clone`, no prior state) with `compact` 0.5.2, Node v22.22.1, Yarn 4.18.0 and Docker 29.1.3.

## Table of contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Installation](#installation)
5. [Configuration](#configuration)
6. [Usage](#usage)
7. [API reference](#api-reference)
8. [Project structure](#project-structure)
9. [Testing](#testing)
10. [Deployment](#deployment)
11. [Troubleshooting / FAQ](#troubleshooting--faq)
12. [Midnight and Compact development challenges](#midnight-and-compact-development-challenges)
13. [Contributing](#contributing)
14. [License](#license)

## Overview

AI agents are starting to pay each other directly — for an API call, a piece of data, compute time, or a completed task. On the agent-payment rails that exist today (x402, Coinbase Agentic Wallets, Mastercard Agent Pay), proving a payment is legitimate means publishing the whole payment: anyone watching the chain can see who paid whom, how much, and when.

Husk is built for that specific problem, and for developers rather than end users. Its claim is deliberately narrow (`docs/architecture.md`): *when a payment is routed through Husk, it is genuinely screened and the transaction stays private* — not that routing through Husk is unavoidable, since no application-layer compliance system can force a wallet to route through it. The direct users are developers building agent platforms, wallets or marketplaces, and businesses that must prove compliance without publishing their agents' financial activity (`docs/husk-blueprint.md` §3); a consumer-facing app is explicitly out of scope for Wave 1.

## Architecture

Three parts, plus the docs that specify them:

- **Contract — `contracts/husk.compact`** (Compact, `pragma language_version 0.23`). Declares one exported ledger field (`screened: Set<Bytes<32>>`), two witnesses (`screeningPassed`, `screeningNonce`), and one circuit (`pay`). Value moves as native Zswap shielded coins; the contract never holds a balance between calls.
- **Compiled-contract binding — `contracts/index.ts`**. Exports the generated `Contract`, `ledger`, `pureCircuits` and types from `contracts/managed/husk/contract/index.js` (produced by `yarn compile`, gitignored), plus `zkAssetsPath` (points at `contracts/managed/husk`) and `makeCompiledHusk(witnesses)`, which binds the circuit to a witness implementation and to those compiled assets.
- **Off-chain screening driver — `test/src/screening.ts`**. Implements the off-chain side of `screeningPassed`: it calls dilisense's `GET https://api.dilisense.com/v1/checkIndividual` (`x-api-key` header, `names=<claimed name>`, `fuzzy_search=1`) once per claimed name (no retries) and returns a verdict. Policy: any `SANCTION`/`CRIMINAL` hit fails; PEP-only hits pass with a logged `SCREENING_PEP_FLAG` flag; no hits pass clean. Any HTTP error, malformed body, timeout or transport failure fails closed (`passed: false`), and the witness factory (`makeScreeningWitness`) returns `false` for a name with no pre-computed verdict. It never throws past its own boundary and never logs the key.
- **Test harness — `test/src/*` + `test/compose.yml`**. `test/src/config.ts` (network endpoints), `test/src/wallet.ts` (wallet provider: sync, shielded transfer, coin lookup, transaction balancing/submission), `test/src/providers.ts` (Midnight.js providers: indexer, proof server, node ZK config, level private-state), and the two test files in `test/src/test/`. `test/compose.yml` runs the local devnet (node, indexer, proof server).

How they talk to each other, per `docs/architecture.md` §Flow:

```text
payer's driver (test/src/*)                      Midnight local devnet
──────────────────────────                       ─────────────────────
1. screen the claimed name off-chain
   screenRecipientName() → dilisense API  ───────► (external: api.dilisense.com)
   verdict pre-computed (fail-closed)
2. call pay(recipient, coin, amount, name)
   witnesses: screeningPassed → saved verdict
              screeningNonce  → random 32B salt
   transaction submission (proof + balancing) ───► node (127.0.0.1:9944)
                                                  proof server (127.0.0.1:6300)
3. pass: receiveShielded + sendImmediateShielded
   commitment → screened.insert()               ─► indexer (127.0.0.1:8088)
   fail: whole transaction reverts, nothing
         public is written
4. recipient's wallet discovers the coin by ordinary wallet sync
```

Two constraints worth knowing before reading the contract (`docs/architecture.md`):

- `sendShielded` cannot spend a coin the caller's wallet still owns, so `pay()` uses `receiveShielded` (taking momentary custody of a freshly constructed, contract-addressed coin in the same atomic call) followed by `sendImmediateShielded` (forwarding its full value to the recipient). Nothing persists between payments.
- Because `sendImmediateShielded` returns change as a contract-owned coin and the SDK exposes no way to enumerate a contract's owned coins, `pay()` requires `amount == coin.value` exactly — no partial payments and no change, so no value can be stranded.

The demo agent described in `docs/husk-blueprint.md` Phase 3 and `docs/architecture.md` ("Demo agent (Wave 1)") — an MCP-connected Claude session with the tool surface `get_balance()` / `check_policy()` / `pay()` (narrowed to `check_policy(amount)` / `pay(counterparty, amount)` in `docs/architecture.md`) — is a plan, not code in this repo: Phase 0 is the only phase with checked items and Phases 1–5 are unchecked, and there is no MCP server implementation here. (`.vscode/mcp.json` configures a `midnight-kapa` MCP server at `https://midnight.mcp.kapa.ai` for editor docs lookups, not the demo agent.)

## Prerequisites

| Requirement | Version / form | Where it comes from |
|---|---|---|
| Compact compiler CLI | version-manager wrapper `0.5.2` (`compact --version`); real compiler `0.31.1` (`compact compile --version`) | The two commands report different numbers for two different things. Compiled output reports compiler `0.31.1`, language `0.23.0`, runtime `0.16.0` (`contracts/managed/husk/compiler/contract-info.json`); the contract's pragma is `pragma language_version 0.23`. Install steps: https://docs.midnight.network. |
| Node.js | `>=22.0.0` | `engines` field in `test/package.json` (run with v22.22.1). |
| Yarn | Yarn 4 (Berry). No exact version is pinned — there is no `packageManager` field in `test/package.json` and no root `package.json` at all | `test/.yarnrc.yml` is a Yarn Berry config (`nodeLinker: node-modules`, `enableScripts: true`, `npmMinimalAgeGate: 0`, `approvedGitRepositories: ["**"]`). Run with Yarn 4.18.0. |
| Docker + Docker Compose | Any current Docker Engine/Desktop with Compose v2 | The test suite runs against a local devnet started by `test/compose.yml`: `midnightntwrk/midnight-node:1.0.0`, `midnightntwrk/indexer-standalone:4.3.3`, `midnightntwrk/proof-server:8.1.0`. |
| WSL2 + Docker Desktop (Windows only) | — | `docs/husk-blueprint.md` Phase 0 records the toolchain as "WSL2 + Docker Desktop + Compact compiler, pinned to 0.31.1 per official compatibility matrix". |
| dilisense API key | Free tier: 100 checks/month | **Only** needed for the real-screening suite, `test/src/test/pay-screening.test.ts`. Compiling the contract and the `pay()` logic suite (`test/src/test/pay.test.ts`) do not need it (see [Testing](#testing)). |

The version-manager wrapper and the real compiler are two different numbers: `compact --version` reports wrapper `0.5.2`, while `compact compile --version` reports compiler `0.31.1`. The 0.31.1 compiler is what the pinned contract output in `docs/husk-blueprint.md` Phase 0 corresponds to. For install steps, follow https://docs.midnight.network — this repo records only "Install Midnight toolchain (WSL2 + Docker Desktop + Compact compiler…)" and documents no install commands of its own.

Only `local` is verified end-to-end by this repo's test suite. `test/src/config.ts` has endpoint plumbing for `preview`/`preprod`, but it is untested here — do not assume those networks work.

## Installation

Works from a clean clone; run as-is. `yarn install` must come before `yarn compile` — Yarn's CLI refuses to run scripts without its `node_modules` state file (see [Troubleshooting](#troubleshooting--faq)).

```bash
git clone https://github.com/phllp-tanstic/Husk.git
cd Husk/test
yarn install     # clean-clone run: Yarn 4.18.0 reported "Done in 27s 160ms"; it built the native addons protobufjs, classic-level, msgpackr-extract, cpu-features and ssh2
yarn compile     # invokes the Compact compiler (0.31.1) via the compact 0.5.2 wrapper
```

`yarn compile` runs `compact compile ../contracts/husk.compact ../contracts/managed/husk` and prints exactly:

```
Compiling 1 circuits:
```

It writes the compiled contract to `contracts/managed/husk/` (gitignored — `contracts/managed/` is in the root `.gitignore` and is never committed):

```
contracts/managed/husk/
├── compiler/contract-info.json     # compiler 0.31.1 / language 0.23.0 / runtime 0.16.0, circuit + witness signatures, ledger layout
├── contract/index.js, index.d.ts   # the generated TypeScript binding consumed by contracts/index.ts
├── keys/pay.prover, pay.verifier   # prover/verifier keys
└── zkir/pay.zkir, pay.bzkir        # circuit representation
```

The compile step is required before anything that imports `contracts/index.ts` — it imports `./managed/husk/contract/index.js`, so the tests and any type-checking fail with `ERR_MODULE_NOT_FOUND` until `yarn compile` has run.

**On Windows:** run the whole sequence inside WSL2 with Docker Desktop integration enabled. `docs/husk-blueprint.md` Phase 0 records that as the project's environment ("WSL2 + Docker Desktop + Compact compiler"), and the local devnet in `test/compose.yml` is a Docker Compose stack (see [Troubleshooting](#troubleshooting--faq)).

For install steps, follow https://docs.midnight.network. This repo records only "Install Midnight toolchain (WSL2 + Docker Desktop + Compact compiler…)" (`docs/husk-blueprint.md`); it does not document install commands of its own.

## Configuration

The only environment file in the repo is `.env.example` at the root (there is no `test/.env.example`):

```bash
# .env.example — the only variable it defines (the rest of the file is comments)
DILISENSE_API_KEY=
```

`test/src/screening.ts` resolves the key in this order: the process environment first, then Node's `process.loadEnvFile` on `<repo root>/.env`, then `test/.env`. Missing files are ignored; a real env value always wins. Never commit a key — the root `.gitignore` ignores `.env`, `.env.local`, `.env.*.local`, `.env.preview` and `.env.preprod`.

The variables actually read by this code (verified by searching for `process.env` across `contracts/` and `test/src/` — these four are the complete set):

| Variable | Read by | Default | Example | Purpose |
|---|---|---|---|---|
| `DILISENSE_API_KEY` | `test/src/screening.ts` (`resolveDilisenseApiKey`) | none — absent means the key is missing, and screening fails closed (`passed: false`) | `DILISENSE_API_KEY="your-dilisense-key-here"` | Auth for the real dilisense `checkIndividual` call. Without it, `pay-screening.test.ts` is skipped entirely; `screeningPassed` returns false, never "allowed". The value is never logged. |
| `MIDNIGHT_NETWORK` | `test/src/config.ts` (`getConfig`), `test/vitest.config.ts`, both test files | `local` | `MIDNIGHT_NETWORK=local` | Selects the network config: `local` (`undeployed`), `preview` or `preprod`. Any other value throws `Unknown network: …`. `yarn test:local` sets it to `local`; plain `yarn test` relies on the `?? 'local'` default in code. |
| `MIDNIGHT_PROOF_SERVER` | `test/src/config.ts` | `http://127.0.0.1:6300` | `MIDNIGHT_PROOF_SERVER=http://127.0.0.1:6300` | Proof-server URL **for the `preview` and `preprod` configs only**; the `local` config always uses `http://127.0.0.1:6300` (the port `test/compose.yml` publishes). |
| `LOG_LEVEL` | both test files (`pino({ level })`) | `info` | `LOG_LEVEL=debug` | Log verbosity, standard pino levels. |

Notes on network selection:

- `test/vitest.config.ts` reads `MIDNIGHT_NETWORK` too: for any non-`local` value it loads `.env.<network>` from the project directory (so `test/.env.preview` or `test/.env.preprod` when running from `test/`) as test env vars; shell env still wins. No `.env.preview` / `.env.preprod` file is tracked in the repo.
- A comment in `test/vitest.config.ts` refers to `MIDNIGHT_PREVIEW_SEED`, but **no code reads that variable**: both test files build their wallets from the hardcoded dev seeds `…0001` (Alice) and `…0002` (Bob). Do not set it expecting an effect.
- Ports published by `test/compose.yml` (all bound to `127.0.0.1`): node `9944`, indexer `8088`, proof server `6300`. The indexer is configured with network id `undeployed` and the node with `CFG_PRESET: dev`.

Only `local` is verified end-to-end by this repo's test suite; the `preview`/`preprod` plumbing in `test/src/config.ts` and `test/vitest.config.ts` is untested here — do not assume those networks work. Both test files build their wallets from the hardcoded dev seeds `…0001` (Alice) and `…0002` (Bob) regardless of the network setting.

## Usage

All commands below run from `test/` (that is where `package.json` lives).

### Compile the contract

```bash
cd test
yarn compile
# Compiling 1 circuits:
```

### Run the test suite against the local devnet

```bash
cd test
yarn env:up      # docker compose up -d --wait — returns once node, indexer and proof server are healthy
yarn test:local  # MIDNIGHT_NETWORK=local yarn test
yarn env:down    # docker compose down
```

`yarn validate` chains those three (`yarn env:up && yarn test:local; yarn env:down`). `yarn test` on its own also defaults to the local network (`MIDNIGHT_NETWORK` defaults to `local` in `test/src/config.ts` and `test/vitest.config.ts`). `yarn proof:up` / `yarn proof:down` start/stop only the proof server.

What a passing run looks like (shape, from an actual fresh-clone run):

1. A vitest banner (`RUN v4.1.10 /<path>/test`); without a key it also prints `DILISENSE_API_KEY not set -- skipping real-API screening tests. Set it in .env to run these.` and reports `src/test/pay-screening.test.ts (3 tests | 3 skipped)`.
2. Pino log lines from the driver, interleaved with per-test stderr, e.g. `Building Alice (seed …0001)`, `Syncing wallet...` with `Wallet sync [n]: shielded=… unshielded=… dust=…` progress, `Alice shielded DUST balance: 250000000000000`, `Deploying Husk contract...`, `Husk deployed at: <hex address>`, `pay() tx submitted: <tx id>`, `Found shielded coin type=0x00…00 value=… mt_index=…`, and a balance line like `PASS balances: alice 250000000000000 -> 200000000000000, bob 250000000000000 -> 300000000000000, txId=<tx id>`.
3. A standard vitest summary at the end, e.g. `Test Files  1 passed | 1 skipped (2)` / `Tests  4 passed | 3 skipped (7)`.

Proving and submitting is the slow part: in the run above, `pay()` plus the recipient's spend-back took 300 s, while the three tests that revert before any proof is submitted took under a second each. The suite allows 10 minutes per test and 15 minutes per hook on the local network (`test/vitest.config.ts`; non-local networks get a longer hook timeout). Timings and tx ids differ on every run — the values above illustrate the shape of the output, they are not reproducible.

### Use the contract from your own code

There is no published client library yet (`docs/husk-blueprint.md` Phase 4 defers a `husk-client` package). The pattern to copy is in `test/src/test/pay.test.ts`: build a wallet (`test/src/wallet.ts`), build providers (`test/src/providers.ts`), compile a binding with `makeCompiledHusk(witnesses)` from `contracts/index.ts`, then use `deployContract` / `submitCallTx` from `@midnight-ntwrk/midnight-js-contracts` with `circuitId: 'pay'`. When submitting, pass `additionalCoinEncPublicKeyMappings` mapping the recipient's coin public key to their encryption public key, otherwise the recipient's wallet cannot decrypt the coin.

## API reference

The contract exposes exactly one circuit and one ledger field (`contracts/husk.compact`; signatures confirmed against the generated `contracts/managed/husk/compiler/contract-info.json`).

### `export circuit pay(recipient, coin, amount, recipientName): []`

Four parameters, no return value. In the compiled `contract-info.json` the circuit's `"pure"` flag is `false` (it touches the ledger and calls witnesses) and `"proof"` is `true`.

| Parameter | Compact type | Encoded as (runtime) | Meaning |
|---|---|---|---|
| `recipient` | `ZswapCoinPublicKey` = `{ bytes: Bytes<32> }` | `{ bytes: encodeCoinPublicKey(bob.getCoinPublicKey()) }` | The recipient's shielded coin public key — the only recipient identity a shielded payment exposes. Mapping this key to the off-chain identity that was actually screened is the driver's responsibility (`docs/architecture.md`). |
| `coin` | `ShieldedCoinInfo` = `{ nonce: Bytes<32>, color: Bytes<32>, value: Uint<128> }` | `encodeShieldedCoinInfo({ type/color, nonce: Uint8Array, value: bigint })` (the tests build `{ type: DUST_TYPE, nonce: randomBytes(32).toString('hex'), value }`, where the runtime field is named `type` and the Compact field `color`) | A **fresh** coin descriptor (invented nonce, value anchored to a coin the payer's wallet really holds) — the caller does not name an existing coin by ledger position. The wallet's balancer funds the contract-addressed output. |
| `amount` | `Uint<128>` | `bigint` | Must equal `coin.value` exactly; a partial payment is rejected by an assert (see invariants below). |
| `recipientName` | `Opaque<"string">` | `string` | The payer-supplied claimed name of the recipient. `Opaque<"string">` is unreadable by the circuit: the generated runtime forwards it into the `screeningPassed` witness call and nowhere else. It is never disclosed, never committed and never written to the ledger — using it in circuit code is a compile error, and it contributes zero circuit inputs to the `.zkir`. |

Behaviour, in order:

1. `assert(screeningPassed(recipient, recipientName, amount), "husk: recipient failed screening")` — the screening gate. Failure reverts the whole transaction: no coin spend, no ledger write, and no public "rejected" trace (a visible rejection would itself leak that a flagged payment was attempted).
2. `assert(amount == coin.value, "husk: partial payment not supported, amount must equal coin value")` — the exact-value gate (also what makes change impossible by construction).
3. `receiveShielded(disclose(coin))` then `sendImmediateShielded(disclose(coin), left<ZswapCoinPublicKey, ContractAddress>(disclose(recipient)), disclose(amount))` — momentary custody of the freshly constructed coin, forwarded in full to the recipient in the same atomic call. `disclose()` here is the compiler's permission gate for private values entering coin primitives, not a publication of plaintext.
4. `assert(result.change.is_some == false, "husk: unexpected change coin")` — safety net; not expected to fire given step 2.
5. Inserts a hiding commitment into the ledger: `persistentCommit<Vector<4, Bytes<32>>>([pad(32, "husk:screened:payment:v1"), recipient.bytes, amount as Bytes<32>, result.sent.nonce], screeningNonce())`. Only the commitment is disclosed — never the nonce, recipient or amount. A repeated identical payment still produces a distinct entry, because the nonce is fresh.

### Ledger

| Field | Type | Notes |
|---|---|---|
| `screened` (exported, ledger index 0) | `Set<Bytes<32>>` | One hiding commitment per payment that passed screening. It proves *a* payment was screened and cleared; it carries no amount, no party, and no timestamp beyond block inclusion. Read off-chain through the generated binding: `ledger(state).screened`. |

There is no balance or custody field — value stays in native Zswap shielded coins, and nothing persists in the contract between calls. The generated binding also exports `pureCircuits`, which is empty: `pay` is the contract's only circuit and it is impure.

### Witnesses

| Witness | Signature | Supplied by |
|---|---|---|
| `screeningPassed` | `(recipient: ZswapCoinPublicKey, recipientName: Opaque<"string">, amount: Uint<128>): Boolean` | The driver. Real implementation: `makeScreeningWitness` in `test/src/screening.ts`, built from verdicts pre-fetched by `screenRecipientName` (dilisense, fail-closed). `pay.test.ts` substitutes a deterministic JS boolean so contract logic can be exercised without spending API quota. Compact witnesses are synchronous, so the driver screens first and hands the pre-computed verdict in; a name with no verdict returns `false`. |
| `screeningNonce` | `(): Bytes<32>` | The driver, once per payment. Fresh uniform randomness (a CSPRNG in production; `randomBytes(32)` in the tests). It is the commitment's hiding salt — reuse would make entries linkable. |

## Project structure

The tracked files (`git ls-files`), annotated:

```
.
├── .env.example                 # template for DILISENSE_API_KEY (see Configuration)
├── .gitignore                   # ignores .env + variants, node_modules/, contracts/managed/, .vscode/* except mcp.json
├── .vscode/mcp.json             # `midnight-kapa` MCP server (https://midnight.mcp.kapa.ai) for editor docs lookups, not the demo agent
├── LICENSE                      # Apache License 2.0
├── README.md
├── contracts/
│   ├── husk.compact             # the contract: `screened` ledger, 2 witnesses, the pay() circuit
│   ├── index.ts                 # zkAssetsPath + makeCompiledHusk(); re-exports the generated binding
│   └── managed/                 # NOT tracked — compiled output, created by `yarn compile`
├── docs/
│   ├── architecture.md          # state model, flow, screening oracle, scope decisions
│   └── husk-blueprint.md        # problem statement, target user, roadmap phases, out-of-scope list
└── test/                        # the test project (own package.json, tsconfig, yarn.lock, compose stack)
    ├── .gitignore               # ignores midnight-level-db/, .yarn/install-state.gz, node_modules/, logs/*.cache.json
    ├── .yarnrc.yml              # Yarn Berry config (node-modules linker)
    ├── compose.yml              # local devnet: node 9944, indexer 8088, proof server 6300
    ├── package.json             # scripts: compile, test, test:local, env:up/down, proof:up/down, validate
    ├── tsconfig.json            # ES2022, strict, noEmit
    ├── vitest.config.ts         # node env, 10-min test timeout, no file parallelism
    ├── yarn.lock
    └── src/
        ├── config.ts            # local / preview / preprod endpoint sets
        ├── providers.ts         # Midnight.js providers (indexer, proof server, zk config, private state)
        ├── screening.ts         # real dilisense oracle + screeningPassed witness factory
        ├── wallet.ts            # wallet provider: sync, shielded transfer, coin lookup, balancing/submission
        └── test/
            ├── pay.test.ts             # 4 tests: PASS / FAIL / EDGE-exceeds / EDGE-partial (no API key)
            └── pay-screening.test.ts   # 3 tests: CLEAN / PEP-only / SANCTIONED (needs DILISENSE_API_KEY)
```

Only `contracts/` (the contract and its binding), `test/` (driver + test harness) and `docs/` (the two design documents) carry code or specification. There is no CI configuration, no `CONTRIBUTING.md` and no `test/.env.example` in this repo — see [Testing](#testing) and [Contributing](#contributing).

## Testing

Two test files, both against the local devnet from `test/compose.yml`. Run them with:

```bash
cd test
yarn env:up      # start the devnet and wait for health
yarn test:local  # MIDNIGHT_NETWORK=local yarn test → NODE_OPTIONS='--experimental-vm-modules' vitest run
yarn env:down
```

A real run in a clean clone (no `DILISENSE_API_KEY` set) finished like this:

```
 ↓ src/test/pay-screening.test.ts (3 tests | 3 skipped)
 ✓ src/test/pay.test.ts (4 tests) 329552ms
     ✓ PASS: screening passed, amount == coin.value → pay() succeeds, screened gains exactly one entry, recipient coin is real and spendable  300835ms
     ✓ FAIL: screening witness returns false → pay() reverts, screened Set unchanged, sender balance unchanged  442ms
     ✓ EDGE-exceeds: amount > coin.value → fails at the exact-amount assert, distinguishable from a screening failure  453ms
     ✓ EDGE-partial: amount < coin.value (genuine partial-payment attempt) → fails at the exact-amount assert  551ms
 Test Files  1 passed | 1 skipped (2)
      Tests  4 passed | 3 skipped (7)
   Duration  341.54s (transform 262ms, setup 0ms, import 11.04s, tests 329.55s, environment 1ms)
```

Take those numbers as a shape reference, not an expectation: the PASS test dominates the runtime because it proves and submits real transactions (~5 minutes here), while the FAIL/EDGE tests revert at the first assert before any proof is submitted (sub-second each). Both files need the devnet running; the wallets are built from the fixed seeds `…0001` / `…0002`, which the dev node's genesis funds (no faucet or drip call exists in the code — the suites only assert that Alice holds at least one shielded DUST coin to fund the payment).

### `test/src/test/pay.test.ts` — contract logic, no API key required

Wires a deterministic JS stub for `screeningPassed` (and `randomBytes(32)` for `screeningNonce`), so the contract's own logic is what is under test and zero dilisense quota is spent. Note the stub's signature omits the name argument (`(_ctx, _recipient, _amount)`) — the name flows through for real in `pay-screening.test.ts`. Four cases:

| Test | What it establishes |
|---|---|
| PASS | Screening passes and `amount == coin.value`: `pay()` succeeds; `screened` gains **exactly one** entry; the recipient's wallet discovers a real committed coin with the exact value and `mt_index > 0`; the recipient then spends it back, proving it is genuinely spendable. |
| FAIL | `screeningPassed` returns false: the transaction reverts with `husk: recipient failed screening`; the `screened` set is unchanged and the sender's shielded balance is unchanged. The error is asserted **not** to be the exact-amount message. |
| EDGE-exceeds | `amount = coin.value + 1`, with screening passing so the failure cannot be the screening gate: fails at the exact-value assert (`husk: partial payment not supported, amount must equal coin value`); no ledger write, no balance change; the superseded `husk: amount exceeds coin value` message must not appear. |
| EDGE-partial | `amount = coin.value - 1`: same exact-value assert, same absence of state change. |

### `test/src/test/pay-screening.test.ts` — real screening policy branches, needs `DILISENSE_API_KEY`

Wires the real oracle (`makeScreeningWitness` over verdicts fetched by `screenRecipientName`) into `pay()` on the running devnet, covering three policy branches:

| Test | Claimed name | Expected |
|---|---|---|
| CLEAN | `Ferdinand Bricklemeister` (invented, unlisted) | `passed: true`, `pepFlagged: false`, `total_hits: 0`; `pay()` succeeds and `screened` gains an entry. |
| PEP-only | `Angela Merkel` (canonical PEP) | `passed: true`, `pepFlagged: true` with PEP hits and no blocking hits; the structured `SCREENING_PEP_FLAG` line is logged (not silent) and `pay()` proceeds. |
| SANCTIONED | `Igor Sechin` (OFAC/EU-listed) | `passed: false` with SANCTION/CRIMINAL hits; `pay()` reverts with `husk: recipient failed screening`; no ledger write, no balance change. |

Quota discipline: the free tier is 100 calls/month, so the suite spends **at most one call per claimed name, ever** (three total). The first run records each full response in `test/logs/screening-verdicts.cache.json` (gitignored via `test/.gitignore`'s `logs/*.cache.json`); later runs replay the recorded verdict, logged as cached, with zero API calls. Without a key the whole file is skipped at collection time (`describe.skipIf`), reports as skipped, and the suite still passes:

```
DILISENSE_API_KEY not set -- skipping real-API screening tests. Set it in .env to run these.
 ↓ src/test/pay-screening.test.ts (3 tests | 3 skipped)
```

### What is not covered

- **No CI runs any of this.** There is no `.github/` directory, no workflow file and no CI config anywhere in `git ls-files`; the suite runs only when someone starts the devnet and runs it locally. That is also why this README has no build/status badge.
- **No tests for the fail-closed branches of `screening.ts`**: the HTTP-error, timeout, transport-failure and "witness invoked for an unscreened name" paths (`passed: false`) are implemented but not exercised by either file (the live-call count assertion in `pay-screening.test.ts` only covers the pass/block policy branches).
- **No unit tests, and no lint or type-check script**: `test/package.json` has no `lint`/`typecheck` script, and nothing in the scripts runs `tsc` (`test/tsconfig.json` is `noEmit`).
- **No boundary coverage** for `Uint<128>` limits, no multi-recipient or parallel-payment tests, and no tests for a demo agent or a client library — neither exists in this repo yet (`docs/husk-blueprint.md` Phase 3 and Phase 4 are unchecked).

## Deployment

There is no deployment path beyond local devnet testing, and this section will not pretend otherwise:

- There is no deploy script, no published contract address, no network-specific deployment artifact and no CI in this repo. The `test/package.json` scripts only compile and run tests.
- Both test files deploy a **fresh contract instance per run** inside `beforeAll` (`deployContract` from `@midnight-ntwrk/midnight-js-contracts`), so the address printed in a run (`Husk deployed at: <hex>`) is an ephemeral devnet address, not a stable deployment.
- `test/src/config.ts` does define `preview` and `preprod` endpoint sets, selectable via `MIDNIGHT_NETWORK`, but nothing in the repo demonstrates or documents deploying there, and both suites build wallets from hardcoded dev seeds (see [Configuration](#configuration)).

The Wave 2 items that would make this section real — an owner-triggered auditor disclosure proof, multi-asset support and a published `husk-client` library — are explicitly out of scope for this wave in `docs/husk-blueprint.md` (§6 Phase 6, §7).

## Troubleshooting / FAQ

These are issues this project actually hit, or that a fresh-clone verification run hit, plus the documentation mismatches currently present in the repo. Nothing here is generic filler.

**1. Windows: use WSL2, not the native Windows toolchain.** `docs/husk-blueprint.md` Phase 0 records the environment as "WSL2 + Docker Desktop + Compact compiler". The local devnet is a Docker Compose stack, and the Compact compiler is invoked directly by `yarn compile`. Running the suite from a native Windows shell is not a documented path here.

No specific native-Windows error message is captured in this repo; the requirement stands as documented, without an invented symptom.

**2. `yarn compile` fails before `yarn install`.** Yarn refuses to run scripts without its install state file:

```
Usage Error: Couldn't find the node_modules state file - running an install might help (findPackageLocation)
```

Run `yarn install` first (see [Installation](#installation)).

**3. Tests (or any import of `contracts/index.ts`) fail with a missing module** until the contract is compiled:

```
Error: Cannot find module './managed/husk/contract/index.js' imported from .../contracts/index.ts
Serialized Error: { code: 'ERR_MODULE_NOT_FOUND' }
```

`contracts/managed/` is gitignored build output; it does not exist in a fresh clone. Run `yarn compile`.

**4. `sendShielded` cannot spend a coin the caller's wallet owns.** This was the original failure mode of `pay()`; the fix is in the current contract (and in commit `8a82652`, "Fix pay(): sendShielded cannot spend a caller-owned coin"). `sendShielded` requires the contract to already own its input coin, which an agent's own wallet coin never is. `pay()` therefore takes momentary custody inside one atomic call — `receiveShielded` accepts a freshly constructed coin addressed to the contract (funded by the payer's wallet at the balancing layer), then `sendImmediateShielded` forwards that same coin to the recipient (`docs/architecture.md` §State).

**5. Partial payments are rejected — deliberately.** `husk: partial payment not supported, amount must equal coin value` means `amount != coin.value`. This is not a bug to patch out: `sendImmediateShielded` returns change as a *contract-owned* coin, and the SDK exposes no way to enumerate a contract's owned coins to find and re-spend that change later, so any partial payment would strand value in the contract permanently. An agent paying a non-round amount must split coins at the wallet layer beforehand (`docs/architecture.md` §State).

**6. dilisense fuzzy matching produces false positives (and the policy keeps them).** Husk queries with `fuzzy_search=1` to catch spelling/transliteration variants of listed names. The cost is documented in `docs/architecture.md`: a query for "Igor Sechin" (Rosneft CEO, born 1960) also matched an unrelated FSB officer named "Igor Anatolyevich Sushchin", on a shared given name and a surname three edits away. dilisense's response carries no match score or matched-field, so Husk cannot distinguish a strong identity match from a weak token-level one and is fail-closed: any SANCTION/CRIMINAL hit blocks the payment. That prevents evasion but causes measurable false refusals — a known tradeoff, not a defect in the wiring.

**7. dilisense quota is small and metered.** The free tier is 100 calls/month. `pay-screening.test.ts` spends at most one call per claimed name, ever (three total), recording each response in `test/logs/screening-verdicts.cache.json` and replaying it on later runs (logged as cached). If you delete that cache file, the next run spends real calls again.

**8. `DILISENSE_API_KEY not set -- skipping real-API screening tests. Set it in .env to run these.`** is the expected, non-fatal message when no key is available: the three screening tests report as skipped and the `pay()` logic suite still runs to completion. Set the key (root `.env` or `test/.env`, or the real environment) to run them.

**9. Documentation drift in this repo — prefer the code and `docs/architecture.md` over the checklists.** Verified examples:

- `docs/husk-blueprint.md` Phase 0 still reads `- [ ] Confirm access to a real screening data source (dilisense — signup pending on work-email requirement)`, while dilisense is wired and live in `test/src/screening.ts`.
- Phase 1–5 in the same file are entirely unchecked, including "Confirm the contract compiles" — although `yarn compile` succeeds and the four contract tests pass.
- The key-concepts table in §5 still lists "contract coin-custody bookkeeping" as public state; the current contract's only ledger field is `screened`, and custody is momentary (there is no custody record).
- `test/vitest.config.ts` mentions `MIDNIGHT_PREVIEW_SEED` in a comment, but no code reads it.
- `docs/architecture.md` itself records two earlier drafts it had to correct (the custodial commitment-ledger design, and the removed `deriveAgentKey` identity scaffolding) — the code is the current truth; when the docs and the contract disagree, the contract and the compiled `contract-info.json` win.

**10. `yarn env:up` looks like it hangs.** It runs `docker compose up -d --wait`, so it blocks until the node, indexer and proof server have all reported healthy — typically a minute-plus on a first start. In one verification run on a 7.6 GB-RAM machine, the indexer container exited (code 1) shortly after the node became healthy and `env:up` failed; re-running the same command brought all three services up healthy. If `env:up` exits non-zero, check `docker compose logs indexer` and re-run it.

**11. Benign output in a passing run** (all observed in the final green run above, none of which indicates a failure): the `--experimental-vm-modules` setting from the `test` script, Node's `DEP0040` punycode deprecation warning, `Sourcemap for ".../contracts/managed/husk/contract/index.js" points to missing source files`, and subxt notices such as `RPC-CORE: subscribeRuntimeVersion(): RuntimeVersion:: disconnected from ws://127.0.0.1:9944/: 1000:: Normal Closure`.

**12. Closed-wallet/state leftovers between runs.** `test/.gitignore` ignores `midnight-level-db/` (the level private-state store) and `logs/*.cache.json`. If a run behaves oddly, deleting `test/midnight-level-db/` gives you a clean private-state store; the suites also create a fresh private-state store name per provider build (`husk-pay-${Date.now()}`).

**13. Compact CLI `--skip-zk` vs `--skip-zkir` drift.** Documented project history from `docs/husk-blueprint.md` (not freshly reproduced): the docs named a `--skip-zk` flag while the compiler accepted `--skip-zkir`. Kept here so the mismatch stays on record even though neither string appears in any currently tracked file.

## Midnight and Compact development challenges

`docs/architecture.md` has **no** section titled "Challenges & Discoveries" — its sections are State, Flow, Screening oracle — real, from Wave 1, What is intentionally NOT built this wave, Demo agent (Wave 1) and Design questions — resolved. The findings below are the ones actually recorded across those sections (and in `docs/husk-blueprint.md` and the contract's own comments); nothing here is invented.

- **Compact has no private-ledger primitive.** Everything declared with `ledger` is public. Privacy comes from data that never touches the ledger, with only commitments published on-chain (`docs/architecture.md` §State).
- **`disclose()` is a permission gate, not a leak.** The compiler requires `disclose()` wherever a witness-derived value enters a ledger or coin-primitive call; the actual value privacy of a shielded coin comes from Zswap (commitments and nullifiers, not plaintext amounts), independently of the `disclose()` calls needed to satisfy the compiler.
- **Hashes bind, they do not hide.** The docs record the resolution explicitly: use `persistentCommit`/`transientCommit` from `CompactStandardLibrary`, never hand-rolled `persistentHash`-based commitments for hiding purposes. The ledger entry in `pay()` is a `persistentCommit` under a fresh witness salt for exactly this reason; the domain tag (`pad(32, "husk:screened:payment:v1")`) distinguishes the entry's purpose.
- **Witnesses are synchronous.** `screeningPassed` cannot perform an async HTTP call itself, so the driver screens first (`screenRecipientName`, async) and hands the pre-computed verdict into the witness (`makeScreeningWitness`); a name with no pre-computed verdict returns `false` rather than skipping the check.
- **`Opaque<"string">` is genuinely unreadable by the circuit.** The claimed recipient name reaches the witness call and nothing else: the compiler rejects any disclose/commit/use of it inside circuit code, and the compiled `.zkir` contains no trace of it and consumes zero circuit inputs for it — verified by compilation with compact 0.5.2 / compiler 0.31.1 / language 0.23.0 (contract comments, `contract-info.json`).
- **Change coins are unrecoverable, so change was designed out.** `sendImmediateShielded` returns any change as a contract-owned coin, and the SDK at this version exposes no way for off-chain code to enumerate a contract's owned coins in order to find and re-spend that change. Rather than strand value, `pay()` requires `amount == coin.value` exactly; coin splitting for non-round amounts is deferred to the wallet layer by design.
- **The wallet's balancer picks the input UTXO, not the caller.** An earlier design assumed the caller names a specific `QualifiedShieldedCoinInfo` by ledger position; the mechanism actually takes a bare `ShieldedCoinInfo` (color + value) and lets the wallet balancer choose which of the payer's coins cover it. That is a behavioural difference clients have to account for, and it changes what `pay()`'s `coin` argument means (a fresh descriptor, not an existing coin).
- **Delivery needs the recipient's encryption key, supplied by the payer's driver.** The payer passes the recipient's coin public key *and* maps it to the recipient's encryption public key (`additionalCoinEncPublicKeyMappings` in the tests), otherwise the coin ciphertext cannot be decrypted by the recipient. There is no relay service: the recipient discovers the coin by ordinary wallet sync.
- **Routing cannot be enforced at this layer.** The original design held custody in a contract-tracked commitment map to stop an agent bypassing screening; the docs record that reasoning as wrong and it was removed — nothing at this layer can force a payment through a particular contract, and no comparable system (x402, Coinbase Agentic Wallets, Mastercard Agent Pay) can either. Husk's claim was narrowed accordingly. The consequence: custody was dropped, `pay()` operates on coins the agent already holds, and double-spend/replay protection comes from Zswap's own nullifiers instead of Husk logic.
- **Toolchain versions must line up.** The contract pins `pragma language_version 0.23`, and the compile output records compiler `0.31.1`, language `0.23.0`, runtime `0.16.0`; `docs/husk-blueprint.md` Phase 0 records the compiler as "pinned to 0.31.1 per official compatibility matrix". The Midnight.js packages in `test/package.json` are pinned to exact versions (`4.1.1`, wallet SDK `1.2.0`) rather than ranges, while the remaining dependencies use caret ranges.

Also worth budgeting for: proving is slow locally. In the verification run, one `pay()` that submits two transactions took ~5 minutes, and the other three tests — which revert before any proof is submitted — took under a second each.

## Contributing

There is no `CONTRIBUTING.md` and no pull-request template in this repo (verified — the only tracked files are the ones listed under [Project structure](#project-structure)). These are the expectations, stated plainly rather than linked:

**Before opening a PR**

1. Run the full flow locally and keep the output: `cd test && yarn install && yarn compile && yarn env:up && yarn test:local && yarn env:down`. A PR that changes the contract or the driver should include a run showing `Tests  4 passed | 3 skipped (7)` or better (with `DILISENSE_API_KEY` set, `Test Files  2 passed (2)`).
2. Do not commit `.env` files, keys, `contracts/managed/` (compile output), `test/midnight-level-db/`, or `test/logs/*.cache.json` — all are gitignored, and a real dilisense key must never land in the repo or in logs.
3. Keep `docs/architecture.md` in sync with the contract. That file states it is "the first thing a technical judge checks against the code"; if a change alters the state model, the flow, the screening policy or the scope claims, update it in the same PR. `docs/husk-blueprint.md`'s roadmap checkboxes are already stale (see [Troubleshooting](#troubleshooting--faq) item 9) — fixing them is welcome, but do not treat them as the spec.
4. Update the policy comment block at the top of `test/src/screening.ts` (and the tests) if you change screening behaviour; the fail-closed policy is documented there, in `docs/architecture.md` and in the contract comments, and all three need to agree.

**What to expect in review**

- Small, focused PRs over large rewrites. Changes to the deliberate design decisions — the exact-value gate, momentary custody via `receiveShielded` + `sendImmediateShielded`, the fail-closed screening policy, or the `screened` commitment format — should be raised as an issue first, since each of them is a documented tradeoff with a reason behind it.
- State the verification status of your change: which commands you ran, what the output was, and what you did **not** verify. `docs/husk-blueprint.md` §6 supporting goal 5 is explicit that the project's credibility rests on separating what is built from what is planned.
- No CLA, linter config or commit-message convention is configured in this repo, so there is nothing to conform to beyond the above.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). The file at the repo root is the standard, unmodified Apache 2.0 text; `contracts/husk.compact` carries the matching per-file header ("Copyright 2026 phllp-tanstic"). No other tracked file has a license header. The repo is also tagged `midnightntwrk` and `midnightntwrk-compact`.
