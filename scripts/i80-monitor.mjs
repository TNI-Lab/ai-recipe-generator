#!/usr/bin/env node
// I-80 Reno -> Palisades road-status monitor.
// Polls Caltrans every 5 minutes and, on a closed -> open transition,
// sends an iMessage (macOS only) to the configured phone number.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PHONE = '+14056149978';
const INTERVAL_MS = 5 * 60 * 1000;
const STATE_FILE = path.join(os.homedir(), '.i80-monitor-state.json');
const CALTRANS_URL = 'https://roads.dot.ca.gov/?roadnumber=80';

// I-80 corridor between the Nevada state line (Reno) and the Palisades
// Tahoe / Donner Pass area on the Caltrans side. Any closure message that
// mentions one of these place names is considered "on the corridor".
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

async function fetchConditions() {
  const res = await fetch(CALTRANS_URL, {
    headers: { 'User-Agent': 'i80-monitor/1.0 (personal use)' },
  });
  if (!res.ok) throw new Error(`Caltrans responded ${res.status}`);
  return await res.text();
}

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
    const globalRe = new RegExp(re.source, 'g');
    let m;
    while ((m = globalRe.exec(textUpper)) !== null) {
      const start = Math.max(0, m.index - 300);
      const end = Math.min(textUpper.length, m.index + 300);
      const context = textUpper.slice(start, end);
      if (CORRIDOR_KEYWORDS.some((c) => context.includes(c))) {
        return { closed: true, excerpt: context.trim() };
      }
    }
  }
  return { closed: false, excerpt: null };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { closed: null, lastCheck: null, excerpt: null };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sendIMessage(phone, message) {
  if (process.platform !== 'darwin') {
    console.warn(
      `Not on macOS (${process.platform}); would have sent to ${phone}: ${message}`,
    );
    return;
  }
  const safe = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy "${phone}" of targetService
    send "${safe}" to targetBuddy
end tell`;
  execFileSync('osascript', ['-e', script], { stdio: 'inherit' });
}

async function checkOnce() {
  const ts = new Date().toISOString();
  try {
    const html = await fetchConditions();
    const text = stripHtml(html);
    const { closed, excerpt } = findCorridorClosure(text);
    const prev = readState();

    console.log(`[${ts}] I-80 Reno<->Palisades: ${closed ? 'CLOSED' : 'OPEN'}`);

    if (prev.closed === true && closed === false) {
      const human = new Date().toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
      });
      const msg = `I-80 between Reno and Palisades just REOPENED (per Caltrans, ${human} PT). Drive safe.`;
      try {
        sendIMessage(PHONE, msg);
        console.log(`[${ts}] Sent reopen iMessage to ${PHONE}`);
      } catch (err) {
        console.error(`[${ts}] iMessage send failed:`, err.message);
      }
    }

    writeState({ closed, lastCheck: ts, excerpt });
  } catch (err) {
    console.error(`[${ts}] Check failed:`, err.message);
  }
}

async function main() {
  console.log(
    `I-80 Reno<->Palisades monitor started. Polling every ${
      INTERVAL_MS / 60000
    } min.`,
  );
  console.log(`Notify target: iMessage ${PHONE} (macOS only).`);
  console.log(`State file:    ${STATE_FILE}`);
  console.log(`Data source:   ${CALTRANS_URL}`);
  await checkOnce();
  setInterval(checkOnce, INTERVAL_MS);
}

main();
