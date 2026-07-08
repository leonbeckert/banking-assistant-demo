// Mistral client + pinned model IDs. Everything in /assistant may call the LLM;
// nothing in /engine ever does. temperature is 0 EVERYWHERE (determinism kit).
import { Mistral } from "@mistralai/mistralai";

const apiKey = process.env.MISTRAL_API_KEY;
if (!apiKey) {
  // Surfaced clearly at first API hit rather than a cryptic 401 deep in a call.
  console.warn("[assistant] MISTRAL_API_KEY is not set. Copy .env.local with your Mistral Studio key.");
}

export const mistral = new Mistral({ apiKey: apiKey ?? "" });

// Model IDs verified live against the /v1/models list on 2026-07-05.
export const MODELS = {
  // Conversation route - mistral-large-2512 ("Large 3"). Considered mistral-medium-2604
  // ("Medium 3.5", Apr 2026 - newer), but list price flipped the call: Large 3 is
  // $0.5/$1.5 per Mtok vs Medium 3.5 at $1.5/$7.5 (mistral.ai/pricing/api, 2026-07-05)
  // - the newer medium costs 5x more. Cheapest model that passes evals wins.
  conversation: "mistral-large-2512",
  // Gate / router - ministral-14b-2512, sampled 3x per message with a majority vote.
  // Started on the 3B; the eval suite showed persistent boundary misroutes (g01/g09/
  // r05), so the gate stepped up to the strongest ministral. The suite is the sizing
  // instrument: smallest model that passes, not smallest model full stop.
  gate: "ministral-14b-2512",
  // Retrieval embeddings.
  embed: "mistral-embed",
} as const;

export const TEMPERATURE = 0;

// ---- Rate limiting + retry --------------------------------------------------
// This key's verified limit is 60 req/min (x-ratelimit-limit-req-minute header,
// checked 2026-07-05). The live demo runs with NO throttle (interval 0) - human
// typing is the pacing. Batch scripts set MISTRAL_MIN_INTERVAL_MS (~1200ms = ~50/min)
// to stay under the cap; 429s (e.g. token-burst spikes) are always retried with
// backoff as cheap insurance. Interval is read per-call so a batch script can
// raise it after the module loads.
let lastCallAt = 0;
let chain: Promise<unknown> = Promise.resolve();

function minInterval(): number {
  const v = Number(process.env.MISTRAL_MIN_INTERVAL_MS ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Serialises calls and enforces a minimum spacing, then retries on 429.
export async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const gap = minInterval();
    if (gap > 0) {
      const wait = gap - (Date.now() - lastCallAt);
      if (wait > 0) await sleep(wait);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        lastCallAt = Date.now();
        return await fn();
      } catch (err: unknown) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 429 && attempt < 6) {
          const backoff = Math.max(gap, 12000) * (attempt + 1);
          console.warn(`[rate] 429, backing off ${(backoff / 1000).toFixed(0)}s (attempt ${attempt + 1})`);
          await sleep(backoff);
          continue;
        }
        throw err;
      }
    }
  };
  // Serialise so concurrent callers cannot burst past the spacing.
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

// ---- Token/usage accounting -------------------------------------------------
// Per-model ledger so the eval runner can compute cost-per-turn.
// Single-process, single-flight demo: reset before a turn, snapshot after.
// The Mistral SDK returns usage as { promptTokens, completionTokens, totalTokens }.
export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}
export type UsageLedger = Record<string, ModelUsage>;

let ledger: UsageLedger = {};

export function recordUsage(model: string, usage: unknown): void {
  const u = (usage ?? {}) as { promptTokens?: number; prompt_tokens?: number; completionTokens?: number; completion_tokens?: number };
  const prompt = u.promptTokens ?? u.prompt_tokens ?? 0;
  const completion = u.completionTokens ?? u.completion_tokens ?? 0;
  const cur = ledger[model] ?? { promptTokens: 0, completionTokens: 0, calls: 0 };
  cur.promptTokens += prompt;
  cur.completionTokens += completion;
  cur.calls += 1;
  ledger[model] = cur;
}

export function resetUsage(): void {
  ledger = {};
}

export function snapshotUsage(): UsageLedger {
  return JSON.parse(JSON.stringify(ledger));
}
