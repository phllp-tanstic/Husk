// Husk — REAL compliance-screening oracle (dilisense AML Screening API).
//
// Implements the off-chain side of the `screeningPassed` witness declared in
// contracts/husk.compact:
//
//   witness screeningPassed(recipient: ZswapCoinPublicKey,
//                           recipientName: Opaque<"string">,
//                           amount: Uint<128>): Boolean;
//
// Provider: dilisense — GET https://api.dilisense.com/v1/checkIndividual
//           header `x-api-key: <key>`, params `names=<claimed name>` and
//           `fuzzy_search=1` (spelling distance 1), per
//           https://developers.dilisense.com/.
//
// POLICY (decided, implemented EXACTLY):
//   * Any SANCTION or CRIMINAL hit in found_records  -> screening FAILS.
//   * PEP-only hits (no SANCTION/CRIMINAL)           -> screening PASSES,
//                                                       with a structured
//                                                       log line flagging
//                                                       the PEP hit(s).
//   * No hits at all                                 -> screening PASSES.
//   * Any HTTP error (4xx/5xx), timeout, or network failure -> screening
//     FAILS (fail-closed). Screening is never skipped and never fails open:
//     on any error this module logs the failure clearly and reports
//     passed=false; it never throws past its API boundary.
//
// API key: read from the DILISENSE_API_KEY environment variable. It is NEVER
// hardcoded and NEVER committed (see .env.example and .gitignore). The key
// value is never logged.
//
// NOTE ON WITNESS SYNCHRONICITY: Compact witnesses are synchronous. The
// driver therefore performs the (async) screening FIRST — via
// screenRecipientName() — and then wires the resulting verdict into the
// witness via makeScreeningWitness(). The claimed name itself still flows
// into the circuit as the Opaque<"string"> argument and from there into the
// witness call, exactly as the contract requires; the pre-fetched verdict is
// the driver-side result of screening that same name.
import type { Logger } from 'pino';

export const DILISENSE_CHECK_INDIVIDUAL_URL =
  'https://api.dilisense.com/v1/checkIndividual';

const DEFAULT_TIMEOUT_MS = 20_000;

/** source_type values documented by dilisense. */
export type DilisenseSourceType = 'SANCTION' | 'PEP' | 'CRIMINAL' | 'OTHER';

/** One entry of dilisense's found_records (fields we rely on are optional-typed; the full record is preserved). */
export type DilisenseRecord = {
  source_type?: string;
  source_id?: string;
  id?: string;
  name?: string;
  [extra: string]: unknown;
};

/** The checkIndividual response shape (undocumented extra fields preserved). */
export type DilisenseResponse = {
  timestamp?: string;
  total_hits?: number;
  found_records?: DilisenseRecord[];
  error_message?: string;
  [extra: string]: unknown;
};

export type ScreeningVerdict = {
  /** Final policy decision. false = pay() must be rejected. */
  passed: boolean;
  /** true when the pass was NOT clean: PEP-only hits were present and flagged. */
  pepFlagged: boolean;
  /** SANCTION/CRIMINAL records that caused the failure (empty on clean pass). */
  blockingHits: DilisenseRecord[];
  /** PEP records present on a pass (empty unless pepFlagged). */
  pepHits: DilisenseRecord[];
  /** OTHER-type records (neither blocking nor PEP) — logged, policy-neutral. */
  otherHits: DilisenseRecord[];
  /** Set when fail-closed due to transport/HTTP/provider error. */
  error?: string;
  httpStatus?: number;
  /** The FULL parsed API response (null only when the API was never reached). */
  raw: DilisenseResponse | null;
};

/**
 * Resolves the dilisense API key.
 *
 * Source of truth is the process environment (DILISENSE_API_KEY). If (and
 * only if) it is unset, a local untracked .env file is consulted via Node's
 * built-in process.loadEnvFile — repo root first, then test/ — so developers
 * can keep the key out of shell rc files. Missing files are silently ignored;
 * an existing value in the real environment always wins and the key is never
 * returned in any log output.
 */
export function resolveDilisenseApiKey(): string | undefined {
  const direct = process.env['DILISENSE_API_KEY'];
  if (direct && direct.trim().length > 0) return direct.trim();
  for (const candidate of [
    new URL('../../.env', import.meta.url), // repo root
    new URL('../.env', import.meta.url), // test project root
  ]) {
    try {
      process.loadEnvFile(candidate);
    } catch {
      // No .env file at this location — perfectly fine, keep looking.
    }
    const loaded = process.env['DILISENSE_API_KEY'];
    if (loaded && loaded.trim().length > 0) return loaded.trim();
  }
  return undefined;
}

function classify(records: DilisenseRecord[]): {
  blocking: DilisenseRecord[];
  pep: DilisenseRecord[];
  other: DilisenseRecord[];
} {
  const blocking: DilisenseRecord[] = [];
  const pep: DilisenseRecord[] = [];
  const other: DilisenseRecord[] = [];
  for (const record of records) {
    switch (record.source_type) {
      case 'SANCTION':
      case 'CRIMINAL':
        blocking.push(record);
        break;
      case 'PEP':
        pep.push(record);
        break;
      default:
        other.push(record);
        break;
    }
  }
  return { blocking, pep, other };
}

/**
 * Performs ONE real dilisense checkIndividual call for the claimed name and
 * applies the policy above. Never retries (the free tier is 100 calls/month —
 * quota is money). Never throws: every failure mode resolves to a verdict
 * with passed=false (fail-closed) and a clear `error` description.
 */
export async function screenRecipientName(
  recipientName: string,
  logger: Logger,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ScreeningVerdict> {
  const failClosed = (error: string, extra?: Partial<ScreeningVerdict>): ScreeningVerdict => {
    const verdict: ScreeningVerdict = {
      passed: false,
      pepFlagged: false,
      blockingHits: [],
      pepHits: [],
      otherHits: [],
      error,
      raw: null,
      ...extra,
    };
    // Structured, unmistakable failure line — screening NEVER silently skips.
    logger.error(
      {
        event: 'SCREENING_FAILED',
        provider: 'dilisense',
        endpoint: DILISENSE_CHECK_INDIVIDUAL_URL,
        claimed_name: recipientName,
        decision: 'FAIL_CLOSED',
        error,
        http_status: verdict.httpStatus,
      },
      `screening FAILED (fail-closed) for claimed name "${recipientName}": ${error}`,
    );
    return verdict;
  };

  const apiKey = resolveDilisenseApiKey();
  if (!apiKey) {
    return failClosed(
      'DILISENSE_API_KEY is not set (copy .env.example to .env and fill it in) — refusing to screen, refusing to pay',
    );
  }

  const url = new URL(DILISENSE_CHECK_INDIVIDUAL_URL);
  url.searchParams.set('names', recipientName);
  url.searchParams.set('fuzzy_search', '1');

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: unknown) {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return failClosed(`network/transport failure calling dilisense (${reason})`);
  }

  if (!response.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 500);
    } catch {
      bodySnippet = '<unreadable body>';
    }
    return failClosed(
      `dilisense returned HTTP ${response.status} ${response.statusText}${bodySnippet ? `: ${bodySnippet}` : ''}`,
      { httpStatus: response.status },
    );
  }

  let raw: DilisenseResponse;
  try {
    raw = (await response.json()) as DilisenseResponse;
  } catch (e: unknown) {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return failClosed(`dilisense returned 200 but the body is not valid JSON (${reason})`, {
      httpStatus: response.status,
    });
  }

  const records = Array.isArray(raw.found_records) ? raw.found_records : [];
  const { blocking, pep, other } = classify(records);

  if (blocking.length > 0) {
    const verdict: ScreeningVerdict = {
      passed: false,
      pepFlagged: pep.length > 0,
      blockingHits: blocking,
      pepHits: pep,
      otherHits: other,
      raw,
      httpStatus: response.status,
    };
    logger.error(
      {
        event: 'SCREENING_BLOCKED',
        provider: 'dilisense',
        claimed_name: recipientName,
        decision: 'FAIL',
        total_hits: raw.total_hits ?? records.length,
        blocking: blocking.map((r) => ({ source_type: r.source_type, source_id: r.source_id, name: r.name })),
      },
      `screening FAILED: claimed name "${recipientName}" has ${blocking.length} SANCTION/CRIMINAL hit(s)`,
    );
    return verdict;
  }

  if (pep.length > 0) {
    // PEP-only: PASSES, but the flag is logged — structured line, not silent.
    const flagPayload = {
      event: 'SCREENING_PEP_FLAG',
      provider: 'dilisense',
      claimed_name: recipientName,
      decision: 'PASS_WITH_FLAG',
      total_hits: raw.total_hits ?? records.length,
      pep_hits: pep.map((r) => ({ source_type: r.source_type, source_id: r.source_id, name: r.name })),
    };
    logger.warn(flagPayload, `screening PASSED with PEP flag: claimed name "${recipientName}" has ${pep.length} PEP-only hit(s) (no SANCTION/CRIMINAL)`);
    return {
      passed: true,
      pepFlagged: true,
      blockingHits: [],
      pepHits: pep,
      otherHits: other,
      raw,
      httpStatus: response.status,
    };
  }

  logger.info(
    {
      event: 'SCREENING_CLEAN_PASS',
      provider: 'dilisense',
      claimed_name: recipientName,
      decision: 'PASS',
      total_hits: raw.total_hits ?? 0,
      other_hits: other.map((r) => ({ source_type: r.source_type, source_id: r.source_id, name: r.name })),
    },
    `screening PASSED clean: claimed name "${recipientName}" has no SANCTION/CRIMINAL/PEP hits`,
  );
  return {
    passed: true,
    pepFlagged: false,
    blockingHits: [],
    pepHits: [],
    otherHits: other,
    raw,
    httpStatus: response.status,
  };
}

/**
 * Builds the `screeningPassed` witness implementation around pre-computed
 * verdicts. Compact witnesses are synchronous, so the driver calls
 * screenRecipientName() first and hands the verdicts to this factory.
 *
 * Fail-closed by construction: a name with no pre-computed verdict (e.g. a
 * payment attempt for an identity that was never screened) makes the witness
 * return false and log — a payment can never bypass screening by omitting
 * the oracle call.
 */
export function makeScreeningWitness(
  verdictsByClaimedName: Map<string, ScreeningVerdict>,
  logger: Logger,
): (
  context: unknown,
  recipient: unknown,
  recipientName: string,
  amount: unknown,
) => [Record<string, never>, boolean] {
  return (_context, _recipient, recipientName, _amount) => {
    const verdict = verdictsByClaimedName.get(recipientName);
    if (!verdict) {
      logger.error(
        {
          event: 'SCREENING_WITNESS_UNSCREENED_NAME',
          claimed_name: recipientName,
          decision: 'FAIL_CLOSED',
        },
        `screening witness invoked for claimed name "${recipientName}" with NO pre-computed verdict — failing closed`,
      );
      return [{}, false];
    }
    return [{}, verdict.passed];
  };
}
