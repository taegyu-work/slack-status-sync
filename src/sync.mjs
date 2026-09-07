// Recurring job: read the hr@ calendar for who is 재택 / 연차 / 반차 / 외근,
// read each connected person's own calendar for a meeting in progress, and
// set their Slack status + DND accordingly.
//
// Priority: 연차 / 반차 / 외근 always win; 재택 yields to 회의 중 during the
// meeting. Idempotent: safe to run repeatedly; clears a status it set once
// the person is no longer away / in a meeting.

import { readFile, writeFile } from 'node:fs/promises';
import { getGraphToken, getCalendarView, getMeetingNow } from './graph.mjs';
import { classify, statusKey } from './classify.mjs';
import { parseRoster } from './roster.mjs';
import { createStore } from './store.mjs';
import * as slack from './slack.mjs';

const cfgUrl = (n) => new URL(`../config/${n}`, import.meta.url);
const CFG = JSON.parse(await readFile(cfgUrl('settings.json'), 'utf8'));
const MAP = JSON.parse(await readFile(cfgUrl('status-map.json'), 'utf8'));
const MANAGED_TEXTS = new Set(Object.values(MAP).map((v) => v.text));

const DRY = CFG.dryRun || process.env.DRY_RUN === '1';
const OFFSET = CFG.utcOffset || '+09:00';
const pad = (n) => String(n).padStart(2, '0');

function env(k) {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

// "what day / hour is it" in the configured tz
function tzParts(date) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: CFG.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hh: +p.hour, mm: +p.minute };
}

// a Date at a given wall-clock time on `dateStr` in the configured tz
const wall = (dateStr, hhmm) => new Date(`${dateStr}T${hhmm}:00${OFFSET}`);

// Graph start/end -> Date (values are already KST wall time via Prefer header)
const evTime = (x) => new Date(x.dateTime.replace(/\.\d+$/, '') + OFFSET);

function computeWindow(c, ev, today) {
  const { start, end, halfDaySplit } = CFG.workday;
  if (c.time) {
    return {
      from: wall(today, `${pad(c.time.sh)}:${pad(c.time.sm)}`),
      to: wall(today, `${pad(c.time.eh)}:${pad(c.time.em)}`),
    };
  }
  if (c.part === 'AM') return { from: wall(today, start), to: wall(today, halfDaySplit) };
  if (c.part === 'PM') return { from: wall(today, halfDaySplit), to: wall(today, end) };
  if (c.type === '외근' && !c.isAllDay && ev?.start?.dateTime) {
    return { from: evTime(ev.start), to: evTime(ev.end) };
  }
  return { from: wall(today, start), to: wall(today, end) };
}

async function ensureToken(store, uid, c) {
  const skew = 5 * 60 * 1000;
  if (c.access_token && c.expires_at && Date.now() < c.expires_at - skew) return c.access_token;
  const r = await slack.refresh(env('SLACK_CLIENT_ID'), env('SLACK_CLIENT_SECRET'), c.refresh_token);
  const patch = {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: Date.now() + r.expires_in * 1000,
  };
  if (!DRY) await store.patchConnection(uid, patch);
  Object.assign(c, patch);
  return patch.access_token;
}

async function main() {
  const now = new Date();
  const { date: today } = tzParts(now);
  const dayStart = wall(today, '00:00');
  const dayEnd = new Date(dayStart.getTime() + 86400_000);

  const store = createStore(env('WORKER_URL'), env('SYNC_SECRET'));

  // 1. calendar + roster (roster lives in the Worker's KV, not the repo)
  const gtok = await getGraphToken(env('MS_TENANT_ID'), env('MS_CLIENT_ID'), env('MS_CLIENT_SECRET'));
  const [events, roster] = await Promise.all([
    getCalendarView(
      gtok, env('MS_CALENDAR_MAILBOX'), dayStart.toISOString(), dayEnd.toISOString(), CFG.graphTimezone,
    ),
    store.getRoster().then(parseRoster),
  ]);

  // 2. classify + resolve to email
  const desired = new Map(); // email -> { key,text,emoji,dnd,from,to,subject }
  const unresolved = [];

  const mailbox = env('MS_CALENDAR_MAILBOX').toLowerCase();
  for (const ev of events) {
    const c = classify(ev.subject, ev);
    if (!c) continue;
    let person = roster.resolve(c.name, c.team);
    if (!person) {
      // Self-organised 외근 events: the organiser IS the person, so their
      // real email is on the event even when the name isn't in the roster.
      const orgEmail = ev.organizer?.emailAddress?.address?.toLowerCase();
      if (orgEmail && orgEmail !== mailbox) {
        person = { email: orgEmail, name: c.name, team: c.team, viaOrganizer: true };
      }
    }
    if (!person) { unresolved.push(ev.subject); continue; }

    const key = statusKey(c.type, c.part);
    const conf = MAP[key] || MAP[c.type];
    const win = computeWindow(c, ev, today);
    const prev = desired.get(person.email);
    // if multiple entries for one person, keep the one that starts earliest
    if (!prev || win.from < prev.from) {
      desired.set(person.email, {
        key, text: conf.text, emoji: conf.emoji, dnd: conf.dnd,
        from: win.from, to: win.to, subject: ev.subject,
      });
    }
  }

  // 3. load Slack connections
  const conns = (await store.getConnections()) || {};

  const lookaheadMs = (CFG.lookaheadMinutes || 30) * 60000;
  const MEET = CFG.meetings || { enabled: false };
  const meetLookaheadMs = (MEET.lookaheadMinutes || 2) * 60000;
  // Day-level statuses that yield to "회의 중" while a meeting is on.
  // 연차 / 반차 / 외근 mean the person is away, so they always win.
  const DAY_YIELDS_TO_MEETING = new Set(['재택', '재택_AM', '재택_PM']);

  const report = {
    date: today, ranAt: now.toISOString(), dryRun: DRY,
    events: events.length, connections: Object.keys(conns).length,
    set: [], cleared: [], skipped: [], unresolved, unmatchedConnections: [], errors: [],
  };

  // Resolve a connection to a roster email: prefer the Slack email, fall back
  // to matching the Korean real_name against the roster (unique names only).
  const connEmail = (c) => {
    if (c.email) return c.email.toLowerCase();
    if (c.real_name) return roster.resolve(c.real_name, '')?.email || '';
    return '';
  };

  // 4. apply per connected user
  for (const [uid, c] of Object.entries(conns)) {
    const email = connEmail(c);
    try {
      if (!email) report.unmatchedConnections.push({ uid, real_name: c.real_name || null });

      // day-level status from the hr@ calendar
      const day = email ? desired.get(email) : null;
      const dayActive =
        day && now >= new Date(day.from.getTime() - lookaheadMs) && now < day.to;
      const dayIsAway = dayActive && !DAY_YIELDS_TO_MEETING.has(day.key);

      // meeting on the person's own calendar (skip entirely when the day
      // status already means "away", or meetings are disabled / no email)
      let meeting = null;
      if (MEET.enabled && email && !dayIsAway) {
        try {
          meeting = await getMeetingNow(gtok, email, now, meetLookaheadMs, {
            tz: CFG.graphTimezone,
            requireAttendeeOrOnline: MEET.requireAttendeeOrOnline !== false,
          });
        } catch (e) {
          report.errors.push({ uid, email, error: `meeting ${e.message}` });
        }
      }

      // pick the winner
      let chosen = null;
      if (dayIsAway) {
        chosen = { key: day.key, text: day.text, emoji: day.emoji, dnd: day.dnd, to: day.to, subject: day.subject };
      } else if (meeting) {
        chosen = { key: '회의', ...MAP['회의'], to: meeting.to, subject: '회의' };
      } else if (dayActive) {
        chosen = { key: day.key, text: day.text, emoji: day.emoji, dnd: day.dnd, to: day.to, subject: day.subject };
      }

      const token = await ensureToken(store, uid, c);

      if (chosen) {
        const prof = await slack.getProfile(token);
        const ours =
          !prof.status_text ||
          MANAGED_TEXTS.has(prof.status_text) ||
          (c.managed && c.managed.date === today);
        if (!ours) {
          report.skipped.push({ uid, email, reason: 'manual status', current: prof.status_text });
          continue;
        }
        const exp = Math.floor(chosen.to.getTime() / 1000);
        if (prof.status_text === chosen.text && Number(prof.status_expiration) === exp) {
          report.skipped.push({ uid, email, reason: 'already set', text: chosen.text });
        } else {
          if (!DRY) await slack.setStatus(token, chosen.text, chosen.emoji, exp);
          report.set.push({ uid, email, text: chosen.text, until: chosen.to.toISOString(), subject: chosen.subject });
        }
        if (chosen.dnd) {
          const minutes = Math.max(1, Math.round((chosen.to.getTime() - now.getTime()) / 60000));
          if (!DRY) await slack.setSnooze(token, minutes).catch((e) =>
            report.errors.push({ uid, error: `snooze ${e.code || e.message}` }));
        }
        if (!DRY) await store.patchConnection(uid, { managed: { date: today, key: chosen.key } });
      } else if (c.managed && c.managed.date === today) {
        // set earlier today, no longer away / in a meeting -> clear if still ours
        const prof = await slack.getProfile(token);
        if (MANAGED_TEXTS.has(prof.status_text)) {
          if (!DRY) {
            await slack.clearStatus(token);
            await slack.endSnooze(token).catch(() => {});
          }
          report.cleared.push({ uid, email });
        }
        if (!DRY) await store.patchConnection(uid, { managed: null });
      }
    } catch (e) {
      const code = e.code || e.message;
      report.errors.push({ uid, email, error: code });
      if (code === 'invalid_refresh_token' || code === 'token_revoked') {
        if (!DRY) await store.patchConnection(uid, { needs_reauth: true }).catch(() => {});
      }
    }
  }

  console.log(JSON.stringify(report, null, 2));
  await writeFile(new URL('../last-run.json', import.meta.url), JSON.stringify(report, null, 2));
  if (!DRY) await store.writeReport(report).catch((e) => console.error('report write failed:', e.message));
  if (report.errors.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
