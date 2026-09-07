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

/**
 * Find the meeting a person is in *right now* on their own calendar.
 * Returns { from: Date, to: Date } for the currently-active accepted meeting
 * that ends latest (so back-to-back meetings keep the status up), or null.
 *
 * A meeting counts only if: not all-day, showAs=busy, the user accepted it or
 * organises it, and (when requireAttendeeOrOnline) it has another attendee or
 * an online-meeting link — which filters out personal focus-time blocks.
 */
export async function getMeetingNow(token, mailbox, now, lookaheadMs, opts = {}) {
  const { tz = 'Korea Standard Time', requireAttendeeOrOnline = true } = opts;
  const startIso = new Date(now.getTime() - 60_000).toISOString();
  const endIso = new Date(now.getTime() + lookaheadMs + 60_000).toISOString();

  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/calendarView` +
    `?startDateTime=${encodeURIComponent(startIso)}&endDateTime=${encodeURIComponent(endIso)}` +
    `&$select=start,end,isAllDay,showAs,responseStatus,isOnlineMeeting,attendees&$top=50&$orderby=start/dateTime`;

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${tz}"` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`meeting calendarView: ${JSON.stringify(json.error || json)}`);

  const parse = (x) => new Date(x.dateTime.replace(/\.\d+$/, '') + '+09:00');
  let best = null;
  for (const ev of json.value || []) {
    if (ev.isAllDay) continue;
    if (ev.showAs !== 'busy') continue;
    const resp = ev.responseStatus?.response;
    if (resp !== 'organizer' && resp !== 'accepted') continue;
    if (requireAttendeeOrOnline && !ev.isOnlineMeeting && !(ev.attendees?.length >= 1)) continue;

    const from = parse(ev.start);
    const to = parse(ev.end);
    if (now < new Date(from.getTime() - lookaheadMs) || now >= to) continue; // not active now
    if (!best || to > best.to) best = { from, to };
  }
  return best;
}
