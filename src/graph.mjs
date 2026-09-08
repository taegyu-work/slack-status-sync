// Microsoft Graph: client-credentials auth + read mailbox calendars.

export async function getGraphToken(tenantId, clientId, clientSecret) {
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Graph token: ${json.error_description || res.status}`);
  return json.access_token;
}

/**
 * Expanded instances (calendarView) for a mailbox calendar between two ISO instants.
 * `mailbox` is the SMTP address whose calendar holds the leave events (a shared
 * HR mailbox). Works for a user, shared, or group mailbox address.
 * `Prefer: outlook.timezone` makes every returned start/end a KST wall-clock time.
 */
export async function getCalendarView(token, mailbox, startIso, endIso, tz = 'Korea Standard Time') {
  const events = [];
  let url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/calendarView` +
    `?startDateTime=${encodeURIComponent(startIso)}&endDateTime=${encodeURIComponent(endIso)}` +
    `&$select=subject,start,end,isAllDay,showAs,categories,organizer&$top=100&$orderby=start/dateTime`;

  while (url) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${tz}"` },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`calendarView: ${JSON.stringify(json.error || json)}`);
    events.push(...(json.value || []));
    url = json['@odata.nextLink'] || null;
  }
  return events;
}

// Events whose subject looks like leave (연차/반차/휴가/재택/외근) are ignored —
// leave often lands on the personal calendar too (via Daou → own cal → hr@).
const LEAVE_SUBJECT = /연차|반차|반반차|휴가|재택|외근|out of office|OOO/i;

// Query params for a per-person meeting lookup.
function meetingViewParams(now, lookaheadMs) {
  const startIso = new Date(now.getTime() - 60_000).toISOString();
  const endIso = new Date(now.getTime() + lookaheadMs + 60_000).toISOString();
  return (
    `?startDateTime=${encodeURIComponent(startIso)}&endDateTime=${encodeURIComponent(endIso)}` +
    `&$select=subject,start,end,isAllDay,showAs,responseStatus,isOnlineMeeting,attendees` +
    `&$top=50&$orderby=start/dateTime`
  );
}

/**
 * Reduce a person's calendarView to the meeting they're in *right now* —
 * { fromISO, toISO } for the currently-active accepted meeting that ends
 * latest (so back-to-back meetings keep the status up), or null.
 *
 * Counts only if: not all-day, showAs=busy, the user accepted/organises it,
 * and (when requireAttendeeOrOnline) it has another attendee, a room booked,
 * or an online-meeting link — which filters out personal focus-time blocks.
 */
export function pickMeeting(events, now, lookaheadMs, requireAttendeeOrOnline = true) {
  const parse = (x) => new Date(x.dateTime.replace(/\.\d+$/, '') + '+09:00');
  let best = null;
  for (const ev of events || []) {
    if (ev.isAllDay) continue;
    if (ev.showAs !== 'busy') continue;
    if (LEAVE_SUBJECT.test(ev.subject || '')) continue;
    const resp = ev.responseStatus?.response;
    if (resp !== 'organizer' && resp !== 'accepted') continue;
    if (requireAttendeeOrOnline && !ev.isOnlineMeeting && !(ev.attendees?.length >= 1)) continue;

    const from = parse(ev.start);
    const to = parse(ev.end);
    if (now < new Date(from.getTime() - lookaheadMs) || now >= to) continue;
    if (!best || to > best) best = to;
  }
  return best ? { fromISO: null, toISO: best.toISOString() } : null;
}

/** Single-mailbox meeting lookup (used by tests). */
export async function getMeetingNow(token, mailbox, now, lookaheadMs, opts = {}) {
  const { tz = 'Korea Standard Time', requireAttendeeOrOnline = true } = opts;
  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/calendarView` +
    meetingViewParams(now, lookaheadMs);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${tz}"` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`meeting calendarView: ${JSON.stringify(json.error || json)}`);
  return pickMeeting(json.value, now, lookaheadMs, requireAttendeeOrOnline);
}

/**
 * Meeting lookup for many mailboxes at once via Graph's $batch endpoint
 * (<=20 requests per call). Returns Map<mailbox-lowercased, {toISO}|null>,
 * plus errors: Map<mailbox, message>.
 */
export async function getMeetingsForMany(token, mailboxes, now, lookaheadMs, opts = {}) {
  const { tz = 'Korea Standard Time', requireAttendeeOrOnline = true } = opts;
  const params = meetingViewParams(now, lookaheadMs);
  const out = new Map();
  const errors = new Map();
  const list = [...new Set(mailboxes.map((m) => m.toLowerCase()))];

  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20);
    const body = {
      requests: chunk.map((mb, j) => ({
        id: String(j),
        method: 'GET',
        url: `/users/${encodeURIComponent(mb)}/calendarView${params}`,
        headers: { Prefer: `outlook.timezone="${tz}"` },
      })),
    };
    const res = await fetch('https://graph.microsoft.com/v1.0/$batch', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`$batch: ${JSON.stringify(json.error || json)}`);
    for (const r of json.responses || []) {
      const mb = chunk[Number(r.id)];
      if (r.status >= 200 && r.status < 300) {
        out.set(mb, pickMeeting(r.body?.value, now, lookaheadMs, requireAttendeeOrOnline));
      } else {
        errors.set(mb, JSON.stringify(r.body?.error || r.body || r.status));
      }
    }
  }
  return { meetings: out, errors };
}
