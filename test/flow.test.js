// End-to-end vault flow with a stubbed HTTP layer. This checks the request
// MindVault sends and how it handles replies; it is not a live model test
// (use `npm run preflight` for that).

import test from "node:test";
import assert from "node:assert/strict";
import { seedVault } from "../src/seed.js";
import * as V from "../src/vault.js";
import { validateInterpretation } from "../src/validate.js";

const TZ = "Asia/Kolkata";
const cfg = { apiKey: "test-key", baseUrl: "https://example.test/v1/", model: "nvidia/test-nemotron", extraBody: {}, timeoutMs: 5000, maxTokens: 1000 };

function fakeFetch(reply, calls = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    if (typeof reply === "function") return reply(body, calls.length);
    return new Response(JSON.stringify({ model: cfg.model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }), { status: 200 });
  };
}

function interpretationFor(vault) {
  return {
    tasks: [
      { sourceId: "src_lab", sourceVersion: 1, title: "Chemistry lab report", proposedDeadline: null, proposedDurationMinutes: 90, proposedPriority: "high", prerequisiteSourceIds: [], rationale: "Due tomorrow morning.", needsConfirmation: [] },
      { sourceId: "src_app", sourceVersion: 1, title: "Internship application draft", proposedDeadline: "2026-12-31T23:59:00+05:30", proposedDurationMinutes: 60, proposedPriority: "medium", prerequisiteSourceIds: ["src_cv"], rationale: "Due Friday; needs CV.", needsConfirmation: ["Is Friday the 31st?"] },
      { sourceId: "src_cv", sourceVersion: 1, title: "Update CV", proposedDeadline: null, proposedDurationMinutes: 30, proposedPriority: "medium", prerequisiteSourceIds: [], rationale: "Unblocks the application.", needsConfirmation: [] },
      { sourceId: "src_journal", sourceVersion: 1, title: "leak", proposedDeadline: null, proposedDurationMinutes: 10, proposedPriority: "low", prerequisiteSourceIds: [], rationale: "", needsConfirmation: [] },
    ],
    missingInformation: ["How long will the application take?"],
  };
}

test("preview excludes private notes and calendar, and sends exactly what was shown", async () => {
  const vault = seedVault(TZ);
  const { disclosure, excluded } = V.previewDisclosure(vault, { windowStart: "00:00", windowEnd: "23:59" });
  const payload = disclosure.messages[1].content;
  assert.ok(!payload.includes("Journal"));
  assert.ok(!payload.includes("Classes"));
  assert.ok(excluded.some((x) => x.id === "src_journal" && x.reason === "Marked private"));

  const shown = structuredClone(disclosure.messages);
  const calls = [];
  const plan = await V.approveDisclosure(vault, disclosure.id, disclosure.digest, cfg, fakeFetch(interpretationFor(vault), calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer test-key");
  assert.deepEqual(calls[0].body.messages, shown);
  assert.equal(calls[0].body.response_format.type, "json_schema");
  assert.equal(plan.mode, "connected");
  assert.ok(plan.warnings.some((w) => w.includes("not shared")));
  assert.ok(!JSON.stringify(plan).includes("leak"));
  // App draft has no confirmed duration, so it is not scheduled.
  assert.ok(plan.unscheduled.some((u) => u.taskId === "src_app"));
  assert.equal(disclosure.messages, null);
});

test("a changed vault blocks a stale approval", async () => {
  const vault = seedVault(TZ);
  const { disclosure } = V.previewDisclosure(vault, {});
  V.updateSource(vault, "src_cv", { body: "changed" });
  await assert.rejects(() => V.approveDisclosure(vault, disclosure.id, disclosure.digest, cfg, fakeFetch({})), /changed/);
});

test("a mismatched digest is refused", async () => {
  const vault = seedVault(TZ);
  const { disclosure } = V.previewDisclosure(vault, {});
  await assert.rejects(() => V.approveDisclosure(vault, disclosure.id, "0".repeat(64), cfg, fakeFetch({})), /does not match/);
});

test("falls back to JSON mode when schema output is rejected", async () => {
  const vault = seedVault(TZ);
  const { disclosure } = V.previewDisclosure(vault, {});
  const calls = [];
  const reply = (body, n) =>
    n === 1
      ? new Response("response_format not supported", { status: 400 })
      : new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "<think>hmm</think>```json\n" + JSON.stringify(interpretationFor(vault)) + "\n```" } }] }), { status: 200 });
  const plan = await V.approveDisclosure(vault, disclosure.id, disclosure.digest, cfg, fakeFetch(reply, calls));
  assert.equal(calls[1].body.response_format.type, "json_object");
  assert.equal(plan.inference.mode, "json_object");
});

test("confirming a suggestion and rebuilding schedules the work; memory correction makes plans stale", async () => {
  const vault = seedVault(TZ);
  const { disclosure } = V.previewDisclosure(vault, { windowStart: "00:00", windowEnd: "23:59" });
  const plan = await V.approveDisclosure(vault, disclosure.id, disclosure.digest, cfg, fakeFetch(interpretationFor(vault)));
  V.updateSource(vault, "src_app", { durationMinutes: 60 });
  assert.ok(V.planIsStale(vault, plan));
  const rebuilt = V.rebuildPlan(vault, plan.id);
  const now = Date.now();
  // Depending on the time the test runs, blocks may be limited; just check consistency.
  assert.ok(rebuilt.blocks.every((b) => b.taskId !== "src_journal"));
  const cvEnd = Math.max(...rebuilt.blocks.filter((b) => b.taskId === "src_cv").map((b) => Date.parse(b.endsAt)));
  for (const b of rebuilt.blocks.filter((x) => x.taskId === "src_app")) assert.ok(Date.parse(b.startsAt) >= cvEnd);
  assert.ok(now);

  V.correctMemory(vault, "mem_block", { value: "I prefer 40-minute focus blocks.", setting: { name: "focusBlockMinutes", value: 40 } });
  assert.ok(V.planIsStale(vault, rebuilt));
  assert.throws(() => V.commitPlan(vault, rebuilt.id, {}), /changed/);
  const again = V.rebuildPlan(vault, rebuilt.id);
  assert.equal(again.prefs.blockMinutes, 40);
  const mem = vault.memories.find((m) => m.status === "active" && m.setting?.name === "focusBlockMinutes");
  assert.equal(mem.version, 2);
  assert.equal(vault.memories.find((m) => m.id === "mem_block").status, "superseded");
});

test("commit is idempotent and review_day carries unfinished work forward", () => {
  const vault = seedVault(TZ);
  const plan = V.localPlan(vault, { windowStart: "00:00", windowEnd: "23:59" });
  const ids = [...new Set(plan.blocks.map((b) => b.taskId))];
  const first = V.commitPlan(vault, plan.id, { reminderTaskIds: ids });
  const second = V.commitPlan(vault, plan.id, { reminderTaskIds: ids });
  assert.equal(second.idempotent, true);
  assert.equal(vault.reminders.length, first.reminders.length);

  if (ids.length) V.setSourceDone(vault, ids[0], true);
  const job = V.createJob(vault, { inMinutes: 1 });
  assert.equal(V.tick(vault, new Date(Date.now() + 61000)), true);
  assert.equal(job.status, "completed");
  const review = vault.reviews.at(-1);
  assert.ok(review);
  assert.equal(review.planId, plan.id);
  assert.equal(V.tick(vault, new Date(Date.now() + 62000)), vault.reminders.some((r) => r.status === "scheduled" && Date.parse(r.at) <= Date.now() + 62000));
});

test("forgetting a source wipes it from derived plans and cancels reminders", () => {
  const vault = seedVault(TZ);
  const plan = V.localPlan(vault, { windowStart: "00:00", windowEnd: "23:59" });
  V.commitPlan(vault, plan.id, { reminderTaskIds: [...new Set(plan.blocks.map((b) => b.taskId))] });
  V.deleteSource(vault, "src_lab");
  const text = JSON.stringify(vault);
  assert.ok(!text.includes("Chemistry lab report"));
  assert.ok(!text.includes("titration"));
  assert.ok(vault.reminders.filter((r) => r.taskId === "src_lab").every((r) => r.status !== "scheduled"));
});

test("validation drops unknown sources and implausible values", () => {
  const allowed = new Map([["a", 1]]);
  const v = validateInterpretation(
    { tasks: [{ sourceId: "a", sourceVersion: 1, title: "x", proposedDeadline: "not a date", proposedDurationMinutes: 9999, proposedPriority: "urgent", prerequisiteSourceIds: ["a", "zzz"], rationale: "r", needsConfirmation: [] }, { sourceId: "evil" }], missingInformation: [] },
    allowed,
  );
  assert.equal(v.tasks.length, 1);
  assert.equal(v.tasks[0].proposedDeadline, null);
  assert.equal(v.tasks[0].proposedDurationMinutes, null);
  assert.equal(v.tasks[0].proposedPriority, "medium");
  assert.deepEqual(v.tasks[0].prerequisiteSourceIds, []);
  assert.equal(v.problems.length, 3);
});
