import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { PRODUCT_COLUMNS } from '@/lib/commerce/store'
import { validateProductInput } from '@/lib/commerce/validate'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

// Update / delete one product. The service-role client bypasses the
// agent-gated RLS, so the role check and the account scope are both
// enforced here. Deleting is safe for past orders: order_items keep a
// name + price snapshot and their product_id goes NULL.

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

  const result = validateProductInput(body, { partial: true })
  if (!result.ok) {
    return NextResponse.json({ error: t(`commerce.${result.error}`) }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin()
    .from('products')
    .update(result.value)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select(PRODUCT_COLUMNS)
    .maybeSingle()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: t('commerce.skuTaken') }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: t('commerce.productNotFound') }, { status: 404 })
  return NextResponse.json({ product: data })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { data, error } = await supabaseAdmin()
    .from('products')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) {
    return NextResponse.json({ error: t('commerce.productNotFound') }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
