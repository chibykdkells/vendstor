import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  searchProducts: vi.fn(),
  createOrder: vi.fn(),
  loadCommerceSettings: vi.fn(),
  listConversationOrders: vi.fn(),
}));
vi.mock('./store', () => h);

import { COMMERCE_TOOLS, createCommerceToolSession } from './ai-tools';

const db = {} as SupabaseClient;
const ctx = {
  db,
  accountId: 'acct-1',
  conversationId: 'cv1',
  contactId: 'c1',
  businessName: 'Ada Stores',
  currency: 'NGN',
};

const order = {
  id: 'o1',
  order_number: 'INV-0003',
  status: 'pending_payment',
  currency: 'NGN',
  subtotal: '10000.00',
  total: '10000.00',
  contact_id: 'c1',
  conversation_id: 'cv1',
  created_at: '2026-10-11T10:00:00Z',
  items: [
    {
      product_id: 'p1',
      product_name: 'Ankara Shoes',
      unit_price: '5000.00',
      quantity: 2,
      line_total: '10000.00',
    },
  ],
};

const bank = {
  bank_name: 'GTBank',
  bank_account_name: 'Ada Stores Ltd',
  bank_account_number: '0123456789',
  payment_instructions: null,
};

const call = (name: string, input: Record<string, unknown> = {}) => ({
  id: 't1',
  name,
  input,
});
const parse = (content: string) => JSON.parse(content);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('COMMERCE_TOOLS', () => {
  it('declares the three shop tools with object schemas', () => {
    expect(COMMERCE_TOOLS.map((t) => t.name)).toEqual([
      'search_products',
      'create_order',
      'get_order_status',
    ]);
    for (const t of COMMERCE_TOOLS) {
      expect(t.parameters.type).toBe('object');
    }
  });
});

describe('search_products', () => {
  it('returns ids, formatted prices and availability words', async () => {
    h.searchProducts.mockResolvedValue([
      {
        id: 'p1',
        name: 'Ankara Shoes',
        description: 'Handmade',
        sku: null,
        price: '5000.00',
        stock_quantity: 2,
        image_url: null,
        is_active: true,
      },
      {
        id: 'p2',
        name: 'Bag',
        description: null,
        sku: null,
        price: '1500.50',
        stock_quantity: null,
        image_url: null,
        is_active: true,
      },
      {
        id: 'p3',
        name: 'Cap',
        description: null,
        sku: null,
        price: '800',
        stock_quantity: 0,
        image_url: null,
        is_active: true,
      },
    ]);
    const session = createCommerceToolSession(ctx);
    const out = await session.execute(
      call('search_products', { query: 'shoes' })
    );
    expect(h.searchProducts).toHaveBeenCalledWith(db, 'acct-1', 'shoes', 8);
    const { products } = parse(out.content);
    expect(products[0]).toMatchObject({
      id: 'p1',
      availability: 'only 2 left',
      description: 'Handmade',
    });
    expect(products[0].price).toContain('5,000');
    expect(products[1]).toMatchObject({ availability: 'available' });
    expect(products[1].price).toContain('1,500.50');
    expect(products[2]).toMatchObject({ availability: 'out of stock' });
    expect(products[1]).not.toHaveProperty('description');
  });

  it('tells the model not to invent products when nothing matches', async () => {
    h.searchProducts.mockResolvedValue([]);
    const out = await createCommerceToolSession(ctx).execute(
      call('search_products', { query: 'laptop' })
    );
    expect(parse(out.content).note).toMatch(/not in the catalog/);
  });
});

describe('create_order', () => {
  it('creates an AI order and queues the invoice then bank details', async () => {
    h.createOrder.mockResolvedValue({ ok: true, value: order });
    h.loadCommerceSettings.mockResolvedValue(bank);
    const session = createCommerceToolSession(ctx);
    const out = await session.execute(
      call('create_order', {
        items: [{ product_id: 'p1', quantity: 2 }],
        note: ' deliver to Yaba ',
      })
    );

    expect(out.isError).toBeUndefined();
    expect(h.createOrder).toHaveBeenCalledWith(db, {
      accountId: 'acct-1',
      contactId: 'c1',
      conversationId: 'cv1',
      items: [{ product_id: 'p1', quantity: 2 }],
      source: 'ai',
      customerNote: 'deliver to Yaba',
    });
    const result = parse(out.content);
    expect(result.order_number).toBe('INV-0003');
    expect(result.next_step).toMatch(/Don't repeat them/);
    expect(session.outbox).toHaveLength(2);
    expect(session.outbox[0]).toContain('*Invoice INV-0003*');
    expect(session.outbox[1]).toContain('Account number: 0123456789');
    expect(session.needsHuman).toBe(false);
  });

  it('flags a human when bank details are missing', async () => {
    h.createOrder.mockResolvedValue({ ok: true, value: order });
    h.loadCommerceSettings.mockResolvedValue(null);
    const session = createCommerceToolSession(ctx);
    const out = await session.execute(
      call('create_order', { items: [{ product_id: 'p1', quantity: 1 }] })
    );
    expect(session.outbox).toHaveLength(1);
    expect(session.needsHuman).toBe(true);
    expect(parse(out.content).next_step).toMatch(/team member/);
  });

  it('allows only one order per reply', async () => {
    h.createOrder.mockResolvedValue({ ok: true, value: order });
    h.loadCommerceSettings.mockResolvedValue(bank);
    const session = createCommerceToolSession(ctx);
    const items = { items: [{ product_id: 'p1', quantity: 1 }] };
    await session.execute(call('create_order', items));
    const second = await session.execute(call('create_order', items));
    expect(second.isError).toBe(true);
    expect(h.createOrder).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{}, /non-empty list/],
    [{ items: [] }, /non-empty list/],
    [{ items: [{ quantity: 1 }] }, /product_id/],
    [{ items: [{ product_id: 'p1', quantity: 0 }] }, /whole number/],
    [{ items: [{ product_id: 'p1', quantity: 1.5 }] }, /whole number/],
    [{ items: [{ product_id: 'p1', quantity: '2' }] }, /whole number/],
  ])(
    'rejects malformed items %j before touching the DB',
    async (input, msg) => {
      const out = await createCommerceToolSession(ctx).execute(
        call('create_order', input)
      );
      expect(out.isError).toBe(true);
      expect(parse(out.content).error).toMatch(msg);
      expect(h.createOrder).not.toHaveBeenCalled();
    }
  );

  it('relays business-rule failures in plain words', async () => {
    h.createOrder.mockResolvedValue({
      ok: false,
      error: { code: 'insufficient_stock', detail: 'Ankara Shoes' },
    });
    const session = createCommerceToolSession(ctx);
    const out = await session.execute(
      call('create_order', { items: [{ product_id: 'p1', quantity: 9 }] })
    );
    expect(out.isError).toBe(true);
    expect(parse(out.content).error).toMatch(
      /Not enough stock of Ankara Shoes/
    );
    expect(session.outbox).toHaveLength(0);
  });
});

describe('get_order_status', () => {
  it('describes statuses in plain words', async () => {
    h.listConversationOrders.mockResolvedValue([
      { ...order, status: 'payment_submitted' },
    ]);
    const out = await createCommerceToolSession(ctx).execute(
      call('get_order_status')
    );
    expect(parse(out.content).orders[0]).toMatchObject({
      order_number: 'INV-0003',
      status: expect.stringMatching(/receipt received/),
    });
  });
});

describe('execute', () => {
  it('reports malformed JSON arguments and unknown tools as errors', async () => {
    const session = createCommerceToolSession(ctx);
    const bad = await session.execute(
      call('create_order', { __invalid_json: '{oops' })
    );
    expect(bad.isError).toBe(true);
    const unknown = await session.execute(call('delete_everything'));
    expect(parse(unknown.content).error).toMatch(/Unknown tool/);
  });
});
