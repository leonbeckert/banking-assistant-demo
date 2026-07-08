// INPUT MODERATION (Mistral Moderation API - "Moderation 2" on the input side).
// Runs BEFORE the gate when enabled. Verified live against this key on 2026-07-05
// (model mistral-moderation-2603 via mistral-moderation-latest).
//
// DOCTRINE: the verdict is a ROUTING SIGNAL, not a kill switch.
//   clean            → normal flow.
//   flagged-context  → PASS-WITH-NOTE. `pii`/`financial`/`law`/`health` fire on the
//                      ORDINARY content of an authenticated banking chat (a customer
//                      naming their own card, a money question). They do NOT change the
//                      conversation: no tone shift, no "abusive" framing. The note feeds
//                      logging/redaction policy downstream, not the reply.
//   flagged-severe   → polite refusal + audit + human path (criminal-solicitation class).
//   (TONE de-escalation - an abusive-but-legitimate vent - is a SEPARATE signal handled
//    by frustrationSignal below; the Moderation model honestly PASSES such vents, so it
//    never rides a context category. Only the tone signal may alter tone.)
//
// FAIL-OPEN: a moderation API error NEVER blocks the turn - we log an audit note and
// continue. The gate + the intent-object boundary + confirm/SCA still stand.
import { withLimit, recordUsage } from "./client";

export const MODERATION_MODEL = "mistral-moderation-latest";

// --- Category → routing-signal mapping (documented, bank context) -------------
// The Moderation model returns 11 boolean categories. We split them by what a
// retail bank must actually do about them:
//
// SEVERE (refuse + human path): genuine harm / illegality - a customer asking the
//   assistant to help commit or conceal a crime, threats, sexual content,
//   self-harm, dangerous instructions, or a prompt-injection/jailbreak attempt.
//   hate_and_discrimination is DELIBERATELY not severe: the moderation model fires
//   it on hostile-toward-the-assistant tone ("I hate you, you're all incompetent"),
//   and the bank posture is NEVER refuse service for tone - de-escalation handles
//   it, the verdict is still logged. Human-certified: gold_des_04.
const SEVERE_CATEGORIES = new Set([
  "criminal",
  "violence_and_threats",
  "sexual",
  "selfharm",
  "dangerous",
  "jailbreaking",
]);
// CONTEXT (pass-with-note, NO tone change): categories that fire on the ORDINARY
//   content of a banking chat. "financial" trips on any money discussion; "law" on any
//   regulation question; "pii" on a customer naming their own card/account; "health" on
//   a hardship/medical mention. A bank that refused - or apologised to - these would
//   refuse/patronise its own core service. So they PASS: the served outcome is untouched
//   and the verdict is only NOTED (it feeds downstream logging/redaction policy, not the
//   conversation). Critically, a context flag NEVER de-escalates: tone-shift is reserved
//   for the frustration/abuse signal, so "Lock my Visa ending 4471" (a `pii` hit) is a
//   clean lock, not an apology.
const CONTEXT_CATEGORIES = new Set(["financial", "law", "pii", "health"]);

export type ModerationRouting = "clean" | "context" | "severe" | "unavailable" | "off";

export interface ModerationVerdict {
  ran: boolean; // did we actually call the API this turn? (false when toggle off)
  routing: ModerationRouting;
  flaggedCategories: string[];
  topCategory?: string; // highest-scoring flagged category (for the trace line)
  traceLine: string; // the row shown in the panel in EVERY state
  auditNote?: string; // appended to the audit log ONLY when the verdict changed the outcome
  model?: string;
}

// Toggle-off state - no API call, no audit entry, honest trace row.
export function moderationOff(): ModerationVerdict {
  return {
    ran: false,
    routing: "off",
    flaggedCategories: [],
    traceLine: "moderation: off (demo rate budget)",
  };
}

// Raw response shape of POST /v1/moderations (snake_case). We call the endpoint
// directly instead of via mistral.classifiers.moderate because the SDK drops the
// `usage` block - and screening cost must be MEASURED, not estimated.
interface RawModerationResponse {
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
  results?: { categories?: Record<string, boolean>; category_scores?: Record<string, number> }[];
}

async function callModerationApi(message: string): Promise<RawModerationResponse> {
  const resp = await fetch("https://api.mistral.ai/v1/moderations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODERATION_MODEL, input: [message] }),
  });
  if (!resp.ok) {
    // Carry statusCode so withLimit's 429 backoff sees it, like SDK errors.
    throw Object.assign(new Error(`moderation HTTP ${resp.status}`), { statusCode: resp.status });
  }
  return (await resp.json()) as RawModerationResponse;
}

export async function moderateInput(message: string): Promise<ModerationVerdict> {
  try {
    const res = await withLimit(() => callModerationApi(message));
    // Classifier billing is input-only; the API's total_tokens (message + the
    // classifier's own template) is the conservative billing basis - prompt_tokens
    // alone would undercount (live probe: prompt 15, total 76 for one sentence).
    recordUsage(res.model ?? MODERATION_MODEL, {
      promptTokens: res.usage?.total_tokens ?? res.usage?.prompt_tokens ?? 0,
      completionTokens: 0,
    });
    const r = res.results?.[0];
    const cats = (r?.categories ?? {}) as Record<string, boolean>;
    const scores = (r?.category_scores ?? {}) as Record<string, number>;
    const flagged = Object.entries(cats)
      .filter(([, v]) => v)
      .map(([k]) => k);

    if (flagged.length === 0) {
      return {
        ran: true,
        routing: "clean",
        auditNote: "pass",
        flaggedCategories: [],
        traceLine: "moderation: pass",
        model: res.model,
      };
    }

    const severe = flagged.some((c) => SEVERE_CATEGORIES.has(c));
    // The trace names the single highest-scoring flagged category.
    const top = flagged.slice().sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))[0];
    if (severe) {
      return {
        ran: true,
        routing: "severe",
        flaggedCategories: flagged,
        topCategory: top,
        traceLine: `moderation: flagged (${top})`,
        auditNote: `input flagged as ${flagged.join(", ")}; request refused, human path offered instead`,
        model: res.model,
      };
    }
    // CONTEXT class: pass-with-note. The served outcome is unchanged; the verdict is
    // only NOTED. Trace reads `pass (<cat> noted)`, NOT `flagged`.
    return {
      ran: true,
      routing: "context",
      flaggedCategories: flagged,
      topCategory: top,
      traceLine: `moderation: pass (${top} noted)`,
      auditNote: flagged.includes("hate_and_discrimination")
        ? `pass (${flagged.join(", ")} noted; hostile tone is de-escalated, never refused)`
        : `pass (${flagged.join(", ")} noted; expected in banking, changes nothing)`,
      model: res.model,
    };
  } catch (err: unknown) {
    // FAIL-OPEN - the turn is never blocked by a moderation error.
    const e = err as { statusCode?: number; message?: string };
    console.error("[moderation] failed open:", e?.statusCode, e?.message);
    return {
      ran: true,
      routing: "unavailable",
      flaggedCategories: [],
      traceLine: "moderation: unavailable, failed open",
      auditNote: "moderation unavailable, failed open; gate + boundary still standing",
    };
  }
}

// Deterministic frustration/abuse signal. The Moderation model honestly PASSES an
// abusive-but-legitimate vent (e.g. "you useless bot, fix it NOW" scores ~0.04 on
// hate_and_discrimination - below threshold), so the DE-ESCALATE-AND-SERVE behavior
// hangs off this tone signal, not a faked verdict. Runs only under the moderation
// toggle, so it never perturbs the eval (which runs with moderation off).
const ABUSE_WORDS =
  /\b(useless|stupid|idiot|idiotic|garbage|trash|rubbish|worst|pathetic|incompetent|moron|dumb|ridiculous|hate you|shut up|screw you|piece of)\b/i;

export function frustrationSignal(message: string): boolean {
  if (ABUSE_WORDS.test(message)) return true;
  // A shouted imperative: an ALL-CAPS word of 3+ letters plus urgency/repetition.
  const shouted = /\b[A-Z]{3,}\b/.test(message);
  const urgent = /\b(now|immediately|right now|third time|again and again|fix it)\b/i.test(message);
  if (shouted && urgent) return true;
  // Heavy exclamation is a soft frustration cue when paired with urgency.
  return /!!+/.test(message) && urgent;
}
