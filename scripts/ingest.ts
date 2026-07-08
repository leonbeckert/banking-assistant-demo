// Re-ingestion for the curious ("npm run setup"). Embeds the curated corpus once
// via Mistral Embed and writes the PRE-BUILT vector index to data/faq-index.json.
// That index is committed, so a fresh clone runs WITHOUT ingestion - the app loads
// the index and only ever embeds the per-query vector at runtime. Running setup
// again simply regenerates the index (swapping the corpus = replace faq-corpus.json
// then re-run). Prints similarity self-checks so you can see retrieval working.
import "../evals/_env";
import fs from "fs";
import path from "path";
import { Mistral } from "@mistralai/mistralai";

const apiKey = process.env.MISTRAL_API_KEY;
if (!apiKey) {
  console.error("Set MISTRAL_API_KEY (copy .env.local.example → .env.local). Aborting.");
  process.exit(1);
}
const client = new Mistral({ apiKey });

const CORPUS_FILE = path.join(process.cwd(), "data", "faq-corpus.json");
const INDEX_FILE = path.join(process.cwd(), "data", "faq-index.json");

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  const corpus = JSON.parse(fs.readFileSync(CORPUS_FILE, "utf-8")) as {
    version: string;
    chunks: { id: string; title: string; text: string; language?: string }[];
  };
  console.log(`Corpus: ${corpus.version} - ${corpus.chunks.length} chunks`);

  const inputs = corpus.chunks.map((c) => `${c.title}\n${c.text}`);
  const res = await client.embeddings.create({ model: "mistral-embed", inputs });
  const vectors = res.data.map((d, i) => ({ id: corpus.chunks[i].id, vector: d.embedding as number[] }));
  const dim = vectors[0].vector.length;
  console.log(`Embedded ${vectors.length} chunks (dim ${dim}).`);

  const index = { model: "mistral-embed", dim, version: corpus.version, vectors };
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
  console.log(`Wrote pre-built index → ${path.relative(process.cwd(), INDEX_FILE)} (${(fs.statSync(INDEX_FILE).size / 1024).toFixed(0)} KB).`);

  // Self-check: probe a few queries (incl. French + cross-lingual) against the index.
  const probes = [
    "how do I lock my card",
    "what should I do if my card is lost or stolen",
    "comment faire opposition sur ma carte",
    "how do I check my balance",
  ];
  for (const q of probes) {
    const qr = await client.embeddings.create({ model: "mistral-embed", inputs: [q] });
    const qv = qr.data[0].embedding as number[];
    const ranked = vectors
      .map((v) => ({ id: v.id, score: cosine(qv, v.vector) }))
      .sort((a, b) => b.score - a.score);
    console.log(`"${q}" → ${ranked[0].id} (${ranked[0].score.toFixed(3)}), ${ranked[1].id} (${ranked[1].score.toFixed(3)})`);
  }
  console.log("\nIngestion complete. The committed index means clone-and-run needs no ingestion.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
