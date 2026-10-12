import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { ORDER_LIST_COLUMNS } from '@/lib/commerce/store'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

// Orders list for the owner screen. RLS (orders_select) scopes to the
// caller's account. `?status=` filters; `open` is shorthand for the two
// awaiting-payment states (what an owner checks the bank for).

const STATUS_FILTERS: Record<string, string[]> = {
  open: ['pending_payment', 'payment_submitted'],
  pending_payment: ['pending_payment'],
  payment_submitted: ['payment_submitted'],
  paid: ['paid'],
  fulfilled: ['fulfilled'],
  cancelled: ['cancelled'],
}

export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount()
    const status = new URL(request.url).searchParams.get('status')
    let query = supabase
      .from('orders')
      .select(ORDER_LIST_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(200)
    if (status && status !== 'all') {
      const statuses = STATUS_FILTERS[status]
      if (!statuses) {
        return NextResponse.json({ error: t('commerce.invalidStatusFilter') }, { status: 400 })
      }
      query = query.in('status', statuses)
    }
    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ orders: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
