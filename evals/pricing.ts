// Mistral Studio list prices, USD per 1M tokens.
// Source: https://mistral.ai/pricing/api/ - fetched 2026-07-05.
//   Mistral Large 3 (mistral-large-2512): $0.5 in / $1.5 out
//   Mistral Medium 3.5 (mistral-medium-2604): $1.5 in / $7.5 out (newer, 5x pricier than Large 3)
//   Ministral 14B  (ministral-14b-2512):  $0.2 in / $0.2 out
//   Ministral 8B   (ministral-8b-2512):   $0.15 in / $0.15 out
//   Ministral 3B   (ministral-3b-2512):   $0.1 in / $0.1 out
//   Mistral Embed  (mistral-embed):       $0.1 in (embeddings are input-only)
//   Mistral Moderation (mistral-moderation-2603): $0.1 in (classifier, input-only)
//     - fetched 2026-07-06 from the same page.
// Note: the marketing homepage still quotes the older Large 2 rate ($2/$6);
// the /pricing/api/ page is the authoritative per-model list and is used here.
// FX: 1 USD ≈ 0.92 EUR (approximate, 2026-07). The cost line is an inference-only
// estimate, deliberately labelled as such on the scorecard.
export const USD_PER_MTOK: Record<string, { in: number; out: number }> = {
  "mistral-large-2512": { in: 0.5, out: 1.5 },
  "mistral-medium-2604": { in: 1.5, out: 7.5 },
  "ministral-14b-2512": { in: 0.2, out: 0.2 },
  "ministral-8b-2512": { in: 0.15, out: 0.15 },
  "ministral-3b-2512": { in: 0.1, out: 0.1 },
  "mistral-embed": { in: 0.1, out: 0.0 },
  "mistral-moderation-2603": { in: 0.1, out: 0.0 },
  "mistral-moderation-latest": { in: 0.1, out: 0.0 },
};

export const USD_TO_EUR = 0.92;

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

// Cost in EUR for a per-model usage ledger.
export function costEur(usageByModel: Record<string, ModelUsage>): number {
  let usd = 0;
  for (const [model, u] of Object.entries(usageByModel)) {
    const rate = USD_PER_MTOK[model];
    if (!rate) continue;
    usd += (u.promptTokens / 1e6) * rate.in + (u.completionTokens / 1e6) * rate.out;
  }
  return usd * USD_TO_EUR;
}

export function mergeUsage(
  into: Record<string, ModelUsage>,
  add: Record<string, ModelUsage>,
): void {
  for (const [model, u] of Object.entries(add)) {
    const cur = into[model] ?? { promptTokens: 0, completionTokens: 0, calls: 0 };
    cur.promptTokens += u.promptTokens;
    cur.completionTokens += u.completionTokens;
    cur.calls += u.calls;
    into[model] = cur;
  }
}
