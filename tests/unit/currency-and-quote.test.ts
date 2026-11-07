import { describe, expect, it } from 'vitest';
import {
  calculateLineTotal,
  calculateTax,
  centsToDecimalString,
  decimalStringToCents,
  formatCurrency,
  getCurrencyDecimals,
  minorUnitsToDecimalString,
  parseAmountToMinorUnits,
} from '../../src/lib/currency';
import { calculateQuote, computeQuoteChecksum, verifyQuoteIntegrity } from '../../src/lib/quote-engine';

describe('Currency and Minor Unit Arithmetic', () => {
  it('formats minor units (cents) to currency strings accurately', () => {
    expect(formatCurrency(179900, 'USD')).toBe('$1,799.00');
    expect(formatCurrency(0, 'USD')).toBe('$0.00');
    expect(formatCurrency(4950, 'USD')).toBe('$49.50');
  });

  it('converts integer cents to strict PayPal decimal strings without float drift', () => {
    expect(centsToDecimalString(179900)).toBe('1799.00');
    expect(centsToDecimalString(99)).toBe('0.99');
    expect(centsToDecimalString(5)).toBe('0.05');
    expect(centsToDecimalString(0)).toBe('0.00');
  });

  it('safely parses decimal currency strings into integer cents', () => {
    expect(decimalStringToCents('1799.00')).toBe(179900);
    expect(decimalStringToCents('1,799.00')).toBe(179900);
    expect(decimalStringToCents('0.99')).toBe(99);
    expect(decimalStringToCents('49.5')).toBe(4950);
  });

  it('correctly reports ISO currency decimal places', () => {
    expect(getCurrencyDecimals('JPY')).toBe(0);
    expect(getCurrencyDecimals('KRW')).toBe(0);
    expect(getCurrencyDecimals('USD')).toBe(2);
    expect(getCurrencyDecimals('EUR')).toBe(2);
    expect(getCurrencyDecimals('GBP')).toBe(2);
    expect(getCurrencyDecimals('BHD')).toBe(3);
    expect(getCurrencyDecimals('KWD')).toBe(3);
    expect(getCurrencyDecimals('OMR')).toBe(3);
  });

  it('converts multi-currency minor units to decimal strings accurately', () => {
    // 0-decimal currencies
    expect(minorUnitsToDecimalString(5000, 'JPY')).toBe('5000');
    expect(minorUnitsToDecimalString(125000, 'KRW')).toBe('125000');

    // 2-decimal currencies
    expect(minorUnitsToDecimalString(179900, 'USD')).toBe('1799.00');
    expect(minorUnitsToDecimalString(5, 'EUR')).toBe('0.05');

    // 3-decimal currencies
    expect(minorUnitsToDecimalString(1250, 'BHD')).toBe('1.250');
    expect(minorUnitsToDecimalString(5, 'KWD')).toBe('0.005');
  });

  it('parses multi-currency decimal strings into exact minor units without precision loss', () => {
    // 0-decimal currencies
    expect(parseAmountToMinorUnits('5000', 'JPY')).toBe(5000);
    expect(() => parseAmountToMinorUnits('5000.75', 'JPY')).toThrow();

    // 2-decimal currencies
    expect(parseAmountToMinorUnits('1799.00', 'USD')).toBe(179900);
    expect(parseAmountToMinorUnits('0.99', 'EUR')).toBe(99);

    // 3-decimal currencies
    expect(parseAmountToMinorUnits('1.250', 'BHD')).toBe(1250);
    expect(parseAmountToMinorUnits('0.005', 'KWD')).toBe(5);
  });

  it('calculates line item totals with integer safety', () => {
    expect(calculateLineTotal(5, 179900)).toBe(899500);
    expect(calculateLineTotal(0, 179900)).toBe(0);
    expect(() => calculateLineTotal(-1, 100)).toThrow();
  });

  it('calculates taxes using basis points without float accumulation', () => {
    // 7.5% on $1,000.00 (100000 cents) = $75.00 (7500 cents)
    expect(calculateTax(100000, 750)).toBe(7500);
    // 7.5% on $19.99 (1999 cents) = $1.50 (149.925 -> 150 cents)
    expect(calculateTax(1999, 750)).toBe(150);
  });
});

describe('Quote Engine and Cryptographic Integrity', () => {
  const reqId = 'req-test-001';
  const bizId = '00000000-0000-4000-8000-000000000001';
  const supId = '00000000-0000-4000-8000-000000000100'; // AfriTech

  it('generates a deterministic quote loaded authoritatively from the catalogue', () => {
    const quote = calculateQuote({
      requestId: reqId,
      businessId: bizId,
      supplierId: supId,
      items: [
        { sku: 'LAP-DELL-XPS15', quantity: 2 }, // 2 * $1,799.00 = $3,598.00 (359800)
      ],
      taxBasisPoints: 750, // 7.5% of 359800 = 26985 cents
      shippingCents: 4500, // $45.00 freight
    });

    expect(quote.subtotalCents).toBe(359800);
    expect(quote.taxCents).toBe(26985);
    expect(quote.shippingCents).toBe(4500);
    expect(quote.totalCents).toBe(359800 + 26985 + 4500);
    expect(quote.supplierName).toBe('AfriTech Solutions Hub');
    expect(quote.status).toBe('active');
    expect(quote.checksumHash).toBeDefined();
    expect(verifyQuoteIntegrity(quote)).toBe(true);
  });

  it('rejects quote creation for mismatched supplier products', () => {
    expect(() =>
      calculateQuote({
        requestId: reqId,
        businessId: bizId,
        supplierId: supId, // AfriTech
        items: [
          { sku: 'MON-DELL-U2723QE', quantity: 1 }, // Westfield monitor, not AfriTech
        ],
      })
    ).toThrow(/belongs to supplier/);
  });

  it('detects tampering when quote total or items are modified', () => {
    const quote = calculateQuote({
      requestId: reqId,
      businessId: bizId,
      supplierId: supId,
      items: [{ sku: 'LAP-DELL-XPS15', quantity: 1 }],
    });

    expect(verifyQuoteIntegrity(quote)).toBe(true);

    // Tamper with the total
    const tamperedQuote = { ...quote, totalCents: quote.totalCents - 10000 };
    expect(verifyQuoteIntegrity(tamperedQuote)).toBe(false);
  });
});
