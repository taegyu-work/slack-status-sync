// Shared, pure helpers used by both jobs (Node + Cloudflare Worker safe).

// Day-level statuses that yield to "회의 중" while a meeting is on.
// 연차 / 반차 / 외근 mean the person is away, so they always win.
export const DAY_YIELDS_TO_MEETING = new Set(['재택', '재택_AM', '재택_PM']);

/** 'YYYY-MM-DD' for `now` in the given IANA timezone. */
export function tzToday(now, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

const pad = (n) => String(n).padStart(2, '0');
/** A Date at wall-clock `hhmm` on `dateStr`, in a fixed-offset tz (KST = +09:00). */
export const wall = (dateStr, hhmm, offset = '+09:00') =>
  new Date(`${dateStr}T${hhmm}:00${offset}`);

/**
 * Combine the day-level status (from the hr@ calendar) with a meeting
 * happening right now, applying the priority rules.
 *
 * @param day  { key,text,emoji,dnd,fromISO,toISO,subject } | null
 * @param meeting { fromISO,toISO } | null
 * @param now  Date
 * @param dayLookaheadMs  how early a day-status window may activate
 * @param meetingConf  status-map entry for "회의" ({text,emoji,dnd})
 * @returns { key,text,emoji,dnd,toISO,subject,source } | null
 */
export function resolveStatus(day, meeting, now, dayLookaheadMs, meetingConf) {
  const dayActive =
    day &&
    now >= new Date(new Date(day.fromISO).getTime() - dayLookaheadMs) &&
    now < new Date(day.toISO);
  const dayIsAway = dayActive && !DAY_YIELDS_TO_MEETING.has(day.key);

  const dayChosen = () => ({
    key: day.key, text: day.text, emoji: day.emoji, dnd: !!day.dnd,
    toISO: day.toISO, subject: day.subject || day.key, source: 'leave',
  });

  if (dayIsAway) return dayChosen();
  if (meeting) {
    return {
      key: '회의', text: meetingConf.text, emoji: meetingConf.emoji, dnd: !!meetingConf.dnd,
      toISO: meeting.toISO, subject: '회의', source: 'meeting',
    };
  }
  if (dayActive) return dayChosen();
  return null;
}

/**
 * Graph's calendarView returns events that merely *touch* the query window, so
 * an all-day event for yesterday (end = today 00:00) still comes back in today's
 * query. True only if [start, end) genuinely overlaps [dayStart, dayEnd).
 */
export const spanOverlapsDay = (start, end, dayStart, dayEnd) =>
  new Date(start) < new Date(dayEnd) && new Date(end) > new Date(dayStart);

/** Whether the meeting check can be skipped for this connection. */
export function dayMeansAway(day, now, dayLookaheadMs) {
  if (!day) return false;
  const active =
    now >= new Date(new Date(day.fromISO).getTime() - dayLookaheadMs) &&
    now < new Date(day.toISO);
  return active && !DAY_YIELDS_TO_MEETING.has(day.key);
}
