-- ActionOS Pay: Seed Data for Demo & Development
-- Provides a deterministic business tenant, team members, approved/unapproved suppliers,
-- and catalogue items priced in integer minor units (cents).

DO $$
DECLARE
  v_biz_id UUID := '00000000-0000-4000-8000-000000000001'::uuid;
  v_user_amina UUID := '00000000-0000-4000-8000-000000000010'::uuid;
  v_user_chidi UUID := '00000000-0000-4000-8000-000000000020'::uuid;
  v_user_tunde UUID := '00000000-0000-4000-8000-000000000030'::uuid;

  v_sup_afritech UUID := '00000000-0000-4000-8000-000000000100'::uuid;
  v_sup_westfield UUID := '00000000-0000-4000-8000-000000000200'::uuid;
  v_sup_shadowtech UUID := '00000000-0000-4000-8000-000000000300'::uuid;
BEGIN
  -- 1. Demo Business Tenant
  INSERT INTO businesses (id, name, slug, default_currency, budget_limit_cents)
  VALUES (v_biz_id, 'Apex Innovations Africa Ltd', 'apex-innovations', 'USD', 1000000)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    budget_limit_cents = EXCLUDED.budget_limit_cents;

  -- 2. Team Memberships
  INSERT INTO memberships (id, business_id, user_id, user_name, user_email, role, approval_limit_cents)
  VALUES
    ('00000000-0000-4000-8000-000000000011'::uuid, v_biz_id, v_user_amina, 'Amina Bello', 'amina@apexafrica.co', 'requester', 250000),
    ('00000000-0000-4000-8000-000000000021'::uuid, v_biz_id, v_user_chidi, 'Chidi Okonkwo', 'chidi@apexafrica.co', 'approver', 1500000),
    ('00000000-0000-4000-8000-000000000031'::uuid, v_biz_id, v_user_tunde, 'Tunde Davies', 'tunde@apexafrica.co', 'admin', 5000000)
  ON CONFLICT (business_id, user_id) DO NOTHING;

  -- 3. Suppliers (Approved & Unapproved)
  INSERT INTO suppliers (id, business_id, name, code, is_approved, risk_rating, country, contact_email)
  VALUES
    (v_sup_afritech, v_biz_id, 'AfriTech Solutions Hub', 'SUP-AFRITECH', true, 'low', 'NG', 'procurement@afritech.africa'),
    (v_sup_westfield, v_biz_id, 'Westfield Peripherals Global', 'SUP-WESTFIELD', true, 'low', 'US', 'enterprise@westfield-direct.com'),
    (v_sup_shadowtech, v_biz_id, 'ShadowTech Grey Market Ltd', 'SUP-SHADOWTECH', false, 'high', 'AE', 'support@shadowtech.biz')
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    is_approved = EXCLUDED.is_approved,
    risk_rating = EXCLUDED.risk_rating;

  -- 4. Catalogue Products (Priced in minor unit cents)
  INSERT INTO products (id, business_id, supplier_id, sku, name, description, category, unit_price_cents, currency, in_stock)
  VALUES
    -- AfriTech Hardware
    ('00000000-0000-4000-8000-000000001001'::uuid, v_biz_id, v_sup_afritech, 'LAP-DELL-XPS15', 'Dell XPS 15 9530', 'Intel Core i7-13700H, 32GB DDR5 RAM, 1TB NVMe SSD, 15.6" OLED display', 'Laptops', 179900, 'USD', true),
    ('00000000-0000-4000-8000-000000001002'::uuid, v_biz_id, v_sup_afritech, 'LAP-LEN-X1CARB', 'Lenovo ThinkPad X1 Carbon Gen 11', 'Intel Core i7, 16GB RAM, 512GB SSD, Ultra-lightweight carbon chassis', 'Laptops', 145000, 'USD', true),
    ('00000000-0000-4000-8000-000000001003'::uuid, v_biz_id, v_sup_afritech, 'LAP-APP-MBP14', 'Apple MacBook Pro 14" M3', 'Apple M3 Pro Chip 11-core CPU, 18GB Unified Memory, 512GB SSD', 'Laptops', 199900, 'USD', true),
    ('00000000-0000-4000-8000-000000001004'::uuid, v_biz_id, v_sup_afritech, 'PWR-APC-1500VA', 'APC Smart-UPS 1500VA LCD', 'Line-interactive battery backup with AVR for office workstations & servers', 'Power Infrastructure', 59000, 'USD', true),
    ('00000000-0000-4000-8000-000000001005'::uuid, v_biz_id, v_sup_afritech, 'NET-STLK-STD', 'Starlink Standard Enterprise Kit', 'High-speed, low-latency satellite dish kit with WiFi router for enterprise failover', 'Networking', 59900, 'USD', true),

    -- Westfield Peripherals
    ('00000000-0000-4000-8000-000000002001'::uuid, v_biz_id, v_sup_westfield, 'MON-DELL-U2723QE', 'Dell UltraSharp 27" 4K USB-C Hub Monitor', 'IPS Black 4K UHD, 90W Power Delivery, RJ45 Ethernet, Daisy Chain', 'Monitors', 48000, 'USD', true),
    ('00000000-0000-4000-8000-000000002002'::uuid, v_biz_id, v_sup_westfield, 'ACC-LOGI-MXM3S', 'Logitech MX Master 3S Wireless Mouse', '8K DPI sensor, quiet click, electromagnetic MagSpeed scrolling', 'Accessories', 9900, 'USD', true),
    ('00000000-0000-4000-8000-000000002003'::uuid, v_biz_id, v_sup_westfield, 'ACC-LOGI-MXKEYS', 'Logitech MX Keys S Wireless Keyboard', 'Illuminated smart backlighting, multi-device Bluetooth / Logi Bolt', 'Accessories', 11900, 'USD', true),
    ('00000000-0000-4000-8000-000000002004'::uuid, v_biz_id, v_sup_westfield, 'AUD-BOSE-QC45', 'Bose QuietComfort 45 Noise-Cancelling Headphones', 'Acoustic Noise Cancelling, Aware Mode, 24-hr battery, enterprise mic', 'Audio', 27900, 'USD', true),

    -- ShadowTech Unapproved Products (Used to demonstrate policy enforcement rejection)
    ('00000000-0000-4000-8000-000000003001'::uuid, v_biz_id, v_sup_shadowtech, 'LAP-SHAD-GREY01', 'Uncertified Refurbished Enterprise Laptop', 'Grey-market import without manufacturer warranty', 'Laptops', 45000, 'USD', true)
  ON CONFLICT (business_id, sku) DO UPDATE SET
    unit_price_cents = EXCLUDED.unit_price_cents,
    name = EXCLUDED.name,
    in_stock = EXCLUDED.in_stock;

END $$;
