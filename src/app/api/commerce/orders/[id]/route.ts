import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { ORDER_LIST_COLUMNS, markOrderPaid } from '@/lib/commerce/store'
import { ACTION_FROM_STATUSES, isOrderAction } from '@/lib/commerce/validate'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

// Order actions from the owner screen: { action: 'mark_paid' | 'fulfill'
// | 'cancel' }. mark_paid goes through the `mark_order_paid` RPC (status
// check + stock decrement in one transaction); fulfill/cancel are a
// conditional UPDATE so a stale screen can't, e.g., cancel a paid order.

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: t('common.invalidJson') }, { status: 400 })
  if (!isOrderAction(body.action)) {
    return NextResponse.json({ error: t('commerce.invalidAction') }, { status: 400 })
  }

  const db = supabaseAdmin()

  if (body.action === 'mark_paid') {
    const result = await markOrderPaid(db, ctx.accountId, id, ctx.userId).catch(
      (err: unknown) => err as Error,
    )
    if (result instanceof Error) {
      return NextResponse.json({ error: result.message }, { status: 500 })
    }
    if (!result.ok) {
      return result.error.code === 'order_not_found'
        ? NextResponse.json({ error: t('commerce.orderNotFound') }, { status: 404 })
        : NextResponse.json({ error: t('commerce.orderStatusConflict') }, { status: 409 })
    }
  } else {
    const { from, to } = ACTION_FROM_STATUSES[body.action as 'fulfill' | 'cancel']
    const { data, error } = await db
      .from('orders')
      .update({ status: to })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .in('status', from)
      .select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) {
      const { data: exists } = await db
        .from('orders')
        .select('id')
        .eq('id', id)
        .eq('account_id', ctx.accountId)
        .maybeSingle()
      return exists
        ? NextResponse.json({ error: t('commerce.orderStatusConflict') }, { status: 409 })
        : NextResponse.json({ error: t('commerce.orderNotFound') }, { status: 404 })
    }
  }

  const { data: order, error } = await db
    .from('orders')
    .select(ORDER_LIST_COLUMNS)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ order })
}
