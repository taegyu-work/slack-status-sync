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
| `config/emoji/` | the custom `:yeoncha:`/`:bancha:`/`:banbancha:` emoji referenced above (source PNGs + upload notes) |
| `config/roster.example.csv` | roster format (real `roster.csv` is git-ignored) |
| `worker/src/index.js` | Cloudflare Worker — connect flow + KV store + sync API + **cron writer** |
| `worker/wrangler.toml` | KV binding + `[triggers] crons` |
| `.github/workflows/sync.yml` | the 15-min leave-feed cron |
| `test/` | classifier, roster, meeting-filter, and priority-resolver tests |

## Setup

See **[SETUP.md](SETUP.md)**.

## Admin dashboard & failure alerts

`GET /admin?key=ADMIN_KEY` — a read-only page (bookmark it) showing:

- how many minutes since the leave feed and the Worker cron last ran (⚠️ if stale)
- the most recent errors from both
- everyone connected: today's status, what Slack currently shows, whether they need to reconnect
- everyone in the roster who **hasn't** connected yet — the list to chase during rollout

`ADMIN_KEY` is a separate secret from `SYNC_SECRET` (which can *write* connection
data) — a leaked admin link only exposes read-only names/emails/status, not write
access. Set it with `wrangler secret put ADMIN_KEY`; without it, `/admin` is
inaccessible from a plain browser (only `Authorization: Bearer SYNC_SECRET` works).

If `ALERT_WEBHOOK_URL` is set (a Slack Incoming Webhook), the cron posts there —
cooldown-limited so a persistent failure nags, not spams — when: it crashes
(e.g. the Graph client secret expired), a person's Slack connection breaks
(`token_revoked` / `invalid_auth` → also flips their `needs_reauth`), or a run
ends with any other errors.

## Day-to-day

- **Add / fix a person:** edit `config/roster.csv` (git-ignored), then `npm run roster:push`.
- **Change wording or emoji:** edit `config/status-map.json`, commit, `npx wrangler deploy` (the Worker bundles it).
- **Change hours / half-day split / disable meetings:** edit `config/settings.json`, commit, `npx wrangler deploy`.
- **Test the leave feed safely:** Actions tab → *Run workflow* → tick **dry_run**.
- **See what happened:**
  - the admin dashboard (`/admin?key=...`) for a human-readable view
  - leave feed → `last-run` artifact, or `report:latest` in KV
  - meeting writer → `report:meetings:latest` in KV (`npx wrangler kv key get --binding KV report:meetings:latest`)
- **Someone needs to reconnect:** their `conn:<id>.needs_reauth` gets a timestamp
  after a `token_revoked` / `invalid_auth` — shows up on `/admin` and (if
  `ALERT_WEBHOOK_URL` is set) as a Slack alert. Send them the Worker URL.

## Known limits / assumptions

- **Name matching.** Calendar events carry only a Korean name (+ 직급 + 팀).
  Matching goes name → roster → email → Slack. Keep the roster current.
  Ambiguous names with no team on the event land in `unresolved`.
- **`showAs` is ignored on purpose for leave** — people mark their own
  `재택근무(오후)` / 외근 entries as *Free*, but they're still away.
- **Meetings** count only if: not all-day, `showAs: busy`, you accepted/organise
  it, and it has another attendee, a booked room, or an online-meeting link
  (skips focus-time blocks).
- **외근 detection** is subject-text only: the literal word `외근` (staff are
  asked to prefix titles with `[외근]`), or — as a fallback — an institution
  word (병원·대학·보건소·식약처·…), a CRA visit token (MV/OV/모니터링/방문/…),
  or a title with ≥ 2 commas. Multi-person 외근 titles without commas/parens
  (e.g. `김건소 정서우 오후 외근 티알`) are handled by trying every 2-4 syllable
  Hangul token against the roster and keeping whatever resolves.
- **Showing the calendar subject in 외근/회의 status text is opt-in, per
  person** — e.g. `외근 중 · 고려대병원` or `회의 중 · 분기 리뷰` instead of
  the bare base text. Off by default (`conn.showSubject`, unset ⇒ false); a
  person turns it on by (re)connecting via the "상세 정보 포함으로 연결" link
  on the landing page, which round-trips through Slack OAuth's `state` param
  to `/callback`. `appendSubject()` in `resolve.mjs` builds the text,
  truncated to fit Slack's 100-char `status_text` limit (Slack rejects longer
  ones outright, no silent truncation). 재택/연차/반차 never get this even
  when opted in — their subject is just the person's own name.
- **`반반차`** (quarter day) is its own type — `반반차`/`반반차_AM`/`반반차_PM`
  in `status-map.json`, distinct from `반차` — since the hr@ calendar uses it
  for real, shorter blocks (e.g. `(14:00~16:00)`) and showing it as a normal
  half-day 반차 status would overstate how long the person's away.
- **연차/반차/반반차 use custom emoji** (`:yeoncha:`/`:bancha:`/`:banbancha:`)
  — bold text rendered edge-to-edge by `scripts/text-emoji.ps1` and uploaded
  to the EverTri workspace. Deliberately plain (no ring/badge, no
  handwriting): Slack shows status emoji at ~16-20px, and only large bold
  glyphs with minimal padding survive being shrunk that far — see
  `config/emoji/README.md` for what didn't work. Custom emoji are
  workspace-local — moving to a different Slack workspace means re-uploading
  them there first.
- **Config lives in the repo** — `status-map.json` / `settings.json` changes reach
  the Worker only on `wrangler deploy`, and the GitHub job on push.
- **Off-hours cleanup is automatic** — the writer only runs ~07:00–19:00 KST;
  outside that, `status_expiration` and the DND snooze end time clear things.
- **Manual statuses win.** If a user sets their own status text, the writer
  leaves it and drops its `managed` marker for that person.
- **Don't run the official Outlook Calendar Slack app's status feature too.**
  Both write the same status field on a timer and will overwrite each other —
  and its "부재중" / "Working elsewhere" text isn't one this app recognises, so
  the writer reads it as a manual status and backs off. Each user turns off
  "update my status" in that app (or removes it).
