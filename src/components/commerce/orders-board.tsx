"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Bot, Loader2, MessageSquare, Receipt, ShoppingBag } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { formatPrice } from "@/lib/currency";
import type { OrderStatus } from "@/lib/commerce/types";
import { cn } from "@/lib/utils";

interface OrderRow {
  id: string;
  order_number: string;
  status: OrderStatus;
  source: "ai" | "agent" | "api";
  currency: string;
  total: number | string;
  customer_note: string | null;
  conversation_id: string | null;
  payment_proof_message_id: string | null;
  paid_at: string | null;
  created_at: string;
  contact: { id: string; name: string | null; phone: string } | null;
  items: {
    product_name: string;
    unit_price: number | string;
    quantity: number;
    line_total: number | string;
  }[];
}

const FILTERS = ["open", "paid", "fulfilled", "cancelled", "all"] as const;
type Filter = (typeof FILTERS)[number];

type Action = "mark_paid" | "fulfill" | "cancel";

const STATUS_STYLE: Record<OrderStatus, string> = {
  pending_payment: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  payment_submitted: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  paid: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  fulfilled: "border-border bg-muted text-muted-foreground",
  cancelled: "border-border bg-muted text-muted-foreground line-through",
};

/**
 * Orders the AI (or an agent) created in chat. The default "Needs
 * attention" view is the bank-check queue: orders awaiting payment,
 * with those whose receipt arrived highlighted. Payment is only ever
 * confirmed here, by a person.
 */
export function OrdersBoard() {
  const t = useTranslations("Commerce.orders");
  const tStatus = useTranslations("Commerce.status");
  const { canSendMessages } = useAuth();
  const [filter, setFilter] = useState<Filter>("open");
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<OrderRow | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/commerce/orders?status=${filter}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setOrders((data.orders as OrderRow[]) ?? []);
      else toast.error(data.error ?? t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [filter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (order: OrderRow, action: Action) => {
      const total = formatPrice(Number(order.total), order.currency);
      const confirmText =
        action === "mark_paid"
          ? t("confirmMarkPaid", { total, number: order.order_number })
          : action === "cancel"
            ? t("confirmCancel", { number: order.order_number })
            : null;
      if (confirmText && !window.confirm(confirmText)) return;

      setBusy(action);
      try {
        const res = await fetch(`/api/commerce/orders/${order.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t("actionError"));
          return;
        }
        toast.success(t(`done.${action}`, { number: order.order_number }));
        setSelected(null);
        await load();
      } catch {
        toast.error(t("actionError"));
      } finally {
        setBusy(null);
      }
    },
    [load, t],
  );

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("title")}</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label={t("filterLabel")}>
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === f
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`filters.${f}`)}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center">
            <ShoppingBag className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t(`empty.${filter}`)}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {orders.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => setSelected(o)}
                  className={cn(
                    "flex w-full flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/50 sm:flex-nowrap",
                    o.status === "payment_submitted" ? "border-sky-500/40" : "border-border",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{o.order_number}</span>
                      {o.source === "ai" && (
                        <Bot className="h-3.5 w-3.5 text-muted-foreground" aria-label={t("byAi")} />
                      )}
                      {o.payment_proof_message_id && (
                        <Receipt className="h-3.5 w-3.5 text-sky-500" aria-label={t("receiptReceived")} />
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {contactLabel(o, t("unknownCustomer"))} · {itemsSummary(o)}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(o.created_at), { addSuffix: true })}
                  </span>
                  <span className="w-28 text-sm font-medium text-foreground sm:text-right">
                    {formatPrice(Number(o.total), o.currency)}
                  </span>
                  <Badge variant="outline" className={cn("shrink-0", STATUS_STYLE[o.status])}>
                    {tStatus(o.status)}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="sm:max-w-lg">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {selected.order_number}
                  <Badge variant="outline" className={STATUS_STYLE[selected.status]}>
                    {tStatus(selected.status)}
                  </Badge>
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">
                      {contactLabel(selected, t("unknownCustomer"))}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(selected.created_at).toLocaleString()}
                      {selected.source === "ai" ? ` · ${t("byAi")}` : ""}
                    </p>
                  </div>
                  {selected.conversation_id && (
                    <Link
                      href={`/inbox?c=${selected.conversation_id}`}
                      className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                      {t("openChat")}
                    </Link>
                  )}
                </div>

                {selected.status === "payment_submitted" && (
                  <p className="rounded-md border border-sky-500/30 bg-sky-500/10 p-2 text-xs text-sky-700 dark:text-sky-300">
                    {t("receiptHint")}
                  </p>
                )}

                <table className="w-full text-sm">
                  <tbody>
                    {selected.items.map((item, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="py-1.5 pr-2 text-foreground">
                          {item.quantity} × {item.product_name}
                        </td>
                        <td className="py-1.5 text-right text-muted-foreground">
                          {formatPrice(Number(item.line_total), selected.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="pt-2 font-semibold text-foreground">{t("total")}</td>
                      <td className="pt-2 text-right font-semibold text-foreground">
                        {formatPrice(Number(selected.total), selected.currency)}
                      </td>
                    </tr>
                  </tfoot>
                </table>

                {selected.customer_note && (
                  <div>
                    <p className="text-xs text-muted-foreground">{t("note")}</p>
                    <p className="text-foreground">{selected.customer_note}</p>
                  </div>
                )}
              </div>

              {canSendMessages && (
                <DialogFooter className="gap-2 sm:justify-between">
                  {(selected.status === "pending_payment" ||
                    selected.status === "payment_submitted") && (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => act(selected, "cancel")}
                        disabled={busy !== null}
                        className="text-red-500"
                      >
                        {busy === "cancel" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                        {t("cancelOrder")}
                      </Button>
                      <Button onClick={() => act(selected, "mark_paid")} disabled={busy !== null}>
                        {busy === "mark_paid" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                        {t("markPaid")}
                      </Button>
                    </>
                  )}
                  {selected.status === "paid" && (
                    <Button onClick={() => act(selected, "fulfill")} disabled={busy !== null}>
                      {busy === "fulfill" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                      {t("markFulfilled")}
                    </Button>
                  )}
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function contactLabel(o: OrderRow, fallback: string): string {
  if (!o.contact) return fallback;
  return o.contact.name ? `${o.contact.name} (${o.contact.phone})` : o.contact.phone;
}

function itemsSummary(o: OrderRow): string {
  return o.items.map((i) => `${i.quantity} × ${i.product_name}`).join(", ");
}
