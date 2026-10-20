// ActionOS Pay: AI Structured Procurement Planner
// Parses natural-language purchase requests into schema-validated procurement plans.
// If critical details are missing, triggers structured clarifications rather than guessing.
// Uses Gemini API when configured, with a resilient deterministic offline fallback.

import { z } from 'zod';
import { DEMO_BUSINESS, DEMO_PRODUCTS, DEMO_SUPPLIERS, searchProducts } from './catalog';
import { PlanItem, StructuredPlan } from './types';

export const PlanItemSchema = z.object({
  sku: z.string().optional(),
  matchedProductId: z.string().optional(),
  productName: z.string().min(1),
  description: z.string().optional(),
  quantity: z.number().int().positive(),
  estimatedUnitPriceCents: z.number().int().nonnegative().optional(),
  suggestedSupplierId: z.string().optional(),
  suggestedSupplierName: z.string().optional(),
});

export const StructuredPlanSchema = z.object({
  summary: z.string().min(1),
  justification: z.string().optional(),
  currency: z.string().default('USD'),
  budgetLimitCents: z.number().int().positive(),
  items: z.array(PlanItemSchema),
  clarificationNeeded: z.boolean(),
  clarificationQuestions: z.array(z.string()).optional(),
  suggestedSupplierId: z.string().optional(),
  confidenceScore: z.number().min(0).max(1),
});

/**
 * Extracts budget amount from prompt (e.g. "$8,000", "8000 dollars", "under $5k")
 */
function extractBudgetFromPrompt(text: string, defaultBudget = 1000000): number {
  const kMatch = text.match(/under\s*\$?(\d+(?:\.\d+)?)\s*k/i) || text.match(/budget\s*(?:of)?\s*\$?(\d+(?:\.\d+)?)\s*k/i);
  if (kMatch) {
    return Math.round(parseFloat(kMatch[1]) * 1000 * 100);
  }

  const dollarMatch =
    text.match(/\$\s*(\d+(?:,\d{3})*(?:\.\d{2})?)/) ||
    text.match(/under\s*\$?\s*(\d+(?:,\d{3})*(?:\.\d{2})?)/i) ||
    text.match(/budget\s*(?:of)?\s*\$?\s*(\d+(?:,\d{3})*(?:\.\d{2})?)/i);

  if (dollarMatch) {
    const rawNum = dollarMatch[1].replace(/,/g, '');
    const num = parseFloat(rawNum);
    if (!isNaN(num) && num > 0) {
      return Math.round(num * 100);
    }
  }

  return defaultBudget;
}

/**
 * Deterministic offline NLP intent parser for procurement prompts.
 */
function parseIntentOffline(prompt: string, defaultBudgetCents: number): StructuredPlan {
  const lower = prompt.toLowerCase();
  const matchedItems: PlanItem[] = [];
  const clarificationQuestions: string[] = [];

  // Look for supplier preferences in prompt
  let preferredSupplier = DEMO_SUPPLIERS.find((s) => lower.includes(s.name.toLowerCase()) || lower.includes(s.code.toLowerCase()));
  if (!preferredSupplier) {
    if (lower.includes('afritech') || lower.includes('lagos') || lower.includes('nigeria')) {
      preferredSupplier = DEMO_SUPPLIERS.find((s) => s.code === 'SUP-AFRITECH');
    } else if (lower.includes('westfield') || lower.includes('monitor') || lower.includes('peripherals')) {
      preferredSupplier = DEMO_SUPPLIERS.find((s) => s.code === 'SUP-WESTFIELD');
    } else if (lower.includes('shadowtech') || lower.includes('grey') || lower.includes('refurbished')) {
      preferredSupplier = DEMO_SUPPLIERS.find((s) => s.code === 'SUP-SHADOWTECH');
    }
  }

  // Check for specific products in prompt
  for (const product of DEMO_PRODUCTS) {
    const nameMatch = lower.includes(product.name.toLowerCase());
    const skuMatch = lower.includes(product.sku.toLowerCase());
    const keywordMatch =
      (product.sku === 'LAP-DELL-XPS15' && (lower.includes('xps') || lower.includes('dell'))) ||
      (product.sku === 'LAP-LEN-X1CARB' && (lower.includes('thinkpad') || lower.includes('lenovo') || lower.includes('x1'))) ||
      (product.sku === 'LAP-APP-MBP14' && (lower.includes('macbook') || lower.includes('apple') || lower.includes('mbp'))) ||
      (product.sku === 'MON-DELL-U2723QE' && (lower.includes('monitor') || lower.includes('4k') || lower.includes('u2723qe'))) ||
      (product.sku === 'ACC-LOGI-MXM3S' && (lower.includes('mouse') || lower.includes('mx master'))) ||
      (product.sku === 'ACC-LOGI-MXKEYS' && (lower.includes('keyboard') || lower.includes('mx keys'))) ||
      (product.sku === 'AUD-BOSE-QC45' && (lower.includes('headphone') || lower.includes('headset') || lower.includes('bose') || lower.includes('qc45'))) ||
      (product.sku === 'PWR-APC-1500VA' && (lower.includes('ups') || lower.includes('battery backup') || lower.includes('apc'))) ||
      (product.sku === 'NET-STLK-STD' && (lower.includes('starlink') || lower.includes('satellite'))) ||
      (product.sku === 'LAP-SHAD-GREY01' && (lower.includes('refurbished') || lower.includes('grey') || lower.includes('uncertified')));

    if (nameMatch || skuMatch || keywordMatch) {
      // Find quantity near keyword or in string
      let quantity = 1;
      const numMatches = prompt.match(/\b(\d+)\b/g);
      if (numMatches) {
        for (const numStr of numMatches) {
          const val = parseInt(numStr, 10);
          if (val > 0 && val <= 100 && val !== 15 && val !== 27 && val !== 14) {
            // Filter out common monitor/screen sizes like 15", 27", 14"
            quantity = val;
            break;
          }
        }
      }

      // Check if item already added
      if (!matchedItems.some((i) => i.sku === product.sku)) {
        matchedItems.push({
          sku: product.sku,
          matchedProductId: product.id,
          productName: product.name,
          description: product.description,
          quantity,
          estimatedUnitPriceCents: product.unitPriceCents,
          suggestedSupplierId: product.supplierId,
          suggestedSupplierName: DEMO_SUPPLIERS.find((s) => s.id === product.supplierId)?.name,
        });
      }
    }
  }

  // If no specific product matched, attempt generic search or flag clarification
  if (matchedItems.length === 0) {
    if (lower.includes('laptop') || lower.includes('computer') || lower.includes('pc')) {
      const defaultLaptop = DEMO_PRODUCTS.find((p) => p.sku === 'LAP-DELL-XPS15')!;
      matchedItems.push({
        sku: defaultLaptop.sku,
        matchedProductId: defaultLaptop.id,
        productName: defaultLaptop.name,
        description: defaultLaptop.description,
        quantity: 1,
        estimatedUnitPriceCents: defaultLaptop.unitPriceCents,
        suggestedSupplierId: defaultLaptop.supplierId,
        suggestedSupplierName: 'AfriTech Solutions Hub',
      });
      clarificationQuestions.push('Do you have a specific laptop brand preference (e.g. Dell XPS 15, ThinkPad X1, or MacBook Pro)?');
    } else if (lower.includes('monitor') || lower.includes('screen') || lower.includes('display')) {
      const defaultMon = DEMO_PRODUCTS.find((p) => p.sku === 'MON-DELL-U2723QE')!;
      matchedItems.push({
        sku: defaultMon.sku,
        matchedProductId: defaultMon.id,
        productName: defaultMon.name,
        description: defaultMon.description,
        quantity: 1,
        estimatedUnitPriceCents: defaultMon.unitPriceCents,
        suggestedSupplierId: defaultMon.supplierId,
        suggestedSupplierName: 'Westfield Peripherals Global',
      });
    } else {
      // General search
      const searched = searchProducts(prompt);
      if (searched.length > 0) {
        const top = searched[0];
        matchedItems.push({
          sku: top.sku,
          matchedProductId: top.id,
          productName: top.name,
          description: top.description,
          quantity: 1,
          estimatedUnitPriceCents: top.unitPriceCents,
          suggestedSupplierId: top.supplierId,
          suggestedSupplierName: DEMO_SUPPLIERS.find((s) => s.id === top.supplierId)?.name,
        });
      } else {
        clarificationQuestions.push('Could not find matching catalogue items. Please specify product name, model or SKU.');
      }
    }
  }

  const budgetLimitCents = extractBudgetFromPrompt(prompt, defaultBudgetCents);
  const primarySupplierId = preferredSupplier?.id || matchedItems[0]?.suggestedSupplierId || DEMO_SUPPLIERS[0].id;

  const plan: StructuredPlan = {
    summary: `Procurement of ${matchedItems.map((i) => `${i.quantity}x ${i.productName}`).join(', ')}`,
    justification: `Automated plan extracted from intent: "${prompt}"`,
    currency: 'USD',
    budgetLimitCents,
    items: matchedItems,
    clarificationNeeded: clarificationQuestions.length > 0,
    clarificationQuestions: clarificationQuestions.length > 0 ? clarificationQuestions : undefined,
    suggestedSupplierId: primarySupplierId,
    confidenceScore: clarificationQuestions.length > 0 ? 0.72 : 0.95,
  };

  return StructuredPlanSchema.parse(plan);
}

/**
 * Parses natural language purchase intent into a structured plan.
 */
export async function parseProcurementIntent(
  prompt: string,
  businessBudgetLimitCents = DEMO_BUSINESS.budgetLimitCents
): Promise<StructuredPlan> {
  const apiKey = process.env.AI_API_KEY || process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const catalogueContext = DEMO_PRODUCTS.map(
        (p) => `- SKU: ${p.sku}, Name: "${p.name}", Category: ${p.category}, Unit Price: $${(p.unitPriceCents / 100).toFixed(2)}, Supplier ID: ${p.supplierId}`
      ).join('\n');

      const suppliersContext = DEMO_SUPPLIERS.map(
        (s) => `- ID: ${s.id}, Name: "${s.name}", Approved: ${s.isApproved}`
      ).join('\n');

      const systemPrompt = `You are ActionOS Pay's AI procurement planner.
Analyze the user's purchase request and match it to items in the approved catalogue.
Available Catalogue:
${catalogueContext}

Available Suppliers:
${suppliersContext}

Return JSON strictly matching this schema:
{
  "summary": "Short summary of the purchase plan",
  "justification": "Why these items match the request",
  "currency": "USD",
  "budgetLimitCents": integer in minor units (e.g. 800000 for $8000.00),
  "items": [
    {
      "sku": "product SKU from catalogue",
      "matchedProductId": "product ID",
      "productName": "product name",
      "quantity": integer >= 1,
      "estimatedUnitPriceCents": integer in cents,
      "suggestedSupplierId": "supplier ID"
    }
  ],
  "clarificationNeeded": boolean,
  "clarificationQuestions": ["list of questions if details are vague"],
  "suggestedSupplierId": "ID of the single primary supplier for this quote",
  "confidenceScore": number between 0.0 and 1.0
}`;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\nUser Purchase Request:\n"${prompt}"` }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const rawJsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawJsonText) {
          const parsed = JSON.parse(rawJsonText);
          return StructuredPlanSchema.parse(parsed);
        }
      }
    } catch (err) {
      console.warn('Gemini API call failed, using deterministic offline intent parser:', err);
    }
  }

  // Fallback to deterministic NLP parser
  return parseIntentOffline(prompt, businessBudgetLimitCents);
}
