// L3-UPGRADE (beta, timeboxed) - push the eval logic onto Mistral Observability
// primitives: a Dataset (+ records), a custom Judge, and a Campaign. This is the
// UPGRADE on top of the canonical offline runner (evals/run.ts) - not a dependency.
// Every step is guarded: if the beta fights back we log the verbatim error and move
// on, leaving the offline runner as the source of truth. Run: `npm run studio:obs`.
import "../evals/_env";
process.env.MISTRAL_MIN_INTERVAL_MS = process.env.STUDIO_RATE_MS ?? "1200";
import fs from "fs";
import path from "path";
import { Mistral } from "@mistralai/mistralai";
import { withLimit } from "@/assistant/client";

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });

function logErr(where: string, err: any) {
  console.error(`\n[obs] ${where} FAILED (offline runner remains canonical).`);
  console.error(`[obs] status: ${err?.statusCode} body: ${typeof err?.body === "string" ? err.body : JSON.stringify(err?.body ?? err?.message)}`);
}

async function main() {
  const evalset = JSON.parse(fs.readFileSync(path.join(process.cwd(), "evals", "evalset.json"), "utf-8")) as { items: any[] };

  // 1) Dataset ---------------------------------------------------------------
  let datasetId: string | undefined;
  try {
    const ds = await withLimit(() => client.beta.observability.datasets.create({
      name: `retail-assistant-evalset-${Date.now()}`,
      description: "40-item stratified eval set for the retail-assistant demo (ported from the offline runner).",
    }));
    datasetId = (ds as any).id ?? (ds as any).datasetId;
    console.log(`[obs] dataset created: ${datasetId}`);
  } catch (err) {
    logErr("datasets.create", err);
  }

  // 1b) A few records (bounded - 3, to respect rate limits) -------------------
  if (datasetId) {
    for (const item of evalset.items.slice(0, 3)) {
      try {
        await withLimit(() => client.beta.observability.datasets.createRecord({
          datasetId,
          postDatasetRecordInSchema: {
            payload: { messages: [{ role: "user", content: item.utterance }] },
            properties: { evalId: item.id, category: item.category, expected: JSON.stringify(item.expected) },
          } as any,
        }));
        console.log(`[obs] record added: ${item.id}`);
      } catch (err) {
        logErr(`datasets.createRecord(${item.id})`, err);
        break;
      }
    }
  }

  // 2) Judge -----------------------------------------------------------------
  let judgeId: string | undefined;
  try {
    const judge = await withLimit(() => client.beta.observability.judges.create({
      name: `groundedness-${Date.now()}`,
      description: "Groundedness judge for the retail-assistant answer lane (ported from evals/judge.ts).",
      modelName: "mistral-large-2512",
      instructions:
        "Judge whether the assistant ANSWER is fully grounded in the sources it was given. 'pass' if every factual claim is supported and no forbidden move was made; 'fail' otherwise.",
      tools: [],
      output: {
        type: "CLASSIFICATION",
        options: [
          { value: "pass", description: "Answer is grounded and made no forbidden claim." },
          { value: "fail", description: "Answer fabricated a fact or made a forbidden claim." },
        ],
      },
    } as any));
    judgeId = (judge as any).id ?? (judge as any).judgeId;
    console.log(`[obs] judge created: ${judgeId}`);
  } catch (err) {
    logErr("judges.create", err);
  }

  // 3) Campaign --------------------------------------------------------------
  // NOTE (beta rough edge): a Campaign runs a judge over LOGGED chat-completion
  // EVENTS selected by a filter - NOT over the uploaded dataset records. So a
  // dataset-driven eval and a campaign are two different primitives; wiring the
  // 40 items into a campaign means logging them as completion events first.
  if (judgeId) {
    try {
      const campaign = await withLimit(() => client.beta.observability.campaigns.create({
        judgeId,
        name: `retail-assistant-smoke-${Date.now()}`,
        description: "Smoke campaign applying the groundedness judge over recent completion events.",
        maxNbEvents: 10,
        searchParams: { filters: null } as any,
      } as any));
      console.log(`[obs] campaign created: ${(campaign as any).id ?? JSON.stringify(campaign).slice(0, 120)}`);
    } catch (err) {
      logErr("campaigns.create", err);
      console.error("[obs] campaigns consume logged completion events (searchParams filter), not dataset records - documented rough edge.");
    }
  }

  console.log("\n[obs] Done. The offline runner (npm run eval) remains the canonical scorecard.");
}

main().catch((e) => { console.error(e); process.exit(1); });
