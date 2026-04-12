#!/usr/bin/env node
// I-80 Reno -> Palisades road-status monitor.
//
// Runs as either:
//   (a) a daemon on a machine (no args; polls every 5 min), or
//   (b) a single check under a scheduler (GitHub Actions, cron) using --once.
//
// SOURCES (all run in parallel each cycle):
//   1. Caltrans plaintext bulletin (always on)
//        https://roads.dot.ca.gov/?roadnumber=80
//   2. Google Maps Routes API drive-time heuristic (opt-in)
//        Set GOOGLE_MAPS_API_KEY. Compares current Reno(Verdi)->Colfax drive
//        time against GOOGLE_MAPS_BASELINE_SECONDS (default 6000s = 100 min
//        free-flow) and flags "closed" when the ratio exceeds
//        GOOGLE_MAPS_CLOSURE_RATIO (default 2.0) or no route is returned.
//
// AGGREGATION: overall = CLOSED if any source says closed;
//              OPEN if at least one says open and none says closed;
//              otherwise UNKNOWN (no transition, no notification).
//
// NOTIFIERS (configure at least one):
//   - ntfy.sh (simplest; no account):
//       * Install the "ntfy" app on your phone (iOS or Android).
//       * Pick a hard-to-guess topic, e.g. i80-reno-alerts-7f3a9c.
//       * Subscribe to that topic in the app.
//       * Export NTFY_TOPIC=i80-reno-alerts-7f3a9c (optionally NTFY_SERVER).
//   - iMessage (macOS only):
//       * Export NOTIFY_IMESSAGE=+14056149978
//
// Only fires on a CLOSED -> OPEN transition. State is persisted to
// $STATE_DIR/state.json (default ~/.i80-monitor-state.json).
//
// Run:  node scripts/i80-monitor.mjs            # daemon, 5-min loop
//       node scripts/i80-monitor.mjs --once     # one check (for schedulers)
//       node scripts/i80-monitor.mjs --selftest # parser self-test, no network

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INTERVAL_MS = 5 * 60 * 1000;

const STATE_FILE = process.env.STATE_DIR
  ? path.join(process.env.STATE_DIR, 'state.json')
  : path.join(os.homedir(), '.i80-monitor-state.json');

const CORRIDOR_KEYWORDS = [
  'NEVADA STATE LINE', 'STATE LINE', 'VERDI',
  'TRUCKEE', 'DONNER', 'NORDEN', 'SODA SPRINGS',
  'KINGVALE', 'BOREAL', 'CISCO', 'EMIGRANT GAP',
  'BLUE CANYON', 'COLFAX', 'APPLEGATE', 'ALTA',
  'SIERRA', 'PLACER', 'NEVADA COUNTY',
  'PALISADES', 'TAHOE',
];

const CLOSURE_PATTERNS = [
  /IS\s+CLOSED/, /ROAD\s+CLOSED/, /HIGHWAY\s+CLOSED/,
  /CLOSED\s+TO\s+ALL/, /CLOSED\s+DUE/, /CLOSED\s+FROM/,
  /CLOSED\s+BETWEEN/, /CLOSED\s+AT/, /CLOSED\s+IN\s+BOTH/,
];

// ---------------- Parsers ----------------

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function findCorridorClosure(textUpper) {
  for (const re of CLOSURE_PATTERNS) {
    const g = new RegExp(re.source, 'g');
    let m;
    while ((m = g.exec(textUpper)) !== null) {
      const start = Math.max(0, m.index - 300);
      const end = Math.min(textUpper.length, m.index + 300);
      const ctx = textUpper.slice(start, end);
      if (CORRIDOR_KEYWORDS.some((k) => ctx.includes(k))) {
        return { closed: true, excerpt: ctx.trim() };
      }
    }
  }
  return { closed: false };
}

// ---------------- Sources ----------------

async function caltransPlaintext() {
  const url = 'https://roads.dot.ca.gov/?roadnumber=80';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'i80-monitor/1.1 (personal)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Caltrans HTTP ${res.status}`);
  const { closed, excerpt } = findCorridorClosure(stripHtml(await res.text()));
  return {
    name: 'caltrans',
    status: closed ? 'closed' : 'open',
    detail: closed ? excerpt.slice(0, 240) : 'no corridor closure in bulletin',
  };
}

// Reno-side I-80 entrance (Verdi, NV) -> Colfax, CA — the whole Donner stretch.
const GMAP_ORIGIN = { latitude: 39.5109, longitude: -119.9869 };
const GMAP_DEST = { latitude: 39.1007, longitude: -120.9534 };

async function googleMapsTravelTime() {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY not set');
  const baseline = Number(process.env.GOOGLE_MAPS_BASELINE_SECONDS || 6000);
  const ratio = Number(process.env.GOOGLE_MAPS_CLOSURE_RATIO || 2.0);

  const body = {
    origin: { location: { latLng: GMAP_ORIGIN } },
    destination: { location: { latLng: GMAP_DEST } },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
  };
  const res = await fetch(
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) {
    throw new Error(`Google Routes HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const json = await res.json();
  const dur = json?.routes?.[0]?.duration;
  if (!dur) {
    // No route at all usually implies the corridor is impassable.
    return {
      name: 'google-maps',
      status: 'closed',
      detail: 'Google Routes returned no route (likely impassable)',
    };
  }
  const seconds = Number(String(dur).replace(/s$/, ''));
  const mult = seconds / baseline;
  return {
    name: 'google-maps',
    status: mult >= ratio ? 'closed' : 'open',
    detail: `drive time ${Math.round(seconds / 60)} min vs baseline ${Math.round(baseline / 60)} min (${mult.toFixed(2)}x; closed threshold ${ratio}x)`,
  };
}

async function collectStatus() {
  const sources = [caltransPlaintext];
  if (process.env.GOOGLE_MAPS_API_KEY) sources.push(googleMapsTravelTime);

  const results = await Promise.all(
    sources.map((fn) =>
      fn().catch((err) => ({ name: fn.name, status: 'error', detail: err.message })),
    ),
  );
  const anyClosed = results.some((r) => r.status === 'closed');
  const anyOpen = results.some((r) => r.status === 'open');
  const overall = anyClosed ? 'closed' : anyOpen ? 'open' : 'unknown';
  return { overall, results };
}

// ---------------- Notifiers ----------------

async function sendNtfy(title, body) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return false;
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
  const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      Title: title,
      Priority: 'high',
      Tags: 'vertical_traffic_light,mountain',
    },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
  return true;
}

function sendIMessage(message) {
  const phone = process.env.NOTIFY_IMESSAGE;
  if (!phone) return false;
  if (process.platform !== 'darwin') {
    console.warn(`Not on macOS (${process.platform}); skipping iMessage.`);
    return false;
  }
  const safe = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script =
    'tell application "Messages"\n' +
    '  set targetService to 1st service whose service type = iMessage\n' +
    `  set targetBuddy to buddy "${phone}" of targetService\n` +
    `  send "${safe}" to targetBuddy\n` +
    'end tell';
  execFileSync('osascript', ['-e', script], { stdio: 'inherit' });
  return true;
}

async function notifyReopen(results) {
  const human = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const title = 'I-80 Reno<->Palisades REOPENED';
  const body = [
    `I-80 between Reno and Palisades is OPEN as of ${human} PT.`,
    '',
    ...results.map((r) => `- ${r.name}: ${r.status}${r.detail ? ' - ' + r.detail : ''}`),
    '',
    'Drive safe.',
  ].join('\n');

  const sent = [];
  try { if (await sendNtfy(title, body)) sent.push('ntfy'); }
  catch (e) { console.error('ntfy failed:', e.message); }
  try { if (sendIMessage(body)) sent.push('imessage'); }
  catch (e) { console.error('imessage failed:', e.message); }

  if (sent.length === 0) {
    console.warn('No notifier configured (set NTFY_TOPIC and/or NOTIFY_IMESSAGE).');
  } else {
    console.log(`Notified via: ${sent.join(', ')}`);
  }
}

// ---------------- State / loop ----------------

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { overall: null, lastCheck: null }; }
}

function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function checkOnce() {
  const ts = new Date().toISOString();
  try {
    const { overall, results } = await collectStatus();
    const prev = readState();
    const breakdown = results.map((r) => `${r.name}=${r.status}`).join(' ');
    console.log(`[${ts}] overall=${overall} (${breakdown})`);

    if (prev.overall === 'closed' && overall === 'open') {
      await notifyReopen(results);
    }
    writeState({ overall, results, lastCheck: ts });
  } catch (err) {
    console.error(`[${ts}] cycle failed:`, err.message);
  }
}

// ---------------- Self-test ----------------

function selftest() {
  const cases = [
    ['open everywhere',
      'No traffic restrictions are reported for this area.', false],
    ['closed Donner',
      'I-80 is closed from Colfax to the Nevada state line due to snow.', true],
    ['closed Truckee',
      'Road closed at Truckee in both directions.', true],
    ['closed Sacramento (outside corridor)',
      'I-80 is closed from Sacramento to West Sac for a crash.', false],
    ['chain controls only',
      'R2 chain controls from Colfax to Truckee.', false],
  ];
  let ok = true;
  for (const [name, html, expected] of cases) {
    const got = findCorridorClosure(stripHtml(html)).closed;
    const pass = got === expected;
    ok = ok && pass;
    console.log(`${pass ? 'OK  ' : 'FAIL'} | ${name} -> closed=${got}`);
  }
  process.exit(ok ? 0 : 1);
}

// ---------------- Entry ----------------

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--selftest')) return selftest();

  const gmap = process.env.GOOGLE_MAPS_API_KEY ? ' google-maps' : '';
  const notifiers = [
    process.env.NTFY_TOPIC && 'ntfy',
    process.env.NOTIFY_IMESSAGE && 'imessage',
  ].filter(Boolean);

  console.log(`I-80 Reno<->Palisades monitor. Sources: caltrans${gmap}.`);
  console.log(`Notifiers: ${notifiers.length ? notifiers.join(', ') : '(none configured)'}.`);
  console.log(`State file: ${STATE_FILE}`);

  await checkOnce();
  if (args.has('--once')) return;
  console.log(`Polling every ${INTERVAL_MS / 60000} min...`);
  setInterval(checkOnce, INTERVAL_MS);
}

main();
