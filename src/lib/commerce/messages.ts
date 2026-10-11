// ============================================================
// Customer-facing commerce messages (WhatsApp formatting: *bold*).
//
// Built from DB rows, never from LLM output: the invoice lines, totals
// and bank account number must be exactly what's stored, so the AI
// decides *when* to send them but doesn't write them.
// ============================================================

import { formatPrice } from '@/lib/currency';
import type { CommerceSettings, Order } from './types';

export function buildInvoiceText(order: Order, businessName: string): string {
  const lines = order.items.map(
    (item) =>
      `${item.quantity} × ${item.product_name} — ${formatPrice(
        Number(item.line_total),
        order.currency
      )}`
  );
  return [
    `*Invoice ${order.order_number}*`,
    businessName,
    '',
    ...lines,
    '',
    `*Total: ${formatPrice(Number(order.total), order.currency)}*`,
  ].join('\n');
}

/** True when there's enough to tell a customer where to transfer. */
export function hasBankDetails(settings: CommerceSettings | null): boolean {
  return Boolean(
    settings?.bank_name?.trim() &&
    settings.bank_account_name?.trim() &&
    settings.bank_account_number?.trim()
  );
}

/**
 * Bank-transfer instructions for one order, or null when the business
 * hasn't filled in its bank details (the caller should hand off to a
 * human rather than send an incomplete message).
 */
export function buildBankDetailsText(
  settings: CommerceSettings | null,
  order: Pick<Order, 'order_number' | 'total' | 'currency'>
): string | null {
  if (!settings || !hasBankDetails(settings)) return null;
  const parts = [
    `To pay, please transfer *${formatPrice(Number(order.total), order.currency)}* to:`,
    '',
    `Bank: ${settings.bank_name!.trim()}`,
    `Account name: ${settings.bank_account_name!.trim()}`,
    `Account number: ${settings.bank_account_number!.trim()}`,
    `Reference: ${order.order_number}`,
  ];
  const extra = settings.payment_instructions?.trim();
  if (extra) parts.push('', extra);
  parts.push('', 'Once done, send a screenshot of your receipt here.');
  return parts.join('\n');
}

type OrderSummary = Pick<Order, 'order_number' | 'total' | 'currency'>;

/** Sent to the customer when their receipt is attached to an order. */
export function buildPaymentReceivedText(order: OrderSummary): string {
  return (
    `Thank you! We've received your payment receipt for order ` +
    `${order.order_number}. We'll confirm it shortly.`
  );
}

/** Internal contact note telling an agent to check the bank. */
export function buildPaymentProofNote(order: OrderSummary): string {
  return (
    `💳 Payment receipt received for ${order.order_number} ` +
    `(${formatPrice(Number(order.total), order.currency)}). ` +
    `Check the bank account, then mark the order paid.`
  );
}
