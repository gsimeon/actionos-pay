// ActionOS Pay: Currency & Minor-Unit Math
// Invariant: All financial arithmetic is performed in integer minor units (e.g. cents)
// to eliminate floating point imprecision and currency rounding drift.

export const CURRENCY_DECIMALS: Record<string, number> = {
  // Zero decimals (minor unit = 1 unit)
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  PYG: 0,
  UGX: 0,
  RWF: 0,
  BIF: 0,
  // Three decimals (minor unit = 1/1000 unit)
  BHD: 3,
  JOD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  // Default is 2 for USD, EUR, GBP, CAD, AUD, NGN, KES, ZAR, etc.
};

export function getCurrencyDecimals(currency: string): number {
  const code = (currency || 'USD').toUpperCase();
  return CURRENCY_DECIMALS[code] ?? 2;
}

export function formatCurrency(minorUnits: number, currency = 'USD'): string {
  const decimals = getCurrencyDecimals(currency);
  const amount = minorUnits / Math.pow(10, decimals);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    return `${currency.toUpperCase()} ${amount.toFixed(decimals)}`;
  }
}

/**
 * Formats integer minor units into a strict decimal string for external provider APIs (e.g. 179900 -> "1799.00")
 */
export function minorUnitsToDecimalString(units: number, currency = 'USD'): string {
  if (!Number.isInteger(units)) {
    throw new Error(`minorUnitsToDecimalString expects an integer minor unit, got ${units}`);
  }
  const decimals = getCurrencyDecimals(currency);
  if (decimals === 0) {
    return `${units}`;
  }
  const isNegative = units < 0;
  const abs = Math.abs(units);
  const divisor = Math.pow(10, decimals);
  const whole = Math.floor(abs / divisor);
  const remainder = abs % divisor;
  const paddedRemainder = remainder.toString().padStart(decimals, '0');
  return `${isNegative ? '-' : ''}${whole}.${paddedRemainder}`;
}

export function centsToDecimalString(cents: number): string {
  return minorUnitsToDecimalString(cents, 'USD');
}

/**
 * Safely parses a decimal string (e.g. "1799.00", "5000", or "1.500") into integer minor units (e.g. cents)
 * using the currency's exact decimal precision without floating point drift.
 */
export function parseAmountToMinorUnits(val: string | number, currency = 'USD'): number {
  if (typeof val === 'number') {
    if (isNaN(val) || !isFinite(val)) {
      throw new Error(`Invalid numeric amount: ${val}`);
    }
    const decimals = getCurrencyDecimals(currency);
    const multiplier = Math.pow(10, decimals);
    return Math.round(val * multiplier);
  }
  const cleaned = val.trim().replace(/,/g, '');
  const decimals = getCurrencyDecimals(currency);

  if (decimals === 0) {
    if (!/^-?\d+$/.test(cleaned)) {
      throw new Error(`Invalid integer currency amount string for 0-decimal currency ${currency}: "${val}"`);
    }
    return parseInt(cleaned, 10);
  }

  const regex = new RegExp(`^-?\\d+(\\.\\d{1,${decimals}})?$`);
  if (!regex.test(cleaned)) {
    throw new Error(`Invalid decimal currency amount string for ${currency} (max ${decimals} decimals): "${val}"`);
  }

  const parts = cleaned.split('.');
  const whole = parseInt(parts[0], 10);
  const fractional = parts[1] || '';
  const paddedFraction = (fractional + '0'.repeat(decimals)).slice(0, decimals);
  const minor = parseInt(paddedFraction, 10);
  const multiplier = Math.pow(10, decimals);

  return whole >= 0 ? whole * multiplier + minor : whole * multiplier - minor;
}

export function decimalStringToCents(val: string | number): number {
  return parseAmountToMinorUnits(val, 'USD');
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
