// ActionOS Pay: Deterministic Server-Side Quote Engine
// Invariants:
// 1. Browser never supplies unit prices; they are authoritatively loaded from the catalogue.
// 2. All arithmetic is in integer minor units (cents).
// 3. Produces an immutable SHA-256 integrity checksum sealing the quote version and terms.

import { createHash, randomUUID } from 'crypto';
import { getProductById, getProductBySku, getSupplierById } from './catalog';
import { calculateLineTotal, calculateTax } from './currency';
import { Quote, QuoteItem } from './types';

export interface QuoteInputItem {
  productId?: string;
  sku?: string;
  quantity: number;
}

export interface GenerateQuoteParams {
  requestId: string;
  businessId: string;
  supplierId: string;
  version?: number;
  items: QuoteInputItem[];
  taxBasisPoints?: number; // e.g. 750 = 7.5%
  shippingCents?: number;
}

/**
 * Computes a deterministic SHA-256 seal for a quote snapshot.
 * Any modification to items, prices, supplier, or total invalidates the hash.
 */
export function computeQuoteChecksum(params: {
  requestId: string;
  version: number;
  supplierId: string;
  totalCents: number;
  currency: string;
  items: { sku?: string; quantity: number; unitPriceCents: number; totalCents: number }[];
}): string {
  const canonicalPayload = JSON.stringify({
    requestId: params.requestId,
    version: params.version,
    supplierId: params.supplierId,
    totalCents: params.totalCents,
    currency: params.currency,
    items: params.items.map((i) => ({
      sku: i.sku || '',
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
      totalCents: i.totalCents,
    })),
  });

  return createHash('sha256').update(canonicalPayload).digest('hex');
}

/**
 * Verifies that a quote has not been tampered with since creation.
 */
export function verifyQuoteIntegrity(quote: Quote): boolean {
  const calculated = computeQuoteChecksum({
    requestId: quote.requestId,
    version: quote.version,
    supplierId: quote.supplierId,
    totalCents: quote.totalCents,
    currency: quote.currency,
    items: quote.items,
  });
  return calculated === quote.checksumHash;
}

/**
 * Deterministically constructs a validated Quote with integer minor unit math.
 */
export function calculateQuote(params: GenerateQuoteParams): Quote {
  const {
    requestId,
    businessId,
    supplierId,
    version = 1,
    items: rawItems,
    taxBasisPoints = 750, // 7.5% standard tax
    shippingCents = 4500, // $45.00 flat insured freight
  } = params;

  const supplier = getSupplierById(supplierId);
  if (!supplier) {
    throw new Error(`Supplier with ID "${supplierId}" not found in catalogue.`);
  }

  if (!rawItems || rawItems.length === 0) {
    throw new Error('Quote must contain at least one item.');
  }

  const quoteId = randomUUID();
  const quoteItems: QuoteItem[] = [];
  let subtotalCents = 0;

  for (const itemInput of rawItems) {
    if (itemInput.quantity <= 0 || !Number.isInteger(itemInput.quantity)) {
      throw new Error(`Invalid item quantity: ${itemInput.quantity}. Must be positive integer.`);
    }

    const product = itemInput.sku
      ? getProductBySku(itemInput.sku)
      : itemInput.productId
      ? getProductById(itemInput.productId)
      : undefined;

    if (!product) {
      throw new Error(`Product not found for SKU: "${itemInput.sku}" or ID: "${itemInput.productId}"`);
    }

    if (product.supplierId !== supplierId) {
      throw new Error(
        `Product "${product.name}" (${product.sku}) belongs to supplier "${product.supplierId}", not selected supplier "${supplierId}".`
      );
    }

    const lineTotalCents = calculateLineTotal(itemInput.quantity, product.unitPriceCents);
    subtotalCents += lineTotalCents;

    quoteItems.push({
      id: randomUUID(),
      quoteId,
      productId: product.id,
      sku: product.sku,
      itemName: product.name,
      quantity: itemInput.quantity,
      unitPriceCents: product.unitPriceCents,
      totalCents: lineTotalCents,
    });
  }

  const taxCents = calculateTax(subtotalCents, taxBasisPoints);
  const totalCents = subtotalCents + taxCents + shippingCents;
  const currency = 'USD';

  const checksumHash = computeQuoteChecksum({
    requestId,
    version,
    supplierId,
    totalCents,
    currency,
    items: quoteItems,
  });

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  return {
    id: quoteId,
    requestId,
    businessId,
    supplierId,
    supplierName: supplier.name,
    version,
    items: quoteItems,
    subtotalCents,
    taxCents,
    shippingCents,
    totalCents,
    currency,
    checksumHash,
    status: 'active',
    expiresAt,
    createdAt: new Date().toISOString(),
  };
}
