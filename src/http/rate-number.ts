const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;

// Normalize decimal notation so equivalent values can be compared without rounding.
// For example, 1.2300 and 1.23e0 both become the key "123:-2".
function decimalKey(value: string): string {
  const match = DECIMAL_PATTERN.exec(value);

  if (!match) {
    throw new Error('Invalid decimal rate');
  }

  const integerPart = match[1];
  const fractionalPart = match[2] ?? '';
  const explicitExponent = Number(match[3] ?? 0);

  const allDigits = integerPart + fractionalPart;
  const significantDigits = allDigits.replace(/^0+/, '');
  const coefficient = significantDigits.replace(/0+$/, '');
  const removedTrailingZeros = significantDigits.length - coefficient.length;
  const normalizedExponent = explicitExponent - fractionalPart.length + removedTrailingZeros;

  return `${coefficient}:${normalizedExponent}`;
}

/** Reject conversions that change the decimal value sent in the JSON response. */
export function rateToNumber(decimal: string): number {
  const numericRate = Number(decimal);
  const isPositiveFiniteNumber = Number.isFinite(numericRate) && numericRate > 0;

  if (!isPositiveFiniteNumber) {
    throw new Error('Rate cannot be represented as a JSON number without changing its decimal value');
  }

  const originalDecimal = decimalKey(decimal);
  const serializedDecimal = decimalKey(String(numericRate));

  if (originalDecimal !== serializedDecimal) {
    throw new Error('Rate cannot be represented as a JSON number without changing its decimal value');
  }

  return numericRate;
}
