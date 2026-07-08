// Prints the registered Studio agent's id, versions, and aliases - the
// screenshot-worthy L4 view. Reads data/studio-agent.json for the agent id, then
// queries the live Agents API (beta). Run: `npm run studio:status`.
import "../evals/_env";
process.env.MISTRAL_MIN_INTERVAL_MS = process.env.STUDIO_RATE_MS ?? "1200";
import fs from "fs";
import path from "path";
import { Mistral } from "@mistralai/mistralai";
import { withLimit } from "@/assistant/client";

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! });
const MANIFEST = path.join(process.cwd(), "data", "studio-agent.json");

async function main() {
  let agentId: string | undefined;
  try { agentId = JSON.parse(fs.readFileSync(MANIFEST, "utf-8")).agentId; } catch { /* none */ }
  if (!agentId) {
    console.log("No Studio agent registered. Run `npm run studio:register` first.");
    process.exit(0);
  }

  try {
    const agent = await withLimit(() => client.beta.agents.get({ agentId }));
    const aliases = await withLimit(() => client.beta.agents.listVersionAliases({ agentId }));

    console.log("Studio agent (beta) - L2 + L4");
    console.log("──────────────────────────────────────────────");
    console.log(`id:          ${agent.id}`);
    console.log(`name:        ${agent.name}`);
    console.log(`model:       ${agent.model}`);
    console.log(`current ver: ${agent.version}`);
    console.log(`versions:    [${(agent.versions ?? []).join(", ")}]`);
    console.log(`tools:       ${(agent.tools ?? []).map((t: any) => t.function?.name ?? t.type).join(", ") || "(none)"}`);
    console.log(`aliases:`);
    for (const a of aliases) console.log(`  ${a.alias.padEnd(6)} → version ${a.version}`);
    console.log("──────────────────────────────────────────────");
    console.log("Promotion rule: dev tracks newest; prod moves only when the evals pass.");
  } catch (err: any) {
    console.error("[studio] status call FAILED. status:", err?.statusCode, "body:", typeof err?.body === "string" ? err.body : JSON.stringify(err?.body ?? err?.message));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
