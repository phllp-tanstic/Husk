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
 * `screeningPassed` is a TEST-ONLY stand-in for the real off-chain
 * sanctions/PEP oracle (see docs/architecture.md): the driver queries the
 * provider with the recipient's identity and the payment amount and returns
 * whether the payment may proceed. In these tests the witness is wired to a
 * JS-controlled boolean so the PASS and FAIL paths can both be exercised
 * against the real devnet.
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