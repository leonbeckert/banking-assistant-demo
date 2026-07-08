// Dependency-free .env.local loader for the offline scripts (tsx does not load it
// the way `next dev` does). Import this FIRST in every eval script.
import fs from "fs";
import path from "path";

const envFile = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

if (!process.env.MISTRAL_API_KEY) {
  console.error("MISTRAL_API_KEY not set. Copy .env.local.example → .env.local and add your Mistral Studio key.");
  process.exit(1);
}
