/**
 * Local calendar access (macOS) through Calendar.app.
 *
 * Everything the user already has in Calendar.app is reachable this way — Google,
 * Feishu/Lark, Outlook and Exchange accounts included — so a Mac user needs no
 * OAuth client and no secret iCal address. The first call raises the system
 * Automation prompt for Calendar; later calls reuse that grant.
 */

import { execFile } from 'node:child_process';

const SCRIPT_TIMEOUT_MS = 60000;
const MAX_EVENTS = 2000;

function runJxa(script, timeoutMs = SCRIPT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || '').trim();
        if (/-1743|not authorized|不允许/i.test(message)) {
          reject(new Error('Calendar access denied: allow DSH to control "Calendar" in System Settings → Privacy & Security → Automation'));
          return;
        }
        reject(new Error(message || 'osascript failed'));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

export function isSupported() {
  return process.platform === 'darwin';
}

/** Calendar.app's local calendars, in the order it lists them. */
export async function listCalendars() {
  if (!isSupported()) return [];
  const raw = await runJxa('JSON.stringify(Application("Calendar").calendars.name())', 20000);
  const names = JSON.parse(raw || '[]');
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const value = String(name || '').trim();
    if (!value || seen.has(value)) continue;
    if (/^siri/i.test(value)) continue;
    seen.add(value);
    out.push({ id: value, name: value });
  }
  return out;
}

/**
 * Events of the given calendars overlapping one window.
 * Returns the board's event shape so the month grid can render them directly.
 */
export async function readEvents(calendarNames, from, to) {
  if (!isSupported() || !calendarNames.length) return [];
  const script = `
ObjC.import('Foundation')
const Calendar = Application('Calendar')
const names = ${JSON.stringify(calendarNames)}
const from = new Date(${from.getTime()})
const to = new Date(${to.getTime()})
const out = []
for (const name of names) {
  let cal
  try { cal = Calendar.calendars.byName(name) } catch (err) { continue }
  let events = []
  try {
    events = cal.events.whose({ _and: [{ startDate: { _greaterThan: from } }, { startDate: { _lessThan: to } }] })()
  } catch (err) { continue }
  for (const event of events) {
    let summary = ''
    let start = null
    let end = null
    let allDay = false
    let location = ''
    try { summary = String(event.summary() || '').trim() } catch (err) {}
    if (!summary) continue
    try { start = event.startDate() } catch (err) {}
    try { end = event.endDate() } catch (err) {}
    try { allDay = event.alldayEvent() === true } catch (err) {}
    try { location = String(event.location() || '').trim() } catch (err) {}
    if (!start) continue
    out.push({
      calendar: name,
      summary: summary,
      start: start.getTime(),
      end: end ? end.getTime() : start.getTime(),
      allDay: allDay,
      location: location,
    })
    if (out.length >= ${MAX_EVENTS}) break
  }
}
JSON.stringify(out)
`;
  const raw = await runJxa(script);
  const rows = JSON.parse(raw || '[]');
  return rows.map((row) => ({
    summary: row.summary,
    location: row.location || '',
    start: new Date(row.start),
    end: new Date(row.end),
    allDay: row.allDay === true,
    rrule: null,
    exdates: [],
    cancelled: false,
  }));
}
