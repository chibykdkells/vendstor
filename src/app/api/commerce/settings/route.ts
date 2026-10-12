import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { validatePaymentSettings } from '@/lib/commerce/validate'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

// Payment settings — the bank details the AI sends with each invoice,
// plus the invoice-number prefix. Settings-class (migration 047): any
// member reads, admin+ writes. `next_order_number` is never writable
// here; only `create_order` advances it.

const COLUMNS =
  'bank_name, bank_account_name, bank_account_number, payment_instructions, order_number_prefix'

const EMPTY = {
  bank_name: null,
  bank_account_name: null,
  bank_account_number: null,
  payment_instructions: null,
  order_number_prefix: 'INV-',
}

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('commerce_settings')
      .select(COLUMNS)
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ settings: data ?? EMPTY })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: t('common.invalidJson') }, { status: 400 })

  const result = validatePaymentSettings(body)
  if (!result.ok) {
    return NextResponse.json({ error: t(`commerce.${result.error}`) }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin()
    .from('commerce_settings')
    .upsert({ account_id: ctx.accountId, ...result.value }, { onConflict: 'account_id' })
    .select(COLUMNS)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ settings: data })
}
