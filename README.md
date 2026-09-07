# slack-status-sync

Sets each employee's **Slack status** automatically from Outlook calendars:

- **재택근무 / 연차 / 반차 / 외근** — from a shared HR mailbox calendar
- **회의 중** — from each connected person's *own* calendar, during a meeting

Priority: 연차 / 반차 / 외근 always win; 재택 shows **회의 중** while a meeting
is on, then reverts.

Built because the official **Outlook Calendar for Slack** app can't do this:
it only reads each person's *primary* calendar, only has three fixed statuses,
and its background sync is unreliable.

```
One-time per employee                     Every 5 min, Mon–Fri (working hours)
┌────────────────────────────┐            ┌─────────────────────────────────────┐
│ Cloudflare Worker           │            │ GitHub Actions (Node, no deps)      │
│  /         → "Add to Slack" │            │  1. read HR calendar (Graph)       │
│  /callback → store token    │            │  2. classify 재택/연차/반차/외근    │
│  /connections  ─────────────┼──GET──────▶│  3. roster (from KV): name → email  │
│  /roster       ─────────────┼──GET──────▶│  4. per-user meeting lookup (Graph) │
│  /connections/:id ◀─────────┼──POST──────│  5. skip if user set manual status │
│  /report      ◀─────────────┼──POST──────│  6. users.profile.set + dnd.setSnooze
│      ▼                      │            │  7. clear when no longer away/busy  │
│  Cloudflare KV              │            │                                     │
│  conn:<id> · roster · report│            │                                     │
└────────────────────────────┘            └─────────────────────────────────────┘
       (bearer SYNC_SECRET on /connections, /roster, /report)
```

## Cost

Free. Cloudflare Workers + KV free plan, Slack API (no charge). GitHub Actions
is free with unlimited minutes because **this repo is public** — which is safe
because it holds no PII: the roster (names + emails) lives only in the Worker's
KV, never in the repo.

## Repo layout

| Path | What |
|---|---|
| `src/sync.mjs` | the scheduled job (orchestration) |
| `src/classify.mjs` | event subject → `{type, part, time, name, team}` |
| `src/graph.mjs` | Microsoft Graph: token, HR `calendarView`, per-user meeting lookup |
| `src/slack.mjs` | `users.profile.set`, `dnd.setSnooze`, token refresh |
| `src/store.mjs` | the Worker's `/connections` · `/roster` · `/report` API (KV behind it) |
| `src/roster.mjs` | roster CSV text → name/team resolver |
| `scripts/push-roster.mjs` | push local `config/roster.csv` → KV (`npm run roster:push`) |
| `config/settings.json` | timezone, working hours, look-ahead, meeting toggle |
| `config/status-map.json` | type → status text / emoji / DND |
| `config/roster.example.csv` | roster format (real `roster.csv` is git-ignored) |
| `worker/` | Cloudflare Worker — connect flow + KV store + sync API |
| `.github/workflows/sync.yml` | the cron |
| `test/` | classifier + meeting-filter tests |

## Setup

See **[SETUP.md](SETUP.md)**.

## Day-to-day

- **Add / fix a person:** edit `config/roster.csv` (git-ignored), then `npm run roster:push`.
- **Change wording or emoji:** edit `config/status-map.json`, commit.
- **Change hours / half-day split / disable meetings:** edit `config/settings.json`.
- **Test safely:** Actions tab → *Run workflow* → tick **dry_run**.
- **See what happened:** the `last-run` artifact, or `report:latest` in KV.
- **Someone needs to reconnect:** their `conn:<id>.needs_reauth` flips to `true`
  after a `token_revoked` / `invalid_refresh_token`. Send them the Worker URL.

## Known limits / assumptions

- **Name matching.** Calendar events carry only a Korean name (+ 직급 + 팀).
  Matching goes name → roster → email → Slack. Keep the roster current.
  Ambiguous names with no team on the event land in `unresolved`.
- **`showAs` is ignored on purpose for leave** — people mark their own
  `재택근무(오후)` / 외근 entries as *Free*, but they're still away.
- **Meetings** count only if: not all-day, `showAs: busy`, you accepted/organise
  it, and it has another attendee or an online-meeting link (skips focus-time).
- **Multi-person 외근 events** only set the first name / the `(이름)` in parens.
- **`반반차`** is treated like `반차` for the parsed window.
- **GitHub cron drift.** Scheduled Actions run a few minutes late under load and
  pause after 60 days with no commits; the 5-min cadence + `status_expiration`
  safety net absorb it.
- **Manual statuses win.** If a user sets their own status, the job leaves it.
