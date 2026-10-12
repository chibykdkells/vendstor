"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, Package, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { formatPrice } from "@/lib/currency";
import type { Product } from "@/lib/commerce/types";

interface Draft {
  id?: string;
  name: string;
  description: string;
  sku: string;
  price: string;
  stock: string;
  is_active: boolean;
}

function emptyDraft(): Draft {
  return { name: "", description: "", sku: "", price: "", stock: "", is_active: true };
}

function toDraft(p: Product): Draft {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? "",
    sku: p.sku ?? "",
    price: String(Number(p.price)),
    stock: p.stock_quantity === null ? "" : String(p.stock_quantity),
    is_active: p.is_active,
  };
}

/**
 * Product catalog the AI sells from. Everything here is what the bot
 * may quote: only active products are visible to it, and prices/stock
 * come straight from these rows.
 */
export function ProductsManager() {
  const t = useTranslations("Commerce.products");
  const { defaultCurrency, canSendMessages } = useAuth();
  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/commerce/products", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems((data.products as Product[]) ?? []);
      else toast.error(data.error ?? t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error(t("nameRequired"));
      return;
    }
    const payload = {
      name: draft.name,
      description: draft.description,
      sku: draft.sku,
      price: draft.price,
      stock_quantity: draft.stock,
      is_active: draft.is_active,
    };
    setSaving(true);
    try {
      const res = await fetch(
        draft.id ? `/api/commerce/products/${draft.id}` : "/api/commerce/products",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("saveError"));
        return;
      }
      toast.success(draft.id ? t("updated") : t("created"));
      setDraft(null);
      await load();
    } catch {
      toast.error(t("saveError"));
    } finally {
      setSaving(false);
    }
  }, [draft, load, t]);

  const toggleActive = useCallback(
    async (p: Product, next: boolean) => {
      // Optimistic: flip locally, roll back on failure.
      setItems((prev) => prev.map((i) => (i.id === p.id ? { ...i, is_active: next } : i)));
      const res = await fetch(`/api/commerce/products/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: next }),
      });
      if (!res.ok) {
        setItems((prev) => prev.map((i) => (i.id === p.id ? { ...i, is_active: !next } : i)));
        toast.error(t("saveError"));
      }
    },
    [t],
  );

  const remove = useCallback(
    async (p: Product) => {
      if (!window.confirm(t("deleteConfirm", { name: p.name }))) return;
      const res = await fetch(`/api/commerce/products/${p.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(t("deleteError"));
        return;
      }
      await load();
    },
    [load, t],
  );

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("title")}</h1>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">{t("description")}</p>
        </div>
        {canSendMessages && (
          <Button onClick={() => setDraft(emptyDraft())}>
            <Plus className="mr-1 h-4 w-4" />
            {t("new")}
          </Button>
        )}
      </div>

      <div className="mt-6">
        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-center">
            <Package className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 sm:flex-nowrap"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                    {!p.is_active && <Badge variant="secondary">{t("hidden")}</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {[p.sku, p.description].filter(Boolean).join(" · ") || " "}
                  </p>
                </div>
                <div className="w-28 text-sm font-medium text-foreground sm:text-right">
                  {formatPrice(Number(p.price), defaultCurrency)}
                </div>
                <div className="w-28 text-xs sm:text-right">
                  <StockLabel stock={p.stock_quantity} />
                </div>
                {canSendMessages && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={p.is_active}
                      onCheckedChange={(next) => toggleActive(p, next)}
                      aria-label={t("activeLabel")}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setDraft(toDraft(p))}
                      aria-label={t("edit")}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => remove(p)}
                      aria-label={t("delete")}
                      className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? t("edit") : t("new")}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="space-y-3">
              <Field label={t("nameLabel")}>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={t("namePlaceholder")}
                  className="bg-muted text-foreground"
                />
              </Field>
              <Field label={t("descriptionLabel")} hint={t("descriptionHint")}>
                <Textarea
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  className="min-h-20 bg-muted text-foreground"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("priceLabel", { currency: defaultCurrency })}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={draft.price}
                    onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                    className="bg-muted text-foreground"
                  />
                </Field>
                <Field label={t("stockLabel")} hint={t("stockHint")}>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    value={draft.stock}
                    onChange={(e) => setDraft({ ...draft, stock: e.target.value })}
                    className="bg-muted text-foreground"
                  />
                </Field>
              </div>
              <Field label={t("skuLabel")}>
                <Input
                  value={draft.sku}
                  onChange={(e) => setDraft({ ...draft, sku: e.target.value })}
                  className="bg-muted text-foreground"
                />
              </Field>
              <label className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <span>
                  <span className="block text-sm font-medium text-foreground">{t("activeLabel")}</span>
                  <span className="block text-xs text-muted-foreground">{t("activeHint")}</span>
                </span>
                <Switch
                  checked={draft.is_active}
                  onCheckedChange={(next) => setDraft({ ...draft, is_active: next })}
                />
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StockLabel({ stock }: { stock: number | null }) {
  const t = useTranslations("Commerce.products");
  if (stock === null) return <span className="text-muted-foreground">{t("stockUntracked")}</span>;
  if (stock === 0) return <span className="font-medium text-red-400">{t("outOfStock")}</span>;
  return <span className="text-muted-foreground">{t("inStock", { count: stock })}</span>;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
