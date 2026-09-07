const norm = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(팀|본부|부서|부|실|team)$/i, '');

/**
 * Parse roster CSV text (name,team,email header; # comments and blank lines
 * ignored) into a resolver:
 *   resolve(name, team) -> { name, team, email } | null
 * Returns null when the name is unknown, or ambiguous and team doesn't help.
 */
export function parseRoster(text) {
  const rows = (text || '')
    .replace(/^﻿/, '') // strip Excel BOM
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (!rows.length) throw new Error('roster is empty');
  const header = rows.shift().split(',').map((h) => h.trim().toLowerCase());
  const iName = header.indexOf('name');
  const iTeam = header.indexOf('team');
  const iEmail = header.indexOf('email');
  if (iName < 0 || iEmail < 0) throw new Error('roster must have "name" and "email" columns');

  const byName = new Map();
  for (const line of rows) {
    const c = line.split(',').map((x) => x.trim());
    const entry = {
      name: c[iName],
      team: iTeam >= 0 ? c[iTeam] || '' : '',
      email: (c[iEmail] || '').toLowerCase(),
    };
    if (!entry.name || !entry.email) continue;
    const key = norm(entry.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry);
  }

  return {
    size: byName.size,
    resolve(name, team) {
      const cands = byName.get(norm(name)) || [];
      if (cands.length === 1) return cands[0];
      if (cands.length > 1 && team) {
        const t = norm(team);
        const m = cands.find((c) => {
          const ct = norm(c.team);
          return ct && (ct === t || ct.includes(t) || t.includes(ct));
        });
        if (m) return m;
      }
      return null;
    },
  };
}
