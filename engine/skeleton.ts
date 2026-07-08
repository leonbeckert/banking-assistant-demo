// Degradation skeleton - the "absorbed Telmi" deterministic flows.
// NO LLM CALL IS EVER MADE HERE. This is what keeps the front door open when
// inference is down: FAQ answers served VERBATIM from the governed corpus chunk
// (no generation), the card-lock button riding the existing deterministic engine,
// and a direct human route. Same product, degraded surface - not a second brain.
import fs from "fs";
import path from "path";
import type { Citation } from "@/app/lib/contract";

interface Chunk {
  id: string;
  title: string;
  url: string;
  text: string;
  language?: string;
  topic?: string;
}

let chunks: Chunk[] | null = null;
function loadChunks(): Chunk[] {
  if (chunks) return chunks;
  const c = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "faq-corpus.json"), "utf-8"));
  chunks = c.chunks as Chunk[];
  return chunks;
}

export interface SkeletonFaq {
  id: string;
  question: string; // the tappable label
  chunkId: string; // the governed corpus chunk answered verbatim
}

// The 6 top questions the skeleton can answer directly from the corpus (English,
// for the English demo UI). Verbatim chunk text, real citation, zero generation.
export const SKELETON_FAQS: SkeletonFaq[] = [
  { id: "lost", question: "My card is lost or stolen - what do I do?", chunkId: "faq_002" },
  { id: "balance", question: "How do I check my balance?", chunkId: "faq_014" },
  { id: "hours", question: "What are the phone support hours?", chunkId: "faq_018" },
  { id: "appointment", question: "How do I book an advisor appointment?", chunkId: "faq_022" },
  { id: "cle", question: "What is the Clé Digitale?", chunkId: "faq_024" },
  { id: "complaint", question: "How do I file a complaint?", chunkId: "faq_038" },
];

export function skeletonFaqList(): SkeletonFaq[] {
  return SKELETON_FAQS;
}

// Verbatim answer from the governed chunk, plus its citation. No model in the loop.
export function skeletonAnswer(chunkId: string): { text: string; citation: Citation } | null {
  const ch = loadChunks().find((c) => c.id === chunkId);
  if (!ch) return null;
  return { text: ch.text, citation: { id: ch.id, title: ch.title, url: ch.url, score: 1 } };
}
