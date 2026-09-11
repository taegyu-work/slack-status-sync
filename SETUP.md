# Setup

Reproducible guide. (The live EverTri deployment's real IDs are in the
git-ignored `DEPLOYMENT.md`.)

You need: a Slack workspace admin, a Microsoft 365 **Global Admin** (for Graph
admin consent), a Cloudflare account (free), and a GitHub account.

---

## 1. Slack app

1. <https://api.slack.com/apps> → **Create New App** → *From a manifest* → pick
   the workspace → paste, adjusting `redirect_urls` later:

   ```json
   {
     "display_information": { "name": "근무상태" },
     "oauth_config": {
       "redirect_urls": ["https://REPLACE.workers.dev/callback"],
       "scopes": { "user": ["users.profile:write","users.profile:read","users:read","users:read.email","dnd:write"] }
     },
     "settings": { "token_rotation_enabled": true }
   }
   ```
2. **Basic Information** → note **Client ID** and **Client Secret**.
3. If the workspace requires admin approval for apps, approve it. No install
   needed — each user authorises themselves.

---

## 2. Entra ID app registration (to read the HR calendar)

1. <https://entra.microsoft.com> → **App registrations** → **New registration**
   (single tenant, no redirect URI).
2. **API permissions** → **Microsoft Graph** → **Application permissions** →
   **`Calendars.Read`** → **Grant admin consent**.
3. **Certificates & secrets** → **New client secret** → copy the **Value**.
4. **Overview** → note **Application (client) ID** and **Directory (tenant) ID**.
5. The HR leave calendar is a mailbox address (a shared mailbox works) — that's
   `MS_CALENDAR_MAILBOX`.

> Optional hardening: `Calendars.Read` grants all-mailbox read. You can restrict
> the *leave* calendar with an application access policy, **but meeting support
> needs all-mailbox access**, so only do this if you set
> `meetings.enabled: false` in `config/settings.json`.

---

## 3. Cloudflare Worker + KV + cron

The Worker does the connect flow, the KV store, **and** the 5-min cron that
overlays 회의 중 and writes every Slack status — so it needs the Graph secrets
too. Free Cloudflare account, then from `worker/`:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create <name>        # paste the id into worker/wrangler.toml
npx wrangler secret put SLACK_CLIENT_ID
npx wrangler secret put SLACK_CLIENT_SECRET
npx wrangler secret put SYNC_SECRET             # long random string; save it
npx wrangler secret put MS_TENANT_ID           # from step 2
npx wrangler secret put MS_CLIENT_ID           # from step 2
npx wrangler secret put MS_CLIENT_SECRET       # from step 2
npx wrangler deploy                             # prints https://<name>.<sub>.workers.dev
npx wrangler secret put REDIRECT_URI            # https://<name>.<sub>.workers.dev/callback
npx wrangler deploy
```

`worker/wrangler.toml` carries `[triggers] crons = ["*/5 * * * *"]` — `wrangler
deploy` registers it. The cron fires every 5 min around the clock; the
`scheduled()` handler bails outside KST working hours (Mon–Fri ~06:00–20:00) —
adjust that guard in `worker/src/index.js` if your day differs.

Then set the real `…/callback` in **Slack → OAuth & Permissions → Redirect URLs**.
Visit the Worker URL — you should see the "Add to Slack" page.

---

## 4. GitHub repo + secrets

1. Create a repo, push this folder. **Public is fine** — there's no PII in it
   (the roster lives in the Worker's KV, not the repo).
2. **Settings → Secrets and variables → Actions** (the leave feed only — no
   Slack secrets here, the Worker does the Slack writes):

   | Secret | From |
   |---|---|
   | `MS_TENANT_ID` `MS_CLIENT_ID` `MS_CLIENT_SECRET` | step 2 |
   | `MS_CALENDAR_MAILBOX` | the HR calendar's mailbox address |
   | `WORKER_URL` | `https://<name>.<sub>.workers.dev` |
   | `SYNC_SECRET` | the same string set on the Worker |

3. **Settings → Actions → General** → allow workflows.

---

## 5. Roster

`config/roster.csv` is **git-ignored** — it holds real names/emails and is
pushed to the Worker's KV, never committed. Format: see
[`config/roster.example.csv`](config/roster.example.csv).

```bash
# .env  (git-ignored)
WORKER_URL=https://<name>.<sub>.workers.dev
SYNC_SECRET=<same as the Worker>

npm run roster:push
```

Re-run `npm run roster:push` whenever the roster changes.

---

## 6. Test, then roll out

1. **Actions → slack-status-sync (leave feed) → Run workflow → tick `dry_run`.**
   Check the run log / `last-run` artifact: `events` > 0, `unresolved` empty (fix
   names in `roster.csv` + re-push), `connections` grows as people connect.
2. Run it **without** dry-run so `conn:<id>.day` gets written.
3. Connect your own Slack via the Worker URL. Within 5 min the Worker cron should
   set your status from `day` (and 회의 중 if you're in a meeting). Force a run
   now with `npx wrangler tail` open, or:
   `npx wrangler kv key get --binding KV report:meetings:latest`.
4. Roll out — send staff the Worker URL:

   > **[경영기획팀] Slack 근무상태 자동 표시 – 1분 설정**
   > 부서 일정(재택·연차·반차·외근)과 회의 일정에 맞춰 Slack 상태가 자동으로
   > 표시됩니다. 아래 링크에서 **본인 Slack 계정을 한 번만 연결**해주세요.
   > (이메일 읽기 권한 승인 필요)
   > 👉 https://<name>.<sub>.workers.dev
   > 직접 설정한 상태는 건드리지 않습니다.
   >
   > 📌 **외근 일정을 만들 때는 제목 맨 앞에 `[외근]` 을 넣어주세요.**
   > (예: `[외근] 홍길동, 식약처 대면심사`) — 병원·대학·식약처 등 방문지 이름이
   > 있으면 자동 인식되지만, `[외근]` 을 붙이면 확실합니다.
   >
   > ⚠️ 기존 **Outlook Calendar** Slack 앱을 쓰고 계신 분은, 그 앱의
   > **상태 자동 변경 기능을 꺼주세요** (Slack → Outlook Calendar 앱 → 홈 탭
   > → "상태 업데이트" 해제). 두 개가 같이 켜져 있으면 상태가 서로 덮어씁니다.

5. Two schedules now run during KST working hours: the GitHub leave feed every
   15 min (`report:latest`, `last-run` artifact) and the Worker cron every 5 min
   (`report:meetings:latest`). Watch both for the first week.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `unresolved` has entries | name in `roster.csv` doesn't match the calendar — fix it and `npm run roster:push` |
| `unmatchedConnections` has entries | that person's Slack email / real name doesn't line up with any roster row |
| `errors: […invalid_refresh_token…]` | that user reconnects via the Worker URL (`needs_reauth` is set on their KV record) |
| `errors: […calendarView…]` | Graph consent missing, wrong `MS_CALENDAR_MAILBOX`, or an access policy excludes it |
| `…: 401` from the Worker | `SYNC_SECRET` mismatch (Worker vs GitHub vs `.env`) |
| status set but no DND | `dnd:write` scope missing — re-add, users reconnect |
| `transitions: [{action:"skip-manual"}]` | that person set their own status text — the writer backs off until it's cleared |
| `report:meetings` has `capped > 0` every run | more than `MAX_TX` transitions per tick sustained — raise `MAX_TX` in `worker/src/index.js` (watch the free-plan subrequest budget) |
| meetings never show 회의 중 | Graph app lacks all-mailbox `Calendars.Read`, or `meetings.enabled` is false, or `MS_*` secrets missing on the **Worker** |
| leave feed writes `day` but Slack never changes | Worker cron not deployed / `[triggers] crons` missing / `MS_CLIENT_SECRET` not set on the Worker |
| leave feed never runs on schedule | no repo commits for 60 days (GitHub pauses crons) — push any commit |
