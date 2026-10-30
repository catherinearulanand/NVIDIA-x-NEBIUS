// Nebius Token Factory adapter (OpenAI-compatible chat completions API).
// The API key stays on the server; the browser never sees it.

export const TASK_INTERPRETATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tasks", "missingInformation"],
  properties: {
    tasks: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "sourceId",
          "sourceVersion",
          "title",
          "proposedDeadline",
          "proposedDurationMinutes",
          "proposedPriority",
          "prerequisiteSourceIds",
          "rationale",
          "needsConfirmation",
        ],
        properties: {
          sourceId: { type: "string" },
          sourceVersion: { type: "integer" },
          title: { type: "string" },
          proposedDeadline: { type: ["string", "null"] },
          proposedDurationMinutes: { type: ["integer", "null"] },
          proposedPriority: { type: "string", enum: ["high", "medium", "low"] },
          prerequisiteSourceIds: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
          needsConfirmation: { type: "array", items: { type: "string" } },
        },
      },
    },
    missingInformation: { type: "array", items: { type: "string" } },
  },
};

export function nebiusConfig(env = process.env) {
  return {
    apiKey: env.NEBIUS_API_KEY || "",
    baseUrl: (env.NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1/").replace(/\/?$/, "/"),
    model: env.NEBIUS_MODEL_ID || "",
    extraBody: env.NEBIUS_EXTRA_BODY ? JSON.parse(env.NEBIUS_EXTRA_BODY) : {},
    timeoutMs: Number(env.NEBIUS_TIMEOUT_MS || 30000),
    maxTokens: Number(env.NEBIUS_MAX_TOKENS || 2000),
  };
}

export function isConfigured(cfg) {
  return Boolean(cfg.apiKey && cfg.model);
}

// Pulls a JSON object out of a completion, tolerating reasoning tags or a
// fenced block around it.
export function extractJson(text) {
  if (typeof text !== "string") throw new Error("The model returned no text.");
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last <= first) throw new Error("The model reply did not contain a JSON object.");
  return JSON.parse(t.slice(first, last + 1));
}

async function post(cfg, body, fetchImpl) {
  const res = await fetchImpl(`${cfg.baseUrl}chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Nebius returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

/**
 * Sends exactly `messages` (the approved disclosure) and returns the parsed
 * interpretation plus usage metadata. Tries strict JSON-schema output first
 * and falls back to JSON mode if the endpoint rejects response_format.
 */
export async function interpretTasks(cfg, messages, fetchImpl = fetch) {
  if (!isConfigured(cfg)) throw new Error("Nebius is not configured. Set NEBIUS_API_KEY and NEBIUS_MODEL_ID.");
  const started = Date.now();
  const base = { model: cfg.model, messages, max_tokens: cfg.maxTokens, temperature: 0.2, ...cfg.extraBody };
  let mode = "json_schema";
  let completion;
  try {
    completion = await post(
      cfg,
      {
        ...base,
        response_format: {
          type: "json_schema",
          json_schema: { name: "task_interpretation", strict: true, schema: TASK_INTERPRETATION_SCHEMA },
        },
      },
      fetchImpl,
    );
  } catch (e) {
    if (e.status !== 400 && e.status !== 422) throw e;
    mode = "json_object";
    completion = await post(cfg, { ...base, response_format: { type: "json_object" } }, fetchImpl);
  }
  const choice = completion.choices?.[0];
  if (!choice) throw new Error("The model returned no choices.");
  if (choice.finish_reason === "length") throw new Error("The model reply was cut off before it finished.");
  const parsed = extractJson(choice.message?.content);
  return {
    parsed,
    meta: {
      model: completion.model || cfg.model,
      mode,
      latencyMs: Date.now() - started,
      usage: completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          }
        : null,
    },
  };
}

export async function listModels(cfg, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.baseUrl}models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) throw new Error(`Nebius returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return (body.data ?? []).map((m) => m.id);
}
