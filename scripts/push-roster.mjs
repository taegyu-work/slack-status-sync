// Push the local (git-ignored) config/roster.csv into the Worker's KV.
// The roster is not in the public repo; this is how you update it.
//
//   WORKER_URL=... SYNC_SECRET=... node scripts/push-roster.mjs
//   # or:  node --env-file=.env scripts/push-roster.mjs

import { readFile } from 'node:fs/promises';
import { createStore } from '../src/store.mjs';

const WORKER_URL = process.env.WORKER_URL;
const SYNC_SECRET = process.env.SYNC_SECRET;
if (!WORKER_URL || !SYNC_SECRET) {
  console.error('Set WORKER_URL and SYNC_SECRET (env vars or a .env file with --env-file).');
  process.exit(1);
}

const csv = await readFile(new URL('../config/roster.csv', import.meta.url), 'utf8');
const store = createStore(WORKER_URL, SYNC_SECRET);
const res = await store.putRoster(csv);
console.log('pushed roster:', res);

// sanity-check it parses
const { parseRoster } = await import('../src/roster.mjs');
const r = parseRoster(await store.getRoster());
console.log(`roster now has ${r.size} resolvable names in KV`);
