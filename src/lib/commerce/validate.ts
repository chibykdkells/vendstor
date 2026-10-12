// ============================================================
// Input validation for the owner-facing commerce API (products,
// payment settings, order actions). Pure functions — the routes in
// src/app/api/commerce call these and map `{ ok: false }` to a 400.
// Error values are message *keys* under the `Api.commerce` namespace so
// the route can translate them.
// ============================================================

import type { OrderStatus } from './types';

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_PRICE = 1_000_000_000_000; // numeric(14,2) headroom
const MAX_STOCK = 1_000_000_000;

export interface ProductInput {
  name: string;
  description: string | null;
  sku: string | null;
  price: number;
  stock_quantity: number | null;
  is_active: boolean;
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function parsePrice(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n < 0 || n > MAX_PRICE) return null;
  // At most two decimal places (kobo/cents).
  if (Math.round(n * 100) / 100 !== n) return null;
  return n;
}

/** Blank / null → not tracked; otherwise a whole number ≥ 0. */
function parseStock(value: unknown): number | null | 'invalid' {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_STOCK) {
    return 'invalid';
  }
  return n;
}

/**
 * Validate a product body. `partial` (PATCH) accepts any subset of
 * fields; a full create requires name + price.
 */
export function validateProductInput(
  body: unknown,
  opts: { partial: boolean }
): Validated<Partial<ProductInput>> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalidBody' };
  }
  const b = body as Record<string, unknown>;
  const out: Partial<ProductInput> = {};

  if (b.name !== undefined || !opts.partial) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return { ok: false, error: 'nameRequired' };
    out.name = name.slice(0, 200);
  }

  if (b.price !== undefined || !opts.partial) {
    const price = parsePrice(b.price);
    if (price === null) return { ok: false, error: 'invalidPrice' };
    out.price = price;
  }

  if (b.stock_quantity !== undefined) {
    const stock = parseStock(b.stock_quantity);
    if (stock === 'invalid') return { ok: false, error: 'invalidStock' };
    out.stock_quantity = stock;
  } else if (!opts.partial) {
    out.stock_quantity = null;
  }

  const description = optionalText(b.description, 2000);
  if (description !== undefined) out.description = description;
  const sku = optionalText(b.sku, 64);
  if (sku !== undefined) out.sku = sku;

  if (b.is_active !== undefined) {
    if (typeof b.is_active !== 'boolean') return { ok: false, error: 'invalidBody' };
    out.is_active = b.is_active;
  }

  if (opts.partial && Object.keys(out).length === 0) {
    return { ok: false, error: 'nothingToUpdate' };
  }
  return { ok: true, value: out };
}

export interface PaymentSettingsInput {
  bank_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  payment_instructions: string | null;
  order_number_prefix: string;
}

export function validatePaymentSettings(
  body: unknown
): Validated<PaymentSettingsInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalidBody' };
  }
  const b = body as Record<string, unknown>;
  const accountNumber = optionalText(b.bank_account_number, 34) ?? null;
  if (accountNumber && !/^[A-Za-z0-9 -]+$/.test(accountNumber)) {
    return { ok: false, error: 'invalidAccountNumber' };
  }
  const prefix =
    typeof b.order_number_prefix === 'string'
      ? b.order_number_prefix.trim()
      : 'INV-';
  if (!/^[A-Za-z0-9-]{0,12}$/.test(prefix)) {
    return { ok: false, error: 'invalidPrefix' };
  }
  return {
    ok: true,
    value: {
      bank_name: optionalText(b.bank_name, 100) ?? null,
      bank_account_name: optionalText(b.bank_account_name, 150) ?? null,
      bank_account_number: accountNumber,
      payment_instructions: optionalText(b.payment_instructions, 500) ?? null,
      order_number_prefix: prefix,
    },
  };
}

export type OrderAction = 'mark_paid' | 'fulfill' | 'cancel';

export function isOrderAction(value: unknown): value is OrderAction {
  return value === 'mark_paid' || value === 'fulfill' || value === 'cancel';
}

/**
 * Statuses an order may be in for each simple status action (mark_paid
 * goes through the `mark_order_paid` RPC, which enforces its own). A
 * paid order can't be cancelled here: that would need a refund and a
 * stock restore, which the pilot handles by hand.
 */
export const ACTION_FROM_STATUSES: Record<
  Exclude<OrderAction, 'mark_paid'>,
  { from: OrderStatus[]; to: OrderStatus }
> = {
  fulfill: { from: ['paid'], to: 'fulfilled' },
  cancel: { from: ['pending_payment', 'payment_submitted'], to: 'cancelled' },
};
