import { GetRates, type RatesResult } from './application/get-rates';
import { dailyRefresh } from './application/refresh-schedule';
import { isAuthorized } from './http/auth';
import { rateToNumber } from './http/rate-number';
import { BcvSource, BCV_URL } from './infrastructure/bcv-source';
import { CloudflareRateCache } from './infrastructure/cloudflare-cache';

interface Env {
  API_KEY: string;
  PUBLICATION_HOUR_VET?: string;
  CACHE_RETENTION_SECONDS?: string;
}

interface RatesConfiguration {
  publicationHour: number;
  cacheRetentionSeconds: number;
}

const MINIMUM_API_KEY_LENGTH = 32;
const DEFAULT_PUBLICATION_HOUR = 18;
const DEFAULT_CACHE_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MINIMUM_CACHE_RETENTION_SECONDS = 4 * 24 * 60 * 60;
const MAXIMUM_CACHED_SERVICES = 16;
const RATES_PATH = '/api/v1/rates';
const INTERNAL_CACHE_PATH = '/__internal/bcv-rates-v1';

// Reuse services so concurrent requests in the same isolate share one BCV fetch.
const services = new Map<string, GetRates>();

function jsonResponse(body: unknown, status = 200): Response {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  return new Response(JSON.stringify(body), { status, headers });
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsedValue = value === undefined ? fallback : Number(value);
  const isValid = Number.isSafeInteger(parsedValue) && parsedValue > 0;

  if (!isValid) {
    throw new Error('Invalid configuration');
  }

  return parsedValue;
}

function readConfiguration(env: Env): RatesConfiguration | null {
  const publicationHour = Number(env.PUBLICATION_HOUR_VET ?? DEFAULT_PUBLICATION_HOUR);
  const isValidHour = Number.isInteger(publicationHour)
    && publicationHour >= 0
    && publicationHour <= 23;

  if (!isValidHour) {
    return null;
  }

  const cacheRetentionSeconds = parsePositiveInteger(
    env.CACHE_RETENTION_SECONDS,
    DEFAULT_CACHE_RETENTION_SECONDS,
  );

  if (cacheRetentionSeconds < MINIMUM_CACHE_RETENTION_SECONDS) {
    return null;
  }

  return { publicationHour, cacheRetentionSeconds };
}

function getRatesService(origin: string, configuration: RatesConfiguration): GetRates {
  const { publicationHour, cacheRetentionSeconds } = configuration;
  const cacheKey = `${origin}${INTERNAL_CACHE_PATH}`;
  const serviceKey = `${cacheKey}:${publicationHour}:${cacheRetentionSeconds}`;
  const existingService = services.get(serviceKey);

  if (existingService) {
    return existingService;
  }

  const source = new BcvSource();
  const cache = new CloudflareRateCache(caches.default, cacheKey, cacheRetentionSeconds);
  const needsRefresh = dailyRefresh(publicationHour);
  const service = new GetRates(source, cache, needsRefresh);

  if (services.size >= MAXIMUM_CACHED_SERVICES) {
    services.clear();
  }

  services.set(serviceKey, service);
  return service;
}

function ratesResponse(result: RatesResult): Response {
  const { snapshot, stale } = result;
  const dollarRate = rateToNumber(snapshot.rates.USD);
  const euroRate = rateToNumber(snapshot.rates.EUR);

  return jsonResponse({
    source: BCV_URL,
    baseCurrency: 'VES',
    rates: {
      USD: dollarRate,
      EUR: euroRate,
    },
    effectiveDate: snapshot.rates.effectiveDate,
    checkedAt: snapshot.checkedAt,
    updatedAt: snapshot.updatedAt,
    stale,
  });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  // Authentication must happen before routing or reading the internal cache.
  if (!env.API_KEY || env.API_KEY.length < MINIMUM_API_KEY_LENGTH) {
    return jsonResponse({ error: 'configuration_error' }, 503);
  }

  const providedApiKey = request.headers.get('X-API-Key');
  const authorized = await isAuthorized(providedApiKey, env.API_KEY);

  if (!authorized) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const url = new URL(request.url);

  if (url.pathname !== RATES_PATH) {
    return jsonResponse({ error: 'not_found' }, 404);
  }

  if (request.method !== 'GET') {
    const response = jsonResponse({ error: 'method_not_allowed' }, 405);
    response.headers.set('Allow', 'GET');
    return response;
  }

  try {
    const configuration = readConfiguration(env);

    if (!configuration) {
      return jsonResponse({ error: 'configuration_error' }, 503);
    }

    const service = getRatesService(url.origin, configuration);
    const result = await service.execute();
    return ratesResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown failure';
    console.error('rates_request_failed', { message });
    return jsonResponse({ error: 'rates_unavailable' }, 503);
  }
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
