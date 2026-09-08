// Cloudflare Worker: per-employee Slack connect flow + token store (KV)
// + the 5-minute cron that overlays "회의 중" and does ALL Slack writes.
//
//   GET  /                      -> "Add to Slack" page
//   GET  /callback?code=...     -> exchange code, save tokens to KV, success page
//   GET  /connections           -> [bearer SYNC_SECRET] { [slackUserId]: conn }
//   POST /connections/:uid      -> [bearer SYNC_SECRET] merge-patch one connection
//   GET  /roster                -> [bearer SYNC_SECRET] roster CSV text
//   PUT  /roster                -> [bearer SYNC_SECRET] replace roster CSV
//   POST /report                -> [bearer SYNC_SECRET] store the leave-job run log
//   cron */5 (KST work hours)   -> read each connection's `day` (written by the
//                                  GitHub leave job), check their own calendar for
//                                  a live meeting, resolve priority, set Slack.
//
// KV binding: `KV`  (namespace created with `wrangler kv namespace create ...`)
// Secrets: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SYNC_SECRET,
//          MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET  (REDIRECT_URI optional)

import { getGraphToken, getMeetingsForMany } from '../../src/graph.mjs';
import { resolveStatus, dayMeansAway, tzToday } from '../../src/resolve.mjs';
import * as slack from '../../src/slack.mjs';
import MAP from '../../config/status-map.json';
import SETTINGS from '../../config/settings.json';

const USER_SCOPES = 'users.profile:write,users.profile:read,users:read,users:read.email,dnd:write';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/') return html(landing(env, url.origin));
      if (req.method === 'GET' && url.pathname === '/callback') return html(await handleCallback(req, env, url));

      // --- authenticated sync API ---
      if (/^\/(connections|roster|report)/.test(url.pathname)) {
        if (!authed(req, env)) return new Response('unauthorized', { status: 401 });
        if (req.method === 'GET' && url.pathname === '/connections') return json(await listConnections(env));
        if (req.method === 'POST' && url.pathname.startsWith('/connections/')) {
          const uid = decodeURIComponent(url.pathname.slice('/connections/'.length));
          return json(await patchConnection(env, uid, await req.json()));
        }
        if (url.pathname === '/roster') {
          if (req.method === 'GET') {
            const csv = (await env.KV.get('roster')) || '';
            return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8' } });
          }
          if (req.method === 'PUT') {
            const csv = await req.text();
            await env.KV.put('roster', csv);
            return json({ ok: true, bytes: csv.length });
          }
        }
        if (req.method === 'POST' && url.pathname === '/report') {
          const r = await req.json();
          await env.KV.put('report:latest', JSON.stringify(r));
          if (r.date) await env.KV.put(`report:${r.date}`, JSON.stringify(r), { expirationTtl: 60 * 60 * 24 * 90 });
          return json({ ok: true });
        }
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return html(`<h1>오류</h1><p>${escapeHtml(e.message)}</p><p><a href="/">다시 시도</a></p>`, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runMeetingSync(env).catch((e) => console.error('scheduled:', e.stack || e.message)),
    );
  },
};

/* ---------- cron: meeting overlay + Slack writes ---------- */

const KNOWN_TEXTS = new Set(Object.values(MAP).map((v) => v.text));
// Cap the number of connections we do Slack calls for per run, to stay well
// under the Workers free-plan subrequest budget when many people transition at
// 09:00 at once. The leftover clears on the next 5-min tick.
const MAX_TX = 10;

function statusIsOurs(curText, managed) {
  if (!curText) return true;
  if (managed && curText === managed.text) return true;
  return KNOWN_TEXTS.has(curText);
}

async function freshToken(env, uid, c) {
  if (!c.expires_at || c.expires_at > Date.now() + 120_000) return c.access_token;
  if (!c.refresh_token) return c.access_token;
  const r = await slack.refresh(env.SLACK_CLIENT_ID, env.SLACK_CLIENT_SECRET, c.refresh_token);
  await patchConnection(env, uid, {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: Date.now() + r.expires_in * 1000,
  });
  return r.access_token;
}

async function runMeetingSync(env) {
  const now = new Date();

  // Only act during KST working hours (Mon–Fri ~06:00–20:00). Outside that,
  // status_expiration and the DND snooze end time clear everything on their own,
  // so there is nothing for the writer to do. (Cron fires every 5 min regardless
  // because Cloudflare's cron parser rejects hour/DOW-range expressions.)
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const dow = kst.getUTCDay(); // 0=Sun … 6=Sat
  const hour = kst.getUTCHours();
  if (dow === 0 || dow === 6 || hour < 6 || hour >= 20) {
    await env.KV.put('report:meetings:latest', JSON.stringify({
      job: 'meetings', ranAt: now.toISOString(), idle: 'outside KST working hours',
    }));
    return;
  }

  const today = tzToday(now, SETTINGS.timezone);
  const dayLookaheadMs = (SETTINGS.lookaheadMinutes || 30) * 60_000;
  const meetLookaheadMs = (SETTINGS.meetings?.lookaheadMinutes || 2) * 60_000;
  const meetingsOn = SETTINGS.meetings?.enabled !== false;

  const conns = await listConnections(env);
  const entries = Object.entries(conns);
  if (!entries.length) {
    await env.KV.put('report:meetings:latest', JSON.stringify({
      job: 'meetings', ranAt: now.toISOString(), idle: 'no connections',
    }));
    return;
  }

  const gtok = await getGraphToken(env.MS_TENANT_ID, env.MS_CLIENT_ID, env.MS_CLIENT_SECRET);

  // Look up meetings only for people with an email who aren't already "away"
  // for the whole day (연차/반차/외근) — that always wins, so skip the call.
  const meetingEmails = meetingsOn
    ? entries
        .filter(([, c]) => c.email && !dayMeansAway(c.day || null, now, dayLookaheadMs))
        .map(([, c]) => c.email.toLowerCase())
    : [];

  let meetings = new Map();
  let mErrors = new Map();
  if (meetingEmails.length) {
    ({ meetings, errors: mErrors } = await getMeetingsForMany(
      gtok, meetingEmails, now, meetLookaheadMs,
      { tz: SETTINGS.graphTimezone, requireAttendeeOrOnline: SETTINGS.meetings?.requireAttendeeOrOnline !== false },
    ));
  }

  const report = {
    job: 'meetings', ranAt: now.toISOString(), date: today,
    connections: entries.length, meetingLookups: meetingEmails.length,
    transitions: [], skipped: 0, capped: 0, errors: [],
  };
  for (const [mb, e] of mErrors) report.errors.push({ mailbox: mb, error: e });

  let tx = 0;
  for (const [uid, c] of entries) {
    const meeting = c.email ? meetings.get(c.email.toLowerCase()) || null : null;
    const chosen = resolveStatus(c.day || null, meeting, now, dayLookaheadMs, MAP['회의']);

    // Steady state — what we last set still matches. No Slack call.
    if (chosen && c.managed &&
        c.managed.key === chosen.key &&
        c.managed.date === today &&
        c.managed.toISO === chosen.toISO) { report.skipped++; continue; }

    // Nothing wanted and nothing we set today: the status (if any) already
    // expired on its own overnight — just drop the stale marker, no Slack call.
    if (!chosen && (!c.managed || c.managed.date !== today)) {
      if (c.managed) await patchConnection(env, uid, { managed: null });
      else report.skipped++;
      continue;
    }

    if (tx >= MAX_TX) { report.capped++; continue; }
    tx++;

    try {
      const token = await freshToken(env, uid, c);
      const prof = await slack.getProfile(token);
      const curText = prof.status_text || '';

      if (!statusIsOurs(curText, c.managed)) {
        if (c.managed) await patchConnection(env, uid, { managed: null });
        report.transitions.push({ uid, action: 'skip-manual', curText });
        continue;
      }

      if (chosen) {
        const endMs = new Date(chosen.toISO).getTime();
        await slack.setStatus(token, chosen.text, chosen.emoji, Math.floor(endMs / 1000));
        if (chosen.dnd) {
          await slack.setSnooze(token, Math.max(1, Math.round((endMs - Date.now()) / 60_000))).catch(() => {});
        } else if (c.managed?.dnd) {
          await slack.endSnooze(token).catch(() => {});
        }
        await patchConnection(env, uid, {
          managed: {
            key: chosen.key, date: today, toISO: chosen.toISO,
            text: chosen.text, emoji: chosen.emoji, dnd: !!chosen.dnd,
            source: chosen.source, at: now.toISOString(),
          },
        });
        report.transitions.push({ uid, action: 'set', key: chosen.key, source: chosen.source, until: chosen.toISO });
      } else {
        await slack.clearStatus(token);
        if (c.managed?.dnd) await slack.endSnooze(token).catch(() => {});
        await patchConnection(env, uid, { managed: null });
        report.transitions.push({ uid, action: 'clear' });
      }
    } catch (e) {
      report.errors.push({ uid, error: e.code || e.message });
      if (['token_revoked', 'invalid_auth', 'account_inactive', 'not_authed'].includes(e.code)) {
        await patchConnection(env, uid, { needs_reauth: now.toISOString() }).catch(() => {});
      }
    }
  }

  await env.KV.put('report:meetings:latest', JSON.stringify(report));
}

function authed(req, env) {
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${env.SYNC_SECRET}` && !!env.SYNC_SECRET;
}

const redirectUri = (env, origin) => env.REDIRECT_URI || `${origin}/callback`;

/* ---------- KV token store ---------- */

async function listConnections(env) {
  const out = {};
  let cursor;
  do {
    const page = await env.KV.list({ prefix: 'conn:', cursor });
    for (const k of page.keys) {
      const v = await env.KV.get(k.name, 'json');
      if (v && v.slackUserId) out[v.slackUserId] = v;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function patchConnection(env, uid, patch) {
  const key = `conn:${uid}`;
  const existing = (await env.KV.get(key, 'json')) || { slackUserId: uid };
  const merged = { ...existing, ...patch, slackUserId: uid };
  await env.KV.put(key, JSON.stringify(merged));
  return { ok: true };
}

/* ---------- Slack connect flow ---------- */

function landing(env, origin) {
  const u = new URL('https://slack.com/oauth/v2/authorize');
  u.searchParams.set('client_id', env.SLACK_CLIENT_ID);
  u.searchParams.set('user_scope', USER_SCOPES);
  u.searchParams.set('redirect_uri', redirectUri(env, origin));
  return `
    <h1>EverTri 근무상태 · Slack 연동</h1>
    <p>아래 버튼으로 본인 Slack 계정을 <b>한 번만</b> 연결하면, 부서 일정
    (재택 · 연차 · 반차 · 외근)에 따라 Slack 상태가 자동으로 표시됩니다.</p>
    <p><a class="btn" href="${u.toString()}">Add to Slack</a></p>
    <p class="muted">연결을 해제하려면 인사팀에 알려주세요.</p>`;
}

async function handleCallback(req, env, url) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) return `<h1>연결 취소됨</h1><p>${escapeHtml(error)}</p><p><a href="/">다시 시도</a></p>`;
  if (!code) return `<h1>인증 코드 없음</h1><p><a href="/">다시 시도</a></p>`;

  const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(env, url.origin),
    }),
  });
  const j = await tokenRes.json();
  if (!j.ok) return `<h1>연결 실패</h1><p>${escapeHtml(j.error)}</p><p><a href="/">다시 시도</a></p>`;

  const u = j.authed_user;
  // users.info returns email (needs users:read.email) + the Korean real_name,
  // which is our fallback match key when email is unavailable.
  const info = await fetch(`https://slack.com/api/users.info?user=${u.id}`, {
    headers: { authorization: `Bearer ${u.access_token}` },
  }).then((r) => r.json());
  const p = info.ok ? info.user.profile || {} : {};
  const email = (p.email || '').toLowerCase();
  const realName = p.real_name || p.display_name || info.user?.real_name || '';

  await env.KV.put(`conn:${u.id}`, JSON.stringify({
    slackUserId: u.id,
    email,
    real_name: realName,
    display_name: p.display_name || '',
    access_token: u.access_token,
    refresh_token: u.refresh_token || null,
    expires_at: u.expires_in ? Date.now() + u.expires_in * 1000 : null,
    team_id: j.team?.id || null,
    managed: null,
    needs_reauth: null,
    updated_at: new Date().toISOString(),
  }));

  return `
    <h1>연결 완료 ✅</h1>
    <p><b>${escapeHtml(email || u.id)}</b> 계정이 연결되었습니다.</p>
    <p>이제 부서 일정에 따라 Slack 상태가 자동으로 설정됩니다. 이 창은 닫으셔도 됩니다.</p>
    ${email ? '' : '<p class="muted">이메일을 읽지 못했습니다. 인사팀에 문의해주세요.</p>'}`;
}

/* ---------- helpers ---------- */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function html(inner, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EverTri Slack 상태 연동</title>
<style>
  body{font-family:system-ui,-apple-system,'Malgun Gothic',sans-serif;max-width:32rem;
       margin:4rem auto;padding:0 1.25rem;line-height:1.65;color:#1a1a1a;background:#fafafa}
  h1{font-size:1.35rem;margin-bottom:.5rem}
  .btn{display:inline-block;background:#4A154B;color:#fff;padding:.8rem 1.5rem;border-radius:8px;
       text-decoration:none;font-weight:600;margin:.5rem 0}
  .muted{color:#666;font-size:.9rem;margin-top:2rem}
</style>
${inner}`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
