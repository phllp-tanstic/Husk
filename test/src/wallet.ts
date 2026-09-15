import type {
  QualifiedShieldedCoinInfo,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  type CoinPublicKey,
  DustSecretKey,
  type EncPublicKey,
  type FinalizedTransaction,
  LedgerParameters,
  ZswapSecretKeys,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type {
  MidnightProvider,
  UnboundTransaction,
  WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js-utils';
import type { WalletFacade, FacadeState, UnshieldedKeystore } from '@midnight-ntwrk/wallet-sdk';
import type { ShieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import {
  type DustWalletOptions,
  type EnvironmentConfiguration,
  FluentWalletBuilder,
} from '@midnight-ntwrk/testkit-js';
import * as Rx from 'rxjs';
import type { Logger } from 'pino';

export type WalletSecret =
  | { kind: 'seed'; value: string }
  | { kind: 'mnemonic'; value: string };

export class MidnightWalletProvider implements MidnightProvider, WalletProvider {
  readonly wallet: WalletFacade;
  readonly unshieldedKeystore: UnshieldedKeystore;

  private constructor(
    private readonly logger: Logger,
    wallet: WalletFacade,
    private readonly zswapSecretKeys: ZswapSecretKeys,
    private readonly dustSecretKey: DustSecretKey,
    unshieldedKeystore: UnshieldedKeystore,
  ) {
    this.wallet = wallet;
    this.unshieldedKeystore = unshieldedKeystore;
  }

  getCoinPublicKey(): CoinPublicKey {
    return this.zswapSecretKeys.coinPublicKey;
  }

  getEncryptionPublicKey(): EncPublicKey {
    return this.zswapSecretKeys.encryptionPublicKey;
  }

  async getShieldedAddress(): Promise<ShieldedAddress> {
    return this.wallet.shielded.getAddress();
  }

  /**
   * Sends `amount` of the given shielded token to `receiverAddress`.
   *
   * This spends shielded coins the wallet already holds (the balancer picks
   * available shielded inputs of the same token type); fees are paid from the
   * dust wallet. Used to prove that a coin delivered by `pay()` is genuinely
   * spendable, and to move value back between the two test wallets.
   */
  async transferShielded(
    receiverAddress: ShieldedAddress,
    tokenType: string,
    amount: bigint,
  ): Promise<string> {
    const recipe = await this.wallet.transferTransaction(
      [
        {
          type: 'shielded',
          outputs: [{ type: tokenType, receiverAddress, amount }],
        },
      ],
      {
        shieldedSecretKeys: this.zswapSecretKeys,
        dustSecretKey: this.dustSecretKey,
      },
      { ttl: ttlOneHour() },
    );
    const finalized = await this.wallet.finalizeRecipe(recipe);
    return await this.wallet.submitTransaction(finalized);
  }

  /**
   * Polls wallet state until a spendable shielded coin of the given token
   * type and exact value appears in the shielded wallet's available coins.
   * Resolves with the runtime `QualifiedShieldedCoinInfo` of that coin (with
   * hex-string `type`/`nonce`), or undefined if not found within `timeoutMs`.
   *
   * Convert to Compact's `{ color, nonce: Uint8Array, ... }` circuit argument
   * with `ledger.encodeQualifiedShieldedCoinInfo(coin)` when calling the
   * circuit.
   */
  async findShieldedCoin(
    tokenType: string,
    value: bigint,
    timeoutMs = 120_000,
  ): Promise<QualifiedShieldedCoinInfo | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const synced = await Rx.firstValueFrom(
        this.wallet.state().pipe(Rx.filter((s: FacadeState) => s.isSynced)),
      );
      const match = synced.shielded.availableCoins.find(
        (c) => c.coin.type === tokenType && c.coin.value === value,
      );
      if (match) {
        this.logger.info(
          `Found shielded coin type=${tokenType} value=${value} mt_index=${match.coin.mt_index}`,
        );
        return match.coin;
      }
      if (Date.now() > deadline) {
        this.logger.warn(
          `No shielded coin (type=${tokenType} value=${value}) found within ${timeoutMs}ms; ` +
            `currently available: ${JSON.stringify(
              synced.shielded.availableCoins.map((c) => ({
                type: c.coin.type,
                value: c.coin.value.toString(),
                mt: c.coin.mt_index.toString(),
              })),
            )}`,
        );
        return undefined;
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  async balanceTx(
    tx: UnboundTransaction,
    ttl: Date = ttlOneHour(),
  ): Promise<FinalizedTransaction> {
    const recipe = await this.wallet.balanceUnboundTransaction(
      tx,
      {
        shieldedSecretKeys: this.zswapSecretKeys,
        dustSecretKey: this.dustSecretKey,
      },
      { ttl },
    );
    return await this.wallet.finalizeRecipe(recipe);
  }

  submitTx(tx: FinalizedTransaction): Promise<string> {
    return this.wallet.submitTransaction(tx);
  }

  async start(): Promise<void> {
    this.logger.info('Starting wallet...');
    await this.wallet.start(this.zswapSecretKeys, this.dustSecretKey);
  }

  async stop(): Promise<void> {
    return this.wallet.stop();
  }

  static async build(
    logger: Logger,
    env: EnvironmentConfiguration,
    secret: WalletSecret,
  ): Promise<MidnightWalletProvider> {
    const dustOptions: DustWalletOptions = {
      ledgerParams: LedgerParameters.initialParameters(),
      additionalFeeOverhead: 1_000n,
      feeBlocksMargin: 5,
    };

    const base = FluentWalletBuilder.forEnvironment(env)
      .withDustOptions(dustOptions);
    const builder =
      secret.kind === 'mnemonic'
        ? base.withMnemonic(secret.value)
        : base.withSeed(secret.value);

    const buildResult = await builder.buildWithoutStarting();
    const { wallet, seeds, keystore } = buildResult as {
      wallet: WalletFacade;
      seeds: {
        masterSeed: string;
        shielded: Uint8Array;
        dust: Uint8Array;
      };
      keystore: UnshieldedKeystore;
    };

    logger.info(
      `Wallet built from ${secret.kind}; master seed: ${seeds.masterSeed.slice(0, 8)}...`,
    );

    return new MidnightWalletProvider(
      logger,
      wallet,
      ZswapSecretKeys.fromSeed(seeds.shielded),
      DustSecretKey.fromSeed(seeds.dust),
      keystore,
    );
  }
}

function isProgressStrictlyComplete(progress: unknown): boolean {
  if (!progress || typeof progress !== 'object') {
    return false;
  }
  const candidate = progress as { isStrictlyComplete?: unknown };
  if (typeof candidate.isStrictlyComplete !== 'function') {
    return false;
  }
  return (candidate.isStrictlyComplete as () => boolean)();
}

// Renders sync status as "<complete> (n/m)" where n is the applied index and
// m is the target the wallet must reach for isStrictlyComplete() to be true.
// Shielded/dust progress uses appliedIndex/highestRelevantWalletIndex; the
// unshielded wallet uses appliedId/highestTransactionId.
function formatProgress(progress: unknown): string {
  const complete = isProgressStrictlyComplete(progress);
  if (!progress || typeof progress !== 'object') {
    return `${complete}`;
  }
  const p = progress as {
    appliedIndex?: bigint;
    highestRelevantWalletIndex?: bigint;
    appliedId?: bigint;
    highestTransactionId?: bigint;
  };
  const applied = p.appliedIndex ?? p.appliedId;
  const target = p.highestRelevantWalletIndex ?? p.highestTransactionId;
  if (applied === undefined || target === undefined) {
    return `${complete}`;
  }
  return `${complete} (${applied}/${target})`;
}

export async function syncWallet(
  logger: Logger,
  wallet: WalletFacade,
  timeout = 300_000,
): Promise<FacadeState> {
  logger.info('Syncing wallet...');
  let emissionCount = 0;
  return Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.tap((state: FacadeState) => {
        emissionCount++;
        const shielded = isProgressStrictlyComplete(state.shielded.state.progress);
        const unshielded = isProgressStrictlyComplete(state.unshielded.progress);
        const dust = isProgressStrictlyComplete(state.dust.state.progress);
        logger.info(
          `Wallet sync [${emissionCount}]: shielded=${formatProgress(state.shielded.state.progress)}, ` +
            `unshielded=${formatProgress(state.unshielded.progress)}, dust=${formatProgress(state.dust.state.progress)}`,
        );
        if (!shielded) {
          logger.debug(`  shielded.progress: ${JSON.stringify(state.shielded.state.progress)}`);
        }
        if (!unshielded) {
          logger.debug(`  unshielded.progress: ${JSON.stringify(state.unshielded.progress)}`);
        }
        if (!dust) {
          logger.debug(`  dust.progress: ${JSON.stringify(state.dust.state.progress)}`);
        }
      }),
      Rx.filter(
        (state: FacadeState) =>
          isProgressStrictlyComplete(state.shielded.state.progress) &&
          isProgressStrictlyComplete(state.dust.state.progress) &&
          isProgressStrictlyComplete(state.unshielded.progress),
      ),
      Rx.tap(() => logger.info(`Wallet sync complete after ${emissionCount} emissions`)),
      Rx.timeout({
        each: timeout,
        with: () =>
          Rx.throwError(
            () => new Error(`Wallet sync timeout after ${timeout}ms (${emissionCount} emissions received)`),
          ),
      }),
      Rx.catchError((err) => {
        logger.error(`Wallet sync error: ${err}`);
        return Rx.throwError(() => err);
      }),
    ),
  );
}