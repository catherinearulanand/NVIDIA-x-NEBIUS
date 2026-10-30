// Deterministic day planner. Nemotron interprets notes; this code owns the
// exact constraints: busy time, breaks, effort budget, dependencies and
// deadlines. It is an earliest-deadline/priority heuristic, not an optimizer.

import { zonedToDate } from "./time.js";

const MIN = 60000;
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

function mergeIntervals(list) {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

function subtract(window, busy) {
  let free = [{ ...window }];
  for (const b of busy) {
    const next = [];
    for (const f of free) {
      if (b.end <= f.start || b.start >= f.end) next.push(f);
      else {
        if (b.start > f.start) next.push({ start: f.start, end: b.start });
        if (b.end < f.end) next.push({ start: b.end, end: f.end });
      }
    }
    free = next;
  }
  return free;
}

function findCycles(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map();
  const inCycle = new Set();
  const stack = [];
  function visit(id) {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      for (const s of stack.slice(stack.indexOf(id))) inCycle.add(s);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const p of byId.get(id)?.prerequisites ?? []) if (byId.has(p)) visit(p);
    stack.pop();
    state.set(id, 2);
  }
  for (const t of tasks) visit(t.id);
  return inCycle;
}

function compareTasks(a, b) {
  const da = a.deadline ? Date.parse(a.deadline) : Infinity;
  const db = b.deadline ? Date.parse(b.deadline) : Infinity;
  if (da !== db) return da - db;
  if (a.deadlineConfirmed !== b.deadlineConfirmed) return a.deadlineConfirmed ? -1 : 1;
  const pa = PRIORITY_RANK[a.priority] ?? 1;
  const pb = PRIORITY_RANK[b.priority] ?? 1;
  if (pa !== pb) return pa - pb;
  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

/**
 * @param {object} input
 * @param {string} input.localDate        YYYY-MM-DD in input.timezone
 * @param {string} input.timezone         IANA zone
 * @param {string} input.windowStart      HH:MM
 * @param {string} input.windowEnd        HH:MM
 * @param {number|null} input.effortBudgetMinutes
 * @param {{start:string,end:string,title:string,sourceId:string}[]} input.busy  ISO instants
 * @param {object[]} input.tasks
 * @param {string[]} input.doneIds        prerequisites already completed
 * @param {{blockMinutes:number,breakMinutes:number,minBlockMinutes:number}} input.prefs
 * @param {Date} [input.now]
 */
export function buildPlan(input) {
  const { localDate, timezone, prefs } = input;
  const warnings = [];
  const winStart = zonedToDate(localDate, input.windowStart, timezone).getTime();
  const winEnd = zonedToDate(localDate, input.windowEnd, timezone).getTime();
  if (!(winEnd > winStart)) throw new Error("The plan window must end after it starts.");

  let effectiveStart = winStart;
  const now = input.now ? input.now.getTime() : null;
  if (now && now > winStart && now < winEnd) {
    effectiveStart = Math.ceil(now / (5 * MIN)) * 5 * MIN;
    warnings.push("Part of the window is already in the past, so the plan starts from now.");
  } else if (now && now >= winEnd) {
    warnings.push("This window has already ended; the plan is shown for reference only.");
  }

  const busy = mergeIntervals(
    (input.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })),
  );
  let free = subtract({ start: effectiveStart, end: winEnd }, busy);

  const blockLen = Math.max(5, prefs.blockMinutes) * MIN;
  const breakLen = Math.max(0, prefs.breakMinutes) * MIN;
  const minBlock = Math.max(5, prefs.minBlockMinutes ?? 10) * MIN;
  let budget = input.effortBudgetMinutes == null ? Infinity : input.effortBudgetMinutes * MIN;

  const tasks = input.tasks.map((t) => ({ ...t }));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const done = new Set(input.doneIds ?? []);
  const blocks = [];
  const unscheduled = [];
  const finishedAt = new Map();
  const blocked = new Set();

  for (const t of tasks) {
    if (t.deadline && Date.parse(t.deadline) < winStart) {
      warnings.push(`"${t.title}" has a deadline that has already passed.`);
    }
  }

  const cycles = findCycles(tasks);
  for (const id of cycles) {
    unscheduled.push({ taskId: id, title: byId.get(id).title, reason: "Its prerequisites form a cycle, so it cannot be ordered." });
    blocked.add(id);
  }
  for (const t of tasks) {
    if (blocked.has(t.id)) continue;
    const missing = t.prerequisites.filter((p) => !byId.has(p) && !done.has(p));
    if (missing.length) {
      unscheduled.push({ taskId: t.id, title: t.title, reason: "It depends on an item that is not selected for this plan." });
      blocked.add(t.id);
    }
  }

  let lastEnd = null;
  const remaining = tasks.filter((t) => !blocked.has(t.id));
  while (remaining.length) {
    const ready = remaining.filter((t) =>
      t.prerequisites.every((p) => done.has(p) || finishedAt.has(p) || blocked.has(p)),
    );
    if (!ready.length) break;
    ready.sort(compareTasks);
    const t = ready[0];
    remaining.splice(remaining.indexOf(t), 1);

    const waitingOn = t.prerequisites.filter((p) => blocked.has(p));
    if (waitingOn.length) {
      unscheduled.push({ taskId: t.id, title: t.title, reason: `Waiting on "${byId.get(waitingOn[0])?.title ?? waitingOn[0]}", which is not fully scheduled today.` });
      blocked.add(t.id);
      continue;
    }
    if (!t.durationConfirmed || !t.durationMinutes) {
      unscheduled.push({
        taskId: t.id,
        title: t.title,
        reason: "Its duration is not confirmed.",
        suggestedDurationMinutes: t.suggestedDurationMinutes ?? null,
      });
      blocked.add(t.id);
      continue;
    }

    const notBefore = Math.max(0, ...t.prerequisites.map((p) => finishedAt.get(p) ?? 0));
    let left = t.durationMinutes * MIN;
    const placed = [];
    for (let i = 0; i < free.length && left > 0 && budget > 0; i++) {
      const f = free[i];
      let cursor = Math.max(f.start, notBefore);
      if (lastEnd !== null && cursor < lastEnd + breakLen && cursor >= lastEnd) cursor = lastEnd + breakLen;
      while (left > 0 && budget > 0 && cursor < f.end) {
        const room = f.end - cursor;
        const chunk = Math.min(blockLen, left, room, budget);
        if (chunk < minBlock && chunk < left) break;
        placed.push({ start: cursor, end: cursor + chunk });
        left -= chunk;
        budget -= chunk;
        lastEnd = cursor + chunk;
        cursor = lastEnd + breakLen;
      }
    }
    // Consume the time used (including the trailing break) from free intervals.
    for (const p of placed) free = free.flatMap((f) => subtract(f, [{ start: p.start, end: p.end + breakLen }]));

    for (const p of placed) {
      blocks.push({
        taskId: t.id,
        title: t.title,
        startsAt: new Date(p.start).toISOString(),
        endsAt: new Date(p.end).toISOString(),
        sourceIds: [t.id],
      });
    }
    if (left > 0) {
      const why = budget <= 0 ? "your focus budget for today is used up" : "there is not enough free time left in the window";
      unscheduled.push({
        taskId: t.id,
        title: t.title,
        reason: placed.length
          ? `${Math.round(left / MIN)} of ${t.durationMinutes} minutes did not fit because ${why}.`
          : `It did not fit because ${why}.`,
      });
      blocked.add(t.id);
    } else {
      finishedAt.set(t.id, placed[placed.length - 1].end);
      if (t.deadline && placed[placed.length - 1].end > Date.parse(t.deadline)) {
        warnings.push(`"${t.title}" is planned to finish after its deadline.`);
      }
    }
  }
  for (const t of remaining) {
    if (!unscheduled.some((u) => u.taskId === t.id)) {
      unscheduled.push({ taskId: t.id, title: t.title, reason: "Its prerequisites are not scheduled." });
    }
  }

  blocks.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  assertNoOverlaps(blocks, busy, winStart, winEnd);
  const focusMinutes = blocks.reduce((s, b) => s + (Date.parse(b.endsAt) - Date.parse(b.startsAt)) / MIN, 0);
  return { blocks, unscheduled, warnings, focusMinutes };
}

// Re-validates the hard constraints before a draft is shown or committed.
export function assertNoOverlaps(blocks, busy, winStart, winEnd) {
  const spans = blocks.map((b) => ({ start: Date.parse(b.startsAt), end: Date.parse(b.endsAt) }));
  spans.sort((a, b) => a.start - b.start);
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (!(s.end > s.start)) throw new Error("Invalid block length.");
    if (s.start < winStart || s.end > winEnd) throw new Error("Block outside the plan window.");
    if (i > 0 && s.start < spans[i - 1].end) throw new Error("Blocks overlap.");
    for (const b of busy) if (s.start < b.end && s.end > b.start) throw new Error("Block overlaps busy time.");
  }
}
