import { describe, expect, it } from 'vitest';
import {
  buildBankDetailsText,
  buildInvoiceText,
  hasBankDetails,
} from './messages';
import type { CommerceSettings, Order } from './types';

const order: Order = {
  id: 'o1',
  order_number: 'INV-0001',
  status: 'pending_payment',
  currency: 'NGN',
  subtotal: '16500.50',
  total: '16500.50',
  contact_id: 'c1',
  conversation_id: 'cv1',
  created_at: '2026-10-11T00:00:00Z',
  items: [
    {
      product_id: 'p1',
      product_name: 'Ankara Shoes',
      unit_price: '5000.00',
      quantity: 3,
      line_total: '15000.00',
    },
    {
      product_id: 'p2',
      product_name: 'Leather Bag',
      unit_price: '1500.50',
      quantity: 1,
      line_total: '1500.50',
    },
  ],
};

const settings: CommerceSettings = {
  bank_name: 'GTBank',
  bank_account_name: 'Ada Stores Ltd',
  bank_account_number: '0123456789',
  payment_instructions: null,
};

describe('buildInvoiceText', () => {
  it('lists every line and the total from the stored amounts', () => {
    const text = buildInvoiceText(order, 'Ada Stores');
    expect(text).toContain('*Invoice INV-0001*');
    expect(text).toContain('Ada Stores');
    expect(text).toContain('3 × Ankara Shoes');
    expect(text).toContain('15,000');
    expect(text).toContain('1 × Leather Bag');
    expect(text).toMatch(/\*Total: .*16,500\.50\*/);
  });
});

describe('buildBankDetailsText', () => {
  it('includes the exact account number, amount and order reference', () => {
    const text = buildBankDetailsText(settings, order)!;
    expect(text).toContain('Account number: 0123456789');
    expect(text).toContain('Bank: GTBank');
    expect(text).toContain('Account name: Ada Stores Ltd');
    expect(text).toContain('Reference: INV-0001');
    expect(text).toContain('16,500.50');
    expect(text).toContain('screenshot');
  });

  it('appends the business payment instructions when set', () => {
    const text = buildBankDetailsText(
      { ...settings, payment_instructions: 'Use your name as narration.' },
      order
    )!;
    expect(text).toContain('Use your name as narration.');
  });

  it('returns null when bank details are incomplete', () => {
    expect(buildBankDetailsText(null, order)).toBeNull();
    expect(
      buildBankDetailsText({ ...settings, bank_account_number: '  ' }, order)
    ).toBeNull();
    expect(hasBankDetails({ ...settings, bank_name: null })).toBe(false);
    expect(hasBankDetails(settings)).toBe(true);
  });
});
