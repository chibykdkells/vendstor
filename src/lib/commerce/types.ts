// ============================================================
// Commerce — row shapes for the catalog / order tables (migration
// 047). Postgres `numeric` arrives over PostgREST as a string, so
// money columns are typed `number | string` and normalised with
// `Number()` at the edges.
// ============================================================

export type OrderStatus =
  'pending_payment' | 'payment_submitted' | 'paid' | 'fulfilled' | 'cancelled';

export type OrderSource = 'ai' | 'agent' | 'api';

export interface Product {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  price: number | string;
  /** NULL = stock not tracked. */
  stock_quantity: number | null;
  image_url: string | null;
  is_active: boolean;
}

export interface OrderItem {
  product_id: string | null;
  product_name: string;
  unit_price: number | string;
  quantity: number;
  line_total: number | string;
}

export interface Order {
  id: string;
  order_number: string;
  status: OrderStatus;
  currency: string;
  subtotal: number | string;
  total: number | string;
  contact_id: string | null;
  conversation_id: string | null;
  created_at: string;
  items: OrderItem[];
}

export interface CommerceSettings {
  bank_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  payment_instructions: string | null;
}

/** One requested order line, as passed to `create_order`. */
export interface OrderLineRequest {
  product_id: string;
  quantity: number;
}
