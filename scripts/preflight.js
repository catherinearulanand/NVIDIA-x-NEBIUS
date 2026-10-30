// Checks the Nebius Token Factory setup before a demo:
//   1. lists the NVIDIA models this key can see
//   2. sends one small synthetic planning request to NEBIUS_MODEL_ID
// Usage: npm run preflight   (reads .env or the environment)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nebiusConfig, listModels, interpretTasks } from "../src/nebius.js";
import { validateInterpretation } from "../src/validate.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const cfg = nebiusConfig();
if (!cfg.apiKey) {
  console.error("NEBIUS_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

console.log(`Endpoint: ${cfg.baseUrl}`);
try {
  const models = await listModels(cfg);
  const nvidia = models.filter((m) => /nvidia|nemotron/i.test(m));
  console.log(`\nNVIDIA models available to this key (${nvidia.length}):`);
  for (const m of nvidia) console.log(`  ${m}`);
  if (!cfg.model) {
    console.log("\nSet NEBIUS_MODEL_ID to one of the IDs above (a Nemotron Nano model is the suggested start), then run this again.");
    process.exit(1);
  }
  if (!models.includes(cfg.model)) console.warn(`\nWarning: ${cfg.model} is not in the list above.`);
} catch (e) {
  console.error(`Could not list models: ${e.message}`);
}

const messages = [
  { role: "system", content: "Reply with JSON only matching the task_interpretation schema. One entry per sourceId. Resolve relative deadlines with today's date and timezone." },
  {
    role: "user",
    content: JSON.stringify({
      today: new Date().toISOString().slice(0, 10),
      timezone: "Asia/Kolkata",
      tasks: [
        { sourceId: "src_a", sourceVersion: 1, title: "Write essay outline", text: "Outline for the history essay, due Friday. About an hour.", userDeadline: null, userDurationMinutes: null },
        { sourceId: "src_b", sourceVersion: 1, title: "Write essay draft", text: "Needs the outline first.", userDeadline: null, userDurationMinutes: null },
      ],
      memories: [],
    }),
  },
];

console.log(`\nSending a synthetic request to ${cfg.model}…`);
try {
  const { parsed, meta } = await interpretTasks(cfg, messages);
  const v = validateInterpretation(parsed, new Map([["src_a", 1], ["src_b", 1]]));
  console.log(`OK in ${meta.latencyMs} ms using ${meta.mode} output. Model reported: ${meta.model}`);
  if (meta.usage) console.log(`Tokens: ${meta.usage.promptTokens} in, ${meta.usage.completionTokens} out`);
  console.log(JSON.stringify(v, null, 2));
  if (!v.tasks.length) {
    console.error("\nThe reply was valid JSON but contained no usable tasks.");
    process.exit(1);
  }
  console.log("\nPreflight passed. Record the model ID above in your submission notes.");
} catch (e) {
  console.error(`\nPreflight failed: ${e.message}`);
  console.error("If the reply was cut off, try NEBIUS_MAX_TOKENS=4000. If the model spends tokens reasoning, see NEBIUS_EXTRA_BODY in the README.");
  process.exit(1);
}
