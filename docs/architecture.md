# Husk — Architecture

## State

Compact has no "private ledger" primitive — everything declared with `ledger` is
public, visible to all network observers. Privacy comes from a different mechanism:
data that never touches the ledger at all (witness-held private state, local to
the contract's committed values), with only *commitments* (hashes) of that data
published on-chain. This section was corrected from an earlier draft that used
"private ledger" as if it were a restricted-access ledger type — it isn't; no
such primitive exists in Compact.

**Custody model:** Husk acts as a private, compliance-gated clearing layer, not
a pass-through observer of wallet-to-wallet transfers. This is a deliberate
choice, not an implementation detail — if value moved wallet-to-wallet outside
Husk's control, an agent could simply skip calling Husk and bypass screening
entirely, defeating the point.

**Deposit (agent → Husk custody):**
- An agent deposits value into Husk using Midnight's native shielded coin
  primitives (`mintShieldedToken` / `sendShielded`, per `CompactStandardLibrary`).
- The coin becomes contract-owned, tracked via the ledger's native `Map.insertCoin`
  pattern — this part is genuinely public-ledger bookkeeping (coin custody), but
  reveals only that *a* coin is held by the contract, not which agent it
  corresponds to or its value, once linked to the committed balance below.

**Per-agent balance (private, committed):**
- Each agent's balance *within* Husk is private state, committed via
  `persistentCommit(value, rand)` (or `transientCommit` for values not needing
  cross-session persistence) — never stored raw, never passed through `disclose()`.
- Agent identity is derived from a witness-held secret key (never `ownPublicKey()`,
  which is prover-claimed and not cryptographically bound to the actual signer).

**Per-transaction data (private):**
- Amount and counterparty for a given `pay()` call are private circuit inputs,
  never disclosed. Per Compact's disclosure model, an ordinary circuit parameter
  stays private by default unless explicitly disclosed — no special "private
  ledger" needed for this either.

**Public ledger state:**
- A commitment/nullifier per screened transaction: proves *a* payment was
  checked and cleared, carries no amount, no parties, no timestamp beyond
  block inclusion.
- Contract-held coin custody records (native ledger bookkeeping for the
  deposited value pool itself — not per-agent, not per-transaction).

**Withdrawal (Husk custody → agent's own wallet):** a separate, later action
using `sendShielded`, outside the scope of the `pay()` flow itself. Full design
deferred to Phase 1 implementation — noted here as an open item, not yet
speced.

This is the dual-ledger split the rubric's Engineering criterion grades directly
— keep this section accurate as the contract evolves, since it's the first
thing a technical judge checks against the code.

## Flow

1. Agent A calls `pay(agentB, amount)`.
2. Contract checks A's committed balance (via `persistentCommit`) covers `amount`,
   without revealing the balance itself.
3. Contract queries the screening oracle (real data from Wave 1 — see below) with the minimum needed to check — not the full transaction.
4. **Pass:** both agents' committed balances update atomically within Husk's own
   contract state (A -amount, B +amount) — this is possible in a single circuit
   call because both balances live in Husk's own private state, not split across
   two separate wallets' local state; a public commitment is emitted proving a
   screened payment cleared. Nothing else public.
5. **Fail:** transaction reverts. Nothing is written publicly — a visible "rejected" event would itself leak that A attempted a flagged payment, which defeats the point.
6. **(Wave 2+, not this wave):** owner-triggered disclosure proof — "N payments over period P, all screened, total under $X" — revealed to one chosen party, individual transactions still hidden.

## Screening oracle — real, from Wave 1

Circle's Compliance Engine is gated behind an enterprise request form — not viable for a solo build. Instead:

- **Primary:** OpenSanctions — free, open-source, real OFAC/UN/EU/UK sanctions + PEP data. Self-hosted or queried via their API. Ruled out for Husk specifically: OpenSanctions classifies compliance screening as commercial use regardless of revenue, not eligible for the free/journalist key; only a 30-day trial is available via hosted API, which may not cover the full buildathon timeline.
- **Alternative if a hosted API is preferred over self-hosting:** sanctions.io and ComplyAdvantage were both considered — neither currently offers a genuine ongoing self-serve free tier (sanctions.io is contract/calculator-based; ComplyAdvantage's cheapest self-serve plan is paid, with a discretionary startup-grant program as the only free path).
- **Current candidate:** dilisense — self-serve, ongoing free quota (100 checks/month, not time-boxed), covers sanctions + PEP + criminal + adverse media, EU-hosted, GDPR-compliant, no query logging. Signup requires a work email; in progress.

The off-chain service wraps whichever provider is chosen behind one interface (`screen(address_or_name) -> pass/fail`), and the Compact contract calls that interface. Real data from Wave 1; the interface boundary just means the provider can be swapped without touching contract logic if needed later.

## What is intentionally NOT built this wave

- Trading/swap actions
- Multi-asset support
- General agent-management dashboard
- Full KYT-style transaction-graph risk scoring (address/name screening against real sanctions lists is in scope; deep transaction-pattern risk modeling is not — that's a v2 concern)

## Demo agent (Wave 1)

Agent A runs as a real Claude session connected via MCP — not a standalone script, not a UI button. The session is given a real trigger (consumes an actual free-tier external API) and a scoped goal ("pay the provider for this service if it's within policy"); the tool call to `pay()` happens because the session decided to make it, live.

**MCP tool surface (kept to three, deliberately small):**
- `get_balance()`
- `check_policy(amount)`
- `pay(counterparty, amount)`

These wrap the real Midnight wallet calls — no separate mock layer for the agent side.

**Reliability plan for a live demo:** LLM tool-calling isn't perfectly deterministic, so:
- Keep the triggering condition and system prompt narrow enough that the tool-call decision is close to deterministic given the same input — the goal is genuine autonomy, not open-ended ambiguity that invites a bad run on stage.
- Dry-run the exact demo trigger multiple times beforehand to confirm it reliably converges on calling `pay()`.
- Record a clean successful run as a backup video alongside the live attempt — standard practice, doesn't make the system less real, just protects against a live-demo hiccup in front of judges.

## Open questions to resolve before writing Compact

- [x] Exact Compact syntax for private-state declarations and witness functions — resolved via research against official docs/repos; see custody model above.
- [x] How the real screening-provider call is expressed as a witness/oracle pattern in Compact — to be finalized once the screening provider (dilisense) signup completes.
- [x] Nullifier/commitment primitive Compact exposes natively vs. what needs custom circuit logic — resolved: use `persistentCommit`/`transientCommit` from `CompactStandardLibrary`, never hand-rolled `persistentHash`-based commitments for hiding purposes (hashes bind, they don't hide).
