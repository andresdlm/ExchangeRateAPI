import type { RateCache, Snapshot } from '../domain/rates';

const MILLISECONDS_PER_SECOND = 1000;

export class CloudflareRateCache implements RateCache {
  constructor(
    private readonly cache: Cache,
    private readonly cacheKey: string,
    private readonly retentionSeconds: number,
  ) {}

  async get(): Promise<Snapshot | null> {
    const response = await this.cache.match(this.cacheKey);

    if (!response) {
      return null;
    }

    const snapshot = await response.json<Snapshot>();
    const lastVerificationTime = Date.parse(snapshot.checkedAt);
    const lastUpdateTime = Date.parse(snapshot.updatedAt);

    // Ignore entries with missing rates or invalid timestamps.
    if (!snapshot.rates) {
      return null;
    }

    if (!Number.isFinite(lastVerificationTime) || !Number.isFinite(lastUpdateTime)) {
      return null;
    }

    const ageMilliseconds = Date.now() - lastVerificationTime;
    const retentionMilliseconds = this.retentionSeconds * MILLISECONDS_PER_SECOND;

    // Failed retries must not keep an old snapshot alive indefinitely.
    if (ageMilliseconds >= retentionMilliseconds) {
      return null;
    }

    return snapshot;
  }

  async put(snapshot: Snapshot): Promise<void> {
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${this.retentionSeconds}`,
    };
    const response = new Response(JSON.stringify(snapshot), { headers });

    await this.cache.put(this.cacheKey, response);
  }
}
