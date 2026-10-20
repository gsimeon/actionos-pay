// ActionOS Pay: Currency & Minor-Unit Math
// Invariant: All financial arithmetic is performed in integer minor units (e.g. cents)
// to eliminate floating point imprecision and currency rounding drift.

export function formatCurrency(cents: number, currency = 'USD'): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency.toUpperCase()} ${(amount).toFixed(2)}`;
  }
}

/**
 * Formats integer cents into a strict decimal string for PayPal APIs (e.g. 179900 -> "1799.00")
 */
export function centsToDecimalString(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`centsToDecimalString expects an integer minor unit, got ${cents}`);
  }
  const isNegative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainingCents = abs % 100;
  const paddedCents = remainingCents < 10 ? `0${remainingCents}` : `${remainingCents}`;
  return `${isNegative ? '-' : ''}${dollars}.${paddedCents}`;
}

/**
 * Safely parses a decimal string (e.g. "1799.00" or "49.5") into integer cents without floating point drift
 */
export function decimalStringToCents(val: string | number): number {
  if (typeof val === 'number') {
    return Math.round(val * 100);
  }
  const cleaned = val.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`Invalid decimal currency amount string: "${val}"`);
  }
  const parts = cleaned.split('.');
  const whole = parseInt(parts[0], 10);
  const fractional = parts[1] || '';
  const paddedFraction = (fractional + '00').slice(0, 2);
  const cents = parseInt(paddedFraction, 10);
  return whole >= 0 ? whole * 100 + cents : whole * 100 - cents;
}

/**
 * Multiplies quantity by unit price in cents safely
 */
export function calculateLineTotal(quantity: number, unitPriceCents: number): number {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error(`Quantity must be a non-negative integer, got ${quantity}`);
  }
  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
    throw new Error(`UnitPriceCents must be a non-negative integer, got ${unitPriceCents}`);
  }
  return quantity * unitPriceCents;
}

/**
 * Computes tax using basis points (e.g., 750 = 7.5% tax)
 * Uses standard round-half-up
 */
export function calculateTax(subtotalCents: number, basisPoints: number): number {
  if (subtotalCents <= 0 || basisPoints <= 0) return 0;
  return Math.round((subtotalCents * basisPoints) / 10000);
}
