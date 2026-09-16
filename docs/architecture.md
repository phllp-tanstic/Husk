# Husk — Architecture

## State

Compact has no "private ledger" primitive — everything declared with `ledger` is
public, visible to all network observers. Privacy comes from a different mechanism:
data that never touches the ledger at all, with only *commitments* (hashes) of
that data published on-chain.

**Value model: native Zswap shielded coins, not a hand-rolled ledger.**
An earlier draft of this document proposed Husk holding custody of agent funds
in a contract-tracked commitment map, on the reasoning that custody would stop
an agent from bypassing Husk's screening. That reasoning was wrong and has been
removed: nothing at this layer can force a payment to route through any
particular contract — an agent operator can always call a native wallet transfer
directly, with or without Husk holding custody. This isn't a Husk-specific gap;
no comparable system (x402, Coinbase Agentic Wallets, Mastercard Agent Pay) can
make this guarantee either — compliance routing is an application-layer choice
in all of them, not something the protocol can enforce. Husk's actual claim is
narrower and still real: *when a payment is routed through Husk, it is genuinely
screened and the transaction stays private* — not that routing through Husk is
unavoidable.

Given that, custody adds cost (a hand-rolled balance ledger, replay-protection
logic Husk would have to build and prove itself) without buying the guarantee
it was meant to buy. So pay() operates directly on value the agent already
holds in their own wallet — but not via a direct sendShielded spend of the
agent's coin. sendShielded requires the contract to already own its input
coin, which an agent's own wallet coin never is. pay() instead takes
momentary custody within the same atomic call: receiveShielded accepts
a freshly-constructed coin descriptor addressed to the contract (funded by
the agent's wallet at the balancing layer, not chosen by mt_index), then
sendImmediateShielded forwards that same coin onward to the recipient in
the same transaction. Nothing persists after the call completes — no
contract-held balance survives between payments.

Constraint: pay() requires the payment amount to equal the input coin's
value exactly — no partial payments, no change. This is deliberate, not a
missing feature. sendImmediateShielded returns any change as a
contract-owned coin, and the SDK currently exposes no way for off-chain code
to enumerate a contract's owned coins to discover and re-spend that change
later — building that recovery path would mean the contract holds
unreachable value indefinitely on any partial payment. Requiring an exact
match keeps the "nothing lingers" property genuinely true rather than true
only in the common case. The practical implication: an agent paying a
non-round amount needs a wallet-level coin split beforehand — this is
deferred to the agent/wallet layer by design, not something pay() handles.

One further consequence of this mechanism: the agent's wallet — not the
agent's own choice of a specific held coin — determines which underlying
UTXO funds a payment. Earlier designs assumed the caller names a specific
QualifiedShieldedCoinInfo (an existing coin, by its ledger position); the
actual mechanism takes a bare ShieldedCoinInfo (color + value only), and
the wallet's balancer selects and spends whichever of the agent's coins
cover it. This is a real behavioral difference client libraries and the
demo agent's tool surface need to account for, not just an implementation
detail.

This also means less custom security surface: double-spend/replay
protection comes from Zswap's own nullifier system, not logic Husk has to
get right unsupervised.

**Per-agent identity (private, witness-derived):**
- pay() identifies the recipient directly by their ZswapCoinPublicKey —
the real wallet key that receives the shielded output — not by a
Husk-derived identity hash. An earlier draft of this document described a
deriveAgentKey witness scheme; that scaffolding was removed from the
contract when the custodial-ledger design was dropped — custody bought no
real guarantee (see the Value model section above), so the identity
scaffolding that design needed was removed with it — and this section was
not updated to match at the time. Corrected here. Mapping a
ZswapCoinPublicKey to an off-chain identity that was actually screened remains
the driver's responsibility, same as before.

**Per-transaction data (private):**
- Amount and counterparty for a given `pay()` call are private circuit inputs.
  `disclose()` is required by the compiler wherever a witness-derived value
  passes into a ledger or coin-primitive call — this is a compiler permission
  gate, not a guarantee the value ends up plaintext on-chain. The actual
  privacy guarantee for the coin value itself comes from the Zswap protocol
  (commitments + nullifiers, not plaintext amounts), independent of the
  `disclose()` calls needed to satisfy the compiler.

**Public ledger state:**
- `screened`: a `Set<Bytes<32>>` recording a commitment per screened
  transaction that passed — proves *a* payment was checked and cleared,
  carries no amount, no parties, no timestamp beyond block inclusion.
- Native Zswap public records for the coin spend/receive themselves
  (commitments/nullifiers per the protocol's own design — not Husk-specific
  bookkeeping).

**Delivery to the recipient:** the payer's driver supplies the recipient's
shielded address — both the coin public key (the `recipient` argument to
`pay()`) and the matching encryption public key — when submitting the call
(the test driver passes them via `additionalCoinEncPublicKeyMappings`). The
output ciphertext is therefore addressed to the recipient's own encryption
key, and the recipient's wallet discovers the coin through ordinary wallet
sync, exactly like any other shielded output. The address itself is exchanged
between the two parties out-of-band before paying, as with any shielded
recipient, but there is no separate relay service: nothing beyond normal
wallet sync is needed to receive a coin Husk sent on someone else's behalf.

This is the dual-ledger split the rubric's Engineering criterion grades directly
— keep this section accurate as the contract evolves, since it's the first
thing a technical judge checks against the code.

## Flow

1. The payer's driver calls
   `pay(recipient, coin, amount, recipientName)` with a FRESH
   `ShieldedCoinInfo` descriptor (color + value, invented nonce) — not an
   existing coin named by ledger position. The payer's wallet balancer funds
   the contract-addressed output that `receiveShielded` accepts (see the
   Value model section above); `recipientName` is the payer-supplied claimed
   name of the recipient, which the circuit itself cannot read.
2. Screening happens off-chain in the driver before the call: the claimed
   name is checked against the real provider (dilisense) and a verdict is
   pre-computed. The circuit queries nothing itself — the `screeningPassed`
   witness receives the recipient key, the claimed name and the amount, and
   returns that pre-computed verdict (fail-closed on any missing or errored
   verdict).
3. **Pass:** the circuit takes momentary custody of the freshly-constructed
   coin via `receiveShielded`, then forwards its full value to `recipient` in
   the same atomic call via `sendImmediateShielded` — a single circuit call
   proved by A alone, which is all that's needed since the value transfer
   itself happens at the Zswap protocol level, not via a second party's
   private state. A hiding commitment over the payment context is added to
   `screened`, proving a screened payment cleared. Nothing else public.
4. **Fail:** transaction reverts. Nothing is written publicly — a visible
   "rejected" event would itself leak that A attempted a flagged payment,
   which defeats the point.
5. **Delivery:** via ordinary wallet sync — see "Delivery to the
   recipient" in the State section above for how the recipient's
   address reaches the call.
6. **(Wave 2+, not this wave):** owner-triggered disclosure proof — "N payments
   over period P, all screened, total under $X" — revealed to one chosen
   party, individual transactions still hidden.

## Screening oracle — real, from Wave 1

Circle's Compliance Engine is gated behind an enterprise request form — not viable for a solo build. Instead:

- **Primary:** OpenSanctions — free, open-source, real OFAC/UN/EU/UK sanctions + PEP data. Self-hosted or queried via their API. Ruled out for Husk specifically: OpenSanctions classifies compliance screening as commercial use regardless of revenue, not eligible for the free/journalist key; only a 30-day trial is available via hosted API, which may not cover the full buildathon timeline.
- **Alternative if a hosted API is preferred over self-hosting:** sanctions.io and ComplyAdvantage were both considered — neither currently offers a genuine ongoing self-serve free tier (sanctions.io is contract/calculator-based; ComplyAdvantage's cheapest self-serve plan is paid, with a discretionary startup-grant program as the only free path).
- **Current provider:** dilisense — integrated and live, signup complete. Self-serve, ongoing free quota (100 checks/month, not time-boxed), covers sanctions + PEP + criminal + adverse media, EU-hosted, GDPR-compliant, no query logging.

The off-chain service wraps whichever provider is chosen behind one interface (`screen(address_or_name) -> pass/fail`), and the Compact contract calls that interface. Real data from Wave 1; the interface boundary just means the provider can be swapped without touching contract logic if needed later.

Fuzzy matching is a name-similarity heuristic, not identity
resolution. Husk queries dilisense with fuzzy_search=1 so that
genuine spelling and transliteration variants of a listed name
are caught — the "Igor Sechin" check returned the same real
person across the UK, OFAC, EU, Swiss, Australian, Polish,
Ukrainian and Japanese lists, including Cyrillic
(Игорь Иванович СЕЧИН), Japanese (イーゴリ・セーチン) and
romanization variants (Igor Ivanovitj SETJIN, Igor Ivanovič
SEČIN, SIECZIN Igor Iwanowicz). That same setting also returns
records for different people who merely share partial name
similarity: the same query matched us_fbi_most_wanted's "IGOR
ANATOLYEVICH SUSHCHIN" — an FSB officer wanted for the 2014
Yahoo breach, born 1973 — an individual unrelated to Rosneft
CEO Igor Ivanovich Sechin (born 1960), matching on a shared
given name and a surname three edits away. This is not a Husk
defect but an inherent property of fuzzy matching at any
similarity threshold: name-based screening over- and
under-matches, and dilisense's response carries no match score
or matched-field, so Husk cannot programmatically distinguish a
strong identity match from a weak token-level one. Husk's policy
is therefore deliberately fail-closed — any SANCTION/CRIMINAL
hit, strong or weak, blocks the payment — which prevents
evasion but causes measurable false refusals.

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

## Design questions — resolved

- [x] Exact Compact syntax for private-state declarations and witness functions — resolved via research against official docs/repos; see custody model above.
- [x] How the real screening-provider call is expressed as a witness/oracle pattern in Compact — finalized: dilisense is integrated and live (see test/src/screening.ts), the payer-supplied claimed name flows as Opaque<"string"> into the screeningPassed witness.
- [x] Nullifier/commitment primitive Compact exposes natively vs. what needs custom circuit logic — resolved: use `persistentCommit`/`transientCommit` from `CompactStandardLibrary`, never hand-rolled `persistentHash`-based commitments for hiding purposes (hashes bind, they don't hide).
