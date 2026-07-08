// GOLD-SET RUNNER - component-level classification accuracy against human labels.
//
// The gold set (evals/gold/gold-set.json) holds input -> expected pairs for the
// two classifiers: input moderation (pass | de_escalate | refuse) and the gate
// (intent + derived route). Labels attach to the INPUT + policy, not to any model
// output - so this baseline survives model/prompt/temperature changes and is the
// regression instrument for swaps (e.g. gate 3b -> 14b is a measured accuracy
// delta here, not a smoke test).
//
// No generation, no judge: ~2 API calls per row (moderation + gate), whole set
// in a few minutes. Run: npm run gold   (or: npx tsx evals/gold.ts --limit 6)
import "./_env";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { moderateInput, frustrationSignal } from "../assistant/moderation";
import { runGate } from "../assistant/gate";
import { routeFor, routeEnumFor, shouldClarify } from "../engine/policy";
import { resetUsage, snapshotUsage } from "../assistant/client";
import { costEur } from "./pricing";

interface GoldRow {
  id: string;
  input: string;
  lang: string;
  expected_moderation: "pass" | "de_escalate" | "refuse";
  expected_intent: string | null;
  expected_route: string | null;
  expected_read?: "balance" | "transactions";
  note: string;
  status: "proposed" | "ratified";
  labeled_by: string;
  labeled_at: string;
}

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const doc = JSON.parse(readFileSync(new URL("./gold/gold-set.json", import.meta.url), "utf8"));
const rows: GoldRow[] = doc.items.slice(0, limit);

(async () => {
  resetUsage();
  let modOk = 0, intentOk = 0, routeOk = 0, intentTotal = 0, readOk = 0, readTotal = 0;
  const confusions: string[] = [];
  interface Miss { id: string; kind: "moderation" | "intent" | "route" | "read"; expected: string; got: string; input: string }
  const misses: Miss[] = [];

  for (const r of rows) {
    // Mirror the pipeline's moderation outcome: severe short-circuits (refuse),
    // the deterministic frustration signal de-escalates, everything else passes.
    const verdict = await moderateInput(r.input);
    const modActual =
      verdict.routing === "severe" ? "refuse"
      : verdict.routing === "unavailable" ? "unavailable"
      : frustrationSignal(r.input) ? "de_escalate"
      : "pass";
    const modPass = modActual === r.expected_moderation;
    if (modPass) modOk++;
    else misses.push({ id: r.id, kind: "moderation", expected: r.expected_moderation, got: modActual, input: r.input });

    let intentActual = "-", routeActual = "-", intentPass = true, routePass = true;
    if (r.expected_moderation !== "refuse") {
      // Severe inputs never reach the gate (pipeline short-circuit) - mirrored here.
      intentTotal++;
      const gate = await runGate(r.input);
      intentActual = gate.intent;
      routeActual = shouldClarify(gate, r.input) ? "clarify" : routeEnumFor(gate, routeFor(gate));
      intentPass = intentActual === r.expected_intent;
      routePass = routeActual === r.expected_route;
      if (intentPass) intentOk++;
      if (routePass) routeOk++;
      if (r.expected_read) {
        readTotal++;
        if (gate.readTarget === r.expected_read) readOk++;
        else {
          confusions.push(`${r.id}: expected read ${r.expected_read} got ${gate.readTarget}, input "${r.input}"`);
          misses.push({ id: r.id, kind: "read", expected: r.expected_read, got: gate.readTarget ?? "-", input: r.input });
        }
      }
      if (!intentPass || !routePass) {
        confusions.push(`${r.id}: expected ${r.expected_intent}/${r.expected_route} got ${intentActual}/${routeActual}, input "${r.input}"`);
        if (!intentPass) misses.push({ id: r.id, kind: "intent", expected: String(r.expected_intent), got: intentActual, input: r.input });
        if (!routePass) misses.push({ id: r.id, kind: "route", expected: String(r.expected_route), got: routeActual, input: r.input });
      }
    }

    const ok = modPass && intentPass && routePass;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${r.id.padEnd(13)} mod ${modPass ? "✓" : `✗ ${modActual}`}  ` +
      (r.expected_moderation === "refuse" ? "(gate never runs)" : `intent ${intentPass ? "✓" : `✗ ${intentActual}`}  route ${routePass ? "✓" : `✗ ${routeActual}`}`),
    );
  }

  const proposed = rows.filter((r) => r.status !== "ratified").length;
  console.log(`\n${"═".repeat(64)}`);
  console.log(`GOLD SET (${rows.length} rows)`);
  console.log(`  moderation: ${modOk}/${rows.length}`);
  console.log(`  intent:     ${intentOk}/${intentTotal}`);
  console.log(`  route:      ${routeOk}/${intentTotal}`);
  if (readTotal) console.log(`  read target: ${readOk}/${readTotal} (balance vs transactions - gate read_target vs expected_read)`);
  if (confusions.length) {
    console.log(`\nMisses:`);
    for (const c of confusions) console.log(`  ${c}`);
  }
  // Input-screening cost, measured from the run's own moderation usage (billed
  // input-only; totalTokens basis). This is the "screen" part of the per-turn cost -
  // the full suite runs screening OFF, so this run is where it gets measured.
  const modUsage = Object.fromEntries(
    Object.entries(snapshotUsage()).filter(([m]) => m.includes("moderation")),
  );
  const screeningTokens = Object.values(modUsage).reduce((a, u) => a + u.promptTokens, 0);
  const screening = {
    model: Object.keys(modUsage)[0] ?? "mistral-moderation-latest",
    tokens: screeningTokens,
    costEurPerTurn: rows.length ? costEur(modUsage) / rows.length : 0,
  };
  console.log(`  screening cost: ~€${screening.costEurPerTurn.toFixed(7)}/turn (${screeningTokens} moderation tokens over ${rows.length} rows)`);

  // Structured artifact for the scorecard page - same numbers as the console output.
  if (!Number.isFinite(limit)) {
    mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
    writeFileSync(
      new URL("./results/gold-results.json", import.meta.url),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        itemCount: rows.length,
        moderation: { ok: modOk, total: rows.length },
        intent: { ok: intentOk, total: intentTotal },
        route: { ok: routeOk, total: intentTotal },
        read: { ok: readOk, total: readTotal },
        misses,
        screening,
        ratified: proposed === 0,
        ratifiedBy: proposed === 0 ? [...new Set(rows.map((r) => r.labeled_by))].join(", ") : null,
        labeledAt: rows.map((r) => r.labeled_at).sort().at(-1) ?? null,
      }, null, 2),
    );
  }

  if (proposed > 0) {
    console.log(`\nWARNING: ${proposed}/${rows.length} labels are PROPOSED, not yet human-ratified - this is not a gold baseline until every row is ratified.`);
  } else {
    const by = [...new Set(rows.map((r) => r.labeled_by))].join(", ");
    console.log(`\nLabels human-ratified by ${by}.`);
  }
})();
