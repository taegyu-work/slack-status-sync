// Slack Web API helpers. All calls use a per-user token (xoxp-…) with
// token rotation enabled, so access tokens live ~12h and are refreshed
// via oauth.v2.access with grant_type=refresh_token.

const API = 'https://slack.com/api';

export class SlackError extends Error {
  constructor(code, method) {
    super(`${method}: ${code}`);
    this.code = code;
    this.method = method;
  }
}

async function call(method, token, body, form = false) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': form
        ? 'application/x-www-form-urlencoded'
        : 'application/json; charset=utf-8',
    },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new SlackError(json.error, method);
  return json;
}

export async function refresh(clientId, clientSecret, refreshToken) {
  const res = await fetch(`${API}/oauth.v2.access`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new SlackError(json.error, 'oauth.v2.access');
  const u = json.authed_user || json;
  return {
    access_token: u.access_token,
    refresh_token: u.refresh_token || refreshToken,
    expires_in: u.expires_in || 43200,
  };
}

export const getProfile = (token) =>
  call('users.profile.get', token, {}).then((j) => j.profile);

export const setStatus = (token, status_text, status_emoji, status_expiration) =>
  call('users.profile.set', token, {
    profile: { status_text, status_emoji, status_expiration },
  });

export const clearStatus = (token) =>
  call('users.profile.set', token, {
    profile: { status_text: '', status_emoji: '', status_expiration: 0 },
  });

export const setSnooze = (token, num_minutes) =>
  call('dnd.setSnooze', token, { num_minutes }, true);

export const endSnooze = (token) => call('dnd.endSnooze', token, {}, true);
