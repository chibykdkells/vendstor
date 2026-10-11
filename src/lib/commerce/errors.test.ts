import { describe, expect, it } from 'vitest';
import { describeCommerceError, parseCommerceError } from './errors';

describe('parseCommerceError', () => {
  it('parses a bare code', () => {
    expect(parseCommerceError('commerce:no_items')).toEqual({
      code: 'no_items',
      detail: null,
    });
  });

  it('parses a code with a detail, keeping colons in the detail', () => {
    expect(
      parseCommerceError('commerce:insufficient_stock:Shoe: Size 42')
    ).toEqual({ code: 'insufficient_stock', detail: 'Shoe: Size 42' });
  });

  it('finds the code inside a wrapped PostgREST message', () => {
    expect(
      parseCommerceError('ERROR: commerce:order_not_payable:paid')
    ).toEqual({ code: 'order_not_payable', detail: 'paid' });
  });

  it('returns null for unknown codes and unrelated errors', () => {
    expect(parseCommerceError('commerce:made_up')).toBeNull();
    expect(parseCommerceError('duplicate key value')).toBeNull();
    expect(parseCommerceError('')).toBeNull();
    expect(parseCommerceError(undefined)).toBeNull();
  });
});

describe('describeCommerceError', () => {
  it('names the product when stock is short', () => {
    expect(
      describeCommerceError({ code: 'insufficient_stock', detail: 'Bag' })
    ).toContain('Bag');
  });

  it('falls back to generic wording without a detail', () => {
    expect(
      describeCommerceError({ code: 'product_inactive', detail: null })
    ).toContain('One of the items');
  });
});
