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

## 3. Cloudflare Worker + KV

Free Cloudflare account, then from `worker/`:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create <name>        # paste the id into worker/wrangler.toml
npx wrangler secret put SLACK_CLIENT_ID
npx wrangler secret put SLACK_CLIENT_SECRET
npx wrangler secret put SYNC_SECRET             # long random string; save it
npx wrangler deploy                             # prints https://<name>.<sub>.workers.dev
npx wrangler secret put REDIRECT_URI            # https://<name>.<sub>.workers.dev/callback
npx wrangler deploy
```

Then set the real `…/callback` in **Slack → OAuth & Permissions → Redirect URLs**.
Visit the Worker URL — you should see the "Add to Slack" page.

---

## 4. GitHub repo + secrets

1. Create a repo, push this folder. **Public is fine** — there's no PII in it
   (the roster lives in the Worker's KV, not the repo).
2. **Settings → Secrets and variables → Actions**:

   | Secret | From |
   |---|---|
   | `MS_TENANT_ID` `MS_CLIENT_ID` `MS_CLIENT_SECRET` | step 2 |
   | `MS_CALENDAR_MAILBOX` | the HR calendar's mailbox address |
   | `SLACK_CLIENT_ID` `SLACK_CLIENT_SECRET` | step 1 |
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

1. **Actions → slack-status-sync → Run workflow → tick `dry_run`.** Check the
   run log / `last-run` artifact: `events` > 0, `unresolved` empty (fix names in
   `roster.csv` + re-push), `connections` grows as people connect.
2. Connect your own Slack via the Worker URL, then run **without** dry-run while
   you have a calendar entry or a meeting. Confirm your status changes.
3. Roll out — send staff the Worker URL:

   > **[인사팀] Slack 근무상태 자동 표시 – 1분 설정**
   > 부서 일정(재택·연차·반차·외근)과 회의 일정에 맞춰 Slack 상태가 자동으로
   > 표시됩니다. 아래 링크에서 **본인 Slack 계정을 한 번만 연결**해주세요.
   > (이메일 읽기 권한 승인 필요)
   > 👉 https://<name>.<sub>.workers.dev
   > 직접 설정한 상태는 건드리지 않습니다.

4. The cron runs every 5 min during KST working hours. Watch `report:latest` in
   KV (`npx wrangler kv key get --binding KV report:latest`) or the `last-run`
   artifacts for the first week.

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
| everyone `skipped: "manual status"` | something else is setting statuses (e.g. the native Slack calendar integration still connected) |
| nothing runs on schedule | no repo commits for 60 days (GitHub pauses crons) — push any commit |
