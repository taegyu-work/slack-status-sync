import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatus, dayMeansAway, spanOverlapsDay, appendSubject, DAY_YIELDS_TO_MEETING } from '../src/resolve.mjs';

const NOW = new Date('2026-09-07T14:00:00+09:00');
const LOOK = 30 * 60_000; // 30 min day lookahead
const MEET = { text: '회의 중', emoji: ':calendar:', dnd: false };

// a day-status window that is active at NOW (09:00–18:00 KST)
const dayAt = (key, dnd = false) => ({
  key, text: key, emoji: ':x:', dnd,
  fromISO: '2026-09-07T09:00:00+09:00',
  toISO: '2026-09-07T18:00:00+09:00',
  subject: key,
});
const meetingUntil = (hhmm) => ({ fromISO: null, toISO: `2026-09-07T${hhmm}:00+09:00` });

test('연차 beats a concurrent meeting', () => {
  const r = resolveStatus(dayAt('연차', true), meetingUntil('15:00'), NOW, LOOK, MEET);
  assert.equal(r.key, '연차');
  assert.equal(r.source, 'leave');
});

test('외근 beats a concurrent meeting', () => {
  assert.equal(resolveStatus(dayAt('외근'), meetingUntil('15:00'), NOW, LOOK, MEET).key, '외근');
});

test('반차 beats a concurrent meeting', () => {
  assert.equal(resolveStatus(dayAt('반차_PM', true), meetingUntil('15:00'), NOW, LOOK, MEET).key, '반차_PM');
});

test('반반차 also beats a concurrent meeting (treated as away, like 반차)', () => {
  assert.equal(resolveStatus(dayAt('반반차_PM', true), meetingUntil('15:00'), NOW, LOOK, MEET).key, '반반차_PM');
});

test('재택 yields to a meeting, then reverts when it ends', () => {
  const during = resolveStatus(dayAt('재택'), meetingUntil('15:00'), NOW, LOOK, MEET);
  assert.equal(during.key, '회의');
  assert.equal(during.source, 'meeting');
  assert.equal(during.toISO, '2026-09-07T15:00:00+09:00');

  const after = resolveStatus(dayAt('재택'), null, NOW, LOOK, MEET);
  assert.equal(after.key, '재택');
  assert.equal(after.source, 'leave');
});

test('오전 재택 also yields to a meeting', () => {
  assert.ok(DAY_YIELDS_TO_MEETING.has('재택_AM'));
  assert.equal(resolveStatus(dayAt('재택_AM'), meetingUntil('15:00'), NOW, LOOK, MEET).key, '회의');
});

test('meeting only, no day status -> 회의', () => {
  assert.equal(resolveStatus(null, meetingUntil('15:00'), NOW, LOOK, MEET).key, '회의');
});

test('nothing at all -> null', () => {
  assert.equal(resolveStatus(null, null, NOW, LOOK, MEET), null);
});

test('day window not yet active + no meeting -> null', () => {
  const future = {
    key: '재택', text: '재택', emoji: ':x:', dnd: false,
    fromISO: '2026-09-07T16:00:00+09:00', toISO: '2026-09-07T18:00:00+09:00', subject: '재택',
  };
  assert.equal(resolveStatus(future, null, NOW, LOOK, MEET), null);
});

test('day window activates early within the lookahead', () => {
  const soon = {
    key: '반차_PM', text: '반차', emoji: ':x:', dnd: true,
    fromISO: '2026-09-07T14:20:00+09:00', toISO: '2026-09-07T18:00:00+09:00', subject: '반차',
  };
  assert.equal(resolveStatus(soon, null, NOW, LOOK, MEET).key, '반차_PM');
});

test('expired day status + live meeting -> 회의', () => {
  const past = {
    key: '재택', text: '재택', emoji: ':x:', dnd: false,
    fromISO: '2026-09-07T09:00:00+09:00', toISO: '2026-09-07T13:00:00+09:00', subject: '재택',
  };
  assert.equal(resolveStatus(past, meetingUntil('15:00'), NOW, LOOK, MEET).key, '회의');
  assert.equal(resolveStatus(past, null, NOW, LOOK, MEET), null);
});

test('spanOverlapsDay: yesterday all-day event does not count for today', () => {
  // today = 2026-09-10 KST
  const dayStart = new Date('2026-09-10T00:00:00+09:00');
  const dayEnd = new Date('2026-09-11T00:00:00+09:00');
  // all-day event for Sep 9 only: start 09-09, end 09-10 (exclusive) — touches boundary
  assert.equal(
    spanOverlapsDay(new Date('2026-09-09T00:00:00+09:00'), new Date('2026-09-10T00:00:00+09:00'), dayStart, dayEnd),
    false,
  );
  // all-day event for Sep 10
  assert.equal(
    spanOverlapsDay(new Date('2026-09-10T00:00:00+09:00'), new Date('2026-09-11T00:00:00+09:00'), dayStart, dayEnd),
    true,
  );
  // multi-day Sep 9–11
  assert.equal(
    spanOverlapsDay(new Date('2026-09-09T00:00:00+09:00'), new Date('2026-09-12T00:00:00+09:00'), dayStart, dayEnd),
    true,
  );
  // tomorrow's event
  assert.equal(
    spanOverlapsDay(new Date('2026-09-11T00:00:00+09:00'), new Date('2026-09-12T00:00:00+09:00'), dayStart, dayEnd),
    false,
  );
});

test('appendSubject: appends with a separator, no-op on empty subject', () => {
  assert.equal(appendSubject('외근 중', '고려대병원'), '외근 중 · 고려대병원');
  assert.equal(appendSubject('외근 중', ''), '외근 중');
  assert.equal(appendSubject('외근 중', null), '외근 중');
  assert.equal(appendSubject('외근 중', '  '), '외근 중');
});

test('appendSubject: truncates so the combined text never exceeds 100 chars (Slack rejects longer)', () => {
  const long = '가'.repeat(120);
  const out = appendSubject('외근 중', long);
  assert.ok(out.length <= 100, `length was ${out.length}`);
  assert.ok(out.endsWith('…'));
  assert.ok(out.startsWith('외근 중 · '));
});

test('resolveStatus: subject is off by default — showSubject not passed', () => {
  const day = {
    key: '외근', text: '외근 중', emoji: ':car:', dnd: false,
    fromISO: '2026-09-07T09:00:00+09:00', toISO: '2026-09-07T18:00:00+09:00',
    subject: '액티메디 명지병원 오전 외근 w/대표님 (정서우)',
  };
  assert.equal(resolveStatus(day, null, NOW, LOOK, MEET).text, '외근 중');
  const meeting = { fromISO: null, toISO: '2026-09-07T15:00:00+09:00', subject: '분기 리뷰' };
  assert.equal(resolveStatus(null, meeting, NOW, LOOK, MEET).text, '회의 중');
});

test('resolveStatus: opted in (showSubject=true) -> 외근 status text includes the calendar subject', () => {
  const day = {
    key: '외근', text: '외근 중', emoji: ':car:', dnd: false,
    fromISO: '2026-09-07T09:00:00+09:00', toISO: '2026-09-07T18:00:00+09:00',
    subject: '액티메디 명지병원 오전 외근 w/대표님 (정서우)',
  };
  const r = resolveStatus(day, null, NOW, LOOK, MEET, true);
  assert.equal(r.text, '외근 중 · 액티메디 명지병원 오전 외근 w/대표님 (정서우)');
});

test('resolveStatus: opted in (showSubject=true) -> 회의 status text includes the meeting subject', () => {
  const meeting = { fromISO: null, toISO: '2026-09-07T15:00:00+09:00', subject: '분기 리뷰' };
  const r = resolveStatus(null, meeting, NOW, LOOK, MEET, true);
  assert.equal(r.text, '회의 중 · 분기 리뷰');
});

test('resolveStatus: even opted in, 연차/반차 status text does NOT get a subject appended (just repeats own name)', () => {
  const day = {
    key: '연차', text: '연차', emoji: ':palm_tree:', dnd: true,
    fromISO: '2026-09-07T09:00:00+09:00', toISO: '2026-09-07T18:00:00+09:00',
    subject: '이태규 선임 (경영기획본부) - 연차',
  };
  const r = resolveStatus(day, null, NOW, LOOK, MEET, true);
  assert.equal(r.text, '연차');
});

test('dayMeansAway: 연차 yes, 재택 no, null no, expired no', () => {
  assert.equal(dayMeansAway(dayAt('연차'), NOW, LOOK), true);
  assert.equal(dayMeansAway(dayAt('외근'), NOW, LOOK), true);
  assert.equal(dayMeansAway(dayAt('재택'), NOW, LOOK), false);
  assert.equal(dayMeansAway(null, NOW, LOOK), false);
  assert.equal(dayMeansAway({
    key: '연차', fromISO: '2026-09-07T09:00:00+09:00', toISO: '2026-09-07T13:00:00+09:00',
  }, NOW, LOOK), false);
});
