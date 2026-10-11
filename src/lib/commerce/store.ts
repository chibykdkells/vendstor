// ============================================================
// Commerce data access. Every function takes the Supabase client and
// the tenancy key explicitly (like src/lib/ai/knowledge.ts) so the AI
// path can pass the service-role client and tests can pass a fake.
// Every query filters by account_id — the service role bypasses RLS.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_CURRENCY } from '@/lib/currency';
import { parseCommerceError, type CommerceError } from './errors';
import type {
  CommerceSettings,
  Order,
  OrderLineRequest,
  OrderSource,
  Product,
} from './types';

export const PRODUCT_COLUMNS =
  'id, name, description, sku, price, stock_quantity, image_url, is_active';

const ORDER_COLUMNS =
  'id, order_number, status, currency, subtotal, total, contact_id, ' +
  'conversation_id, created_at, ' +
  'items:order_items(product_id, product_name, unit_price, quantity, line_total)';

const MAX_SEARCH_TERM = 60;

/**
 * Reduce free text (from a customer, via the AI) to a safe search term.
 * PostgREST's `or()` filter syntax treats `,` `.` `:` `(` `)` as
 * structure and `%` `_` `*` as wildcards, so keep only letters,
 * combining marks (Yoruba/Igbo tone marks: "Ọ̀"), numbers, spaces and
 * hyphens.
 */
export function sanitizeSearchTerm(input: string | null | undefined): string {
  return (input ?? '')
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEARCH_TERM)
    .trim();
}

/**
 * Active products matching `query` on name, description or SKU. An
 * empty query lists the catalog (alphabetical), capped at `limit`.
 */
export async function searchProducts(
  db: SupabaseClient,
  accountId: string,
  query: string,
  limit = 10
): Promise<Product[]> {
  let req = db
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('account_id', accountId)
    .eq('is_active', true);
  const term = sanitizeSearchTerm(query);
  if (term) {
    req = req.or(
      `name.ilike.%${term}%,description.ilike.%${term}%,sku.ilike.%${term}%`
    );
  }
  const { data, error } = await req.order('name').limit(limit);
  if (error) throw new Error(`searchProducts failed: ${error.message}`);
  return (data ?? []) as Product[];
}

export async function loadOrder(
  db: SupabaseClient,
  accountId: string,
  orderId: string
): Promise<Order | null> {
  const { data, error } = await db
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('id', orderId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`loadOrder failed: ${error.message}`);
  if (!data) return null;
  const order = data as unknown as Order;
  return {
    ...order,
    items: [...(order.items ?? [])].sort((a, b) =>
      a.product_name.localeCompare(b.product_name)
    ),
  };
}

export type CommerceResult<T> =
  { ok: true; value: T } | { ok: false; error: CommerceError };

export interface CreateOrderArgs {
  accountId: string;
  contactId: string | null;
  conversationId: string | null;
  items: OrderLineRequest[];
  source: OrderSource;
  /** The acting user; null for AI-created orders. */
  createdBy?: string | null;
  customerNote?: string | null;
}

/**
 * Create an order through the `create_order` RPC (prices come from the
 * catalog, never from the caller) and return it with its items.
 * Business-rule failures (stock, inactive product, …) come back as
 * `{ ok: false }`; anything else throws.
 */
export async function createOrder(
  db: SupabaseClient,
  args: CreateOrderArgs
): Promise<CommerceResult<Order>> {
  const { data, error } = await db.rpc('create_order', {
    p_account_id: args.accountId,
    p_contact_id: args.contactId,
    p_conversation_id: args.conversationId,
    p_items: args.items,
    p_source: args.source,
    p_created_by: args.createdBy ?? null,
    p_customer_note: args.customerNote ?? null,
  });
  if (error) {
    const parsed = parseCommerceError(error.message);
    if (parsed) return { ok: false, error: parsed };
    throw new Error(`create_order failed: ${error.message}`);
  }
  const order = await loadOrder(db, args.accountId, data as string);
  if (!order) throw new Error('create_order returned an id that was not found');
  return { ok: true, value: order };
}

/** An agent confirms the bank transfer arrived (decrements stock). */
export async function markOrderPaid(
  db: SupabaseClient,
  accountId: string,
  orderId: string,
  userId: string
): Promise<CommerceResult<null>> {
  const { error } = await db.rpc('mark_order_paid', {
    p_account_id: accountId,
    p_order_id: orderId,
    p_user_id: userId,
  });
  if (error) {
    const parsed = parseCommerceError(error.message);
    if (parsed) return { ok: false, error: parsed };
    throw new Error(`mark_order_paid failed: ${error.message}`);
  }
  return { ok: true, value: null };
}

/** Most recent order in this conversation still awaiting payment. */
export async function findOpenOrderForConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<Order | null> {
  const { data, error } = await db
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('account_id', accountId)
    .eq('conversation_id', conversationId)
    .in('status', ['pending_payment', 'payment_submitted'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`findOpenOrderForConversation failed: ${error.message}`);
  }
  return (data as unknown as Order | null) ?? null;
}

/**
 * Attach the customer's receipt message to an open order and move it
 * to `payment_submitted` so an agent knows to check the bank. Returns
 * false when the order isn't open (already paid, cancelled, …).
 */
export async function recordPaymentProof(
  db: SupabaseClient,
  accountId: string,
  orderId: string,
  messageId: string
): Promise<boolean> {
  const { data, error } = await db
    .from('orders')
    .update({
      status: 'payment_submitted',
      payment_proof_message_id: messageId,
    })
    .eq('id', orderId)
    .eq('account_id', accountId)
    .in('status', ['pending_payment', 'payment_submitted'])
    .select('id');
  if (error) throw new Error(`recordPaymentProof failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/** This conversation's most recent orders, newest first. */
export async function listConversationOrders(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  limit = 3
): Promise<Order[]> {
  const { data, error } = await db
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('account_id', accountId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listConversationOrders failed: ${error.message}`);
  return (data ?? []) as unknown as Order[];
}

/** Whether the account sells anything — gates the AI's shop tools. */
export async function accountHasCatalog(
  db: SupabaseClient,
  accountId: string
): Promise<boolean> {
  const { count, error } = await db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('is_active', true);
  if (error) throw new Error(`accountHasCatalog failed: ${error.message}`);
  return (count ?? 0) > 0;
}

export interface ShopContext {
  businessName: string;
  currency: string;
}

/**
 * What the AI needs to sell for this account, or null when it has no
 * active catalog (the bot then replies exactly as before, without tools).
 */
export async function loadShopContext(
  db: SupabaseClient,
  accountId: string
): Promise<ShopContext | null> {
  if (!(await accountHasCatalog(db, accountId))) return null;
  const { data, error } = await db
    .from('accounts')
    .select('name, default_currency')
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw new Error(`loadShopContext failed: ${error.message}`);
  return {
    businessName: (data?.name as string | undefined) ?? '',
    currency:
      (data?.default_currency as string | undefined) ?? DEFAULT_CURRENCY,
  };
}

export async function loadCommerceSettings(
  db: SupabaseClient,
  accountId: string
): Promise<CommerceSettings | null> {
  const { data, error } = await db
    .from('commerce_settings')
    .select(
      'bank_name, bank_account_name, bank_account_number, payment_instructions'
    )
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`loadCommerceSettings failed: ${error.message}`);
  return (data as CommerceSettings | null) ?? null;
}
