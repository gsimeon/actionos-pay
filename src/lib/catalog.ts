// ActionOS Pay: Catalogue & Supplier Registry
// Provides deterministic fixtures matching supabase/seed.sql

import { Business, Product, Supplier, TeamMember } from './types';

export const DEMO_BUSINESS: Business = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Apex Innovations Africa Ltd',
  slug: 'apex-innovations',
  defaultCurrency: 'USD',
  budgetLimitCents: 1000000, // $10,000.00
  createdAt: '2026-01-01T00:00:00Z',
};

export const DEMO_MEMBERS: TeamMember[] = [
  {
    id: '00000000-0000-4000-8000-000000000011',
    businessId: DEMO_BUSINESS.id,
    userId: '00000000-0000-4000-8000-000000000010',
    userName: 'Amina Bello',
    userEmail: 'amina@apexafrica.co',
    role: 'requester',
    approvalLimitCents: 250000, // $2,500.00
  },
  {
    id: '00000000-0000-4000-8000-000000000021',
    businessId: DEMO_BUSINESS.id,
    userId: '00000000-0000-4000-8000-000000000020',
    userName: 'Chidi Okonkwo',
    userEmail: 'chidi@apexafrica.co',
    role: 'approver',
    approvalLimitCents: 1500000, // $15,000.00
  },
  {
    id: '00000000-0000-4000-8000-000000000031',
    businessId: DEMO_BUSINESS.id,
    userId: '00000000-0000-4000-8000-000000000030',
    userName: 'Tunde Davies',
    userEmail: 'tunde@apexafrica.co',
    role: 'admin',
    approvalLimitCents: 5000000, // $50,000.00
  },
];

export const DEMO_SUPPLIERS: Supplier[] = [
  {
    id: '00000000-0000-4000-8000-000000000100',
    businessId: DEMO_BUSINESS.id,
    name: 'AfriTech Solutions Hub',
    code: 'SUP-AFRITECH',
    isApproved: true,
    riskRating: 'low',
    country: 'NG',
    contactEmail: 'procurement@afritech.africa',
  },
  {
    id: '00000000-0000-4000-8000-000000000200',
    businessId: DEMO_BUSINESS.id,
    name: 'Westfield Peripherals Global',
    code: 'SUP-WESTFIELD',
    isApproved: true,
    riskRating: 'low',
    country: 'US',
    contactEmail: 'enterprise@westfield-direct.com',
  },
  {
    id: '00000000-0000-4000-8000-000000000300',
    businessId: DEMO_BUSINESS.id,
    name: 'ShadowTech Grey Market Ltd',
    code: 'SUP-SHADOWTECH',
    isApproved: false, // Explicitly unapproved for security guardrail tests
    riskRating: 'high',
    country: 'AE',
    contactEmail: 'support@shadowtech.biz',
  },
];

export const DEMO_PRODUCTS: Product[] = [
  // AfriTech Hardware
  {
    id: '00000000-0000-4000-8000-000000001001',
    businessId: DEMO_BUSINESS.id,
    supplierId: '00000000-0000-4000-8000-000000000100',
    sku: 'LAP-DELL-XPS15',
    name: 'Dell XPS 15 9530',
    description: 'Intel Core i7-13700H, 32GB DDR5 RAM, 1TB NVMe SSD, 15.6" OLED display',
    category: 'Laptops',
    unitPriceCents: 179900, // $1,799.00
    currency: 'USD',
    inStock: true,
  },
  {
    id: '00000000-0000-4000-8000-000000001002',
    businessId: DEMO_BUSINESS.id,
    supplierId: '00000000-0000-4000-8000-000000000100',
    sku: 'LAP-LEN-X1CARB',
    name: 'Lenovo ThinkPad X1 Carbon Gen 11',
    description: 'Intel Core i7, 16GB RAM, 512GB SSD, Ultra-lightweight carbon chassis',
    category: 'Laptops',
    unitPriceCents: 145000, // $1,450.00
    currency: 'USD',
    inStock: true,
  },
  {
    id: '00000000-0000-4000-8000-000000001003',
    businessId: DEMO_BUSINESS.id,
    supplierId: '00000000-0000-4000-8000-000000000100',
    sku: 'LAP-APP-MBP14',
    name: 'Apple MacBook Pro 14" M3',
    description: 'Apple M3 Pro Chip 11-core CPU, 18GB Unified Memory, 512GB SSD',
    category: 'Laptops',
    unitPriceCents: 199900, // $1,999.00
    currency: 'USD',
    inStock: true,
  },
  {
    id: '00000000-0000-4000-8000-000000001004',
    businessId: DEMO_BUSINESS.id,
    supplierId: '00000000-0000-4000-8000-000000000100',
    sku: 'PWR-APC-1500VA',
    name: 'APC Smart-UPS 1500VA LCD',
    description: 'Line-interactive battery backup with AVR for office workstations & servers',
    category: 'Power Infrastructure',
    unitPriceCents: 59000, // $590.00
    currency: 'USD',
    inStock: true,
  },
  {
    id: '00000000-0000-4000-8000-000000001005',
    businessId: DEMO_BUSINESS.id,
    supplierId: '00000000-0000-4000-8000-000000000100',
    sku: 'NET-STLK-STD',
    name: 'Starlink Standard Enterprise Kit',
    description: 'High-speed, low-latency satellite dish kit with WiFi router for enterprise failover',
    category: 'Networking',
    unitPriceCents: 59900, // $599.00
    currency: 'USD',
    inStock: true,
  },

  // Westfield Peripherals
  {
    id: '00000000-0000-4000-8000-000000002001',
    businessId: DEMO_BUSINESS.id,
    supplierId: '00000000-0000-4000-8000-000000000200',
    sku: 'MON-DELL-U2723QE',
    name: 'Dell UltraSharp 27" 4K USB-C Hub Monitor',
    description: 'IPS Black 4K UHD, 90W Power Delivery, RJ45 Ethernet, Daisy Chain',
    category: 'Monitors',
    unitPriceCents: 48000, // $480.00
    currency: 'USD',
    inStock: true,
  },
  {
    id: '00000000-0000-4000-8000-000000002002',
    businessId: DEMO_BUSINESS.id,
    supplierId: '00000000-0000-4000-8000-000000000200',
    sku: 'ACC-LOGI-MXM3S',
    name: 'Logitech MX Master 3S Wireless Mouse',
    description: '8K DPI sensor, quiet click, electromagnetic MagSpeed scrolling',
    category: 'Accessories',
    unitPriceCents: 9900, // $99.00
    currency: 'USD',
    inStock: true,
  },
  {
    id: '00000000-0000-4000-8000-000000002003',
    businessId: DEMO_BUSINESS.id,
    supplierId: '00000000-0000-4000-8000-000000000200',
    sku: 'ACC-LOGI-MXKEYS',
    name: 'Logitech MX Keys S Wireless Keyboard',
    description: 'Illuminated smart backlighting, multi-device Bluetooth / Logi Bolt',
    category: 'Accessories',
    unitPriceCents: 11900, // $119.00
    currency: 'USD',
    inStock: true,
  },
  {
    id: '00000000-0000-4000-8000-000000002004',
    businessId: DEMO_BUSINESS.id,
    supplierId: '00000000-0000-4000-8000-000000000200',
    sku: 'AUD-BOSE-QC45',
    name: 'Bose QuietComfort 45 Noise-Cancelling Headphones',
    description: 'Acoustic Noise Cancelling, Aware Mode, 24-hr battery, enterprise mic',
    category: 'Audio',
    unitPriceCents: 27900, // $279.00
    currency: 'USD',
    inStock: true,
  },

  // ShadowTech Unapproved Products (for adversary guardrail demonstration)
  {
    id: '00000000-0000-4000-8000-000000003001',
    businessId: DEMO_BUSINESS.id,
    supplierId: '00000000-0000-4000-8000-000000000300',
    sku: 'LAP-SHAD-GREY01',
    name: 'Uncertified Refurbished Enterprise Laptop',
    description: 'Grey-market import without manufacturer warranty or hardware audit',
    category: 'Laptops',
    unitPriceCents: 45000, // $450.00
    currency: 'USD',
    inStock: true,
  },
];

export function getSuppliers(): Supplier[] {
  return DEMO_SUPPLIERS;
}

export function getSupplierById(id: string): Supplier | undefined {
  return DEMO_SUPPLIERS.find((s) => s.id === id);
}

export function getSupplierByCode(code: string): Supplier | undefined {
  return DEMO_SUPPLIERS.find((s) => s.code.toLowerCase() === code.toLowerCase());
}

export function getProducts(): Product[] {
  return DEMO_PRODUCTS;
}

export function getProductById(id: string): Product | undefined {
  return DEMO_PRODUCTS.find((p) => p.id === id);
}

export function getProductBySku(sku: string): Product | undefined {
  return DEMO_PRODUCTS.find((p) => p.sku.toLowerCase() === sku.toLowerCase());
}

export function searchProducts(term: string): Product[] {
  const lower = term.toLowerCase().trim();
  if (!lower) return DEMO_PRODUCTS;
  return DEMO_PRODUCTS.filter(
    (p) =>
      p.name.toLowerCase().includes(lower) ||
      p.sku.toLowerCase().includes(lower) ||
      p.description.toLowerCase().includes(lower) ||
      p.category.toLowerCase().includes(lower)
  );
}
