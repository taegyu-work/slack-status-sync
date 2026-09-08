// Leave feed (GitHub Actions, every ~15 min).
//
// Reads the hr@ calendar, works out each *connected* person's day-level
// status (재택 / 연차 / 반차 / 외근 or none), and writes it to their KV
// record as `day`. It does NOT touch Slack — the Worker cron reads `day`,
// overlays "회의 중", and does all the Slack writes.

import { readFile, writeFile } from 'node:fs/promises';
import { getGraphToken, getCalendarView } from './graph.mjs';
import { classify, statusKey } from './classify.mjs';
import { parseRoster } from './roster.mjs';
import { createStore } from './store.mjs';
import { tzToday, wall } from './resolve.mjs';

const cfgUrl = (n) => new URL(`../config/${n}`, import.meta.url);
const CFG = JSON.parse(await readFile(cfgUrl('settings.json'), 'utf8'));
const MAP = JSON.parse(await readFile(cfgUrl('status-map.json'), 'utf8'));

const DRY = CFG.dryRun || process.env.DRY_RUN === '1';
const OFFSET = CFG.utcOffset || '+09:00';
const pad = (n) => String(n).padStart(2, '0');

function env(k) {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

const evTime = (x) => new Date(x.dateTime.replace(/\.\d+$/, '') + OFFSET);

function computeWindow(c, ev, today) {
  const { start, end, halfDaySplit } = CFG.workday;
  if (c.time) {
    return {
      from: wall(today, `${pad(c.time.sh)}:${pad(c.time.sm)}`, OFFSET),
      to: wall(today, `${pad(c.time.eh)}:${pad(c.time.em)}`, OFFSET),
    };
  }
  if (c.part === 'AM') return { from: wall(today, start, OFFSET), to: wall(today, halfDaySplit, OFFSET) };
  if (c.part === 'PM') return { from: wall(today, halfDaySplit, OFFSET), to: wall(today, end, OFFSET) };
  if (c.type === '외근' && !c.isAllDay && ev?.start?.dateTime) {
    return { from: evTime(ev.start), to: evTime(ev.end) };
  }
  return { from: wall(today, start, OFFSET), to: wall(today, end, OFFSET) };
}

async function main() {
  const now = new Date();
  const today = tzToday(now, CFG.timezone);
  const dayStart = wall(today, '00:00', OFFSET);
  const dayEnd = new Date(dayStart.getTime() + 86400_000);

  const store = createStore(env('WORKER_URL'), env('SYNC_SECRET'));
  const mailbox = env('MS_CALENDAR_MAILBOX').toLowerCase();

  // 1. hr@ calendar + roster (both from outside the repo)
  const gtok = await getGraphToken(env('MS_TENANT_ID'), env('MS_CLIENT_ID'), env('MS_CLIENT_SECRET'));
  const [events, roster] = await Promise.all([
    getCalendarView(gtok, mailbox, dayStart.toISOString(), dayEnd.toISOString(), CFG.graphTimezone),
    store.getRoster().then(parseRoster),
  ]);

  // 2. classify -> day-level status per email
  const desired = new Map(); // email -> { key,text,emoji,dnd,fromISO,toISO,subject }
  const unresolved = [];
  for (const ev of events) {
    const c = classify(ev.subject, ev);
    if (!c) continue;
    let person = roster.resolve(c.name, c.team);
    if (!person) {
      const orgEmail = ev.organizer?.emailAddress?.address?.toLowerCase();
      if (orgEmail && orgEmail !== mailbox) person = { email: orgEmail };
    }
    if (!person) { unresolved.push(ev.subject); continue; }

    const key = statusKey(c.type, c.part);
    const conf = MAP[key] || MAP[c.type];
    const win = computeWindow(c, ev, today);
    const prev = desired.get(person.email);
    if (!prev || win.from < new Date(prev.fromISO)) {
      desired.set(person.email, {
        key, text: conf.text, emoji: conf.emoji, dnd: !!conf.dnd,
        fromISO: win.from.toISOString(), toISO: win.to.toISOString(), subject: ev.subject,
      });
    }
  }

  // 3. write `day` onto each connection
  const conns = (await store.getConnections()) || {};
  const connEmail = (c) => {
    if (c.email) return c.email.toLowerCase();
    if (c.real_name) return roster.resolve(c.real_name, '')?.email || '';
    return '';
  };

  const report = {
    date: today, ranAt: now.toISOString(), dryRun: DRY, job: 'leave',
    events: events.length, connections: Object.keys(conns).length,
    onLeave: [], unresolved, unmatchedConnections: [], errors: [],
  };

  for (const [uid, c] of Object.entries(conns)) {
    const email = connEmail(c);
    if (!email) { report.unmatchedConnections.push({ uid, real_name: c.real_name || null }); continue; }
    const day = desired.get(email) || null;
    if (day) report.onLeave.push({ uid, email, key: day.key, until: day.toISO });
    try {
      // only write when it changed, to keep KV writes down
      if (JSON.stringify(c.day || null) !== JSON.stringify(day)) {
        if (!DRY) await store.patchConnection(uid, { day });
      }
    } catch (e) {
      report.errors.push({ uid, email, error: e.message });
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
