import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMeetingNow } from '../src/graph.mjs';

// KST wall-clock -> the shape Graph returns with Prefer: outlook.timezone
const dt = (hhmm) => ({ dateTime: `2026-09-07T${hhmm}:00.0000000`, timeZone: 'Korea Standard Time' });
const now = new Date('2026-09-07T14:30:00+09:00');

function withFetch(events, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ value: events }) });
  return fn().finally(() => { globalThis.fetch = orig; });
}

const base = {
  isAllDay: false,
  showAs: 'busy',
  responseStatus: { response: 'accepted' },
  isOnlineMeeting: true,
  attendees: [{}],
};

test('picks the active accepted meeting', () =>
  withFetch(
    [{ ...base, start: dt('14:00'), end: dt('15:00') }],
    async () => {
      const m = await getMeetingNow('t', 'x@y.com', now, 120000, {});
      assert.ok(m);
      assert.equal(m.toISO, new Date('2026-09-07T15:00:00+09:00').toISOString());
    },
  ));

test('ignores declined / not-responded / free / all-day', () =>
  withFetch(
    [
      { ...base, start: dt('14:00'), end: dt('15:00'), responseStatus: { response: 'declined' } },
      { ...base, start: dt('14:00'), end: dt('15:00'), responseStatus: { response: 'notResponded' } },
      { ...base, start: dt('14:00'), end: dt('15:00'), showAs: 'free' },
      { ...base, start: dt('14:00'), end: dt('15:00'), isAllDay: true },
    ],
    async () => assert.equal(await getMeetingNow('t', 'x@y.com', now, 120000, {}), null),
  ));

test('skips solo focus-time (no attendee, not online) when required', () =>
  withFetch(
    [{ ...base, start: dt('14:00'), end: dt('15:00'), isOnlineMeeting: false, attendees: [] }],
    async () => assert.equal(
      await getMeetingNow('t', 'x@y.com', now, 120000, { requireAttendeeOrOnline: true }), null,
    ),
  ));

test('back-to-back: keeps the one ending latest', () =>
  withFetch(
    [
      { ...base, start: dt('14:00'), end: dt('15:00') },
      { ...base, start: dt('14:00'), end: dt('16:00') },
    ],
    async () => {
      const m = await getMeetingNow('t', 'x@y.com', now, 120000, {});
      assert.equal(m.toISO, new Date('2026-09-07T16:00:00+09:00').toISOString());
    },
  ));

test('a meeting already over is not active', () =>
  withFetch(
    [{ ...base, start: dt('13:00'), end: dt('14:00') }],
    async () => assert.equal(await getMeetingNow('t', 'x@y.com', now, 120000, {}), null),
  ));
