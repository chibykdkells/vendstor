import { describe, it, expect, vi, beforeEach } from 'vitest'

// Order actions from the owner screen. The handler writes through the
// service-role client, so it alone enforces the role, the account scope
// and the allowed status transitions.

const h = vi.hoisted(() => ({
  state: {
    forbidden: false,
    /** Rows the conditional UPDATE matched. */
    updateRows: [] as { id: string }[],
    /** Whether the order exists in the caller's account. */
    exists: true,
    calls: [] as { op: string; args: unknown[] }[],
  },
  markOrderPaid: vi.fn(),
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => {
    if (h.state.forbidden) throw new Error('forbidden')
    return { accountId: 'acct-1', userId: 'user-1', role: 'agent' }
  },
  toErrorResponse: () => ({ body: { error: 'Forbidden' }, status: 403 }),
}))

vi.mock('@/lib/i18n/translate', () => ({
  getT: (ns: string) => (key: string) => `${ns}.${key}`,
}))

vi.mock('@/lib/commerce/store', () => ({
  ORDER_LIST_COLUMNS: 'cols',
  markOrderPaid: h.markOrderPaid,
}))

const db = {
  from: (table: string) => {
    const record = (op: string, args: unknown[]) => h.state.calls.push({ op: `${table}.${op}`, args })
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'update']) {
      chain[m] = (...args: unknown[]) => {
        record(m, args)
        return chain
      }
    }
    chain.maybeSingle = () =>
      Promise.resolve({ data: h.state.exists ? { id: 'o1' } : null, error: null })
    chain.single = () =>
      Promise.resolve({ data: { id: 'o1', status: 'updated' }, error: null })
    chain.then = (resolve: (r: unknown) => unknown) =>
      resolve({ data: h.state.updateRows, error: null })
    return chain
  },
}

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => db }))

import { PATCH } from './route'

const params = Promise.resolve({ id: 'o1' })
const req = (body: unknown) =>
  new Request('http://x/api/commerce/orders/o1', {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
type Res = { status: number; body: { error?: string; order?: unknown } }
const patch = async (body: unknown) =>
  (await PATCH(req(body), { params })) as unknown as Res

beforeEach(() => {
  h.state.forbidden = false
  h.state.updateRows = [{ id: 'o1' }]
  h.state.exists = true
  h.state.calls = []
  h.markOrderPaid.mockReset()
})

describe('PATCH /api/commerce/orders/[id]', () => {
  it('rejects unknown actions', async () => {
    const res = await patch({ action: 'refund' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Api.commerce.invalidAction')
  })

  it('requires an agent+ role', async () => {
    h.state.forbidden = true
    expect((await patch({ action: 'mark_paid' })).status).toBe(403)
    expect(h.markOrderPaid).not.toHaveBeenCalled()
  })

  it('marks paid through the RPC with the caller as confirmer', async () => {
    h.markOrderPaid.mockResolvedValue({ ok: true, value: null })
    const res = await patch({ action: 'mark_paid' })
    expect(res.status).toBe(200)
    expect(h.markOrderPaid).toHaveBeenCalledWith(db, 'acct-1', 'o1', 'user-1')
    expect(res.body.order).toEqual({ id: 'o1', status: 'updated' })
  })

  it('maps RPC refusals to 404 / 409', async () => {
    h.markOrderPaid.mockResolvedValue({
      ok: false,
      error: { code: 'order_not_found', detail: null },
    })
    expect((await patch({ action: 'mark_paid' })).status).toBe(404)

    h.markOrderPaid.mockResolvedValue({
      ok: false,
      error: { code: 'order_not_payable', detail: 'paid' },
    })
    const res = await patch({ action: 'mark_paid' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Api.commerce.orderStatusConflict')
  })

  it('cancels only an unpaid order in the caller’s account', async () => {
    const res = await patch({ action: 'cancel' })
    expect(res.status).toBe(200)
    expect(h.state.calls).toEqual(
      expect.arrayContaining([
        { op: 'orders.update', args: [{ status: 'cancelled' }] },
        { op: 'orders.eq', args: ['account_id', 'acct-1'] },
        { op: 'orders.in', args: ['status', ['pending_payment', 'payment_submitted']] },
      ]),
    )
  })

  it('fulfils only a paid order', async () => {
    await patch({ action: 'fulfill' })
    expect(h.state.calls).toEqual(
      expect.arrayContaining([
        { op: 'orders.update', args: [{ status: 'fulfilled' }] },
        { op: 'orders.in', args: ['status', ['paid']] },
      ]),
    )
  })

  it('answers 409 when the order is in the wrong state, 404 when it isn’t ours', async () => {
    h.state.updateRows = []
    expect((await patch({ action: 'cancel' })).status).toBe(409)
    h.state.exists = false
    expect((await patch({ action: 'cancel' })).status).toBe(404)
  })
})
