// ============================================================
// Commerce RPC errors. `create_order` / `mark_order_paid` raise
// 'commerce:<code>[:detail]' (see migration 047) so callers can branch
// on a stable code instead of parsing prose. Anything else is an
// unexpected failure and should be logged, not shown to a customer.
// ============================================================

export type CommerceErrorCode =
  | 'no_items'
  | 'too_many_items'
  | 'bad_item'
  | 'bad_quantity'
  | 'contact_not_in_account'
  | 'conversation_not_in_account'
  | 'product_not_found'
  | 'product_inactive'
  | 'insufficient_stock'
  | 'order_not_found'
  | 'order_not_payable';

const KNOWN_CODES = new Set<string>([
  'no_items',
  'too_many_items',
  'bad_item',
  'bad_quantity',
  'contact_not_in_account',
  'conversation_not_in_account',
  'product_not_found',
  'product_inactive',
  'insufficient_stock',
  'order_not_found',
  'order_not_payable',
]);

export interface CommerceError {
  code: CommerceErrorCode;
  /** Product name or order status, when the code carries one. */
  detail: string | null;
}

/**
 * Parse a Postgres/PostgREST error message into a commerce error, or
 * null when it isn't one of ours. The detail may itself contain ':'
 * (product names can), so only the first two separators split.
 */
export function parseCommerceError(
  message: string | null | undefined
): CommerceError | null {
  if (!message) return null;
  const match = /commerce:([a-z_]+)(?::([\s\S]*))?/.exec(message);
  if (!match || !KNOWN_CODES.has(match[1])) return null;
  return {
    code: match[1] as CommerceErrorCode,
    detail: match[2]?.trim() || null,
  };
}

/**
 * Plain-English explanation of a commerce error, written for the AI to
 * relay (it rewrites in the customer's language and tone). Never
 * mentions internal ids or codes.
 */
export function describeCommerceError(err: CommerceError): string {
  switch (err.code) {
    case 'insufficient_stock':
      return `Not enough stock of ${err.detail ?? 'one of the items'} for that quantity.`;
    case 'product_inactive':
      return `${err.detail ?? 'One of the items'} is no longer available.`;
    case 'product_not_found':
      return 'One of the items is not in the catalog. Search the catalog again and use an id from the results.';
    case 'bad_item':
    case 'bad_quantity':
      return 'Each item needs a catalog product id and a whole-number quantity between 1 and 1000.';
    case 'no_items':
      return 'The order has no items.';
    case 'too_many_items':
      return 'Too many different items in one order (max 50).';
    case 'order_not_found':
      return 'That order was not found.';
    case 'order_not_payable':
      return `That order can't be marked paid (status: ${err.detail ?? 'unknown'}).`;
    case 'contact_not_in_account':
    case 'conversation_not_in_account':
      return 'This chat cannot place orders for this business.';
  }
}
