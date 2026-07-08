"use client";

import type { PendingActionPayload } from "@/app/lib/contract";
import { IconCheck, IconLock } from "./icons";

export type ActionPhase = "confirm" | "success" | "pending" | "cancelled";

export default function ConfirmCard({
  pending,
  selectedCardId,
  phase,
  receipt,
  idempotentNote,
  onSelect,
  onApprove,
  onCancel,
  onRetry,
  lang = "en",
}: {
  pending: PendingActionPayload;
  selectedCardId: string;
  phase: ActionPhase;
  receipt?: { reference: string; action: string; card: string; ts: string };
  idempotentNote?: string;
  onSelect: (cardId: string) => void;
  onApprove: () => void;
  onCancel: () => void;
  onRetry: () => void;
  lang?: "en" | "fr";
}) {
  const t = (en: string, fr: string) => (lang === "fr" ? fr : en);
  const selected = pending.cards.find((c) => c.id === selectedCardId);

  if (phase === "success" && receipt) {
    return (
      <div className="mt-2 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-white">
            <IconCheck className="h-4 w-4" />
          </span>
          <div className="text-sm font-semibold text-emerald-800">{receipt.action}</div>
        </div>
        <dl className="mt-3 space-y-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-faint">{t("Card", "Carte")}</dt>
            <dd className="font-mono font-semibold text-ink">{receipt.card}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-faint">{t("Reference", "Référence")}</dt>
            <dd className="font-mono text-ink-soft">{receipt.reference}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-faint">{t("Time", "Heure")}</dt>
            <dd className="text-ink-soft">{new Date(receipt.ts).toLocaleTimeString()}</dd>
          </div>
        </dl>
        {idempotentNote ? (
          <p className="mt-3 rounded-lg bg-white/70 px-3 py-2 text-xs text-emerald-800 ring-1 ring-emerald-200">
            {idempotentNote}
          </p>
        ) : null}
      </div>
    );
  }

  if (phase === "cancelled") {
    return (
      <div className="mt-2 rounded-2xl border border-line bg-canvas p-4 text-sm text-ink-faint">
        {t("Cancelled - nothing was changed.", "Annulé - rien n'a été modifié.")}
      </div>
    );
  }

  const pendingTimeout = phase === "pending";

  return (
    <div className="mt-2 rounded-2xl border border-line bg-white p-4 shadow-card">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
          <IconLock className="h-4.5 w-4.5" />
        </span>
        <div>
          <div className="text-sm font-semibold text-ink">{pending.actionLabel}</div>
          <div className="text-xs text-ink-faint">{t("Select the card to continue.", "Sélectionnez la carte pour continuer.")}</div>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {pending.cards.map((c) => {
          const active = c.id === selectedCardId;
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              disabled={pendingTimeout}
              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                active ? "border-accent bg-accent-soft ring-1 ring-accent-ring" : "border-line bg-white hover:bg-canvas"
              }`}
            >
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                  active ? "border-accent" : "border-ink-faint/50"
                }`}
              >
                {active ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
              </span>
              <span className="font-mono text-sm font-semibold text-ink">{c.label}</span>
              <span className="ml-auto text-xs text-ink-faint">
                {c.status === "locked" ? t("locked", "verrouillée") : t("active", "active")}
              </span>
            </button>
          );
        })}
      </div>

      {pendingTimeout ? (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
          <div className="text-sm font-semibold text-amber-800">{t("Pending - not completed", "En attente - non finalisé")}</div>
          <p className="mt-0.5 text-xs text-amber-700">
            {t("Strong authentication timed out. Nothing changed on", "L'authentification forte a expiré. Rien n'a été modifié sur")} {selected?.label}. {t("You can retry safely.", "Vous pouvez réessayer en toute sécurité.")}
          </p>
          <button
            onClick={onRetry}
            className="mt-2 w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-white hover:bg-accent/90"
          >
            {t("Retry approval", "Relancer l'approbation")}
          </button>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            onClick={onApprove}
            className="flex-1 rounded-xl bg-accent py-2.5 text-sm font-semibold text-white transition hover:bg-accent/90 active:scale-[0.99]"
          >
            {pending.requiresSca ? t("Approve on device", "Approuver sur l'appareil") : t("Confirm", "Confirmer")}
          </button>
          <button
            onClick={onCancel}
            className="rounded-xl border border-line bg-white px-4 py-2.5 text-sm font-medium text-ink-soft hover:bg-canvas"
          >
            {t("Cancel", "Annuler")}
          </button>
        </div>
      )}
    </div>
  );
}
