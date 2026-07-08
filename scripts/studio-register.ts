// L2 + L4 - Studio Agents API (BETA). Registers the conversation lane as a
// VERSIONED Studio agent (instructions + tools mirroring the app's system prompt)
// and points dev/prod aliases at versions. This is an UPGRADE on top of the L1
// stack: the demo runs fine without it (ASSISTANT_MODE=direct is the default).
//
// Promotion rule (L4): `dev` always points at the newest version; `prod` moves to
// the newest version ONLY when the offline evals pass the bar. "Prod moves only
// when the campaign passes."
//
// If the beta API is not enabled on the key, this prints the verbatim error and
// exits without touching the demo. Run: `npm run studio:register`.
import "../evals/_env";
process.env.MISTRAL_MIN_INTERVAL_MS = process.env.STUDIO_RATE_MS ?? "1200";
import fs from "fs";
import path from "path";
import { Mistral } from "@mistralai/mistralai";
import { withLimit } from "@/assistant/client";

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });
const MANIFEST = path.join(process.cwd(), "data", "studio-agent.json");
const PROMOTION_BAR = 0.85; // prod alias only advances when eval pass-rate >= bar

const AGENT_NAME = "retail-assistant-conversation-lane";
const MODEL = "mistral-large-2512";

// Mirrors the app's conversation-lane system prompt (grounded-or-refuse +
// selects-never-generates) so the Studio agent embodies the same guarantees.
const INSTRUCTIONS = `You are a retail bank's customer conversation lane. Two jobs, both at temperature 0:
1) Grounded answering: answer ONLY from sources supplied in the request. If the sources do not contain the answer, say you cannot and offer a human advisor - never free-style bank facts, fees, or figures. Answer in the customer's language.
2) Card actions: when the customer commands a lock/unlock, call prepare_card_action. You NEVER generate or guess a card number - the deterministic engine resolves the customer's real cards and gates execution by tier: a LOCK is protective (risk-reducing), so it needs one explicit confirm and NO fresh strong authentication; an UNLOCK is security-increasing, so it needs a fresh strong customer authentication (SCA) before anything executes.

You describe how things work; you never perform an action or claim to have done one. The engine - not you - is the system of record. Chat prepares, the app approves, the engine executes.`;

const DESCRIPTION =
  "Conversation lane for a retail-bank assistant demo: grounded RAG answering + structured card-action intent. Acting is deterministic and gated behind confirm + SCA in the engine - the assistant only prepares.";

const CARD_TOOL = {
  type: "function" as const,
  function: {
    name: "prepare_card_action",
    description:
      "Prepare a card lock/unlock. Does NOT execute - the deterministic engine resolves the customer's real cards and requires confirmation + strong authentication. Never invent a card number; only pass card_hint if the customer explicitly stated last digits.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["lock_card", "unlock_card"] },
        card_hint: { type: "string", description: "Last 4 digits IF and ONLY IF the customer stated them." },
      },
      required: ["action"],
    },
  },
};

function readManifest(): { agentId?: string } {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf-8")); } catch { return {}; }
}

function evalPassRate(): number | null {
  try {
    const sc = JSON.parse(fs.readFileSync(path.join(process.cwd(), "evals", "results", "scorecard.json"), "utf-8"));
    return sc.totalPassed / sc.itemCount;
  } catch { return null; }
}

async function main() {
  const existingId = readManifest().agentId;

  let agent;
  try {
    if (existingId) {
      // New VERSION of the existing agent (idempotent re-register).
      agent = await withLimit(() =>
        client.beta.agents.update({
          agentId: existingId,
          agentUpdateRequest: { instructions: INSTRUCTIONS, tools: [CARD_TOOL], description: DESCRIPTION, model: MODEL },
        }),
      );
      console.log(`Updated agent ${agent.id} → new version ${agent.version}.`);
    } else {
      agent = await withLimit(() =>
        client.beta.agents.create({
          model: MODEL,
          name: AGENT_NAME,
          instructions: INSTRUCTIONS,
          tools: [CARD_TOOL],
          description: DESCRIPTION,
          versionMessage: "Initial registration from the L1 conversation lane.",
        }),
      );
      console.log(`Created agent ${agent.id} (version ${agent.version}).`);
    }
  } catch (err: any) {
    console.error("\n[studio] Agents API (beta) call FAILED. The L1 demo is unaffected (ASSISTANT_MODE=direct).");
    console.error("[studio] status:", err?.statusCode, "body:", typeof err?.body === "string" ? err.body : JSON.stringify(err?.body ?? err?.message));
    process.exit(1);
  }

  const latest = agent.version;

  // L4 - aliases. dev → latest always; prod → latest only if evals pass the bar.
  const rate = evalPassRate();
  const promoteProd = rate !== null && rate >= PROMOTION_BAR;

  await withLimit(() => client.beta.agents.createVersionAlias({ agentId: agent.id, alias: "dev", version: latest }));
  console.log(`Alias dev → version ${latest}.`);

  if (promoteProd) {
    await withLimit(() => client.beta.agents.createVersionAlias({ agentId: agent.id, alias: "prod", version: latest }));
    console.log(`Alias prod → version ${latest} (evals ${(rate! * 100).toFixed(0)}% ≥ ${PROMOTION_BAR * 100}% bar).`);
  } else {
    const why = rate === null ? "no eval results yet (run npm run eval)" : `evals ${(rate * 100).toFixed(0)}% < ${PROMOTION_BAR * 100}% bar`;
    console.log(`Alias prod NOT promoted: ${why}. Prod only moves when the campaign passes.`);
  }

  fs.writeFileSync(
    MANIFEST,
    JSON.stringify({ agentId: agent.id, name: AGENT_NAME, latestVersion: latest, aliases: { dev: latest, prod: promoteProd ? latest : "unchanged" }, updatedAt: new Date().toISOString() }, null, 2),
  );
  console.log(`\nManifest written → data/studio-agent.json. Run npm run studio:status for the console view.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
