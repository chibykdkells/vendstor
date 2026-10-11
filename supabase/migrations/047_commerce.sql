-- ============================================================
-- 047_commerce.sql — Product catalog, orders, bank-transfer payment
--
-- Lets a business sell inside the chat: the AI (or an agent) shows
-- products, builds an order, sends an invoice plus bank-transfer
-- details, and an agent confirms the payment once the customer's
-- transfer lands.
--
-- Design notes
--   - Account-scoped like every tenant table (017). One currency per
--     account (021): products carry no currency column; an order
--     snapshots `accounts.default_currency` when it is created.
--   - Prices are NEVER taken from the caller. `create_order` reads
--     each product's current price from `products`, so an LLM can't
--     invent or mis-quote a price into an order. Line name + price are
--     snapshotted onto `order_items` so later catalog edits don't
--     rewrite past invoices.
--   - `stock_quantity` NULL means "not tracked". Stock is checked when
--     an order is created and decremented when the payment is
--     confirmed (bank transfers are confirmed by a human, so that is
--     the moment the sale is real).
--   - Order numbers are per account (`INV-0001`…), allocated from
--     `commerce_settings.next_order_number` under a row lock so two
--     concurrent orders can't share a number.
--   - `create_order` / `mark_order_paid` are SECURITY DEFINER and
--     service_role only (044 convention). Callers verify membership in
--     the app layer, then call with the admin client. Both take
--     `p_account_id` and re-check that every referenced row belongs
--     to it, so a caller bug can't write across tenants.
--
-- RLS
--   products, orders, order_items: data-class, mirroring `deals` —
--   any member reads, agent+ writes. commerce_settings holds bank
--   details: settings-class, mirroring `webhook_endpoints` — any
--   member reads, admin+ writes.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- PRODUCTS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name           text NOT NULL CHECK (btrim(name) <> ''),
  description    text,
  sku            text,
  price          numeric(14, 2) NOT NULL CHECK (price >= 0),
  stock_quantity integer CHECK (stock_quantity IS NULL OR stock_quantity >= 0), -- NULL = not tracked
  image_url      text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Catalog listing / AI product search always filter by account (+ active).
CREATE INDEX IF NOT EXISTS products_account_active_idx
  ON products (account_id, is_active);

-- SKUs are optional, but unique within an account when present.
CREATE UNIQUE INDEX IF NOT EXISTS products_account_sku_key
  ON products (account_id, sku) WHERE sku IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON products;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS products_select ON products;
CREATE POLICY products_select ON products FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS products_insert ON products;
CREATE POLICY products_insert ON products FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS products_update ON products;
CREATE POLICY products_update ON products FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS products_delete ON products;
CREATE POLICY products_delete ON products FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- ------------------------------------------------------------
-- COMMERCE SETTINGS — bank-transfer details + invoice numbering.
-- One row per account, created lazily by `create_order` or the
-- settings UI.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_settings (
  account_id           uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  bank_name            text,
  bank_account_name    text,
  bank_account_number  text,
  payment_instructions text,   -- free text appended to the bank details message
  order_number_prefix  text NOT NULL DEFAULT 'INV-'
    CHECK (char_length(order_number_prefix) <= 12),
  next_order_number    integer NOT NULL DEFAULT 1 CHECK (next_order_number > 0),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_updated_at ON commerce_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON commerce_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE commerce_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commerce_settings_select ON commerce_settings;
CREATE POLICY commerce_settings_select ON commerce_settings FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS commerce_settings_insert ON commerce_settings;
CREATE POLICY commerce_settings_insert ON commerce_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS commerce_settings_update ON commerce_settings;
CREATE POLICY commerce_settings_update ON commerce_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- ORDERS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  order_number             text NOT NULL,
  contact_id               uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id          uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status                   text NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'payment_submitted', 'paid', 'fulfilled', 'cancelled')),
  source                   text NOT NULL DEFAULT 'agent'
    CHECK (source IN ('ai', 'agent', 'api')),
  currency                 text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal                 numeric(14, 2) NOT NULL CHECK (subtotal >= 0),
  total                    numeric(14, 2) NOT NULL CHECK (total >= 0),
  customer_note            text,
  -- The customer's inbound message carrying the transfer receipt.
  payment_proof_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  paid_at                  timestamptz,
  paid_confirmed_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL, -- NULL when source = 'ai'
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_account_order_number_key UNIQUE (account_id, order_number)
);

CREATE INDEX IF NOT EXISTS orders_account_status_idx
  ON orders (account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_conversation_idx
  ON orders (conversation_id);
CREATE INDEX IF NOT EXISTS orders_contact_idx
  ON orders (contact_id);

DROP TRIGGER IF EXISTS set_updated_at ON orders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orders_select ON orders;
CREATE POLICY orders_select ON orders FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS orders_insert ON orders;
CREATE POLICY orders_insert ON orders FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS orders_update ON orders;
CREATE POLICY orders_update ON orders FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS orders_delete ON orders;
CREATE POLICY orders_delete ON orders FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- ORDER ITEMS — name + price snapshotted at order time.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_id   uuid REFERENCES products(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  unit_price   numeric(14, 2) NOT NULL CHECK (unit_price >= 0),
  quantity     integer NOT NULL CHECK (quantity > 0),
  line_total   numeric(14, 2) NOT NULL CHECK (line_total >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_account_idx ON order_items (account_id);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_items_select ON order_items;
CREATE POLICY order_items_select ON order_items FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS order_items_insert ON order_items;
CREATE POLICY order_items_insert ON order_items FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS order_items_update ON order_items;
CREATE POLICY order_items_update ON order_items FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS order_items_delete ON order_items;
CREATE POLICY order_items_delete ON order_items FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- ============================================================
-- create_order — atomic order + items, prices from the catalog.
--
-- p_items: JSON array of {"product_id": uuid, "quantity": int}.
-- Duplicate product_ids are merged. Returns the new order's id.
--
-- Errors are raised as 'commerce:<code>[:detail]' so the app layer
-- can map them to a customer-facing reply without parsing prose:
--   commerce:no_items, commerce:too_many_items, commerce:bad_item,
--   commerce:bad_quantity,
--   commerce:contact_not_in_account, commerce:conversation_not_in_account,
--   commerce:product_not_found, commerce:product_inactive:<name>,
--   commerce:insufficient_stock:<name>
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_order(
  p_account_id      uuid,
  p_contact_id      uuid,
  p_conversation_id uuid,
  p_items           jsonb,
  p_source          text,
  p_created_by      uuid,
  p_customer_note   text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id    uuid;
  v_currency    text;
  v_prefix      text;
  v_number      integer;
  v_subtotal    numeric(14, 2);
  v_product_ids uuid[];
  v_quantities  integer[];
  v_bad_name    text;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'commerce:no_items';
  END IF;
  IF jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'commerce:too_many_items';
  END IF;

  -- Cross-tenant guards: referenced rows must belong to this account.
  IF p_contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM contacts c WHERE c.id = p_contact_id AND c.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'commerce:contact_not_in_account';
  END IF;
  IF p_conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversations cv WHERE cv.id = p_conversation_id AND cv.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'commerce:conversation_not_in_account';
  END IF;

  -- Normalise the requested lines (merge duplicate product_ids) into two
  -- parallel arrays; each query below unnests them as `r`. Arrays, not a
  -- temp table: no pg_temp lookups inside a SECURITY DEFINER function.
  BEGIN
    SELECT array_agg(s.pid ORDER BY s.pid), array_agg(s.qty::integer ORDER BY s.pid)
      INTO v_product_ids, v_quantities
      FROM (
        SELECT (e->>'product_id')::uuid AS pid, SUM((e->>'quantity')::integer) AS qty
          FROM jsonb_array_elements(p_items) AS e
         GROUP BY 1
      ) s;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    -- product_id not a uuid, or quantity not an integer
    RAISE EXCEPTION 'commerce:bad_item';
  END;

  IF EXISTS (
    SELECT 1 FROM unnest(v_quantities) AS q(quantity)
     WHERE q.quantity IS NULL OR q.quantity <= 0 OR q.quantity > 1000
  ) THEN
    RAISE EXCEPTION 'commerce:bad_quantity';
  END IF;

  -- Lock this account's requested product rows so a concurrent price
  -- edit can't land between the checks and the snapshot below.
  PERFORM 1 FROM products p
   WHERE p.account_id = p_account_id AND p.id = ANY (v_product_ids)
   FOR UPDATE;

  -- Every product must exist in this account, be active, and have stock.
  IF EXISTS (
    SELECT 1 FROM unnest(v_product_ids) AS r(product_id)
      LEFT JOIN products p ON p.id = r.product_id AND p.account_id = p_account_id
     WHERE p.id IS NULL
  ) THEN
    RAISE EXCEPTION 'commerce:product_not_found';
  END IF;

  SELECT p.name INTO v_bad_name
    FROM products p
   WHERE p.account_id = p_account_id AND p.id = ANY (v_product_ids) AND NOT p.is_active
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'commerce:product_inactive:%', v_bad_name;
  END IF;

  SELECT p.name INTO v_bad_name
    FROM unnest(v_product_ids, v_quantities) AS r(product_id, quantity)
    JOIN products p ON p.id = r.product_id AND p.account_id = p_account_id
   WHERE p.stock_quantity IS NOT NULL AND p.stock_quantity < r.quantity
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'commerce:insufficient_stock:%', v_bad_name;
  END IF;

  SELECT a.default_currency INTO v_currency FROM accounts a WHERE a.id = p_account_id;

  -- Allocate the order number under the settings row lock.
  INSERT INTO commerce_settings (account_id) VALUES (p_account_id)
    ON CONFLICT (account_id) DO NOTHING;
  UPDATE commerce_settings cs
     SET next_order_number = cs.next_order_number + 1
   WHERE cs.account_id = p_account_id
  RETURNING cs.order_number_prefix, cs.next_order_number - 1
       INTO v_prefix, v_number;

  SELECT SUM(p.price * r.quantity)
    INTO v_subtotal
    FROM unnest(v_product_ids, v_quantities) AS r(product_id, quantity)
    JOIN products p ON p.id = r.product_id AND p.account_id = p_account_id;

  INSERT INTO orders (
    account_id, order_number, contact_id, conversation_id, status,
    source, currency, subtotal, total, customer_note, created_by
  )
  VALUES (
    p_account_id, v_prefix || lpad(v_number::text, 4, '0'), p_contact_id,
    p_conversation_id, 'pending_payment', COALESCE(p_source, 'agent'),
    v_currency, v_subtotal, v_subtotal, p_customer_note, p_created_by
  )
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (
    order_id, account_id, product_id, product_name, unit_price, quantity, line_total
  )
  SELECT v_order_id, p_account_id, p.id, p.name, p.price, r.quantity, p.price * r.quantity
    FROM unnest(v_product_ids, v_quantities) AS r(product_id, quantity)
    JOIN products p ON p.id = r.product_id AND p.account_id = p_account_id;

  RETURN v_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_order(uuid, uuid, uuid, jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order(uuid, uuid, uuid, jsonb, text, uuid, text) TO service_role;

-- ============================================================
-- mark_order_paid — an agent confirms the bank transfer arrived.
--
-- Only from pending_payment / payment_submitted. Decrements tracked
-- stock in the same transaction. Stock is clamped at 0 rather than
-- failing: the money has already moved, so refusing the confirmation
-- would only hide the oversell — the owner sees stock hit 0 instead.
-- Raises commerce:order_not_found / commerce:order_not_payable:<status>.
-- ============================================================
CREATE OR REPLACE FUNCTION public.mark_order_paid(
  p_account_id uuid,
  p_order_id   uuid,
  p_user_id    uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT o.status INTO v_status
    FROM orders o
   WHERE o.id = p_order_id AND o.account_id = p_account_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce:order_not_found';
  END IF;
  IF v_status NOT IN ('pending_payment', 'payment_submitted') THEN
    RAISE EXCEPTION 'commerce:order_not_payable:%', v_status;
  END IF;

  UPDATE products p
     SET stock_quantity = GREATEST(p.stock_quantity - oi.quantity, 0)
    FROM order_items oi
   WHERE oi.order_id = p_order_id
     AND oi.product_id = p.id
     AND p.account_id = p_account_id
     AND p.stock_quantity IS NOT NULL;

  UPDATE orders o
     SET status = 'paid',
         paid_at = now(),
         paid_confirmed_by = p_user_id
   WHERE o.id = p_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_order_paid(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_paid(uuid, uuid, uuid) TO service_role;
