# Husk — Project Blueprint

**A private compliance layer for AI agent-to-agent payments, built on Midnight.**

---

## 1. The problem, in plain terms

AI agents are starting to pay each other directly — one agent paying another for an API call, a piece of data, computing time, or a task it completed. This is happening right now, on real payment rails (things like x402, Coinbase's Agentic Wallets, and similar systems), and the volume is growing fast.

Every one of those systems has the same weakness: to prove a payment is legitimate — not fraud, not money laundering, not going to a sanctioned party — they make the entire payment public. Anyone watching the blockchain can see who paid whom, how much, and when. That's a real cost. A business running agents doesn't want its entire spending pattern visible to competitors, and it *definitely* doesn't want its agents' strategies inferable from a public transaction history. But it also can't skip the compliance check — that's a legal requirement, not optional.

**Husk solves this specific problem:** it lets a payment prove it passed a compliance check, without revealing the payment itself.

---

## 2. The core idea, explained simply

Think of it like a sealed envelope with a stamp on the outside.

- Inside the envelope: who paid, who received, how much. **Nobody sees this except the two parties involved** (and, later, an auditor the owner specifically chooses to show it to).
- The stamp on the outside: proof that the envelope was checked and cleared — "this payment was screened, and it passed." **Anyone can see and verify the stamp.**

The stamp is genuine — it's checked against real, publicly available sanctions and watchlist data (not made up), so it means something. But the stamp gives away nothing about what's inside the envelope.

That's the whole idea. The rest of this document is about how it gets built.

### Why this needs Midnight specifically

Most blockchains are fully transparent by default — every transaction is visible to everyone, forever. To add a compliance check on those chains, you check the payment and then still publish the whole thing. Midnight is built differently: it lets you choose exactly what's public and what stays private, and prove things about the private part without revealing it. That's not a feature bolted on top — it's the reason this product is possible at all. On any other major chain, "private and compliant at the same time" isn't achievable the way it is here.

---

## 3. Who this is for

**The direct user is a developer, not an end consumer** — the same way almost nobody uses Stripe directly; they use a checkout page someone built with Stripe underneath. Concretely:

- Developers building AI agent platforms, wallets, or marketplaces who need their agents to transact compliantly without exposing every transaction publicly.
- Businesses whose AI agents pay for services autonomously, who need to prove compliance to regulators without publishing their agents' entire financial activity.

**Not the target for Wave 1:** a general consumer-facing app. Husk is infrastructure other products plug into — not something a non-technical person opens directly. That's intentional, not a limitation to apologize for.

---

## 4. Objectives

### Primary objective
Prove, with a real working system, that "privately screened" and "publicly verifiable" can both be true of the same payment — something no existing agent-payment system currently does.

### Supporting goals
1. **Build one real, complete flow** — not a broad feature set. One payment type, done honestly, beats several done superficially.
2. **Use real compliance data from day one** — no hardcoded pretend sanctions list. The screening check uses actual, current sanctions/watchlist data.
3. **Demonstrate real agent autonomy** — the payment in the demo is triggered by an actual AI agent (a live, MCP-connected Claude session) making its own decision to pay, not a person clicking a button pretending to be an agent.
4. **Leave behind something reusable** — a published client library that another developer can integrate against without reading the underlying contract source.
5. **Be honest about scope in the documentation** — clearly separate what's built and real from what's roadmap, so the project's credibility rests on what it actually does, not on implied claims.

---

## 5. Key concepts, defined plainly

| Term | Plain-language definition |
|---|---|
| **Midnight** | A blockchain designed so you can choose exactly what information is public and what stays private, while still letting anyone verify that the private part follows the rules — without seeing it. |
| **Compact** | The programming language used to write Midnight's smart contracts (the code that runs the rules on-chain). |
| **Private state** | Information the contract keeps track of, but that isn't visible on the public blockchain. In Compact this is realized as witness-held data plus published commitments — not a "private ledger" (no such primitive exists). |
| **Public state** | Information anyone can see on the blockchain — in Husk's case, a marker that says "a payment was screened and cleared," plus contract coin-custody bookkeeping, with no per-agent or per-transaction detail attached. |
| **Screening / compliance check** | Checking a payment's parties against real sanctions and watchlist data to confirm the transaction isn't going to or from a blocked party. |
| **Selective disclosure** | The ability to reveal specific private information to a specific chosen party (like an auditor) later, without making it public to everyone. |
| **Agent** | An AI system (like Claude) acting on its own within defined boundaries — in this case, deciding when a payment is owed and initiating it. |
| **MCP (Model Context Protocol)** | The standard way an AI agent connects to external tools and takes real actions — in Husk's case, the tools that let an agent check its balance and make a payment. |
| **Client library** | A small, ready-to-use code package that lets another developer's software talk to Husk's contract without needing to understand its internal code. |

---

## 6. Development roadmap checklist

### Phase 0 — Environment & Foundations
- [x] Install Midnight toolchain (WSL2 + Docker Desktop + Compact compiler, pinned to 0.31.1 per official compatibility matrix)
- [x] Complete the official "Hello World" Compact tutorial to confirm the local environment actually compiles and deploys
- [x] Set up Kapa MCP server (replaces the retired "Midnight MCP" server) so documentation lookups are grounded in real, current docs
- [ ] Confirm access to a real screening data source (dilisense — signup pending on work-email requirement)

### Phase 1 — Contract Core
- [ ] Define private state: agent balances (committed, via `persistentCommit`), per-transaction amount and counterparty
- [ ] Define public state: pass/fail commitment per screened transaction, plus contract coin-custody records
- [ ] Implement the `pay()` flow: balance check → screening call → private settlement on pass → silent revert on fail
- [ ] Confirm the contract compiles successfully (this is the hackathon's non-negotiable technical gate)
- [ ] Write and pass test cases for both the pass and fail paths (this is graded separately, under Quality Assurance)

### Phase 2 — Screening Integration
- [ ] Wire the contract's screening call to the chosen real data provider
- [ ] Confirm the interface is provider-agnostic (so the data source could be swapped later without touching contract logic)
- [ ] Test against known real sanctioned entities/addresses to confirm the check actually catches what it should

### Phase 3 — Demo Agent
- [ ] Build the MCP tool surface: `get_balance()`, `check_policy()`, `pay()`
- [ ] Choose the real triggering event (a genuine external API call that creates a real "you owe X" moment)
- [ ] Write a narrowly scoped system prompt so the agent's decision to pay is reliable, not just theoretically possible
- [ ] Dry-run the full agent flow repeatedly before connecting it to the live contract
- [ ] Connect the agent flow to the real deployed contract and confirm an end-to-end successful run

### Phase 4 — Reusability Layer
- [ ] Build a small, clean client library wrapping the contract's calls (e.g. `screenAndPay()`, `getScreeningStatus()`) — repo name locked as `husk-client`, creation deferred until this phase
- [ ] Publish it as its own documented package, separate from the demo repo
- [ ] Write clear docs on the public interface: what a caller provides, what they get back, what stays private

### Phase 5 — Submission Package
- [ ] Write the README: problem, why Midnight, architecture, what's real vs. roadmap, setup instructions
- [ ] Tag the repository `midnightntwrk`
- [ ] Confirm Apache 2.0 licensing compliance
- [ ] Record a clean, successful demo run as backup video
- [ ] Prepare the live demo script (and rehearse it against the reliability plan from Phase 3)
- [ ] Build the pitch slide deck: problem, wedge (why not x402/AgentKit/Skyfire), architecture, demo, roadmap, target user
- [ ] Final check against the judging rubric: Engineering (40%), QA (15%), Product & Vision (15%), UX (15%), Communication (10%), Business Viability (5%)

### Phase 6 (Wave 2+, explicitly not this wave)
- [ ] Owner-triggered selective-disclosure proof for a chosen auditor (aggregate compliance summary without individual transaction detail)
- [ ] Multi-asset support
- [ ] Broader agent-framework integrations beyond the single demo flow

---

## 7. What's intentionally out of scope for Wave 1

Naming this clearly, so nobody mistakes a scope decision for an oversight:
- Trading or swap functionality
- Multi-asset support
- A general agent-management dashboard
- Consumer-facing UI (any interface built is a demo aid, not the product)
- Deep transaction-pattern risk modeling beyond address/name screening against real sanctions data
