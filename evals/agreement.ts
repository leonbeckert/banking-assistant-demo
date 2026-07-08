// Judge-vs-human agreement. Reads evals/anchor/anchor-items.json (after Leon has
// filled the 'human_label' fields) and computes the fraction where the system's
// AUTOMATED verdict agrees with the human label. Patches results/scorecard.json
// so the /scorecard page shows the number instead of "pending human labels".
import "./_env";
import fs from "fs";
import path from "path";

const EVAL_DIR = path.join(process.cwd(), "evals");
const ANCHOR_FILE = path.join(EVAL_DIR, "anchor", "anchor-items.json");
const SCORECARD_FILE = path.join(EVAL_DIR, "results", "scorecard.json");

interface AnchorItem { id: string; automated_verdict: string; human_label: string }

function main() {
  if (!fs.existsSync(ANCHOR_FILE)) {
    console.error("No anchor file. Run `npm run eval` first to generate evals/anchor/anchor-items.json.");
    process.exit(1);
  }
  const anchor = JSON.parse(fs.readFileSync(ANCHOR_FILE, "utf-8")) as { items: AnchorItem[] };
  const labeled = anchor.items.filter((i) => i.human_label === "pass" || i.human_label === "fail");

  if (labeled.length === 0) {
    console.log("No human labels filled yet. Edit evals/anchor/anchor-items.json - set human_label to \"pass\" or \"fail\" for each item (~10 min).");
    console.log(`${anchor.items.length} items awaiting labels.`);
    process.exit(0);
  }

  const agree = labeled.filter((i) => i.human_label === i.automated_verdict).length;
  const agreement = agree / labeled.length;
  console.log(`Judge ↔ human agreement: ${agree}/${labeled.length} = ${(agreement * 100).toFixed(0)}%`);
  if (labeled.length < anchor.items.length) {
    console.log(`(${anchor.items.length - labeled.length} of ${anchor.items.length} anchor items still unlabeled.)`);
  }
  if (agreement < 0.8) {
    console.log("WARNING: Below ~0.8 - do not trust the judged categories until the judge prompt is fixed.");
  }

  if (fs.existsSync(SCORECARD_FILE)) {
    const sc = JSON.parse(fs.readFileSync(SCORECARD_FILE, "utf-8"));
    sc.judgeAgreement = { pending: false, agreement, n: labeled.length };
    fs.writeFileSync(SCORECARD_FILE, JSON.stringify(sc, null, 2));
    console.log("Patched evals/results/scorecard.json (judge ↔ human agreement).");
  }
}

main();
