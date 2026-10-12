"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { buildBankDetailsText } from "@/lib/commerce/messages";
import { SettingsPanelHead } from "./settings-panel-head";

interface PaymentSettingsForm {
  bank_name: string;
  bank_account_name: string;
  bank_account_number: string;
  payment_instructions: string;
  order_number_prefix: string;
}

const EMPTY: PaymentSettingsForm = {
  bank_name: "",
  bank_account_name: "",
  bank_account_number: "",
  payment_instructions: "",
  order_number_prefix: "INV-",
};

/** Example amount for the live preview. */
const PREVIEW_TOTAL = 15000;

/**
 * Bank-transfer details the AI sends after creating an order, plus the
 * invoice-number prefix. Admin+ edits (settings-class); everyone else
 * sees it read-only. The preview is built by the same function the bot
 * uses, so it's exactly what customers will receive.
 */
export function PaymentSettings() {
  const t = useTranslations("Settings.payments");
  const { canEditSettings, defaultCurrency } = useAuth();
  const [form, setForm] = useState<PaymentSettingsForm>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/commerce/settings", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && data.settings) {
          const s = data.settings as Record<string, string | null>;
          setForm({
            bank_name: s.bank_name ?? "",
            bank_account_name: s.bank_account_name ?? "",
            bank_account_number: s.bank_account_number ?? "",
            payment_instructions: s.payment_instructions ?? "",
            order_number_prefix: s.order_number_prefix ?? "INV-",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const preview = useMemo(
    () =>
      buildBankDetailsText(form, {
        order_number: `${form.order_number_prefix}0001`,
        total: PREVIEW_TOTAL,
        currency: defaultCurrency,
      }),
    [form, defaultCurrency],
  );

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/commerce/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("saveError"));
        return;
      }
      toast.success(t("saved"));
    } catch {
      toast.error(t("saveError"));
    } finally {
      setSaving(false);
    }
  };

  const set = (key: keyof PaymentSettingsForm) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const disabled = !canEditSettings || saving;

  return (
    <div>
      <SettingsPanelHead title={t("title")} description={t("description")} />

      {!canEditSettings && (
        <p className="mb-4 rounded-md border border-border bg-muted p-2 text-xs text-muted-foreground">
          {t("readOnly")}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <TextField label={t("bankName")} value={form.bank_name} onChange={set("bank_name")} disabled={disabled} />
          <TextField
            label={t("accountName")}
            value={form.bank_account_name}
            onChange={set("bank_account_name")}
            disabled={disabled}
          />
          <TextField
            label={t("accountNumber")}
            value={form.bank_account_number}
            onChange={set("bank_account_number")}
            disabled={disabled}
            inputMode="numeric"
          />
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">{t("instructions")}</label>
            <Textarea
              value={form.payment_instructions}
              onChange={(e) => set("payment_instructions")(e.target.value)}
              placeholder={t("instructionsPlaceholder")}
              disabled={disabled}
              className="min-h-20 bg-muted text-foreground"
            />
          </div>
          <TextField
            label={t("prefix")}
            hint={t("prefixHint")}
            value={form.order_number_prefix}
            onChange={set("order_number_prefix")}
            disabled={disabled}
          />
          {canEditSettings && (
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("save")}
            </Button>
          )}
        </div>

        <div>
          <p className="mb-1 text-xs text-muted-foreground">{t("previewTitle")}</p>
          {preview ? (
            <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted p-3 font-sans text-sm text-foreground">
              {preview}
            </pre>
          ) : (
            <p className="rounded-lg border border-dashed border-amber-500/40 p-3 text-sm text-amber-600 dark:text-amber-400">
              {t("previewIncomplete")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function TextField({
  label,
  hint,
  value,
  onChange,
  disabled,
  inputMode,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  inputMode?: "numeric" | "text";
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        inputMode={inputMode}
        className="bg-muted text-foreground"
      />
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
