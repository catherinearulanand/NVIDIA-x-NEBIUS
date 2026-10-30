// Synthetic demo vault: the fictional student from the build guide.
// Nothing here is real personal data.

import { addDays, localDateOf, zonedToDate, toZonedIso } from "./time.js";

export function seedVault(timezone, now = new Date()) {
  const today = localDateOf(now, timezone);
  const tomorrow = addDays(today, 1);
  const at = (date, hhmm) => toZonedIso(zonedToDate(date, hhmm, timezone), timezone);
  const created = now.toISOString();

  const source = (s) => ({
    version: 1,
    status: "open",
    selected: true,
    allowCloud: true,
    private: false,
    deadline: null,
    durationMinutes: null,
    priority: null,
    prerequisites: [],
    events: [],
    createdAt: created,
    updatedAt: created,
    ...s,
  });
  const memory = (m) => ({
    version: 1,
    status: "active",
    provenance: "user_entered",
    sourceIds: [],
    validFrom: created,
    validUntil: null,
    supersedesId: null,
    createdAt: created,
    ...m,
  });

  return {
    schema: 1,
    timezone,
    revision: 1,
    createdAt: created,
    sources: [
      source({
        id: "src_lab",
        kind: "task",
        title: "Chemistry lab report",
        body: "Finish the titration analysis first, then write the discussion section. Submit on the course portal.",
        deadline: at(tomorrow, "09:00"),
        durationMinutes: 90,
        priority: "high",
      }),
      source({
        id: "src_app",
        kind: "task",
        title: "Internship application draft",
        body: "Draft the personal statement for the internship application. Due next Monday. I need the updated CV before I can finish it.",
      }),
      source({
        id: "src_cv",
        kind: "task",
        title: "Update CV",
        body: "Add the hackathon project and the lab assistant role.",
        durationMinutes: 30,
      }),
      source({
        id: "src_journal",
        kind: "note",
        title: "Journal (private)",
        body: "Private reflection. Not for planning or cloud use.",
        selected: false,
        allowCloud: false,
        private: true,
      }),
      source({
        id: "src_cal",
        kind: "calendar",
        title: "Class timetable",
        body: "",
        allowCloud: false,
        events: [
          { id: "ev_class", title: "Classes", start: at(today, "10:00"), end: at(today, "13:00") },
          { id: "ev_club", title: "Robotics club meeting", start: at(today, "15:30"), end: at(today, "16:00") },
        ],
      }),
    ],
    memories: [
      memory({
        id: "mem_block",
        kind: "preference",
        value: "I prefer 25-minute focus blocks.",
        setting: { name: "focusBlockMinutes", value: 25 },
        allowedUses: ["planning", "cloud_inference"],
      }),
      memory({
        id: "mem_break",
        kind: "preference",
        value: "Give me a 5-minute break between blocks.",
        setting: { name: "breakMinutes", value: 5 },
        allowedUses: ["planning", "cloud_inference"],
      }),
      memory({
        id: "mem_goal",
        kind: "project_fact",
        value: "This month the internship application matters more to me than club work.",
        allowedUses: ["planning", "cloud_inference"],
      }),
    ],
    disclosures: [],
    plans: [],
    reminders: [],
    notifications: [],
    jobs: [],
    reviews: [],
    activity: [{ id: "act_seed", at: created, type: "vault.created", detail: { profile: "synthetic seed" } }],
  };
}
