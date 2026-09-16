import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import path from 'node:path';

export {
  Contract,
  ledger,
  pureCircuits,
  type Ledger,
  type ImpureCircuits,
  type PureCircuits,
  type Witnesses,
} from './managed/husk/contract/index.js';
import { Contract, type Witnesses } from './managed/husk/contract/index.js';

const currentDir = path.resolve(new URL(import.meta.url).pathname, '..');
export const zkAssetsPath = path.resolve(currentDir, 'managed', 'husk');

/**
 * Build a compiled-contract binding for the Husk `pay()` circuit with the
 * given witness implementations.
 *
 * `screeningPassed` is the REAL off-chain sanctions/PEP oracle bridge (see
 * docs/architecture.md and test/src/screening.ts): the driver queries
 * dilisense (GET /v1/checkIndividual, x-api-key auth) with the recipient's
 * claimed name — supplied by the payer as the `recipientName: Opaque<"string">`
 * circuit argument — and returns whether the payment may proceed. The circuit
 * itself cannot read the name (it is an Opaque value, forwarded into the
 * witness call only); the FAIL/EDGE/PASS tests in pay.test.ts still wire a
 * deterministic JS stub here so contract logic can be exercised without
 * consuming real API quota.
 *
 * `screeningNonce` supplies fresh, uniform per-payment salt: it is what keeps
 * the `screened` ledger commitment unlinkable and its preimage unguessable.
 * A real driver must draw it from a CSPRNG and never reuse it.
 */
export function makeCompiledHusk(witnesses: Witnesses<unknown>) {
  return CompiledContract.make('HuskContract', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(zkAssetsPath),
  );
}