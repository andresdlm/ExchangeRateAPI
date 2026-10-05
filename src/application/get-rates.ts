import {
  SourceUnavailable,
  type RateCache,
  type Rates,
  type RateSource,
  type Snapshot,
} from '../domain/rates';

export interface RatesResult {
  snapshot: Snapshot;
  stale: boolean;
}

export type RefreshPolicy = (checkedAt: string, now: number) => boolean;

const RETRY_DELAY_MILLISECONDS = 60_000;

export class GetRates {
  private pendingRequest?: Promise<RatesResult>;

  constructor(
    private readonly source: RateSource,
    private readonly cache: RateCache,
    private readonly needsRefresh: RefreshPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  execute(): Promise<RatesResult> {
    // Share one update between simultaneous requests in this Worker isolate.
    if (this.pendingRequest) {
      return this.pendingRequest;
    }

    this.pendingRequest = this.loadRates().finally(() => {
      this.pendingRequest = undefined;
    });

    return this.pendingRequest;
  }

  private async loadRates(): Promise<RatesResult> {
    const currentTime = this.now();
    const cachedSnapshot = await this.readCacheSafely();

    if (cachedSnapshot) {
      const stale = this.needsRefresh(cachedSnapshot.checkedAt, currentTime);
      const waitingToRetry = this.isWaitingToRetry(cachedSnapshot, currentTime);

      if (!stale || waitingToRetry) {
        return { snapshot: cachedSnapshot, stale };
      }
    }

    let rates: Rates;

    try {
      rates = await this.source.fetchRates();
    } catch {
      return this.useCachedRatesAfterFailure(cachedSnapshot, currentTime);
    }

    const snapshot = this.createSnapshot(rates, cachedSnapshot);
    await this.saveCacheSafely(snapshot);

    return { snapshot, stale: false };
  }

  private isWaitingToRetry(snapshot: Snapshot, currentTime: number): boolean {
    if (!snapshot.retryAfter) {
      return false;
    }

    const retryTime = Date.parse(snapshot.retryAfter);
    return retryTime > currentTime;
  }

  private async useCachedRatesAfterFailure(
    cachedSnapshot: Snapshot | null,
    currentTime: number,
  ): Promise<RatesResult> {
    if (!cachedSnapshot) {
      throw new SourceUnavailable();
    }

    const retryTime = currentTime + RETRY_DELAY_MILLISECONDS;
    const fallbackSnapshot: Snapshot = {
      ...cachedSnapshot,
      retryAfter: new Date(retryTime).toISOString(),
    };

    // A failed attempt must not change the last successful verification time.
    await this.saveCacheSafely(fallbackSnapshot);
    return { snapshot: fallbackSnapshot, stale: true };
  }

  private createSnapshot(rates: Rates, previousSnapshot: Snapshot | null): Snapshot {
    const checkedAt = new Date(this.now()).toISOString();
    let updatedAt = checkedAt;

    if (previousSnapshot && this.haveSameRates(rates, previousSnapshot.rates)) {
      updatedAt = previousSnapshot.updatedAt;
    }

    return { rates, checkedAt, updatedAt };
  }

  private haveSameRates(current: Rates, previous: Rates): boolean {
    return current.USD === previous.USD
      && current.EUR === previous.EUR
      && current.effectiveDate === previous.effectiveDate;
  }

  private async readCacheSafely(): Promise<Snapshot | null> {
    try {
      return await this.cache.get();
    } catch {
      // If the cache fails, the official source can still provide the rates.
      return null;
    }
  }

  private async saveCacheSafely(snapshot: Snapshot): Promise<void> {
    try {
      await this.cache.put(snapshot);
    } catch {
      // A cache write failure must not prevent returning valid source data.
    }
  }
}
