# slack-status-sync

Sets each employee's **Slack status** automatically from Outlook calendars:

- **재택근무 / 연차 / 반차 / 외근** — from a shared HR mailbox calendar
- **회의 중** — from each connected person's *own* calendar, during a meeting

Priority: 연차 / 반차 / 외근 always win; 재택 shows **회의 중** while a meeting
is on, then reverts.

Built because the official **Outlook Calendar for Slack** app can't do this:
it only reads each person's *primary* calendar, only has three fixed statuses,
and its background sync is unreliable.

## How it runs (split: lazy feed + reliable writer)

```
One-time per employee          Every 15 min (leave feed)        Every 5 min (writer)
┌───────────────────────┐      ┌───────────────────────────┐    ┌────────────────────────┐
│ Cloudflare Worker      │      │ GitHub Actions            │    │ Cloudflare Worker cron │
│  /         Add to Slack│      │  src/sync.mjs             │    │  scheduled() handler   │
│  /callback store token │      │  1 read HR calendar (Graph)    │  1 list connections    │
│  /connections  ────────┼─GET─▶│  2 classify 재택/연차/반차/외근 │  2 read each `day`     │
│  /roster       ────────┼─GET─▶│  3 roster (KV): name → email   │  3 $batch meeting check│
│  /connections/:id ◀────┼POST──│  4 write `conn:<id>.day` to KV │  4 resolve priority   │
│  /report       ◀───────┼POST──│     (NO Slack writes)          │  5 users.profile.set  │
│      ▼                 │      └───────────────────────────┘    │     + dnd, or clear    │
│  Cloudflare KV         │                                       │  6 skip manual status  │
│  conn:<id> roster report                                       └────────────────────────┘
└───────────────────────┘        (bearer SYNC_SECRET on /connections /roster /report)
```

**Why split.** Leave rarely changes, so a flaky 15-min GitHub cron is fine for
it — and it never touches Slack, so drift is invisible. Meetings need to be
timely, so the Cloudflare **cron trigger** (which fires reliably, unlike GitHub
Actions) does the meeting overlay and every Slack write every 5 min. Meeting lag
is ~5 min instead of GitHub's ~12.

## Cost

Free. Cloudflare Workers + KV + Cron Triggers free plan, Slack API (no charge).
GitHub Actions is free with unlimited minutes because **this repo is public** —
safe because it holds no PII: the roster (names + emails) lives only in the
Worker's KV, never in the repo.

The 5-min writer stays inside the Workers free limits: one Graph token call, one
`$batch` per 20 connections, and Slack calls only for people whose status is
*changing* this tick (steady state does zero Slack calls). A hard `MAX_TX` cap
per run spills large 09:00 transitions onto the next tick.

## Repo layout

| Path | What |
|---|---|
| `src/sync.mjs` | **leave feed** (GitHub Actions) — writes `conn:<id>.day`, no Slack |
| `src/resolve.mjs` | pure priority resolver — `resolveStatus(day, meeting, …)` — shared by both |
| `src/classify.mjs` | event subject → `{type, part, time, name, team}` |
| `src/graph.mjs` | Microsoft Graph: token, HR `calendarView`, `$batch` meeting lookup |
| `src/slack.mjs` | `users.profile.set`, `dnd.setSnooze`, token refresh |
| `src/store.mjs` | the Worker's `/connections` · `/roster` · `/report` API (KV behind it) |
| `src/roster.mjs` | roster CSV text → name/team resolver |
| `scripts/push-roster.mjs` | push local `config/roster.csv` → KV (`npm run roster:push`) |
| `config/settings.json` | timezone, working hours, look-ahead, meeting toggle |
| `config/status-map.json` | type → status text / emoji / DND |
| `config/roster.example.csv` | roster format (real `roster.csv` is git-ignored) |
| `worker/src/index.js` | Cloudflare Worker — connect flow + KV store + sync API + **cron writer** |
| `worker/wrangler.toml` | KV binding + `[triggers] crons` |
| `.github/workflows/sync.yml` | the 15-min leave-feed cron |
| `test/` | classifier, meeting-filter, and priority-resolver tests |

## Setup

See **[SETUP.md](SETUP.md)**.

## Day-to-day

- **Add / fix a person:** edit `config/roster.csv` (git-ignored), then `npm run roster:push`.
- **Change wording or emoji:** edit `config/status-map.json`, commit, `npx wrangler deploy` (the Worker bundles it).
- **Change hours / half-day split / disable meetings:** edit `config/settings.json`, commit, `npx wrangler deploy`.
- **Test the leave feed safely:** Actions tab → *Run workflow* → tick **dry_run**.
- **See what happened:**
  - leave feed → `last-run` artifact, or `report:latest` in KV
  - meeting writer → `report:meetings:latest` in KV (`npx wrangler kv key get --binding KV report:meetings:latest`)
- **Someone needs to reconnect:** their `conn:<id>.needs_reauth` gets a timestamp
  after a `token_revoked` / `invalid_auth`. Send them the Worker URL.

## Known limits / assumptions

- **Name matching.** Calendar events carry only a Korean name (+ 직급 + 팀).
  Matching goes name → roster → email → Slack. Keep the roster current.
  Ambiguous names with no team on the event land in `unresolved`.
- **`showAs` is ignored on purpose for leave** — people mark their own
  `재택근무(오후)` / 외근 entries as *Free*, but they're still away.
- **Meetings** count only if: not all-day, `showAs: busy`, you accepted/organise
  it, and it has another attendee, a booked room, or an online-meeting link
  (skips focus-time blocks).
- **Multi-person 외근 events** only set the first name / the `(이름)` in parens.
- **`반반차`** is treated like `반차` for the parsed window.
- **Config lives in the repo** — `status-map.json` / `settings.json` changes reach
  the Worker only on `wrangler deploy`, and the GitHub job on push.
- **Off-hours cleanup is automatic** — the writer only runs ~07:00–19:00 KST;
  outside that, `status_expiration` and the DND snooze end time clear things.
- **Manual statuses win.** If a user sets their own status text, the writer
  leaves it and drops its `managed` marker for that person.
