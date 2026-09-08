import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatus, dayMeansAway, DAY_YIELDS_TO_MEETING } from '../src/resolve.mjs';

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

test('dayMeansAway: 연차 yes, 재택 no, null no, expired no', () => {
  assert.equal(dayMeansAway(dayAt('연차'), NOW, LOOK), true);
  assert.equal(dayMeansAway(dayAt('외근'), NOW, LOOK), true);
  assert.equal(dayMeansAway(dayAt('재택'), NOW, LOOK), false);
  assert.equal(dayMeansAway(null, NOW, LOOK), false);
  assert.equal(dayMeansAway({
    key: '연차', fromISO: '2026-09-07T09:00:00+09:00', toISO: '2026-09-07T13:00:00+09:00',
  }, NOW, LOOK), false);
});
