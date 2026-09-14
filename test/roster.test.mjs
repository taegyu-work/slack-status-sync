import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster } from '../src/roster.mjs';

const CSV = `name,team,email
# comment lines and blanks are ignored

홍길동,경영기획본부,hong@evertri.com
이승주,임상시험 사업팀,sjlee@evertri.com
이승주,인허가 사업팀,seungju03@evertri.com
신재용,,jae@evertri.com
`;

test('resolves a unique name with or without team', () => {
  const r = parseRoster(CSV);
  assert.equal(r.resolve('홍길동', '').email, 'hong@evertri.com');
  assert.equal(r.resolve('홍길동', '아무팀').email, 'hong@evertri.com');
  assert.equal(r.resolve('신재용', '').email, 'jae@evertri.com');
});

test('ambiguous name needs a team to disambiguate', () => {
  const r = parseRoster(CSV);
  assert.equal(r.resolve('이승주', ''), null);
  assert.equal(r.resolve('이승주', '임상시험 사업팀').email, 'sjlee@evertri.com');
  assert.equal(r.resolve('이승주', '인허가').email, 'seungju03@evertri.com');
});

test('unknown name resolves to null', () => {
  const r = parseRoster(CSV);
  assert.equal(r.resolve('없는사람', ''), null);
});

test('entries lists every row for enumeration (e.g. admin "not connected" view)', () => {
  const r = parseRoster(CSV);
  assert.equal(r.entries.length, 4);
  assert.deepEqual(
    r.entries.map((e) => e.name).sort(),
    ['신재용', '이승주', '이승주', '홍길동'].sort(),
  );
});

test('strips a UTF-8 BOM and ignores comments/blank lines', () => {
  const r = parseRoster('﻿' + CSV);
  assert.equal(r.entries.length, 4);
});
