# MindVault Personal

A personal planner that turns scattered commitments into a realistic plan for the day. It uses memory you can inspect and correct, and NVIDIA Nemotron reasoning (served by Nebius Token Factory) that only runs after you have seen and approved the exact request.

Built for the NVIDIA x Nebius Global AI Hackathon, Personal AI track.

## What it does

1. **Remember.** You save memory cards such as "I prefer 25-minute focus blocks". Each card says whether it may be used for planning and whether it may be shared with the model. Correcting a card creates a new version; forgetting it removes every version.
2. **Preview.** When you ask for a plan, MindVault builds the exact request it would send to Nemotron and shows it to you: which tasks and memories are included, which are not (private notes, your calendar), the recipient, the size and a fingerprint.
3. **Interpret with Nemotron.** After you approve, the request goes to an NVIDIA Nemotron model through Nebius Token Factory. Nemotron reads free-text task notes and returns structured JSON: deadlines it found in the text ("due next Monday"), dependencies ("needs the updated CV first"), duration estimates, priorities and short reasons.
4. **Plan with exact rules.** Local code builds the schedule. It subtracts busy time, applies your block and break preferences, respects dependencies and an optional focus budget, and never invents time. Anything Nemotron inferred is labelled and must be confirmed by you. Work without a confirmed duration goes to "Not scheduled" instead of being guessed.
5. **Approve actions.** Saving a plan and its reminders is a separate approval. Reminders are delivered by MindVault's scheduler.
6. **Review.** A scheduled `review_day` job runs on the server (even with the browser closed) and prepares a carry-forward draft for unfinished work. It runs locally and sends nothing to the cloud.
7. **Activity.** Every step is logged without note contents or prompt text.

## Quick start (local)

Requires Node.js 20 or newer. There are no npm dependencies.

```bash
git clone https://github.com/catherinearulanand/NVIDIA-x-NEBIUS.git
cd NVIDIA-x-NEBIUS
cp .env.example .env        # then put your key in .env
npm run preflight           # lists NVIDIA models your key can use and sends one test request
npm start                   # open http://127.0.0.1:8787
```

`npm run preflight` prints the NVIDIA model IDs available to your key. Copy the Nemotron one you want into `NEBIUS_MODEL_ID` in `.env` (a Nemotron Nano model is a sensible start) and run preflight again until it passes.

Without a key the app still runs in **local mode**: planning works, but there is no connected reasoning, and the header says so.

Run the tests with `npm test`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `NEBIUS_API_KEY` | Token Factory API key. Kept on the server, never sent to the browser. |
| `NEBIUS_BASE_URL` | Defaults to `https://api.tokenfactory.nebius.com/v1/`. |
| `NEBIUS_MODEL_ID` | Exact NVIDIA model ID from your catalog. |
| `NEBIUS_EXTRA_BODY` | Optional JSON merged into each request, for model-specific options. |
| `NEBIUS_MAX_TOKENS` | Completion budget (default 2000). Raise it if replies are cut off. |
| `MINDVAULT_PROFILE` | `local` (default, one vault, bound to 127.0.0.1) or `hosted` (per-browser synthetic demo sessions). |
| `MINDVAULT_TIMEZONE` | IANA timezone for plans (default `Asia/Kolkata`). |

## Hosted demo

`MINDVAULT_PROFILE=hosted` gives every browser its own vault seeded with a fictional student, expiring after 24 hours. Connected reasoning is rate limited per session (12 per hour) and per server (400 per day). The page says clearly that it is a synthetic demo and that the server processes what you type.

Deploy options:

- **Render:** create a Blueprint from this repo (`render.yaml`), then set `NEBIUS_API_KEY` and `NEBIUS_MODEL_ID` in the dashboard.
- **Any container host:** `docker build -t mindvault . && docker run -p 8080:8080 -e NEBIUS_API_KEY=... -e NEBIUS_MODEL_ID=... mindvault`

## How it is built

```
server.js            HTTP API, static files, sessions, scheduler loop
src/vault.js         sources, versioned memory, disclosure and approval, plans, commits, review_day
src/planner.js       deterministic scheduler (busy time, breaks, budget, dependencies, deadlines)
src/nebius.js        Token Factory adapter: strict JSON-schema output, JSON-mode fallback
src/validate.js      runtime validation of model output (unknown sources dropped, values bounded)
src/seed.js          synthetic demo data
public/              web UI (vanilla JS)
scripts/preflight.js checks your key and model before a demo
test/                planner and end-to-end flow tests
```

Safety and privacy choices:

- The approval is bound to a SHA-256 fingerprint of the previewed payload. If anything in the vault changes between preview and send, the request is refused; if it changes while the model is answering, the answer is discarded.
- Model output never authorizes anything. It is validated, limited to the sources that were shared, and only shapes a draft that you approve.
- Forgetting a source removes its text from plans, reviews and pending previews and cancels its reminders. It cannot recall a request that was already sent, and the UI says so.
- Mutating API calls need a custom header (blocks cross-site form posts). The local profile accepts only `127.0.0.1` / `localhost` Host headers.

## Limitations

- Storage is plain JSON files on the server, not an encrypted vault.
- The scheduler runs only while the server is running.
- Reminders appear inside MindVault; nothing is written to external calendars.
- The planner is a simple earliest-deadline and priority heuristic, not an optimizer.
- MindVault is a planning aid. It is not a medical, mental-health or crisis service.

## License

MIT. See [LICENSE](LICENSE).
