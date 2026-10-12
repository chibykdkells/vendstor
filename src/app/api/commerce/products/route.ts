import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { PRODUCT_COLUMNS } from '@/lib/commerce/store'
import { validateProductInput } from '@/lib/commerce/validate'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

// Product catalog (migration 047). GET lists every product — active and
// hidden — for the owner screen; the AI only ever sees active ones. Same
// split as quick replies: RLS-scoped read via the user client,
// service-role write after an explicit role check.

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()
    // RLS (products_select) scopes to the caller's account.
    const { data, error } = await supabase
      .from('products')
      .select(`${PRODUCT_COLUMNS}, created_at, updated_at`)
      .order('name')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ products: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: t('common.invalidJson') }, { status: 400 })

  const result = validateProductInput(body, { partial: false })
  if (!result.ok) {
    return NextResponse.json({ error: t(`commerce.${result.error}`) }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin()
    .from('products')
    .insert({ ...result.value, account_id: ctx.accountId, created_by: ctx.userId })
    .select(PRODUCT_COLUMNS)
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: t('commerce.skuTaken') }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ product: data }, { status: 201 })
}
