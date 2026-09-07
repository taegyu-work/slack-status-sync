// Turn a shared-calendar event subject into a leave/work classification.
// Returns null for anything we should not reflect in Slack (internal meetings,
// room bookings, unrecognised entries).

const IGNORE = /회의실|\[회의|교육\s*\[/;

// External field work (외근): CRA site visits, monitoring, hospital/university visits.
const EXTERNAL_KEYWORDS = /(병원|의원|의료원|대학교|대학|보건소|센터|클리닉|캠퍼스|병설|의과학|연구소)/;
const VISIT_TOKENS = /(?:^|[\s,(/])(MV|OV|SV|IMV|COV|SIV|PSSV|PSV|CSV|IV|SIV|모니터링|점검|방문)(?:$|[\s,)/])/i;

const TIME_RANGE = /\((\d{1,2}):(\d{2})\s*[~\-–]\s*(\d{1,2}):(\d{2})\)/;
const PART = /\((오전|오후|AM|PM)\)/i;

export function extractName(subject) {
  const s = subject.trim();
  // Free-form 외근 titles often carry the person in a trailing "(홍길동)" —
  // e.g. "액티메디 명지병원 오전 외근 w/대표님 (정서우)". Prefer that.
  if (/외근/.test(s)) {
    const paren = [...s.matchAll(/\(([가-힣]{2,4})\)/g)].pop();
    if (paren) return paren[1];
  }
  const first = s.split(/[\s,(]/)[0];
  return first || null;
}

export function extractTeam(subject) {
  const m = subject.match(/\(([^)]*(?:팀|본부|부|실|Team))\)/i);
  return m ? m[1].trim() : '';
}

/**
 * @param {string} subject  raw event subject
 * @param {{isAllDay?: boolean}} [event]
 * @returns {null | {type:'재택'|'연차'|'반차'|'외근', part:'AM'|'PM'|null,
 *                   time:{sh,sm,eh,em}|null, name:string|null, team:string,
 *                   isAllDay:boolean}}
 */
export function classify(subject, event = {}) {
  const s = (subject || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  const name = extractName(s);
  const team = extractTeam(s);

  let type = null;
  if (/재택/.test(s)) type = '재택';
  else if (/연차/.test(s)) type = '연차';
  else if (/반차|반반차/.test(s)) type = '반차';
  else if (/외근/.test(s)) type = '외근';
  else if (!IGNORE.test(s)) {
    // No explicit keyword and not an internal meeting / room booking:
    // treat CRA site visits (hospital / university / MV·OV, or a multi-field
    // "name, project, visit-type, site" title) as 외근.
    const commas = (s.match(/,/g) || []).length;
    if (EXTERNAL_KEYWORDS.test(s) || VISIT_TOKENS.test(s) || commas >= 2) type = '외근';
  }
  if (!type) return null;

  let part = null;
  const pm = s.match(PART);
  if (pm) part = /오전|AM/i.test(pm[1]) ? 'AM' : 'PM';

  let time = null;
  const tm = s.match(TIME_RANGE);
  if (tm) {
    time = { sh: +tm[1], sm: +tm[2], eh: +tm[3], em: +tm[4] };
    if (!part) part = time.sh < 12 && (time.eh <= 13) ? 'AM' : time.sh >= 12 ? 'PM' : null;
  }

  if (type === '연차') { part = null; time = null; } // 연차 = full day always

  return { type, part, time, name, team, isAllDay: !!event.isAllDay };
}

/** Map a classification to a status-map key. */
export function statusKey(type, part) {
  if (type === '반차') return part === 'AM' ? '반차_AM' : part === 'PM' ? '반차_PM' : '반차';
  if (type === '재택' && part) return part === 'AM' ? '재택_AM' : '재택_PM';
  return type; // 재택 / 연차 / 외근
}
