import { describe, expect, it } from 'vitest';
import {
  isOrderAction,
  validatePaymentSettings,
  validateProductInput,
} from './validate';

describe('validateProductInput (create)', () => {
  const create = (body: unknown) =>
    validateProductInput(body, { partial: false });

  it('accepts a full product and normalises text', () => {
    expect(
      create({
        name: '  Ankara Shoes ',
        price: '15000.50',
        stock_quantity: '5',
        description: '  Handmade ',
        sku: '',
        is_active: true,
      })
    ).toEqual({
      ok: true,
      value: {
        name: 'Ankara Shoes',
        price: 15000.5,
        stock_quantity: 5,
        description: 'Handmade',
        sku: null,
        is_active: true,
      },
    });
  });

  it('treats blank stock as "not tracked"', () => {
    const out = create({ name: 'Bag', price: 100, stock_quantity: '' });
    expect(out).toMatchObject({ ok: true, value: { stock_quantity: null } });
    expect(create({ name: 'Bag', price: 100 })).toMatchObject({
      ok: true,
      value: { stock_quantity: null },
    });
  });

  it.each([
    [{ price: 100 }, 'nameRequired'],
    [{ name: '   ', price: 100 }, 'nameRequired'],
    [{ name: 'X' }, 'invalidPrice'],
    [{ name: 'X', price: -1 }, 'invalidPrice'],
    [{ name: 'X', price: 1.234 }, 'invalidPrice'],
    [{ name: 'X', price: 'abc' }, 'invalidPrice'],
    [{ name: 'X', price: 1, stock_quantity: -2 }, 'invalidStock'],
    [{ name: 'X', price: 1, stock_quantity: 1.5 }, 'invalidStock'],
    [{ name: 'X', price: 1, is_active: 'yes' }, 'invalidBody'],
    [null, 'invalidBody'],
    [[1], 'invalidBody'],
  ])('rejects %j with %s', (body, error) => {
    expect(create(body)).toEqual({ ok: false, error });
  });
});

describe('validateProductInput (partial)', () => {
  const patch = (body: unknown) =>
    validateProductInput(body, { partial: true });

  it('accepts a single field', () => {
    expect(patch({ is_active: false })).toEqual({
      ok: true,
      value: { is_active: false },
    });
    expect(patch({ stock_quantity: 0 })).toEqual({
      ok: true,
      value: { stock_quantity: 0 },
    });
  });

  it('rejects an empty update', () => {
    expect(patch({})).toEqual({ ok: false, error: 'nothingToUpdate' });
  });
});

describe('validatePaymentSettings', () => {
  it('normalises blanks to null and keeps the prefix', () => {
    expect(
      validatePaymentSettings({
        bank_name: ' GTBank ',
        bank_account_name: 'Ada Stores Ltd',
        bank_account_number: '0123456789',
        payment_instructions: '',
        order_number_prefix: 'ADA-',
      })
    ).toEqual({
      ok: true,
      value: {
        bank_name: 'GTBank',
        bank_account_name: 'Ada Stores Ltd',
        bank_account_number: '0123456789',
        payment_instructions: null,
        order_number_prefix: 'ADA-',
      },
    });
  });

  it('defaults the prefix to INV-', () => {
    expect(validatePaymentSettings({})).toMatchObject({
      ok: true,
      value: { order_number_prefix: 'INV-' },
    });
  });

  it('rejects odd account numbers and prefixes', () => {
    expect(
      validatePaymentSettings({ bank_account_number: '0123<script>' })
    ).toEqual({ ok: false, error: 'invalidAccountNumber' });
    expect(validatePaymentSettings({ order_number_prefix: 'TOO-LONG-PREFIX' })).toEqual({
      ok: false,
      error: 'invalidPrefix',
    });
    expect(validatePaymentSettings({ order_number_prefix: 'a b' })).toEqual({
      ok: false,
      error: 'invalidPrefix',
    });
  });
});

describe('isOrderAction', () => {
  it('accepts only known actions', () => {
    expect(isOrderAction('mark_paid')).toBe(true);
    expect(isOrderAction('fulfill')).toBe(true);
    expect(isOrderAction('cancel')).toBe(true);
    expect(isOrderAction('delete')).toBe(false);
  });
});
