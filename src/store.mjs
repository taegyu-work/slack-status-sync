// Token / roster / run-log store, served by the Cloudflare Worker (Cloudflare
// KV behind it). The Worker authenticates these calls with a shared bearer
// secret (SYNC_SECRET). No Firebase / Google service account needed.

export function createStore(workerUrl, secret) {
  const base = workerUrl.replace(/\/$/, '');
  const auth = { authorization: `Bearer ${secret}` };

  const raw = async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...auth, ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.text();
  };
  const req = async (path, init) => {
    const txt = await raw(path, init);
    return txt ? JSON.parse(txt) : null;
  };

  return {
    // { [slackUserId]: connection }
    getConnections: () => req('/connections'),
    patchConnection: (uid, data) =>
      req(`/connections/${encodeURIComponent(uid)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      }),
    // roster CSV text (kept in KV, not the public repo)
    getRoster: () => raw('/roster'),
    putRoster: (csv) =>
      raw('/roster', { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: csv }),
    writeReport: (report) =>
      req('/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      }),
  };
}
