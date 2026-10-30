import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../src/planner.js";
import { zonedToDate } from "../src/time.js";

const TZ = "Asia/Kolkata";
const DAY = "2026-10-30";
const at = (hhmm) => zonedToDate(DAY, hhmm, TZ).toISOString();
const prefs = { blockMinutes: 25, breakMinutes: 5, minBlockMinutes: 10 };
const task = (t) => ({ version: 1, deadline: null, deadlineConfirmed: false, durationMinutes: null, durationConfirmed: false, priority: "medium", prerequisites: [], ...t });
const base = (over) => ({
  localDate: DAY,
  timezone: TZ,
  windowStart: "14:00",
  windowEnd: "18:00",
  effortBudgetMinutes: null,
  busy: [],
  tasks: [],
  doneIds: [],
  prefs,
  now: new Date(at("08:00")),
  ...over,
});

test("splits work into preference-sized blocks with breaks", () => {
  const r = buildPlan(base({ tasks: [task({ id: "a", title: "A", durationMinutes: 60, durationConfirmed: true })] }));
  assert.deepEqual(
    r.blocks.map((b) => [b.startsAt, b.endsAt]),
    [
      [at("14:00"), at("14:25")],
      [at("14:30"), at("14:55")],
      [at("15:00"), at("15:10")],
    ],
  );
  assert.equal(r.focusMinutes, 60);
});

test("never overlaps busy time", () => {
  const r = buildPlan(
    base({
      busy: [{ start: at("14:20"), end: at("15:00"), title: "Club" }],
      tasks: [task({ id: "a", title: "A", durationMinutes: 50, durationConfirmed: true })],
    }),
  );
  for (const b of r.blocks) assert.ok(!(Date.parse(b.startsAt) < Date.parse(at("15:00")) && Date.parse(b.endsAt) > Date.parse(at("14:20"))));
  assert.equal(r.focusMinutes, 50);
});

test("orders by confirmed deadline, then respects prerequisites", () => {
  const r = buildPlan(
    base({
      tasks: [
        task({ id: "draft", title: "Draft", durationMinutes: 25, durationConfirmed: true, prerequisites: ["cv"], deadline: at("17:00") }),
        task({ id: "cv", title: "CV", durationMinutes: 25, durationConfirmed: true }),
        task({ id: "lab", title: "Lab", durationMinutes: 25, durationConfirmed: true, deadline: at("16:00"), deadlineConfirmed: true }),
      ],
    }),
  );
  assert.deepEqual(r.blocks.map((b) => b.taskId), ["lab", "cv", "draft"]);
});

test("asks for missing durations instead of inventing them", () => {
  const r = buildPlan(base({ tasks: [task({ id: "a", title: "A", suggestedDurationMinutes: 45 })] }));
  assert.equal(r.blocks.length, 0);
  assert.equal(r.unscheduled[0].reason, "Its duration is not confirmed.");
  assert.equal(r.unscheduled[0].suggestedDurationMinutes, 45);
});

test("dependents of unscheduled work are not scheduled", () => {
  const r = buildPlan(
    base({
      tasks: [task({ id: "cv", title: "CV" }), task({ id: "app", title: "App", durationMinutes: 30, durationConfirmed: true, prerequisites: ["cv"] })],
    }),
  );
  assert.equal(r.blocks.length, 0);
  assert.match(r.unscheduled.find((u) => u.taskId === "app").reason, /Waiting on "CV"/);
});

test("respects the declared focus budget and reports the remainder", () => {
  const r = buildPlan(base({ effortBudgetMinutes: 40, tasks: [task({ id: "a", title: "A", durationMinutes: 90, durationConfirmed: true })] }));
  assert.equal(r.focusMinutes, 40);
  assert.match(r.unscheduled[0].reason, /50 of 90 minutes did not fit because your focus budget/);
});

test("reports cycles", () => {
  const r = buildPlan(
    base({
      tasks: [
        task({ id: "a", title: "A", durationMinutes: 25, durationConfirmed: true, prerequisites: ["b"] }),
        task({ id: "b", title: "B", durationMinutes: 25, durationConfirmed: true, prerequisites: ["a"] }),
      ],
    }),
  );
  assert.equal(r.blocks.length, 0);
  assert.equal(r.unscheduled.length, 2);
});

test("an infeasible day gives a partial plan, not invented time", () => {
  const r = buildPlan(base({ windowEnd: "15:00", tasks: [task({ id: "a", title: "A", durationMinutes: 120, durationConfirmed: true })] }));
  assert.ok(r.focusMinutes <= 60);
  assert.match(r.unscheduled[0].reason, /not enough free time/);
});

test("starts from now when the window has begun", () => {
  const r = buildPlan(base({ now: new Date(at("15:02")), tasks: [task({ id: "a", title: "A", durationMinutes: 25, durationConfirmed: true })] }));
  assert.equal(r.blocks[0].startsAt, at("15:05"));
});
