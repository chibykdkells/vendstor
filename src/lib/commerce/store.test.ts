import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createOrder,
  markOrderPaid,
  recordPaymentProof,
  sanitizeSearchTerm,
  searchProducts,
} from './store';

type Call = [method: string, ...args: unknown[]];
type Result = { data: unknown; error: { message: string } | null };

/**
 * Recording fake for the query builder: every chained call is logged
 * per table, and awaiting the chain resolves to the queued result for
 * that table (or rpc name).
 */
function makeDb(results: Record<string, Result[]>) {
  const calls: Record<string, Call[]> = {};
  const next = (key: string): Result =>
    results[key]?.shift() ?? { data: null, error: null };

  const builder = (key: string) => {
    calls[key] ??= [];
    const chain: Record<string, unknown> = {};
    for (const m of [
      'select',
      'eq',
      'in',
      'or',
      'order',
      'limit',
      'update',
      'maybeSingle',
    ]) {
      chain[m] = (...args: unknown[]) => {
        calls[key].push([m, ...args]);
        return chain;
      };
    }
    chain.then = (resolve: (r: Result) => unknown) => resolve(next(key));
    return chain;
  };

  const db = {
    from: (table: string) => builder(table),
    rpc: (name: string, params: unknown) => {
      calls[`rpc:${name}`] = [['rpc', params]];
      return Promise.resolve(next(`rpc:${name}`));
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe('sanitizeSearchTerm', () => {
  it('strips PostgREST filter syntax and wildcards', () => {
    expect(sanitizeSearchTerm('shoe,name.eq.x)(%_*')).toBe('shoe name eq x');
  });

  it('keeps non-Latin letters, digits and hyphens', () => {
    expect(sanitizeSearchTerm('  Ọ̀já  T-shirt 42 ')).toBe('Ọ̀já T-shirt 42');
  });

  it('caps the length', () => {
    expect(sanitizeSearchTerm('a'.repeat(200)).length).toBe(60);
  });
});

describe('searchProducts', () => {
  it('scopes to the account and active products, with a sanitized term', async () => {
    const { db, calls } = makeDb({ products: [{ data: [], error: null }] });
    await searchProducts(db, 'acct-1', 'red, shoes');
    expect(calls.products).toContainEqual(['eq', 'account_id', 'acct-1']);
    expect(calls.products).toContainEqual(['eq', 'is_active', true]);
    expect(calls.products).toContainEqual([
      'or',
      'name.ilike.%red shoes%,description.ilike.%red shoes%,sku.ilike.%red shoes%',
    ]);
  });

  it('lists the catalog without a filter for an empty query', async () => {
    const { db, calls } = makeDb({ products: [{ data: [], error: null }] });
    await searchProducts(db, 'acct-1', '  ');
    expect(calls.products.some(([m]) => m === 'or')).toBe(false);
  });
});

describe('createOrder', () => {
  const args = {
    accountId: 'acct-1',
    contactId: 'c1',
    conversationId: 'cv1',
    items: [{ product_id: 'p1', quantity: 2 }],
    source: 'ai' as const,
  };

  it('passes only ids + quantities to the RPC (prices come from the DB)', async () => {
    const { db, calls } = makeDb({
      'rpc:create_order': [{ data: 'o1', error: null }],
      orders: [
        {
          data: { id: 'o1', order_number: 'INV-0001', items: [] },
          error: null,
        },
      ],
    });
    const out = await createOrder(db, args);
    expect(out).toMatchObject({ ok: true, value: { id: 'o1' } });
    expect(calls['rpc:create_order'][0][1]).toEqual({
      p_account_id: 'acct-1',
      p_contact_id: 'c1',
      p_conversation_id: 'cv1',
      p_items: [{ product_id: 'p1', quantity: 2 }],
      p_source: 'ai',
      p_created_by: null,
      p_customer_note: null,
    });
    expect(calls.orders).toContainEqual(['eq', 'account_id', 'acct-1']);
  });

  it('returns business-rule failures as a typed error', async () => {
    const { db } = makeDb({
      'rpc:create_order': [
        {
          data: null,
          error: { message: 'commerce:insufficient_stock:Ankara Shoes' },
        },
      ],
    });
    expect(await createOrder(db, args)).toEqual({
      ok: false,
      error: { code: 'insufficient_stock', detail: 'Ankara Shoes' },
    });
  });

  it('throws on unexpected database errors', async () => {
    const { db } = makeDb({
      'rpc:create_order': [
        { data: null, error: { message: 'connection reset' } },
      ],
    });
    await expect(createOrder(db, args)).rejects.toThrow('connection reset');
  });
});

describe('markOrderPaid', () => {
  it('maps a double confirmation to order_not_payable', async () => {
    const { db } = makeDb({
      'rpc:mark_order_paid': [
        { data: null, error: { message: 'commerce:order_not_payable:paid' } },
      ],
    });
    expect(await markOrderPaid(db, 'acct-1', 'o1', 'u1')).toEqual({
      ok: false,
      error: { code: 'order_not_payable', detail: 'paid' },
    });
  });
});

describe('recordPaymentProof', () => {
  it('only updates an open order in this account', async () => {
    const { db, calls } = makeDb({
      orders: [{ data: [{ id: 'o1' }], error: null }],
    });
    expect(await recordPaymentProof(db, 'acct-1', 'o1', 'm1')).toBe(true);
    expect(calls.orders).toContainEqual(['eq', 'account_id', 'acct-1']);
    expect(calls.orders).toContainEqual([
      'in',
      'status',
      ['pending_payment', 'payment_submitted'],
    ]);
  });

  it('returns false when the order is no longer open', async () => {
    const { db } = makeDb({ orders: [{ data: [], error: null }] });
    expect(await recordPaymentProof(db, 'acct-1', 'o1', 'm1')).toBe(false);
  });
});
