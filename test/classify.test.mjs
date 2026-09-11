import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, statusKey, extractName, extractTeam } from '../src/classify.mjs';

// Real subjects taken from the shared calendar screenshot.
const cases = [
  ['박수연, KONECT 교육 [회의실_B1]',                              null],
  ['강지훈 선임 (BD&S팀) - 반차박차(08:30~10:30)',                 { type: '반차', part: 'AM' }],
  ['강지 선임 (BD&S팀) - 반차(13:30~17:30)',                       { type: '반차', part: 'PM' }],
  ['김연진 선임 (임상시험 사업팀) - 반차(08:00~12:00)',            { type: '반차', part: 'AM' }],
  ['박민규 선임 (Medical Writing팀) - 연차',                       { type: '연차', part: null }],
  ['박인경 선임 (인허가 사업팀) - 재택근무 에버트라이 경영기획팀',  { type: '재택', part: null }],
  ['윤광현 책임 (Medical Writing팀) - 재택근무',                   { type: '재택', part: null }],
  ['김연진, 재택근무(오후)',                                       { type: '재택', part: 'PM' }],
  ['김태성, 연차',                                                 { type: '연차', part: null }],
  ['김태성, 재택근무',                                             { type: '재택', part: null }],
  ['차광민 (DM/STAT팀) - 반차(13:30~17:30)',                       { type: '반차', part: 'PM' }],
  ['이승주(CO), LUCES-KOR-2023, OV 고려대학교안암병원',            { type: '외근', part: null }],
  ['안세현, 이모티브 ASD, MV, 대구가톨릭대학교병원',               { type: '외근', part: null }],
  ['액티메디 명지병원 오전 외근 w/대표님 (정서우)',                { type: '외근', part: null }],
  ['김건소 정서우 오후 외근 티알',                                 { type: '외근', part: null }],
  ['서지원, iCReaT 교육',                                          null],
  ['GS NIDS 심사자 임상 교육 2차',                                 null],
  ['[외근] 오유리, 식약처 대면심사',                               { type: '외근', part: null }],
  ['정서우, 식약처 방문',                                          { type: '외근', part: null }],
  ['강지훈 선임 (BD&S팀) - 반반차(14:00~16:00)',                   { type: '반차', part: 'PM' }],
  ['김태성 수석 (임상시험 사업팀) - 연차',                         { type: '연차', part: null }],
];

for (const [subject, expected] of cases) {
  test(subject, () => {
    const c = classify(subject, {});
    if (expected === null) {
      assert.equal(c, null);
      return;
    }
    assert.ok(c, 'should classify');
    assert.equal(c.type, expected.type);
    assert.equal(c.part, expected.part);
  });
}

test('name / team extraction', () => {
  assert.equal(extractName('윤광현 책임 (Medical Writing팀) - 재택근무'), '윤광현');
  assert.equal(extractName('김태성, 연차'), '김태성');
  assert.equal(extractName('이승주(CO), LUCES-KOR-2023, OV 고려대병원'), '이승주');
  assert.equal(extractTeam('차광민 (DM/STAT팀) - 반차(13:30~17:30)'), 'DM/STAT팀');
  assert.equal(extractTeam('김태성, 연차'), '');
});

test('statusKey', () => {
  assert.equal(statusKey('재택', null), '재택');
  assert.equal(statusKey('재택', 'PM'), '재택_PM');
  assert.equal(statusKey('반차', 'AM'), '반차_AM');
  assert.equal(statusKey('외근', null), '외근');
});
