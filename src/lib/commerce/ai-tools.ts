// ============================================================
// Shop tools for the AI auto-reply agent (src/lib/ai/agent).
//
// The model decides *what* to do; these tools decide *what's true*.
// Product facts and prices only ever come from `search_products`, an
// order's prices come from the catalog inside `create_order`, and the
// invoice + bank details are composed from DB rows and queued in an
// outbox that the caller sends after the AI's own reply — the model
// never writes an account number or a total itself.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ToolCall,
  ToolDefinition,
  ToolOutcome,
} from '@/lib/ai/agent/types';
import { formatPrice } from '@/lib/currency';
import { describeCommerceError } from './errors';
import { buildBankDetailsText, buildInvoiceText } from './messages';
import {
  createOrder,
  listConversationOrders,
  loadCommerceSettings,
  searchProducts,
} from './store';
import type { OrderLineRequest, OrderStatus, Product } from './types';

const MAX_ORDER_LINES = 20;
const MAX_QUANTITY = 1000;
const SEARCH_LIMIT = 8;
const LOW_STOCK = 5;

export const COMMERCE_TOOLS: ToolDefinition[] = [
  {
    name: 'search_products',
    description:
      "Search the business's product catalog by name, description or SKU. " +
      'Returns product ids, current prices and availability. Use it for every ' +
      'question about products, prices or stock, and to get the product_id ' +
      'needed for create_order. An empty query lists the catalog.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search words, e.g. "red shoes" or "bag". Empty string to browse.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_order',
    description:
      'Create an order once the customer has clearly confirmed exactly which ' +
      'products and quantities they want to buy. Prices are taken from the ' +
      'catalog automatically. After it succeeds, the invoice and bank transfer ' +
      'details are sent to the customer automatically right after your reply — ' +
      'do not repeat the account number or invoice lines yourself. Call at ' +
      'most once per reply.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_ORDER_LINES,
          items: {
            type: 'object',
            properties: {
              product_id: {
                type: 'string',
                description: 'The id from search_products.',
              },
              quantity: {
                type: 'integer',
                minimum: 1,
                maximum: MAX_QUANTITY,
              },
            },
            required: ['product_id', 'quantity'],
          },
        },
        note: {
          type: 'string',
          description:
            'Optional delivery or customization details the customer gave.',
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'get_order_status',
    description:
      "Look up this customer's recent orders in this chat: order number, " +
      'status and total. Use it when they ask about an order or a payment.',
    parameters: { type: 'object', properties: {} },
  },
];

export interface CommerceToolContext {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  contactId: string;
  businessName: string;
  /** accounts.default_currency — products carry no currency of their own. */
  currency: string;
}

export interface CommerceToolSession {
  execute(call: ToolCall): Promise<ToolOutcome>;
  /** Customer messages to send after the AI's reply, in order. */
  readonly outbox: string[];
  /** An order exists but a human must finish (no bank details set). */
  readonly needsHuman: boolean;
}

/** One session per inbound message: tracks the outbox and the
 *  one-order-per-reply limit. */
export function createCommerceToolSession(
  ctx: CommerceToolContext
): CommerceToolSession {
  const outbox: string[] = [];
  let needsHuman = false;
  let orderCreated = false;

  const ok = (value: unknown): ToolOutcome => ({
    content: JSON.stringify(value),
  });
  const fail = (message: string): ToolOutcome => ({
    content: JSON.stringify({ error: message }),
    isError: true,
  });

  async function searchTool(input: Record<string, unknown>) {
    const query = typeof input.query === 'string' ? input.query : '';
    const products = await searchProducts(
      ctx.db,
      ctx.accountId,
      query,
      SEARCH_LIMIT
    );
    if (products.length === 0) {
      return ok({
        products: [],
        note: 'No matching products. Do not offer anything that is not in the catalog; you may try a broader search.',
      });
    }
    return ok({
      products: products.map((p) => serializeProduct(p, ctx.currency)),
    });
  }

  async function createOrderTool(input: Record<string, unknown>) {
    if (orderCreated) {
      return fail(
        'An order was already created in this reply. Do not create another.'
      );
    }
    const items = parseOrderItems(input);
    if (typeof items === 'string') return fail(items);

    const note =
      typeof input.note === 'string' && input.note.trim()
        ? input.note.trim().slice(0, 500)
        : null;
    const result = await createOrder(ctx.db, {
      accountId: ctx.accountId,
      contactId: ctx.contactId,
      conversationId: ctx.conversationId,
      items,
      source: 'ai',
      customerNote: note,
    });
    if (!result.ok) return fail(describeCommerceError(result.error));

    orderCreated = true;
    const order = result.value;
    outbox.push(buildInvoiceText(order, ctx.businessName));
    const settings = await loadCommerceSettings(ctx.db, ctx.accountId);
    const bankText = buildBankDetailsText(settings, order);
    if (bankText) outbox.push(bankText);
    else needsHuman = true;

    return ok({
      order_number: order.order_number,
      total: formatPrice(Number(order.total), order.currency),
      items: order.items.map((i) => ({
        name: i.product_name,
        quantity: i.quantity,
      })),
      next_step: bankText
        ? 'The invoice and bank transfer details will be sent right after your message. ' +
          "Don't repeat them. Thank the customer warmly and ask them to send a screenshot " +
          'of the transfer receipt once they have paid.'
        : 'The invoice will be sent after your message, but bank details are not set up yet. ' +
          'Tell the customer a team member will send the payment details shortly.',
    });
  }

  async function orderStatusTool() {
    const orders = await listConversationOrders(
      ctx.db,
      ctx.accountId,
      ctx.conversationId
    );
    return ok({
      orders: orders.map((o) => ({
        order_number: o.order_number,
        status: STATUS_WORDS[o.status] ?? o.status,
        total: formatPrice(Number(o.total), o.currency),
        created_at: o.created_at,
      })),
    });
  }

  return {
    get outbox() {
      return outbox;
    },
    get needsHuman() {
      return needsHuman;
    },
    async execute(call) {
      if ('__invalid_json' in call.input) {
        return fail('Your tool arguments were not valid JSON. Try again.');
      }
      switch (call.name) {
        case 'search_products':
          return searchTool(call.input);
        case 'create_order':
          return createOrderTool(call.input);
        case 'get_order_status':
          return orderStatusTool();
        default:
          return fail(`Unknown tool: ${call.name}`);
      }
    },
  };
}

const STATUS_WORDS: Record<OrderStatus, string> = {
  pending_payment: 'awaiting payment',
  payment_submitted: 'receipt received — the team is confirming the payment',
  paid: 'paid',
  fulfilled: 'fulfilled',
  cancelled: 'cancelled',
};

function serializeProduct(p: Product, currency: string) {
  const stock = p.stock_quantity;
  const availability =
    stock === null
      ? 'available'
      : stock === 0
        ? 'out of stock'
        : stock <= LOW_STOCK
          ? `only ${stock} left`
          : 'in stock';
  return {
    id: p.id,
    name: p.name,
    price: formatPrice(Number(p.price), currency),
    availability,
    ...(p.description
      ? { description: p.description.trim().slice(0, 300) }
      : {}),
  };
}

/** Validate the model's `items` argument; a string is an error message. */
function parseOrderItems(
  input: Record<string, unknown>
): OrderLineRequest[] | string {
  const raw = input.items;
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'items must be a non-empty list of {product_id, quantity}.';
  }
  if (raw.length > MAX_ORDER_LINES) {
    return `At most ${MAX_ORDER_LINES} different products per order.`;
  }
  const items: OrderLineRequest[] = [];
  for (const entry of raw) {
    const e = entry as Record<string, unknown> | null;
    const productId = e?.product_id;
    const quantity = e?.quantity;
    if (typeof productId !== 'string' || !productId.trim()) {
      return 'Each item needs a product_id from search_products.';
    }
    if (
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QUANTITY
    ) {
      return `Each quantity must be a whole number from 1 to ${MAX_QUANTITY}.`;
    }
    items.push({ product_id: productId.trim(), quantity });
  }
  return items;
}
