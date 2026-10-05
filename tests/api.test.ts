import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GetRates } from '../src/application/get-rates';
import { dailyRefresh } from '../src/application/refresh-schedule';
import type { Snapshot, Rates } from '../src/domain/rates';
import { rateToNumber } from '../src/http/rate-number';
import { parseBcvHtml } from '../src/infrastructure/bcv-source';
import { CloudflareRateCache } from '../src/infrastructure/cloudflare-cache';
import worker from '../src/index';

const officialHtml = readFileSync('tests/fixtures/bcv.html', 'utf8');
const publishedRates = parseBcvHtml(officialHtml);
const TEST_API_KEY = 'a'.repeat(32);

// In-memory source, cache and clock let each scenario control its dependencies.
function createRatesScenario() {
  let currentTime = Date.parse('2026-10-04T12:00:00Z');
  let cachedSnapshot: Snapshot | null = null;
  let sourceCalls = 0;
  let sourceUnavailable = false;
  let currentRates: Rates = publishedRates;

  const source = {
    async fetchRates(): Promise<Rates> {
      sourceCalls++;

      if (sourceUnavailable) {
        throw new Error('Source unavailable');
      }

      return currentRates;
    },
  };

  const cache = {
    async get(): Promise<Snapshot | null> {
      return cachedSnapshot;
    },
    async put(snapshot: Snapshot): Promise<void> {
      cachedSnapshot = snapshot;
    },
  };

  // The tests use a short interval to exercise revalidation independently of scheduling.
  const needsRefresh = (checkedAt: string, now: number): boolean => {
    const elapsedMilliseconds = now - Date.parse(checkedAt);
    return elapsedMilliseconds >= 900_000;
  };

  const clock = () => currentTime;
  const service = new GetRates(source, cache, needsRefresh, clock);

  return {
    service,
    advanceTime(seconds: number) {
      currentTime += seconds * 1000;
    },
    getSourceCalls() {
      return sourceCalls;
    },
    makeSourceUnavailable() {
      sourceUnavailable = true;
    },
    changePublishedRates() {
      currentRates = { ...publishedRates, USD: '900.00000000' };
    },
  };
}

function createRequest(path: string, apiKey?: string, method = 'GET'): Request {
  const headers: Record<string, string> = {};

  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  return new Request(`https://example.com${path}`, { method, headers });
}

test('extracts exact decimals and exchange-rate date from official HTML', () => {
  assert.deepEqual(publishedRates, {
    USD: '871.36890000',
    EUR: '981.17880877',
    effectiveDate: '2026-10-05',
  });
});

test('rejects missing rates, invalid decimals, dates and error pages', () => {
  const invalidPages = [
    officialHtml.replace('id="dolar"', 'id="other"'),
    officialHtml.replace('871,36890000', '-1,00'),
    officialHtml.replace('2026-10-05T', '2026-02-30T'),
    '<html>Unavailable</html>',
  ];

  for (const page of invalidPages) {
    assert.throws(() => parseBcvHtml(page));
  }
});

test('coalesces requests, caches and revalidates without changing updatedAt unnecessarily', async () => {
  const scenario = createRatesScenario();
  const simultaneousRequests = [scenario.service.execute(), scenario.service.execute()];
  const [firstResult] = await Promise.all(simultaneousRequests);
  assert.equal(scenario.getSourceCalls(), 1);

  scenario.advanceTime(899);
  await scenario.service.execute();
  assert.equal(scenario.getSourceCalls(), 1);

  scenario.advanceTime(1);
  const revalidatedResult = await scenario.service.execute();
  assert.equal(scenario.getSourceCalls(), 2);
  assert.equal(revalidatedResult.snapshot.updatedAt, firstResult.snapshot.updatedAt);
  assert.notEqual(revalidatedResult.snapshot.checkedAt, firstResult.snapshot.checkedAt);

  scenario.changePublishedRates();
  scenario.advanceTime(900);
  const changedResult = await scenario.service.execute();
  assert.equal(changedResult.snapshot.rates.USD, '900.00000000');
  assert.notEqual(changedResult.snapshot.updatedAt, firstResult.snapshot.updatedAt);
});

test('serves stale data on failure and backs off without changing checkedAt', async () => {
  const scenario = createRatesScenario();
  const firstResult = await scenario.service.execute();

  scenario.advanceTime(900);
  scenario.makeSourceUnavailable();
  const fallbackResult = await scenario.service.execute();
  assert.equal(fallbackResult.stale, true);
  assert.equal(fallbackResult.snapshot.checkedAt, firstResult.snapshot.checkedAt);

  await scenario.service.execute();
  assert.equal(scenario.getSourceCalls(), 2);

  scenario.advanceTime(60);
  await scenario.service.execute();
  assert.equal(scenario.getSourceCalls(), 3);
});

test('fails when upstream is unavailable without a cached value', async () => {
  const scenario = createRatesScenario();
  scenario.makeSourceUnavailable();
  await assert.rejects(scenario.service.execute());
});

test('authenticates before routes, denies missing configuration and disallows other methods', async () => {
  const environment = { API_KEY: TEST_API_KEY };

  const missingKey = await worker.fetch(createRequest('/api/v1/rates'), environment);
  assert.equal(missingKey.status, 401);

  const wrongKey = await worker.fetch(createRequest('/api/v1/rates', 'wrong'), environment);
  assert.equal(wrongKey.status, 401);

  const invalidConfiguration = await worker.fetch(createRequest('/api/v1/rates'), { API_KEY: '' });
  assert.equal(invalidConfiguration.status, 503);

  const unknownRoute = await worker.fetch(createRequest('/missing', TEST_API_KEY), environment);
  assert.equal(unknownRoute.status, 404);

  const wrongMethod = await worker.fetch(createRequest('/api/v1/rates', TEST_API_KEY, 'POST'), environment);
  assert.equal(wrongMethod.status, 405);
});

test('daily schedule refreshes only at weekday publication boundaries in Venezuela', () => {
  const needsRefresh = dailyRefresh(18);
  const fridayVerification = '2026-10-02T22:01:00Z';
  const mondayVerification = '2026-10-05T22:00:00Z';

  assert.equal(needsRefresh(fridayVerification, Date.parse('2026-10-03T23:00:00Z')), false);
  assert.equal(needsRefresh(fridayVerification, Date.parse('2026-10-04T23:00:00Z')), false);
  assert.equal(needsRefresh(fridayVerification, Date.parse('2026-10-05T21:59:59Z')), false);
  assert.equal(needsRefresh(fridayVerification, Date.parse('2026-10-05T22:00:00Z')), true);
  assert.equal(needsRefresh(mondayVerification, Date.parse('2026-10-06T21:59:59Z')), false);
  assert.equal(needsRefresh(mondayVerification, Date.parse('2026-10-06T22:00:00Z')), true);
  assert.equal(needsRefresh('2026-10-05T12:00:00Z', Date.parse('2026-10-05T22:00:00Z')), true);
});

test('authenticated endpoint extracts BCV and reuses the internal cache', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const cacheEntries = new Map<string, Response>();
  let upstreamCalls = 0;

  globalThis.fetch = async () => {
    upstreamCalls++;
    return new Response(officialHtml);
  };

  const fakeCache = {
    async match(key: string) {
      return cacheEntries.get(key)?.clone();
    },
    async put(key: string, response: Response) {
      cacheEntries.set(key, response.clone());
    },
  };

  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: fakeCache },
  });

  try {
    const environment = { API_KEY: TEST_API_KEY };
    const firstResponse = await worker.fetch(createRequest('/api/v1/rates', TEST_API_KEY), environment);
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get('Cache-Control'), 'no-store');

    const body = await firstResponse.json() as {
      rates: { USD: number; EUR: number };
      effectiveDate: string;
      stale: boolean;
    };

    assert.equal(typeof body.rates.USD, 'number');
    assert.equal(typeof body.rates.EUR, 'number');
    assert.equal(body.rates.USD, 871.3689);
    assert.equal(body.rates.EUR, 981.17880877);
    assert.equal(body.effectiveDate, publishedRates.effectiveDate);
    assert.equal(body.stale, false);

    const secondResponse = await worker.fetch(createRequest('/api/v1/rates', TEST_API_KEY), environment);
    assert.equal(secondResponse.status, 200);
    assert.equal(upstreamCalls, 1);
    assert.equal(cacheEntries.size, 1);
  } finally {
    globalThis.fetch = originalFetch;

    if (originalCaches) {
      Object.defineProperty(globalThis, 'caches', originalCaches);
    } else {
      Reflect.deleteProperty(globalThis, 'caches');
    }
  }
});

test('expired snapshot cannot be kept alive by failed revalidation writes', async () => {
  const oldVerification = new Date(Date.now() - 604801_000).toISOString();
  const snapshot: Snapshot = {
    rates: publishedRates,
    checkedAt: oldVerification,
    updatedAt: oldVerification,
    retryAfter: new Date(Date.now() + 60000).toISOString(),
  };

  const fakeCache = {
    async match() {
      return new Response(JSON.stringify(snapshot));
    },
  } as unknown as Cache;

  const cache = new CloudflareRateCache(fakeCache, 'https://example.com/internal', 604800);
  assert.equal(await cache.get(), null);
});

test('JSON number conversion preserves published decimals and supports exponent notation', () => {
  const decimalValues = [
    '871.36890000',
    '981.17880877',
    '0.00000001',
    '1000000000000000000000.00000000',
    '0001.23000000',
  ];

  for (const value of decimalValues) {
    const numericRate = rateToNumber(value);
    const serializedRate = JSON.stringify(numericRate);
    const parsedRate = JSON.parse(serializedRate);
    assert.equal(parsedRate, Number(value));
  }

  assert.equal(rateToNumber('981.17880877').toString(), '981.17880877');
});

test('JSON number conversion rejects silent rounding, underflow and invalid rates', () => {
  const invalidValues = [
    '9007199254740993.00000000',
    '1.0000000000000001',
    '123456789.123456789',
    '0',
    '-1',
    'NaN',
    'Infinity',
    '1e-400',
  ];

  for (const value of invalidValues) {
    assert.throws(() => rateToNumber(value), value);
  }
});
