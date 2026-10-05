import { Parser } from 'htmlparser2';
import { SourceUnavailable, type Rates, type RateSource } from '../domain/rates';

export const BCV_URL = 'https://www.bcv.org.ve/';

const FETCH_TIMEOUT_MILLISECONDS = 10_000;
const MAXIMUM_HTML_LENGTH = 2_000_000;
const BCV_RATE_PATTERN = /^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type Currency = 'USD' | 'EUR';

interface HtmlElementContext {
  currency?: Currency;
  insideStrong: boolean;
}

function normalizeRate(value: string): string {
  const text = value.trim();

  if (!BCV_RATE_PATTERN.test(text)) {
    throw new SourceUnavailable();
  }

  const normalizedRate = text.replaceAll('.', '').replace(',', '.');
  const numericRate = Number(normalizedRate);

  if (!Number.isFinite(numericRate) || numericRate <= 0) {
    throw new SourceUnavailable();
  }

  return normalizedRate;
}

function validateEffectiveDate(effectiveDate: string): void {
  if (!DATE_PATTERN.test(effectiveDate)) {
    throw new SourceUnavailable();
  }

  const date = new Date(`${effectiveDate}T00:00:00Z`);

  if (!Number.isFinite(date.getTime())) {
    throw new SourceUnavailable();
  }

  // Date normalizes impossible dates, such as February 30. Reject those too.
  const normalizedDate = date.toISOString().slice(0, 10);

  if (normalizedDate !== effectiveDate) {
    throw new SourceUnavailable();
  }
}

function identifyCurrency(elementId: string | undefined): Currency | undefined {
  if (elementId === 'dolar') {
    return 'USD';
  }

  if (elementId === 'euro') {
    return 'EUR';
  }

  return undefined;
}

// Only collect <strong> text inside the official currency blocks.
export function parseBcvHtml(html: string): Rates {
  const elementStack: HtmlElementContext[] = [];
  const rateText: Record<Currency, string[]> = {
    USD: [],
    EUR: [],
  };

  let effectiveDate = '';
  let foundDateLabel = false;

  const parser = new Parser({
    onopentag(tagName, attributes) {
      const parentElement = elementStack.at(-1);
      const currency = identifyCurrency(attributes.id) ?? parentElement?.currency;
      const insideStrong = tagName === 'strong' || parentElement?.insideStrong === true;

      elementStack.push({ currency, insideStrong });

      const classNames = attributes.class?.split(/\s+/) ?? [];
      const isDateElement = tagName === 'span' && classNames.includes('date-display-single');

      // The page has other dates. Read only the one following "Fecha Valor:".
      if (foundDateLabel && isDateElement) {
        effectiveDate = attributes.content?.slice(0, 10) ?? '';
        foundDateLabel = false;
      }
    },

    ontext(text) {
      if (text.includes('Fecha Valor:')) {
        foundDateLabel = true;
      }

      const currentElement = elementStack.at(-1);

      if (currentElement?.currency && currentElement.insideStrong) {
        rateText[currentElement.currency].push(text);
      }
    },

    onclosetag() {
      elementStack.pop();
    },
  }, { decodeEntities: true });

  parser.end(html);
  validateEffectiveDate(effectiveDate);

  const dollarRate = normalizeRate(rateText.USD.join(''));
  const euroRate = normalizeRate(rateText.EUR.join(''));

  return {
    USD: dollarRate,
    EUR: euroRate,
    effectiveDate,
  };
}

export class BcvSource implements RateSource {
  async fetchRates(): Promise<Rates> {
    try {
      const response = await fetch(BCV_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
        headers: {
          Accept: 'text/html',
          'User-Agent': 'BCVExchangeRateAPI/1.0',
        },
        cache: 'no-store',
      });

      if (!response.ok) {
        console.error('bcv_fetch_http_error', { status: response.status });
        throw new SourceUnavailable();
      }

      const html = await response.text();

      if (html.length > MAXIMUM_HTML_LENGTH) {
        throw new SourceUnavailable();
      }

      return parseBcvHtml(html);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UnknownError';
      const message = error instanceof Error ? error.message : 'Unknown source failure';
      console.error('bcv_fetch_failed', { name, message });
      throw new SourceUnavailable();
    }
  }
}
