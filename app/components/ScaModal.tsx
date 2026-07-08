"use client";

import { IconFingerprint, IconShield } from "./icons";
import { BRAND_NAME } from "../lib/brand";

export type ScaStatus = "awaiting" | "sending" | "timeout";

export default function ScaModal({
  open,
  actionLabel,
  cardLabel,
  status,
  onApprove,
  onClose,
  lang = "en",
}: {
  open: boolean;
  actionLabel: string;
  cardLabel: string;
  status: ScaStatus;
  onApprove: () => void;
  onClose: () => void;
  lang?: "en" | "fr";
}) {
  const t = (en: string, fr: string) => (lang === "fr" ? fr : en);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      {/* backdrop */}
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={status === "sending" ? undefined : onClose} />

      {/* phone frame - the native approval surface, NOT the chat */}
      <div className="relative w-[380px] fade-up">
        {/* side buttons on the bezel */}
        <div className="absolute -left-[14px] top-32 h-9 w-[3px] rounded-l bg-slate-800" />
        <div className="absolute -left-[14px] top-44 h-14 w-[3px] rounded-l bg-slate-800" />
        <div className="absolute -right-[14px] top-40 h-20 w-[3px] rounded-r bg-slate-800" />

        <div className="rounded-[3.25rem] border-[14px] border-slate-900 bg-slate-900 shadow-phone">
          <div className="relative flex min-h-[600px] flex-col rounded-[2.5rem] bg-gradient-to-b from-slate-50 to-white px-6 pb-4 pt-3">
            {/* status bar flanking the dynamic island, all at island height */}
            <div className="mb-7 grid grid-cols-3 items-center text-[13px] font-semibold text-ink">
              <span className="justify-self-start pl-1">9:41</span>
              <div className="h-7 w-28 justify-self-center rounded-full bg-slate-900" />
              <span className="flex items-center justify-end gap-1.5 pr-1">
                {/* signal */}
                <span className="flex items-end gap-[2px]">
                  <span className="h-1.5 w-[3px] rounded-sm bg-ink" />
                  <span className="h-2 w-[3px] rounded-sm bg-ink" />
                  <span className="h-2.5 w-[3px] rounded-sm bg-ink" />
                  <span className="h-3 w-[3px] rounded-sm bg-ink" />
                </span>
                {/* wifi */}
                <svg viewBox="0 0 16 12" className="h-3 w-4 fill-ink" aria-hidden="true">
                  <path d="M8 11.2a1.2 1.2 0 100-2.4 1.2 1.2 0 000 2.4zM8 6.2c1.3 0 2.5.5 3.4 1.4l1.2-1.2A6.5 6.5 0 008 5.6a6.5 6.5 0 00-4.6 1.8l1.2 1.2A4.8 4.8 0 018 6.2zM8 2A11 11 0 00.2 5.2l1.2 1.2A9.3 9.3 0 018 3.7c2.5 0 4.8 1 6.6 2.7l1.2-1.2A11 11 0 008 2z" />
                </svg>
                {/* battery */}
                <span className="relative ml-0.5 flex h-3 w-6 items-center rounded-[3px] border border-ink/50 p-[1.5px]">
                  <span className="h-full w-full rounded-[1px] bg-ink" />
                  <span className="absolute -right-[3px] top-1/2 h-1.5 w-[2px] -translate-y-1/2 rounded-r-sm bg-ink/50" />
                </span>
              </span>
            </div>

            {/* app label */}
            <div className="mb-6 text-center text-sm font-medium tracking-wide text-ink-faint">Clé digitale</div>

            {/* bank identity */}
            <div className="mb-6 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                <IconShield className="h-6 w-6" />
              </div>
              <div>
                <div className="text-base font-semibold text-ink">{BRAND_NAME}</div>
                <div className="text-xs text-ink-faint">{t("Approval request", "Demande d'approbation")}</div>
              </div>
            </div>

            {/* what you see is what you sign */}
            <div className="rounded-3xl border border-line bg-white p-5 shadow-card">
              <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{t("You are approving", "Vous approuvez")}</div>
              <div className="mt-1.5 text-2xl font-semibold leading-tight text-ink">{actionLabel}</div>
              <div className="mt-4 flex items-center justify-between rounded-2xl bg-canvas px-4 py-3">
                <span className="text-xs text-ink-faint">{t("Card", "Carte")}</span>
                <span className="font-mono text-base font-semibold text-ink">{cardLabel}</span>
              </div>
              <p className="mt-4 text-xs leading-relaxed text-ink-faint">
                {t(
                  "Only approve this if you requested it. If it wasn't you, tap Cancel.",
                  "N'approuvez que si vous êtes à l'origine de cette demande. Sinon, appuyez sur Annuler.",
                )}
              </p>
            </div>

            {/* action - anchored to the bottom of the screen */}
            <div className="mt-auto pt-8">
              {status === "timeout" ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center">
                  <div className="text-sm font-semibold text-amber-800">{t("Approval timed out", "L'approbation a expiré")}</div>
                  <p className="mt-1 text-[12px] leading-snug text-amber-700">
                    {t(
                      "No signal reached the bank. Nothing was changed. You can close this and retry.",
                      "Aucun signal n'a atteint la banque. Rien n'a été modifié. Vous pouvez fermer et réessayer.",
                    )}
                  </p>
                  <button
                    onClick={onClose}
                    className="mt-3 w-full rounded-xl bg-white py-2.5 text-sm font-semibold text-ink-soft ring-1 ring-line hover:bg-canvas"
                  >
                    {t("Close", "Fermer")}
                  </button>
                </div>
              ) : (
                <button
                  onClick={onApprove}
                  // Deliberately NOT disabled while sending: a double-tap here is
                  // the idempotency demo - the engine dedups by request ID.
                  className={`flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-base font-semibold text-white transition ${
                    status === "sending" ? "bg-accent/70" : "bg-accent hover:bg-accent/90 active:scale-[0.99]"
                  } ${status !== "sending" ? "pulse-ring" : ""}`}
                >
                  {status === "sending" ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                      {t("Verifying…", "Vérification…")}
                    </>
                  ) : (
                    <>
                      <IconFingerprint className="h-5 w-5" />
                      {t("Approve with biometric", "Approuver par biométrie")}
                    </>
                  )}
                </button>
              )}
              {status !== "timeout" ? (
                <button
                  onClick={onClose}
                  disabled={status === "sending"}
                  className="mt-2 w-full rounded-2xl py-3 text-sm font-medium text-ink-faint hover:text-ink-soft disabled:opacity-50"
                >
                  {t("Cancel", "Annuler")}
                </button>
              ) : null}
            </div>

            {/* home indicator */}
            <div className="mx-auto mt-3 h-1.5 w-32 rounded-full bg-slate-300" />
          </div>
        </div>
        <p className="mt-3 text-center text-xs text-white/80">Mock Clé digitale push - approval happens outside the model</p>
      </div>
    </div>
  );
}
