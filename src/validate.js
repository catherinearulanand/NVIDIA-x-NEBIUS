// Runtime validation of Nemotron output. Nothing the model returns is
// trusted until it passes these checks; unknown sources are dropped.

const PRIORITIES = new Set(["high", "medium", "low"]);

function str(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * @param {unknown} raw            parsed model JSON
 * @param {Map<string, number>} allowed  sourceId -> version that was disclosed
 * @param {Date} today
 */
export function validateInterpretation(raw, allowed, today = new Date()) {
  const problems = [];
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.tasks)) {
    throw new Error("The model reply did not match the task interpretation format.");
  }
  const seen = new Set();
  const tasks = [];
  const minDate = today.getTime() - 366 * 864e5;
  const maxDate = today.getTime() + 366 * 864e5;

  for (const t of raw.tasks.slice(0, 12)) {
    if (!t || typeof t !== "object") continue;
    const id = t.sourceId;
    if (!allowed.has(id)) {
      problems.push(`Dropped a task for a source that was not shared (${str(id, 40) || "missing id"}).`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`Dropped a duplicate interpretation for ${id}.`);
      continue;
    }
    seen.add(id);

    let deadline = null;
    if (t.proposedDeadline != null) {
      const ms = Date.parse(t.proposedDeadline);
      if (Number.isFinite(ms) && ms >= minDate && ms <= maxDate) deadline = new Date(ms).toISOString();
      else problems.push(`Ignored an invalid deadline proposed for ${id}.`);
    }
    let duration = null;
    if (t.proposedDurationMinutes != null) {
      const d = Number(t.proposedDurationMinutes);
      if (Number.isInteger(d) && d >= 5 && d <= 480) duration = d;
      else problems.push(`Ignored an implausible duration proposed for ${id}.`);
    }
    const prereqs = Array.isArray(t.prerequisiteSourceIds)
      ? [...new Set(t.prerequisiteSourceIds.filter((p) => allowed.has(p) && p !== id))]
      : [];

    tasks.push({
      sourceId: id,
      sourceVersion: allowed.get(id),
      versionEchoMatched: t.sourceVersion === allowed.get(id),
      title: str(t.title, 120),
      proposedDeadline: deadline,
      proposedDurationMinutes: duration,
      proposedPriority: PRIORITIES.has(t.proposedPriority) ? t.proposedPriority : "medium",
      prerequisiteSourceIds: prereqs,
      rationale: str(t.rationale, 300),
      needsConfirmation: Array.isArray(t.needsConfirmation)
        ? t.needsConfirmation.map((n) => str(n, 200)).filter(Boolean).slice(0, 5)
        : [],
    });
  }
  const missingInformation = Array.isArray(raw.missingInformation)
    ? raw.missingInformation.map((n) => str(n, 200)).filter(Boolean).slice(0, 8)
    : [];
  return { tasks, missingInformation, problems };
}
