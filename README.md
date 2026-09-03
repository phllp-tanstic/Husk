# Husk

**A private compliance layer for AI agent-to-agent payments.**

Agents pay each other constantly now — for API calls, data, compute, other agents' work. Every agent-payment rail live today (x402, Coinbase Agentic Wallets, Mastercard Agent Pay) checks that payment against a compliance policy at the application layer, on a fully transparent chain. The check happens — but so does full public exposure of who paid whom, how much, and when.

Husk proves a payment cleared screening without revealing the payment itself — the public commitment is the husk, the transaction inside stays private.

## Why Midnight

Every existing agent-payment compliance layer runs on a transparent ledger (Base, mostly). They can enforce a policy; they can't hide the transaction while doing it. Midnight's selective disclosure makes "compliant" and "private" true at the same time — that's not a feature we bolted on, it's the reason this is buildable at all.

## What's real in this submission

The Compact contract, the private balance/nullifier design, the selective-disclosure proof, and the screening check itself — this queries real sanctions/PEP data, not a hardcoded stand-in. See `docs/architecture.md` for the provider interface.

## Architecture

See `docs/architecture.md` for the full private/public state split and the contract flow.

## Setup

_(fill in once the toolchain is installed locally — see docs.midnight.network/getting-started)_

## Demo

_(link once recorded — script in docs/demo-script.md)_

## Repo

Tagged `midnightntwrk` per submission requirements. Licensed Apache 2.0.
