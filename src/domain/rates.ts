export interface Rates {
  // Keep the exact published decimals until HTTP response serialization.
  USD: string;
  EUR: string;
  effectiveDate: string;
}

export interface Snapshot {
  rates: Rates;
  checkedAt: string;
  updatedAt: string;
  retryAfter?: string;
}

export interface RateSource {
  fetchRates(): Promise<Rates>;
}

export interface RateCache {
  get(): Promise<Snapshot | null>;
  put(snapshot: Snapshot): Promise<void>;
}

export class SourceUnavailable extends Error {
  constructor() {
    super('No se pudieron obtener tasas válidas del BCV.');
  }
}
