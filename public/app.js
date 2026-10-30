// MindVault web UI. Vanilla JS; all user data is rendered with textContent.

let state = null;
let tab = "today";
let disclosure = null;
let busy = false;
let planForm = null;
const reminderChoices = new Map();
const app = document.getElementById("app");

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "disabled" || k === "value" || k === "selected") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-MindVault": "1" },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 3500);
}

async function act(fn, okMsg) {
  if (busy) return;
  busy = true;
  render();
  try {
    const out = await fn();
    if (okMsg) toast(typeof okMsg === "function" ? okMsg(out) : okMsg);
    await load();
    return out;
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
    render();
  }
}

const tz = () => state.timezone;
const time = (iso) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: tz(), hour: "2-digit", minute: "2-digit" });
const dateTime = (iso) =>
  new Date(iso).toLocaleString("en-GB", { timeZone: tz(), weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const sourceById = (id) => state.sources.find((s) => s.id === id);

async function load() {
  state = await api("GET", "/api/state");
  if (!planForm) planForm = { localDate: state.today, windowStart: "14:00", windowEnd: "18:00", effortBudgetMinutes: "" };
}

// ---------- chrome ----------

function renderChrome() {
  const c = state.config;
  const status = document.getElementById("status");
  status.replaceChildren(
    ...[c.cloudConfigured
      ? h("span", { class: "pill nemo", title: `Endpoint: ${c.endpointHost}` }, "Connected reasoning · ", c.model)
      : h("span", { class: "pill warn" }, "Local mode · no connected reasoning"),
    h("span", { class: "pill" }, state.timezone),
    unreadCount() ? h("span", { class: "pill on" }, `${unreadCount()} new`) : null,
  ].filter(Boolean));
  document.getElementById("banner").replaceChildren(
    c.profile === "hosted"
      ? h("div", { class: "demo" }, "Synthetic hosted demo. Your session has its own fictional data and expires after 24 hours. Do not enter real personal information: this server processes what you type.")
      : "",
  );
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
}

const unreadCount = () => state.notifications.filter((n) => !n.read).length;

// ---------- Today ----------

function currentPlan() {
  const plans = state.plans.filter((p) => p.localDate === planForm.localDate);
  return plans[plans.length - 1] || null;
}

function renderToday() {
  const plan = currentPlan();
  return h(
    "div",
    { class: "grid" },
    h("div", {}, renderPlanForm(), disclosure ? renderDisclosure() : null, plan ? renderPlan(plan) : null),
    h("div", {}, renderNotifications(), renderTasks(), renderReview()),
  );
}

function renderPlanForm() {
  const f = planForm;
  const bind = (k) => (e) => (planForm[k] = e.target.value);
  const cloud = state.config.cloudConfigured;
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "Plan my day"),
    h(
      "div",
      { class: "row" },
      h("label", { class: "field" }, "Date", h("input", { type: "date", value: f.localDate, onchange: (e) => { planForm.localDate = e.target.value; render(); } })),
      h("label", { class: "field" }, "From", h("input", { type: "time", value: f.windowStart, onchange: bind("windowStart") })),
      h("label", { class: "field" }, "Until", h("input", { type: "time", value: f.windowEnd, onchange: bind("windowEnd") })),
      h(
        "label",
        { class: "field", title: "Optional. Your own limit on focused work today." },
        "Focus energy (min)",
        h("input", { type: "number", min: 10, max: 720, step: 5, placeholder: "no limit", value: f.effortBudgetMinutes, onchange: bind("effortBudgetMinutes"), style: "width:9em" }),
      ),
    ),
    h(
      "div",
      { class: "row", style: "margin-top:.7rem" },
      h(
        "button",
        { class: "btn nemo", disabled: busy || !cloud, onclick: previewSend, title: cloud ? "" : "Set NEBIUS_API_KEY and NEBIUS_MODEL_ID on the server" },
        "Preview what Nemotron will see",
      ),
      h("button", { class: "btn", disabled: busy, onclick: () => act(() => api("POST", "/api/plans/local", requestBody()), "Local draft ready") }, "Plan locally"),
    ),
    h(
      "p",
      { class: "muted small" },
      "Connected planning shows you the exact request first. Nothing leaves ",
      state.config.profile === "hosted" ? "this demo server" : "your computer",
      " until you approve it. Busy times and private notes stay local.",
    ),
  );
}

function requestBody() {
  return { ...planForm, effortBudgetMinutes: planForm.effortBudgetMinutes === "" ? null : Number(planForm.effortBudgetMinutes) };
}

async function previewSend() {
  const out = await act(() => api("POST", "/api/disclosures/preview", requestBody()));
  if (out) {
    disclosure = out;
    render();
  }
}

function renderDisclosure() {
  const d = disclosure;
  let payload = null;
  try {
    payload = JSON.parse(d.messages[1].content);
  } catch {}
  return h(
    "section",
    { class: "card soft" },
    h("h2", {}, "Review before sending"),
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, "Recipient"), h("dd", {}, d.recipient),
      h("dt", {}, "Model"), h("dd", {}, d.model),
      h("dt", {}, "Size"), h("dd", {}, `${d.bytes.toLocaleString()} bytes`),
      h("dt", {}, "Fingerprint"), h("dd", {}, h("code", {}, d.digest.slice(0, 16))),
    ),
    h("h3", {}, "Shared"),
    h(
      "ul",
      { class: "list" },
      (payload?.tasks || []).map((t) => h("li", {}, h("strong", {}, t.title), h("div", { class: "muted small" }, t.text))),
      (payload?.memories || []).map((m) => h("li", {}, h("span", { class: "basis fact" }, "memory"), " ", m.text)),
    ),
    h("h3", {}, "Not shared"),
    h("ul", { class: "list small" }, d.excluded.map((x) => h("li", {}, h("strong", {}, x.title), h("span", { class: "muted" }, ` · ${x.reason}`)))),
    h("details", {}, h("summary", {}, "Show the exact request"), h("pre", {}, JSON.stringify(d.messages, null, 2))),
    h("p", { class: "muted small" }, "Removing an item later cannot recall a request that was already sent."),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          class: "btn nemo",
          disabled: busy,
          onclick: async () => {
            const out = await act(() => api("POST", `/api/disclosures/${d.id}/approve`, { digest: d.digest }), (p) => `Nemotron replied in ${(p.inference.latencyMs / 1000).toFixed(1)}s`);
            if (out) disclosure = null;
            render();
          },
        },
        busy ? "Sending…" : "Approve and send",
      ),
      h("button", { class: "btn", disabled: busy, onclick: () => { disclosure = null; render(); } }, "Cancel"),
    ),
  );
}

function renderPlan(plan) {
  const items = [
    ...plan.blocks.map((b) => ({ kind: "block", start: b.startsAt, end: b.endsAt, b })),
    ...plan.busy.map((b) => ({ kind: "busy", start: b.startsAt, end: b.endsAt, b })),
  ].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const explained = new Set();
  const taskIds = [...new Set(plan.blocks.map((b) => b.taskId))];
  if (!reminderChoices.has(plan.id)) reminderChoices.set(plan.id, new Set(taskIds));
  const reminderChoice = reminderChoices.get(plan.id);

  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "row spread" },
      h("h2", {}, plan.state === "committed" ? "Saved plan" : "Draft plan"),
      h(
        "div",
        { class: "row" },
        plan.mode === "connected"
          ? h("span", { class: "pill nemo" }, `Nemotron · ${(plan.inference?.latencyMs / 1000).toFixed(1)}s${plan.inference?.usage ? ` · ${plan.inference.usage.totalTokens} tokens` : ""}`)
          : h("span", { class: "pill" }, "Local only · no connected reasoning"),
        h("span", { class: "pill" }, `${Math.round(plan.focusMinutes)} min focus`),
      ),
    ),
    plan.rebuiltFrom ? h("p", { class: "muted small" }, "Rebuilt locally from the earlier Nemotron reading with your confirmed changes.") : null,
    plan.stale || plan.state === "stale"
      ? h(
          "div",
          { class: "notice warn row spread" },
          h("span", {}, "Something this plan used has changed since it was drafted."),
          h("button", { class: "btn", disabled: busy, onclick: () => act(() => api("POST", `/api/plans/${plan.id}/rebuild`), "Plan rebuilt") }, "Rebuild plan"),
        )
      : null,
    plan.warnings.map((w) => h("div", { class: "notice warn" }, w)),
    h(
      "ul",
      { class: "timeline" },
      items.map((it) => {
        if (it.kind === "busy") return h("li", { class: "busy" }, h("span", { class: "time" }, `${time(it.start)}–${time(it.end)}`), h("span", { class: "what" }, `Busy · ${it.b.title}`));
        const first = !explained.has(it.b.taskId);
        explained.add(it.b.taskId);
        return h(
          "li",
          {},
          h("span", { class: "time" }, `${time(it.start)}–${time(it.end)}`),
          h(
            "div",
            {},
            h("div", { class: "block-title" }, it.b.title),
            first ? renderWhy(plan, it.b.taskId) : null,
          ),
        );
      }),
    ),
    plan.blocks.length === 0 ? h("p", { class: "muted" }, "Nothing could be scheduled in this window.") : null,
    plan.unscheduled.length
      ? h(
          "div",
          {},
          h("h3", {}, "Not scheduled"),
          h(
            "ul",
            { class: "list" },
            plan.unscheduled.map((u) =>
              h("li", {}, h("strong", {}, u.title), h("div", { class: "muted small" }, u.reason), renderWhy(plan, u.taskId, true)),
            ),
          ),
        )
      : null,
    plan.questions?.length
      ? h("div", {}, h("h3", {}, "Nemotron would like to know"), h("ul", { class: "why" }, plan.questions.map((q) => h("li", {}, h("span", { class: "basis question" }, "question"), q))))
      : null,
    h(
      "details",
      {},
      h("summary", {}, "Memory used"),
      h(
        "ul",
        { class: "why" },
        plan.memoryRefs.map((m) => h("li", {}, h("span", { class: "basis fact" }, `v${m.version}`), m.text, m.sentToCloud ? h("span", { class: "muted small" }, "(shared with Nemotron)") : h("span", { class: "muted small" }, "(local only)"))),
      ),
    ),
    plan.state === "draft" && !plan.stale
      ? h(
          "div",
          { class: "card soft", style: "margin:.8rem 0 0" },
          h("h3", { style: "margin-top:0" }, "Approve"),
          taskIds.map((id) => {
            const b = plan.blocks.find((x) => x.taskId === id);
            return h(
              "label",
              { class: "row small" },
              h("input", {
                type: "checkbox",
                checked: reminderChoice.has(id),
                onchange: (e) => (e.target.checked ? reminderChoice.add(id) : reminderChoice.delete(id)),
              }),
              `Remind me at ${time(b.startsAt)} to start ${b.title}`,
            );
          }),
          h(
            "div",
            { class: "row", style: "margin-top:.5rem" },
            h(
              "button",
              {
                class: "btn primary",
                disabled: busy,
                onclick: () => act(() => api("POST", `/api/plans/${plan.id}/commit`, { reminderTaskIds: [...reminderChoice] }), (o) => `Plan saved with ${o.reminders.length} reminder(s)`),
              },
              "Save plan and reminders",
            ),
          ),
          h("p", { class: "muted small" }, "Reminders are saved in MindVault only. Nothing is written to an external calendar."),
        )
      : null,
    plan.state === "committed" ? renderReceipts(plan) : null,
  );
}

function renderWhy(plan, taskId, withConfirm = true) {
  const ex = plan.explanations?.[taskId] || [];
  const label = { fact: "your data", nemotron: "Nemotron", question: "confirm?" };
  return h(
    "ul",
    { class: "why" },
    ex.map((e) =>
      h(
        "li",
        {},
        h("span", { class: `basis ${e.basis}` }, label[e.basis] || e.basis),
        h("span", {}, e.text),
        withConfirm && e.confirm && plan.state !== "committed"
          ? h(
              "button",
              {
                class: "link small",
                disabled: busy,
                onclick: () => confirmValue(plan, taskId, e.confirm),
              },
              "Confirm",
            )
          : null,
      ),
    ),
  );
}

async function confirmValue(plan, taskId, c) {
  const s = sourceById(taskId);
  if (!s) return;
  await act(async () => {
    await api("PATCH", `/api/sources/${taskId}`, { [c.field]: c.value, expectedVersion: s.version });
    return api("POST", `/api/plans/${plan.id}/rebuild`);
  }, "Confirmed and plan rebuilt");
}

function renderReceipts(plan) {
  const rs = state.reminders.filter((r) => r.planId === plan.id);
  return h(
    "div",
    { class: "notice ok" },
    h("div", {}, `Saved ${dateTime(plan.committedAt)}.`),
    rs.length ? h("ul", { class: "why" }, rs.map((r) => h("li", {}, h("span", { class: "basis fact" }, r.status), `${time(r.at)} · ${r.title}`, h("span", { class: "muted small" }, r.id)))) : h("div", {}, "No reminders."),
  );
}

function renderNotifications() {
  const ns = state.notifications.slice().reverse().slice(0, 5);
  if (!ns.length) return null;
  return h(
    "section",
    { class: "card" },
    h("div", { class: "row spread" }, h("h2", {}, "Notifications"), unreadCount() ? h("button", { class: "link small", onclick: () => act(() => api("POST", "/api/notifications/read")) }, "Mark read") : null),
    h("ul", { class: "list small" }, ns.map((n) => h("li", { style: n.read ? "" : "font-weight:600" }, `${time(n.at)} · ${n.text}`))),
  );
}

function renderTasks() {
  const tasks = state.sources.filter((s) => s.kind === "task");
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "Tasks"),
    h(
      "ul",
      { class: "list" },
      tasks.map((s) =>
        h(
          "li",
          { class: "row" },
          h("input", {
            type: "checkbox",
            checked: s.status === "done",
            "aria-label": `Mark ${s.title} done`,
            onchange: (e) => act(() => api("POST", `/api/sources/${s.id}/done`, { done: e.target.checked })),
          }),
          h("span", { class: s.status === "done" ? "done" : "" }, s.title),
          !s.selected ? h("span", { class: "pill" }, "not selected") : null,
        ),
      ),
    ),
  );
}

function renderReview() {
  const job = [...state.jobs].reverse().find((j) => j.status === "active" || j.status === "paused") || [...state.jobs].reverse()[0];
  const review = state.reviews[state.reviews.length - 1];
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "End-of-day review"),
    job
      ? h(
          "dl",
          { class: "kv" },
          h("dt", {}, "Skill"), h("dd", {}, job.skill),
          h("dt", {}, "Status"), h("dd", {}, job.status + (job.demoTiming ? " (demo timing)" : ` (daily at ${job.time})`)),
          job.status === "active" ? [h("dt", {}, "Next run"), h("dd", {}, dateTime(job.nextRunUtc))] : null,
          h("dt", {}, "Last run"), h("dd", {}, job.lastRun ? `${dateTime(job.lastRun.at)} · ${job.lastRun.result}` : "not yet"),
          h("dt", {}, "Cloud use"), h("dd", {}, "none; prepared locally"),
        )
      : h("p", { class: "muted small" }, "Not scheduled. The review runs on this server while it is running, even with this page closed."),
    h(
      "div",
      { class: "row", style: "margin-top:.6rem" },
      h("button", { class: "btn", disabled: busy, onclick: () => act(() => api("POST", "/api/jobs", { time: "21:00" }), "Daily review scheduled for 21:00") }, "Daily at 21:00"),
      h("button", { class: "btn", disabled: busy, onclick: () => act(() => api("POST", "/api/jobs", { inMinutes: 1 }), "Review will run in about a minute") }, "Run in 1 min (demo)"),
      job?.status === "active" ? h("button", { class: "btn", disabled: busy, onclick: () => act(() => api("POST", `/api/jobs/${job.id}/pause`), "Paused") }, "Pause") : null,
      job?.status === "paused" ? h("button", { class: "btn", disabled: busy, onclick: () => act(() => api("POST", `/api/jobs/${job.id}/resume`), "Resumed") }, "Resume") : null,
    ),
    review
      ? h(
          "div",
          { class: "card soft", style: "margin:.8rem 0 0" },
          h("strong", {}, `Review draft · ${dateTime(review.createdAt)}`),
          h("p", {}, review.summary),
          h("ul", { class: "why" }, review.items.map((i) => h("li", {}, h("span", { class: `basis ${i.outcome === "done" ? "fact" : "warn"}` }, i.outcome === "done" ? "done" : "carry"), h("span", {}, `${i.title}: ${i.suggestion}`)))),
          h("p", { class: "muted small" }, review.note),
        )
      : null,
  );
}

// ---------- Memory ----------

let editingMemory = null;

function renderMemory() {
  const active = state.memories.filter((m) => m.status === "active");
  const superseded = state.memories.filter((m) => m.status === "superseded");
  return h(
    "div",
    { class: "grid" },
    h(
      "div",
      {},
      h(
        "section",
        { class: "card" },
        h("h2", {}, "What MindVault remembers"),
        h("p", { class: "muted small" }, "Only memories you approve are saved. Correcting one creates a new version; forgetting one removes every version."),
        h("ul", { class: "list" }, active.map((m) => renderMemoryCard(m, superseded))),
      ),
    ),
    h("div", {}, renderAddMemory()),
  );
}

function historyOf(m, superseded) {
  const out = [];
  let cur = m;
  while (cur?.supersedesId) {
    cur = superseded.find((x) => x.id === cur.supersedesId);
    if (cur) out.push(cur);
  }
  return out;
}

function usesEditor(uses, onchange) {
  const opts = [
    ["planning", "Use for planning"],
    ["cloud_inference", "May share with Nemotron"],
  ];
  return h(
    "div",
    { class: "row small" },
    opts.map(([k, label]) =>
      h("label", { class: "row" }, h("input", { type: "checkbox", checked: uses.includes(k), onchange: (e) => onchange(k, e.target.checked) }), label),
    ),
  );
}

function renderMemoryCard(m, superseded) {
  const history = historyOf(m, superseded);
  if (editingMemory?.id === m.id) {
    const d = editingMemory;
    return h(
      "li",
      {},
      h("textarea", { value: d.value, oninput: (e) => (d.value = e.target.value) }),
      m.setting
        ? h("label", { class: "field" }, m.setting.name, h("input", { type: "number", value: d.settingValue, oninput: (e) => (d.settingValue = e.target.value), style: "width:7em" }))
        : null,
      usesEditor(d.allowedUses, (k, on) => (d.allowedUses = on ? [...new Set([...d.allowedUses, k])] : d.allowedUses.filter((x) => x !== k))),
      h(
        "div",
        { class: "row", style: "margin-top:.4rem" },
        h(
          "button",
          {
            class: "btn primary",
            disabled: busy,
            onclick: async () => {
              const body = { value: d.value, allowedUses: d.allowedUses, expectedVersion: m.version };
              if (m.setting) body.setting = { name: m.setting.name, value: Number(d.settingValue) };
              const ok = await act(() => api("PATCH", `/api/memories/${m.id}`, body), "Saved as a new version");
              if (ok) editingMemory = null;
              render();
            },
          },
          "Save correction",
        ),
        h("button", { class: "btn", onclick: () => { editingMemory = null; render(); } }, "Cancel"),
      ),
    );
  }
  return h(
    "li",
    {},
    h("div", {}, m.value),
    h(
      "div",
      { class: "row small muted" },
      h("span", { class: "pill" }, m.kind.replace("_", " ")),
      h("span", { class: "pill" }, `v${m.version}`),
      m.setting ? h("span", { class: "pill on" }, `${m.setting.name} = ${m.setting.value}`) : null,
      m.allowedUses.includes("cloud_inference") ? h("span", { class: "pill nemo" }, "may share with Nemotron") : h("span", { class: "pill" }, "local only"),
      m.allowedUses.includes("planning") ? null : h("span", { class: "pill warn" }, "not used for planning"),
    ),
    history.length
      ? h("details", {}, h("summary", {}, `${history.length} earlier version(s)`), h("ul", { class: "why" }, history.map((x) => h("li", {}, h("span", { class: "basis fact" }, `v${x.version}`), h("span", { class: "done" }, x.value)))))
      : null,
    h(
      "div",
      { class: "row", style: "margin-top:.3rem" },
      h("button", { class: "link small", onclick: () => { editingMemory = { id: m.id, value: m.value, settingValue: m.setting?.value, allowedUses: [...m.allowedUses] }; render(); } }, "Correct"),
      h("button", { class: "link small", onclick: () => act(() => api("DELETE", `/api/memories/${m.id}`), "Forgotten, including earlier versions") }, "Forget"),
    ),
  );
}

const newMemory = { kind: "preference", value: "", setting: "", settingValue: "", allowedUses: ["planning"] };

function renderAddMemory() {
  const d = newMemory;
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "Add a memory"),
    h("textarea", { placeholder: "e.g. I do my best writing before lunch.", value: d.value, oninput: (e) => (d.value = e.target.value) }),
    h(
      "div",
      { class: "row" },
      h(
        "label",
        { class: "field" },
        "Kind",
        h(
          "select",
          { onchange: (e) => (d.kind = e.target.value) },
          ["preference", "commitment", "project_fact"].map((k) => h("option", { value: k, selected: d.kind === k }, k.replace("_", " "))),
        ),
      ),
      h(
        "label",
        { class: "field" },
        "Planner setting (optional)",
        h(
          "select",
          { onchange: (e) => { d.setting = e.target.value; render(); } },
          h("option", { value: "" }, "none"),
          ["focusBlockMinutes", "breakMinutes", "minBlockMinutes"].map((k) => h("option", { value: k, selected: d.setting === k }, k)),
        ),
      ),
      d.setting ? h("label", { class: "field" }, "Value", h("input", { type: "number", value: d.settingValue, oninput: (e) => (d.settingValue = e.target.value), style: "width:6em" })) : null,
    ),
    usesEditor(d.allowedUses, (k, on) => (d.allowedUses = on ? [...new Set([...d.allowedUses, k])] : d.allowedUses.filter((x) => x !== k))),
    h(
      "button",
      {
        class: "btn primary",
        style: "margin-top:.5rem",
        disabled: busy,
        onclick: async () => {
          const body = { kind: d.kind, value: d.value, allowedUses: d.allowedUses };
          if (d.setting) body.setting = { name: d.setting, value: Number(d.settingValue) };
          const ok = await act(() => api("POST", "/api/memories", body), "Memory saved");
          if (ok) Object.assign(newMemory, { value: "", setting: "", settingValue: "" });
          render();
        },
      },
      "Save memory",
    ),
  );
}

// ---------- Sources ----------

let editingSource = null;
const newSource = { kind: "task", title: "", body: "", deadline: "", durationMinutes: "", priority: "" };

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// Interprets a datetime-local value in the vault timezone.
function fromLocalInput(v) {
  if (!v) return null;
  const [date, hm] = v.split("T");
  const guess = Date.parse(`${date}T${hm}:00Z`);
  const off = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t) / 60000;
  };
  return new Date(guess - off(guess) * 60000).toISOString();
}

function renderSources() {
  const items = state.sources;
  return h(
    "div",
    { class: "grid" },
    h(
      "div",
      {},
      h(
        "section",
        { class: "card" },
        h("h2", {}, "Your sources"),
        h("p", { class: "muted small" }, "Choose what planning may use, and what may be shared with Nemotron. Private items never leave this vault."),
        h("ul", { class: "list" }, items.map(renderSourceItem)),
      ),
    ),
    h("div", {}, renderAddSource()),
  );
}

function sourceToggles(s) {
  const patch = (body) => act(() => api("PATCH", `/api/sources/${s.id}`, { ...body, expectedVersion: s.version }));
  return h(
    "div",
    { class: "row small" },
    h("label", { class: "row" }, h("input", { type: "checkbox", checked: s.selected, onchange: (e) => patch({ selected: e.target.checked }) }), "Use for planning"),
    s.kind !== "calendar"
      ? h("label", { class: "row" }, h("input", { type: "checkbox", checked: s.allowCloud, disabled: s.private, onchange: (e) => patch({ allowCloud: e.target.checked }) }), "May share with Nemotron")
      : h("span", { class: "muted" }, "Busy times are applied on this device only"),
    s.kind !== "calendar" ? h("label", { class: "row" }, h("input", { type: "checkbox", checked: s.private, onchange: (e) => patch({ private: e.target.checked }) }), "Private") : null,
  );
}

function renderSourceItem(s) {
  if (editingSource?.id === s.id) return h("li", {}, renderSourceEditor(editingSource, s));
  return h(
    "li",
    {},
    h(
      "div",
      { class: "row spread" },
      h("strong", { class: s.status === "done" ? "done" : "" }, s.title),
      h("span", { class: "row" }, h("span", { class: "pill" }, s.kind), h("span", { class: "pill" }, `v${s.version}`), s.private ? h("span", { class: "pill warn" }, "private") : null),
    ),
    s.body ? h("div", { class: "muted small" }, s.body) : null,
    s.kind === "task"
      ? h(
          "div",
          { class: "small" },
          s.deadline ? `Deadline ${dateTime(s.deadline)}` : "No confirmed deadline",
          " · ",
          s.durationMinutes ? `${s.durationMinutes} min` : "duration not set",
          s.priority ? ` · ${s.priority} priority` : "",
        )
      : null,
    s.kind === "calendar" ? h("ul", { class: "why" }, s.events.map((e) => h("li", {}, `${dateTime(e.start)}–${time(e.end)} · ${e.title}`))) : null,
    sourceToggles(s),
    h(
      "div",
      { class: "row", style: "margin-top:.3rem" },
      s.kind !== "calendar"
        ? h(
            "button",
            {
              class: "link small",
              onclick: () => {
                editingSource = { id: s.id, kind: s.kind, title: s.title, body: s.body, deadline: toLocalInput(s.deadline), durationMinutes: s.durationMinutes ?? "", priority: s.priority ?? "" };
                render();
              },
            },
            "Edit",
          )
        : null,
      s.kind === "calendar" ? renderAddEvent(s) : null,
      h("button", { class: "link small", onclick: () => act(() => api("DELETE", `/api/sources/${s.id}`), "Forgotten. Plans and reminders that used it were updated.") }, "Forget"),
    ),
  );
}

function renderSourceEditor(d, existing) {
  return h(
    "div",
    {},
    h("label", { class: "field" }, "Title", h("input", { value: d.title, oninput: (e) => (d.title = e.target.value) })),
    h("label", { class: "field" }, "Notes", h("textarea", { value: d.body, oninput: (e) => (d.body = e.target.value) })),
    d.kind === "task"
      ? h(
          "div",
          { class: "row" },
          h("label", { class: "field" }, "Deadline", h("input", { type: "datetime-local", value: d.deadline, oninput: (e) => (d.deadline = e.target.value) })),
          h("label", { class: "field" }, "Minutes", h("input", { type: "number", min: 5, max: 480, value: d.durationMinutes, oninput: (e) => (d.durationMinutes = e.target.value), style: "width:6em" })),
          h(
            "label",
            { class: "field" },
            "Priority",
            h("select", { onchange: (e) => (d.priority = e.target.value) }, ["", "high", "medium", "low"].map((p) => h("option", { value: p, selected: d.priority === p }, p || "not set"))),
          ),
        )
      : null,
    h(
      "div",
      { class: "row", style: "margin-top:.4rem" },
      h(
        "button",
        {
          class: "btn primary",
          disabled: busy,
          onclick: async () => {
            const body = { title: d.title, body: d.body };
            if (d.kind === "task") Object.assign(body, { deadline: fromLocalInput(d.deadline), durationMinutes: d.durationMinutes === "" ? null : Number(d.durationMinutes), priority: d.priority || null });
            const ok = existing
              ? await act(() => api("PATCH", `/api/sources/${existing.id}`, { ...body, expectedVersion: existing.version }), "Saved")
              : await act(() => api("POST", "/api/sources", { kind: d.kind, ...body }), "Added");
            if (ok) {
              if (existing) editingSource = null;
              else Object.assign(newSource, { title: "", body: "", deadline: "", durationMinutes: "", priority: "" });
            }
            render();
          },
        },
        existing ? "Save" : "Add",
      ),
      existing ? h("button", { class: "btn", onclick: () => { editingSource = null; render(); } }, "Cancel") : null,
    ),
  );
}

function renderAddSource() {
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "Add a task or note"),
    h(
      "div",
      { class: "row" },
      ["task", "note"].map((k) =>
        h("label", { class: "row small" }, h("input", { type: "radio", name: "kind", checked: newSource.kind === k, onchange: () => { newSource.kind = k; render(); } }), k),
      ),
    ),
    renderSourceEditor(newSource, null),
    h("p", { class: "muted small" }, "Leave the deadline or duration empty if you are unsure. Nemotron can suggest one for you to confirm."),
  );
}

const newEvent = { title: "", start: "", end: "" };

function renderAddEvent(s) {
  return h(
    "details",
    { style: "flex-basis:100%" },
    h("summary", {}, "Add busy time"),
    h(
      "div",
      { class: "row" },
      h("label", { class: "field" }, "What", h("input", { value: newEvent.title, oninput: (e) => (newEvent.title = e.target.value) })),
      h("label", { class: "field" }, "Start", h("input", { type: "datetime-local", value: newEvent.start, oninput: (e) => (newEvent.start = e.target.value) })),
      h("label", { class: "field" }, "End", h("input", { type: "datetime-local", value: newEvent.end, oninput: (e) => (newEvent.end = e.target.value) })),
      h(
        "button",
        {
          class: "btn",
          disabled: busy,
          onclick: async () => {
            const events = [...s.events, { title: newEvent.title || "Busy", start: fromLocalInput(newEvent.start), end: fromLocalInput(newEvent.end) }];
            const ok = await act(() => api("PATCH", `/api/sources/${s.id}`, { events, expectedVersion: s.version }), "Busy time added");
            if (ok) Object.assign(newEvent, { title: "", start: "", end: "" });
          },
        },
        "Add",
      ),
    ),
  );
}

// ---------- Activity ----------

function renderActivity() {
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "Activity"),
    h("p", { class: "muted small" }, "What MindVault did, recorded without the content of your notes or the text sent to the model."),
    h(
      "ul",
      { class: "list small" },
      state.activity.map((a) =>
        h(
          "li",
          {},
          h("div", { class: "row spread" }, h("strong", {}, a.type), h("span", { class: "muted" }, dateTime(a.at))),
          Object.keys(a.detail || {}).length ? h("code", { class: "muted" }, JSON.stringify(a.detail)) : null,
        ),
      ),
    ),
  );
}

// ---------- render loop ----------

function render() {
  if (!state) return;
  renderChrome();
  const views = { today: renderToday, memory: renderMemory, sources: renderSources, activity: renderActivity };
  const focused = document.activeElement;
  const typing = focused && app.contains(focused) && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName) && focused.type !== "checkbox";
  if (typing && !busy) return; // do not rebuild while the user is typing
  app.replaceChildren(views[tab]());
}

for (const b of document.querySelectorAll(".tabs button")) {
  b.addEventListener("click", () => {
    tab = b.dataset.tab;
    document.activeElement?.blur();
    render();
  });
}
document.getElementById("reset").addEventListener("click", () => {
  disclosure = null;
  editingMemory = editingSource = null;
  planForm = null;
  act(() => api("POST", "/api/vault/reset"), "Demo data reset");
});

load().then(render).catch((e) => (app.textContent = e.message));
setInterval(async () => {
  if (busy) return;
  try {
    const before = JSON.stringify([state?.notifications?.length, state?.jobs, state?.reviews?.length]);
    await load();
    const after = JSON.stringify([state.notifications.length, state.jobs, state.reviews.length]);
    if (before !== after) render();
  } catch {}
}, 10000);
