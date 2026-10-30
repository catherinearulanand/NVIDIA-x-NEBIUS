// Domain logic for one vault: sources, versioned memory, disclosure and
// approval, planning, committed actions, scheduled review and activity.
// Every function takes the vault object and mutates it; the caller saves.

import crypto from "node:crypto";
import { newId } from "./store.js";
import { buildPlan } from "./planner.js";
import { validateInterpretation } from "./validate.js";
import { interpretTasks } from "./nebius.js";
import { localDateOf, localTimeOf, zonedToDate, addDays, weekdayOf, toZonedIso } from "./time.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DISCLOSURE_TTL_MS = 15 * 60000;
const CATCH_UP_MS = 2 * 3600000;
const USES = new Set(["planning", "cloud_inference", "local_reply"]);
const SETTINGS = { focusBlockMinutes: [10, 90], breakMinutes: [0, 30], minBlockMinutes: [5, 30] };

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const textHash = (src) => sha(`${src.title}\n${src.body}`).slice(0, 16);

export function log(vault, type, detail = {}) {
  vault.activity.push({ id: newId("act"), at: new Date().toISOString(), type, detail });
  if (vault.activity.length > 300) vault.activity.splice(0, vault.activity.length - 300);
}

function bump(vault) {
  vault.revision += 1;
}

function findSource(vault, id) {
  const s = vault.sources.find((x) => x.id === id && x.status !== "deleted");
  if (!s) throw new HttpError(404, "Source not found.");
  return s;
}

function findMemory(vault, id) {
  const m = vault.memories.find((x) => x.id === id);
  if (!m) throw new HttpError(404, "Memory not found.");
  return m;
}

function findPlan(vault, id) {
  const p = vault.plans.find((x) => x.id === id);
  if (!p) throw new HttpError(404, "Plan not found.");
  return p;
}

// ---------- sources ----------

function cleanText(v, max, field) {
  if (typeof v !== "string") throw new HttpError(400, `${field} must be text.`);
  const t = v.trim();
  if (!t && field === "Title") throw new HttpError(400, "Title is required.");
  if (t.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters).`);
  return t;
}

function cleanSourceFields(input, existing = {}) {
  const out = {};
  if ("title" in input) out.title = cleanText(input.title, 120, "Title");
  if ("body" in input) out.body = cleanText(input.body ?? "", 2000, "Text");
  if ("deadline" in input) {
    if (input.deadline === null || input.deadline === "") out.deadline = null;
    else if (!Number.isFinite(Date.parse(input.deadline))) throw new HttpError(400, "Deadline is not a valid date.");
    else out.deadline = new Date(input.deadline).toISOString();
  }
  if ("durationMinutes" in input) {
    const d = input.durationMinutes;
    if (d === null || d === "") out.durationMinutes = null;
    else if (!Number.isInteger(Number(d)) || d < 5 || d > 480) throw new HttpError(400, "Duration must be 5 to 480 minutes.");
    else out.durationMinutes = Number(d);
  }
  if ("priority" in input) {
    if (input.priority && !["high", "medium", "low"].includes(input.priority)) throw new HttpError(400, "Invalid priority.");
    out.priority = input.priority || null;
  }
  for (const k of ["selected", "allowCloud", "private"]) if (k in input) out[k] = Boolean(input[k]);
  if (out.private ?? existing.private) out.allowCloud = false;
  if ("events" in input) {
    if (!Array.isArray(input.events) || input.events.length > 30) throw new HttpError(400, "Invalid events.");
    out.events = input.events.map((e) => {
      const start = Date.parse(e.start);
      const end = Date.parse(e.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new HttpError(400, "Each event needs a start before its end.");
      return { id: e.id || newId("ev"), title: cleanText(e.title || "Busy", 80, "Event title"), start: new Date(start).toISOString(), end: new Date(end).toISOString() };
    });
  }
  return out;
}

export function createSource(vault, input) {
  const kind = ["task", "note", "calendar"].includes(input.kind) ? input.kind : "task";
  if (vault.sources.filter((s) => s.status !== "deleted").length >= 40) throw new HttpError(400, "This vault is full.");
  const now = new Date().toISOString();
  const src = {
    id: newId("src"),
    kind,
    title: "",
    body: "",
    version: 1,
    status: "open",
    selected: kind !== "note",
    allowCloud: kind === "task",
    private: false,
    deadline: null,
    durationMinutes: null,
    priority: null,
    prerequisites: [],
    events: [],
    createdAt: now,
    updatedAt: now,
    ...cleanSourceFields({ body: "", ...input }),
  };
  if (!src.title) throw new HttpError(400, "Title is required.");
  vault.sources.push(src);
  bump(vault);
  log(vault, "source.created", { sourceId: src.id, kind });
  return src;
}

export function updateSource(vault, id, input) {
  const src = findSource(vault, id);
  if (input.expectedVersion != null && input.expectedVersion !== src.version) {
    throw new HttpError(409, "This item changed since you opened it. Reload and try again.");
  }
  Object.assign(src, cleanSourceFields(input, src));
  src.version += 1;
  src.updatedAt = new Date().toISOString();
  bump(vault);
  log(vault, "source.updated", { sourceId: id, version: src.version, fields: Object.keys(input).filter((k) => k !== "expectedVersion") });
  return src;
}

export function setSourceDone(vault, id, done) {
  const src = findSource(vault, id);
  src.status = done ? "done" : "open";
  src.version += 1;
  src.updatedAt = new Date().toISOString();
  bump(vault);
  log(vault, done ? "task.completed" : "task.reopened", { sourceId: id });
  return src;
}

// Forgetting: wipe content, invalidate derived plans and pending sends.
export function deleteSource(vault, id) {
  const src = findSource(vault, id);
  src.status = "deleted";
  src.title = "";
  src.body = "";
  src.events = [];
  src.version += 1;
  bump(vault);
  vault.disclosures = vault.disclosures.filter((d) => !d.sourceIds.includes(id));
  let cancelled = 0;
  for (const r of vault.reminders) {
    if (r.taskId === id && r.status === "scheduled") {
      r.status = "cancelled";
      cancelled += 1;
    }
    if (r.taskId === id) r.title = "(forgotten item)";
  }
  for (const p of vault.plans) {
    if (!(id in p.inputVersions)) continue;
    p.blocks = p.blocks.map((b) => (b.taskId === id ? { ...b, title: "(forgotten item)" } : b));
    p.unscheduled = p.unscheduled.map((u) => (u.taskId === id ? { ...u, title: "(forgotten item)", reason: "" } : u));
    if (p.interpretation) p.interpretation.tasks = p.interpretation.tasks.filter((t) => t.sourceId !== id);
    delete p.explanations[id];
    if (p.state === "draft") p.state = "stale";
  }
  for (const r of vault.reviews) {
    r.items = r.items.map((i) => (i.taskId === id ? { ...i, title: "(forgotten item)" } : i));
  }
  log(vault, "source.forgotten", { sourceId: id, remindersCancelled: cancelled });
  return { ok: true, remindersCancelled: cancelled };
}

// ---------- memory ----------

function cleanMemory(input) {
  const value = cleanText(input.value ?? "", 280, "Memory");
  if (!value) throw new HttpError(400, "Memory text is required.");
  const allowedUses = Array.isArray(input.allowedUses) ? [...new Set(input.allowedUses.filter((u) => USES.has(u)))] : ["planning"];
  let setting = null;
  if (input.setting) {
    const range = SETTINGS[input.setting.name];
    const v = Number(input.setting.value);
    if (!range) throw new HttpError(400, "Unknown setting.");
    if (!Number.isInteger(v) || v < range[0] || v > range[1]) throw new HttpError(400, `${input.setting.name} must be between ${range[0]} and ${range[1]}.`);
    setting = { name: input.setting.name, value: v };
  }
  const kind = ["preference", "commitment", "project_fact"].includes(input.kind) ? input.kind : "preference";
  return { value, allowedUses, setting, kind };
}

export function createMemory(vault, input) {
  if (vault.memories.filter((m) => m.status === "active").length >= 30) throw new HttpError(400, "Too many memories.");
  const now = new Date().toISOString();
  const m = {
    id: newId("mem"),
    version: 1,
    status: "active",
    provenance: input.provenance === "user_confirmed_extraction" ? "user_confirmed_extraction" : "user_entered",
    sourceIds: [],
    validFrom: now,
    validUntil: null,
    supersedesId: null,
    createdAt: now,
    ...cleanMemory(input),
  };
  vault.memories.push(m);
  bump(vault);
  log(vault, "memory.saved", { memoryId: m.id, kind: m.kind, allowedUses: m.allowedUses });
  return m;
}

// Correction creates a new version and supersedes the old one.
export function correctMemory(vault, id, input) {
  const old = findMemory(vault, id);
  if (old.status !== "active") throw new HttpError(409, "Only the current version of a memory can be corrected.");
  if (input.expectedVersion != null && input.expectedVersion !== old.version) throw new HttpError(409, "This memory changed since you opened it.");
  const now = new Date().toISOString();
  const merged = cleanMemory({ kind: old.kind, setting: old.setting, allowedUses: old.allowedUses, value: old.value, ...input });
  old.status = "superseded";
  old.validUntil = now;
  const m = {
    ...old,
    ...merged,
    id: newId("mem"),
    version: old.version + 1,
    status: "active",
    provenance: "user_entered",
    validFrom: now,
    validUntil: null,
    supersedesId: old.id,
    createdAt: now,
  };
  vault.memories.push(m);
  bump(vault);
  log(vault, "memory.corrected", { memoryId: m.id, supersedes: old.id, version: m.version });
  return m;
}

export function deleteMemory(vault, id) {
  const m = findMemory(vault, id);
  // Forget the whole lineage, not just the current version.
  const lineage = new Set([m.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const x of vault.memories) {
      if ((lineage.has(x.supersedesId) || lineage.has(x.id)) && !lineage.has(x.id)) {
        lineage.add(x.id);
        changed = true;
      }
      if (lineage.has(x.id) && x.supersedesId && !lineage.has(x.supersedesId)) {
        lineage.add(x.supersedesId);
        changed = true;
      }
    }
  }
  for (const x of vault.memories) {
    if (!lineage.has(x.id)) continue;
    x.status = "deleted";
    x.value = "";
    x.setting = null;
  }
  vault.disclosures = vault.disclosures.filter((d) => !d.memoryIds.some((mid) => lineage.has(mid)));
  for (const p of vault.plans) {
    if (p.memoryRefs.some((r) => lineage.has(r.id))) {
      p.memoryRefs = p.memoryRefs.map((r) => (lineage.has(r.id) ? { ...r, text: "(forgotten memory)" } : r));
      if (p.state === "draft") p.state = "stale";
    }
  }
  bump(vault);
  log(vault, "memory.forgotten", { versions: lineage.size });
  return { ok: true };
}

export function activeMemories(vault, use) {
  return vault.memories.filter((m) => m.status === "active" && (!use || m.allowedUses.includes(use)));
}

function planningPrefs(vault) {
  const prefs = { blockMinutes: 25, breakMinutes: 5, minBlockMinutes: 10 };
  const refs = [];
  for (const m of activeMemories(vault, "planning")) {
    if (m.setting?.name === "focusBlockMinutes") prefs.blockMinutes = m.setting.value;
    if (m.setting?.name === "breakMinutes") prefs.breakMinutes = m.setting.value;
    if (m.setting?.name === "minBlockMinutes") prefs.minBlockMinutes = m.setting.value;
    refs.push({ id: m.id, version: m.version, text: m.value, setting: m.setting, sentToCloud: false });
  }
  return { prefs, refs };
}

// ---------- planning request and disclosure ----------

function cleanRequest(vault, input) {
  const tz = vault.timezone;
  const localDate = /^\d{4}-\d{2}-\d{2}$/.test(input.localDate ?? "") ? input.localDate : localDateOf(new Date(), tz);
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const windowStart = hhmm.test(input.windowStart ?? "") ? input.windowStart : "14:00";
  const windowEnd = hhmm.test(input.windowEnd ?? "") ? input.windowEnd : "18:00";
  if (windowEnd <= windowStart) throw new HttpError(400, "The end time must be after the start time.");
  let effortBudgetMinutes = null;
  if (input.effortBudgetMinutes != null && input.effortBudgetMinutes !== "") {
    const b = Number(input.effortBudgetMinutes);
    if (!Number.isInteger(b) || b < 10 || b > 720) throw new HttpError(400, "Focus budget must be 10 to 720 minutes.");
    effortBudgetMinutes = b;
  }
  return { localDate, windowStart, windowEnd, effortBudgetMinutes, timezone: tz };
}

function planningTasks(vault) {
  return vault.sources.filter((s) => s.kind === "task" && s.status === "open" && s.selected);
}

// Builds the exact payload that would be sent. Nothing is sent here.
export function previewDisclosure(vault, input) {
  const req = cleanRequest(vault, input);
  const tasks = planningTasks(vault);
  const shared = tasks.filter((s) => s.allowCloud && !s.private);
  const excluded = vault.sources
    .filter((s) => s.status !== "deleted" && !shared.includes(s))
    .map((s) => ({
      id: s.id,
      title: s.title,
      reason: s.private
        ? "Marked private"
        : s.kind === "calendar"
          ? "Calendar stays on this device; busy times are applied locally"
          : s.status === "done"
            ? "Already done"
            : !s.selected
              ? "Not selected for planning"
              : "Cloud use not allowed",
    }));
  const memories = activeMemories(vault, "planning").filter((m) => m.allowedUses.includes("cloud_inference"));
  if (!shared.length) throw new HttpError(400, "No tasks are selected and allowed for connected reasoning.");

  const userContent = {
    today: req.localDate,
    weekday: weekdayOf(req.localDate),
    timezone: req.timezone,
    planWindow: `${req.windowStart}-${req.windowEnd}`,
    tasks: shared.map((s) => ({
      sourceId: s.id,
      sourceVersion: s.version,
      title: s.title,
      text: s.body,
      userDeadline: s.deadline ? toZonedIso(new Date(s.deadline), req.timezone) : null,
      userDurationMinutes: s.durationMinutes,
      userPriority: s.priority,
    })),
    memories: memories.map((m) => ({ memoryId: m.id, version: m.version, text: m.value })),
  };
  const messages = [
    {
      role: "system",
      content: [
        "You are the planning interpreter inside MindVault, a personal planner.",
        "Read the user's selected tasks and preferences and reply with JSON only, matching the task_interpretation schema.",
        "Rules:",
        "- Return exactly one entry per given sourceId. Never invent sources. Copy sourceVersion unchanged.",
        "- proposedDeadline: ISO 8601 with offset if the text states or clearly implies a deadline. Resolve words like 'Friday' using today's date, weekday and timezone. Otherwise null. If userDeadline is given, copy it.",
        "- proposedDurationMinutes: your realistic estimate as an integer from 5 to 480, or null if you cannot tell.",
        "- prerequisiteSourceIds: only sourceIds from the input, only when the text says one task needs another first.",
        "- proposedPriority: high, medium or low, considering deadlines and the user's stated priorities.",
        "- rationale: one short sentence explaining the priority, naming the deadline or preference you relied on.",
        "- needsConfirmation: anything you inferred rather than read directly, phrased as a short question for the user.",
        "- missingInformation: questions for the user about information you needed but did not have.",
        "Do not give medical, emotional or diagnostic advice. Do not add commentary outside the JSON.",
      ].join("\n"),
    },
    { role: "user", content: JSON.stringify(userContent, null, 2) },
  ];
  const payloadJson = JSON.stringify(messages);
  const disclosure = {
    id: newId("dis"),
    createdAt: new Date().toISOString(),
    revision: vault.revision,
    request: req,
    sourceIds: shared.map((s) => s.id),
    sourceVersions: Object.fromEntries(shared.map((s) => [s.id, s.version])),
    textHashes: Object.fromEntries(shared.map((s) => [s.id, textHash(s)])),
    memoryIds: memories.map((m) => m.id),
    messages,
    digest: sha(payloadJson),
    bytes: Buffer.byteLength(payloadJson),
    state: "previewed",
  };
  vault.disclosures = vault.disclosures.filter((d) => d.state === "previewed").slice(-4);
  vault.disclosures.push(disclosure);
  log(vault, "disclosure.previewed", { disclosureId: disclosure.id, sources: disclosure.sourceIds.length, memories: disclosure.memoryIds.length, bytes: disclosure.bytes });
  return { disclosure, excluded };
}

function assertFresh(vault, d) {
  if (vault.revision !== d.revision) throw new HttpError(409, "Your vault changed after this preview, so it was not sent. Preview again.");
  for (const [id, v] of Object.entries(d.sourceVersions)) {
    const s = vault.sources.find((x) => x.id === id);
    if (!s || s.version !== v || s.status === "deleted" || !s.allowCloud) throw new HttpError(409, "A shared item changed after the preview. Preview again.");
  }
}

// The user approved this exact payload; send it and build a draft plan.
export async function approveDisclosure(vault, id, digest, cfg, fetchImpl) {
  const d = vault.disclosures.find((x) => x.id === id);
  if (!d || d.state !== "previewed") throw new HttpError(404, "This preview is no longer available. Preview again.");
  if (d.digest !== digest) throw new HttpError(409, "The approved payload does not match the preview.");
  if (Date.now() - Date.parse(d.createdAt) > DISCLOSURE_TTL_MS) throw new HttpError(409, "This preview expired. Preview again.");
  assertFresh(vault, d);
  d.state = "sent";
  log(vault, "inference.requested", { disclosureId: d.id, model: cfg.model, bytes: d.bytes });

  let result;
  try {
    result = await interpretTasks(cfg, d.messages, fetchImpl);
  } catch (e) {
    d.state = "failed";
    log(vault, "inference.failed", { disclosureId: d.id, error: String(e.message).slice(0, 160) });
    throw new HttpError(502, `Connected reasoning failed: ${e.message}`);
  }
  // Discard the response if permissions or inputs changed while waiting.
  assertFresh(vault, d);
  const allowed = new Map(Object.entries(d.sourceVersions));
  const interpretation = validateInterpretation(result.parsed, allowed);
  log(vault, "inference.completed", {
    disclosureId: d.id,
    model: result.meta.model,
    mode: result.meta.mode,
    latencyMs: result.meta.latencyMs,
    usage: result.meta.usage,
    tasksAccepted: interpretation.tasks.length,
    problems: interpretation.problems.length,
  });
  d.messages = null; // keep the digest as a receipt, not the content
  return makePlan(vault, d.request, {
    mode: "connected",
    interpretation,
    textHashes: d.textHashes,
    disclosureId: d.id,
    inference: result.meta,
    sentMemoryIds: d.memoryIds,
  });
}

export function localPlan(vault, input) {
  return makePlan(vault, cleanRequest(vault, input), { mode: "local" });
}

export function rebuildPlan(vault, id) {
  const old = findPlan(vault, id);
  const plan = makePlan(vault, old.request, {
    mode: old.mode,
    interpretation: old.interpretation,
    textHashes: old.textHashes,
    disclosureId: old.disclosureId,
    inference: old.inference,
    sentMemoryIds: old.sentMemoryIds,
    rebuiltFrom: old.id,
  });
  if (old.state === "draft" || old.state === "stale") old.state = "replaced";
  return plan;
}

function makePlan(vault, req, opts) {
  const tz = req.timezone;
  const tasks = planningTasks(vault);
  const interp = new Map();
  const notes = [];
  if (opts.interpretation) {
    for (const t of opts.interpretation.tasks) {
      const s = tasks.find((x) => x.id === t.sourceId);
      if (!s) continue;
      // Only reuse an interpretation of the text the user still has.
      if (opts.textHashes?.[s.id] && opts.textHashes[s.id] !== textHash(s)) {
        notes.push(`"${s.title}" was edited after Nemotron read it; run connected planning again to refresh it.`);
        continue;
      }
      interp.set(s.id, t);
    }
  }
  const { prefs, refs } = planningPrefs(vault);
  for (const r of refs) r.sentToCloud = Boolean(opts.sentMemoryIds?.includes(r.id));

  const explanations = {};
  const planTasks = tasks.map((s) => {
    const t = interp.get(s.id);
    const ex = [];
    let deadline = s.deadline;
    let deadlineConfirmed = Boolean(s.deadline);
    if (s.deadline) ex.push({ basis: "fact", text: `Deadline ${fmt(s.deadline, tz)} (your entry, version ${s.version}).` });
    else if (t?.proposedDeadline) {
      deadline = t.proposedDeadline;
      deadlineConfirmed = false;
      ex.push({ basis: "nemotron", text: `Nemotron read the deadline as ${fmt(t.proposedDeadline, tz)}. Not confirmed yet.`, confirm: { field: "deadline", value: t.proposedDeadline } });
    } else ex.push({ basis: "fact", text: "I do not have a confirmed deadline for this." });

    if (s.durationMinutes) ex.push({ basis: "fact", text: `${s.durationMinutes} minutes (your estimate).` });
    else if (t?.proposedDurationMinutes) ex.push({ basis: "nemotron", text: `Nemotron suggests about ${t.proposedDurationMinutes} minutes.`, confirm: { field: "durationMinutes", value: t.proposedDurationMinutes } });

    const prerequisites = [...new Set([...(s.prerequisites ?? []), ...(t?.prerequisiteSourceIds ?? [])])];
    for (const p of t?.prerequisiteSourceIds ?? []) {
      const ps = vault.sources.find((x) => x.id === p);
      if (ps) ex.push({ basis: "nemotron", text: `Nemotron read that this needs "${ps.title}" first.` });
    }
    if (t?.rationale) ex.push({ basis: "nemotron", text: t.rationale });
    for (const q of t?.needsConfirmation ?? []) ex.push({ basis: "question", text: q });
    explanations[s.id] = ex;
    return {
      id: s.id,
      version: s.version,
      title: s.title,
      deadline,
      deadlineConfirmed,
      durationMinutes: s.durationMinutes,
      durationConfirmed: Boolean(s.durationMinutes),
      suggestedDurationMinutes: t?.proposedDurationMinutes ?? null,
      priority: s.priority || t?.proposedPriority || "medium",
      prerequisites,
    };
  });

  const busy = vault.sources
    .filter((s) => s.kind === "calendar" && s.status === "open" && s.selected)
    .flatMap((s) => s.events.map((e) => ({ ...e, sourceId: s.id })));
  const doneIds = vault.sources.filter((s) => s.status === "done").map((s) => s.id);

  let result;
  try {
    result = buildPlan({ ...req, busy, tasks: planTasks, doneIds, prefs, now: new Date() });
  } catch (e) {
    throw new HttpError(400, e.message);
  }

  const dayStart = zonedToDate(req.localDate, "00:00", tz).getTime();
  const dayEnd = zonedToDate(addDays(req.localDate, 1), "00:00", tz).getTime();
  const busyToday = busy
    .filter((b) => Date.parse(b.end) > dayStart && Date.parse(b.start) < dayEnd)
    .map((b) => ({ title: b.title, startsAt: b.start, endsAt: b.end, sourceId: b.sourceId }));

  const inputVersions = Object.fromEntries([
    ...tasks.map((s) => [s.id, s.version]),
    ...vault.sources.filter((s) => s.kind === "calendar" && s.status !== "deleted").map((s) => [s.id, s.version]),
    ...refs.map((r) => [r.id, r.version]),
  ]);

  const plan = {
    id: newId("plan"),
    skill: "plan_day.v1",
    mode: opts.mode,
    request: req,
    localDate: req.localDate,
    timezone: tz,
    inputVersions,
    revision: vault.revision,
    prefs,
    memoryRefs: refs,
    interpretation: opts.interpretation ?? null,
    textHashes: opts.textHashes ?? null,
    disclosureId: opts.disclosureId ?? null,
    inference: opts.inference ?? null,
    sentMemoryIds: opts.sentMemoryIds ?? [],
    rebuiltFrom: opts.rebuiltFrom ?? null,
    blocks: result.blocks,
    busy: busyToday,
    unscheduled: result.unscheduled,
    warnings: [...result.warnings, ...notes, ...(opts.interpretation?.problems ?? [])],
    questions: opts.interpretation?.missingInformation ?? [],
    explanations,
    focusMinutes: result.focusMinutes,
    state: "draft",
    createdAt: new Date().toISOString(),
  };
  vault.plans = vault.plans.filter((p) => p.state !== "replaced").slice(-9);
  vault.plans.push(plan);
  log(vault, "plan.drafted", { planId: plan.id, mode: plan.mode, blocks: plan.blocks.length, unscheduled: plan.unscheduled.length });
  return plan;
}

function fmt(iso, tz) {
  return new Date(iso).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function planIsStale(vault, plan) {
  for (const [id, v] of Object.entries(plan.inputVersions)) {
    const s = vault.sources.find((x) => x.id === id);
    if (s) {
      if (s.version !== v) return true;
      continue;
    }
    const m = vault.memories.find((x) => x.id === id);
    if (!m || m.status !== "active" || m.version !== v) return true;
  }
  // A memory added after the plan was drafted also makes it out of date.
  const known = new Set(Object.keys(plan.inputVersions));
  return activeMemories(vault, "planning").some((m) => !known.has(m.id));
}

// ---------- committing approved actions ----------

export function commitPlan(vault, id, input) {
  const plan = findPlan(vault, id);
  if (plan.state === "committed") return { plan, reminders: vault.reminders.filter((r) => r.planId === plan.id), idempotent: true };
  if (plan.state !== "draft") throw new HttpError(409, "Only a current draft can be saved.");
  if (planIsStale(vault, plan)) {
    plan.state = "stale";
    throw new HttpError(409, "Something this plan used has changed. Rebuild the plan before saving.");
  }
  const wanted = new Set(Array.isArray(input.reminderTaskIds) ? input.reminderTaskIds : []);
  const created = [];
  for (const taskId of wanted) {
    const first = plan.blocks.find((b) => b.taskId === taskId);
    if (!first) throw new HttpError(400, "A reminder can only be set for a scheduled task.");
    const key = `${plan.id}:${taskId}`;
    if (vault.reminders.some((r) => r.key === key)) continue;
    const r = {
      id: newId("rem"),
      key,
      planId: plan.id,
      taskId,
      title: first.title,
      at: first.startsAt,
      status: Date.parse(first.startsAt) <= Date.now() ? "missed" : "scheduled",
      createdAt: new Date().toISOString(),
    };
    vault.reminders.push(r);
    created.push(r);
  }
  for (const p of vault.plans) {
    if (p !== plan && p.localDate === plan.localDate && p.state === "committed") {
      p.state = "superseded";
      for (const r of vault.reminders) if (r.planId === p.id && r.status === "scheduled") r.status = "cancelled";
    }
  }
  plan.state = "committed";
  plan.committedAt = new Date().toISOString();
  log(vault, "plan.saved", { planId: plan.id, reminders: created.map((r) => r.id) });
  return { plan, reminders: created, idempotent: false };
}

// ---------- scheduler: reminders and review_day ----------

export function createJob(vault, input) {
  const tz = vault.timezone;
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  let nextRun;
  let demoTiming = false;
  let time = null;
  if (input.inMinutes != null) {
    const n = Number(input.inMinutes);
    if (!Number.isInteger(n) || n < 1 || n > 120) throw new HttpError(400, "Choose 1 to 120 minutes.");
    nextRun = new Date(Date.now() + n * 60000);
    demoTiming = true;
  } else {
    time = hhmm.test(input.time ?? "") ? input.time : "21:00";
    nextRun = nextDaily(time, tz, new Date());
  }
  for (const j of vault.jobs) if (j.status === "active" && j.demoTiming === demoTiming) j.status = "replaced";
  const job = {
    id: newId("job"),
    skill: "review_day.v1",
    timezone: tz,
    time,
    demoTiming,
    nextRunUtc: nextRun.toISOString(),
    missedRunPolicy: "run once if within 2 hours, otherwise skip",
    cloudGrant: false,
    status: "active",
    lease: null,
    lastRun: null,
    occurrences: [],
    createdAt: new Date().toISOString(),
  };
  vault.jobs = vault.jobs.filter((j) => j.status !== "replaced").slice(-5);
  vault.jobs.push(job);
  log(vault, "job.enabled", { jobId: job.id, skill: job.skill, nextRunUtc: job.nextRunUtc, demoTiming });
  return job;
}

function nextDaily(time, tz, after) {
  let date = localDateOf(after, tz);
  let at = zonedToDate(date, time, tz);
  if (at <= after) at = zonedToDate(addDays(date, 1), time, tz);
  return at;
}

export function setJobStatus(vault, id, status) {
  const job = vault.jobs.find((j) => j.id === id);
  if (!job) throw new HttpError(404, "Job not found.");
  if (!["active", "paused"].includes(status)) throw new HttpError(400, "Invalid status.");
  if (job.status === "completed") throw new HttpError(409, "This job already finished.");
  job.status = status;
  if (status === "active" && Date.parse(job.nextRunUtc) < Date.now() - CATCH_UP_MS && job.time) {
    job.nextRunUtc = nextDaily(job.time, job.timezone, new Date()).toISOString();
  }
  log(vault, status === "paused" ? "job.paused" : "job.resumed", { jobId: id });
  return job;
}

export function runReview(vault, job, occurrence) {
  const tz = vault.timezone;
  const today = localDateOf(new Date(occurrence), tz);
  const plan = [...vault.plans].reverse().find((p) => p.state === "committed" && p.localDate === today);
  const items = [];
  if (plan) {
    const seen = new Set();
    for (const b of plan.blocks) {
      if (seen.has(b.taskId)) continue;
      seen.add(b.taskId);
      const s = vault.sources.find((x) => x.id === b.taskId);
      const done = s?.status === "done";
      items.push({
        taskId: b.taskId,
        title: s?.status === "deleted" ? "(forgotten item)" : (s?.title ?? b.title),
        outcome: done ? "done" : "carry_forward",
        suggestion: done ? "Completed." : s?.deadline ? `Carry forward. Confirmed deadline ${fmt(s.deadline, tz)}.` : "Carry forward to your next plan.",
      });
    }
    for (const u of plan.unscheduled) {
      if (seen.has(u.taskId)) continue;
      items.push({ taskId: u.taskId, title: u.title, outcome: "carry_forward", suggestion: `Was not scheduled: ${u.reason}` });
    }
  }
  const review = {
    id: newId("rev"),
    skill: "review_day.v1",
    jobId: job.id,
    occurrence,
    localDate: today,
    planId: plan?.id ?? null,
    items,
    summary: plan
      ? `${items.filter((i) => i.outcome === "done").length} done, ${items.filter((i) => i.outcome === "carry_forward").length} to carry forward.`
      : "No saved plan for today, so there is nothing to review.",
    note: "Draft only, prepared locally. Nothing was sent to the cloud. Plan tomorrow when you are ready.",
    createdAt: new Date().toISOString(),
  };
  vault.reviews = vault.reviews.slice(-9);
  vault.reviews.push(review);
  vault.notifications.push({ id: newId("ntf"), at: review.createdAt, kind: "review", text: `End-of-day review ready: ${review.summary}`, read: false });
  log(vault, "review.prepared", { jobId: job.id, reviewId: review.id, items: items.length });
  return review;
}

// One scheduler pass. Returns true if the vault changed.
export function tick(vault, now = new Date()) {
  let changed = false;
  const t = now.getTime();
  for (const r of vault.reminders) {
    if (r.status === "scheduled" && Date.parse(r.at) <= t) {
      r.status = "delivered";
      r.deliveredAt = now.toISOString();
      vault.notifications.push({ id: newId("ntf"), at: r.deliveredAt, kind: "reminder", text: `Time to start: ${r.title}`, read: false });
      log(vault, "reminder.delivered", { reminderId: r.id });
      changed = true;
    }
  }
  for (const job of vault.jobs) {
    if (job.status !== "active") continue;
    if (job.lease && Date.parse(job.lease.until) > t) continue;
    const due = Date.parse(job.nextRunUtc);
    if (due > t) continue;
    const key = `${job.id}@${job.nextRunUtc}`;
    if (job.occurrences.includes(key)) continue;
    job.lease = { occurrence: key, until: new Date(t + 60000).toISOString() };
    if (t - due > CATCH_UP_MS) {
      job.lastRun = { at: now.toISOString(), occurrence: job.nextRunUtc, result: "skipped (missed by more than 2 hours)" };
      log(vault, "job.skipped", { jobId: job.id, occurrence: job.nextRunUtc });
    } else {
      const review = runReview(vault, job, job.nextRunUtc);
      job.lastRun = { at: now.toISOString(), occurrence: job.nextRunUtc, result: review.summary, reviewId: review.id };
    }
    job.occurrences = [...job.occurrences, key].slice(-20);
    job.lease = null;
    if (job.demoTiming) job.status = "completed";
    else job.nextRunUtc = nextDaily(job.time, job.timezone, now).toISOString();
    changed = true;
  }
  if (vault.notifications.length > 50) vault.notifications.splice(0, vault.notifications.length - 50);
  return changed;
}

// ---------- view model ----------

export function snapshot(vault, extra = {}) {
  const tz = vault.timezone;
  return {
    timezone: tz,
    today: localDateOf(new Date(), tz),
    nowLocal: localTimeOf(new Date(), tz),
    revision: vault.revision,
    sources: vault.sources.filter((s) => s.status !== "deleted"),
    memories: vault.memories.filter((m) => m.status !== "deleted"),
    plans: vault.plans.filter((p) => p.state !== "replaced").map((p) => ({ ...p, stale: p.state === "draft" && planIsStale(vault, p) })),
    reminders: vault.reminders.slice(-20),
    notifications: vault.notifications.slice(-20),
    jobs: vault.jobs,
    reviews: vault.reviews.slice(-5),
    activity: vault.activity.slice(-80).reverse(),
    ...extra,
  };
}
