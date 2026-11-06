/**
 * Minimal iCalendar (RFC 5545) reader for calendar subscriptions.
 *
 * Supports exactly what a month view needs: VEVENT start/end (all-day, floating,
 * UTC and TZID wall times), DURATION, EXDATE, and RRULE with FREQ =
 * DAILY / WEEKLY (BYDAY) / MONTHLY / YEARLY plus INTERVAL / COUNT / UNTIL.
 * Unsupported recurrence parts are ignored rather than guessed.
 */

const DAY_MS = 86400000;

/** Undo the 75-octet line folding of the wire format. */
export function unfold(text) {
  return String(text || '')
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .replace(/\r/g, '')
    .split('\n');
}

function parseParams(head) {
  const parts = head.split(';');
  const params = {};
  for (let index = 1; index < parts.length; index += 1) {
    const piece = parts[index];
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    params[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1);
  }
  return params;
}

/** Minutes the zone is ahead of UTC at that instant. */
function zoneOffsetMinutes(timeZone, instant) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = {};
    for (const part of formatter.formatToParts(instant)) parts[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    return (asUtc - instant.getTime()) / 60000;
  } catch (error) {
    return 0;
  }
}

/** Convert a wall-clock time in `timeZone` into the matching instant. */
export function zonedToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let stamp = guess;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    stamp = guess - zoneOffsetMinutes(timeZone, new Date(stamp)) * 60000;
  }
  return new Date(stamp);
}

/** Parse `20261106T090000`, `20261106`, `20261106T010000Z`. */
function parseStamp(value, params) {
  const raw = String(value || '').trim();
  const dateOnly = /^\d{8}$/.test(raw);
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (dateOnly) {
    return { date: new Date(year, month - 1, day), allDay: true };
  }
  const hour = Number(m[4] || 0);
  const minute = Number(m[5] || 0);
  if (m[7]) return { date: new Date(Date.UTC(year, month - 1, day, hour, minute, Number(m[6] || 0))), allDay: false };
  const zone = params.TZID;
  if (zone) return { date: zonedToUtc(year, month, day, hour, minute, zone), allDay: false };
  return { date: new Date(year, month - 1, day, hour, minute, Number(m[6] || 0)), allDay: false };
}

function parseDuration(value) {
  const m = /^(-)?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value || '').trim());
  if (!m) return null;
  const sign = m[1] ? -1 : 1;
  const ms =
    Number(m[2] || 0) * DAY_MS +
    Number(m[3] || 0) * 3600000 +
    Number(m[4] || 0) * 60000 +
    Number(m[5] || 0) * 1000;
  return sign * ms;
}

export function parseRRule(value) {
  const rule = { freq: '', interval: 1, count: 0, until: null, byDay: [] };
  for (const piece of String(value || '').split(';')) {
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    const key = piece.slice(0, eq).toUpperCase();
    const val = piece.slice(eq + 1);
    if (key === 'FREQ') rule.freq = val.toUpperCase();
    else if (key === 'INTERVAL') rule.interval = Math.max(1, Number(val) || 1);
    else if (key === 'COUNT') rule.count = Math.max(0, Number(val) || 0);
    else if (key === 'UNTIL') {
      const stamp = parseStamp(val, {});
      if (stamp) rule.until = stamp.date;
    } else if (key === 'BYDAY') {
      rule.byDay = val
        .split(',')
        .map((token) => String(token).trim().toUpperCase())
        .filter((token) => /^[+-]?\d*[A-Z]{2}$/.test(token))
        .map((token) => {
          const weekday = token.slice(-2);
          const ordinal = Number(token.slice(0, -2));
          const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
          return { weekday: map[weekday], ordinal: Number.isFinite(ordinal) ? ordinal : 0 };
        });
    }
  }
  return rule;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Parse one calendar body into events with parsed Dates. */
export function parseIcs(text) {
  const lines = unfold(text);
  const events = [];
  let current = null;

  const finish = (raw) => {
    if (!raw.DTSTART) return null;
    const start = parseStamp(raw.DTSTART.value, raw.DTSTART.params);
    if (!start) return null;
    let end = null;
    if (raw.DTEND) {
      const parsed = parseStamp(raw.DTEND.value, raw.DTEND.params);
      if (parsed) end = parsed.date;
    }
    if (!end && raw.DURATION) {
      const ms = parseDuration(raw.DURATION.value);
      if (ms) end = new Date(start.date.getTime() + ms);
    }
    if (!end) end = new Date(start.date.getTime() + (start.allDay ? DAY_MS : 0));

    const exdates = [];
    for (const ex of raw.EXDATE || []) {
      for (const piece of String(ex.value).split(',')) {
        const parsed = parseStamp(piece.trim(), ex.params);
        if (parsed) exdates.push(parsed.date.getTime());
      }
    }

    return {
      uid: raw.UID ? String(raw.UID.value) : '',
      summary: raw.SUMMARY ? String(raw.SUMMARY.value).replace(/\\n/gi, ' ').replace(/\\,/g, ',').trim() : '',
      location: raw.LOCATION ? String(raw.LOCATION.value).replace(/\\,/g, ',').trim() : '',
      start: start.date,
      end,
      allDay: start.allDay,
      rrule: raw.RRULE ? parseRRule(raw.RRULE.value) : null,
      exdates,
      cancelled: raw.STATUS ? String(raw.STATUS.value).toUpperCase() === 'CANCELLED' : false,
    };
  };

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) {
        const event = finish(current);
        if (event && event.summary && !event.cancelled) events.push(event);
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const name = head.split(';')[0].toUpperCase();
    const params = parseParams(head);
    if (name === 'EXDATE') {
      if (!current.EXDATE) current.EXDATE = [];
      current.EXDATE.push({ value, params });
    } else {
      current[name] = { value, params };
    }
  }
  return events;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

function addYears(date, years) {
  return new Date(date.getFullYear() + years, date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

/**
 * Occurrences of one event overlapping [windowStart, windowEnd].
 * Each occurrence is { start, end, allDay }.
 */
export function expandOccurrences(event, windowStart, windowEnd, limit = 400) {
  const out = [];
  const duration = Math.max(0, event.end.getTime() - event.start.getTime());
  const excluded = new Set(event.exdates || []);
  const emit = (start) => {
    if (excluded.has(start.getTime())) return;
    const end = new Date(start.getTime() + duration);
    if (start.getTime() > windowEnd.getTime() || end.getTime() < windowStart.getTime()) return;
    out.push({ start, end, allDay: event.allDay });
  };

  if (!event.rrule || !event.rrule.freq) {
    emit(event.start);
    return out;
  }

  const rule = event.rrule;
  const interval = rule.interval || 1;
  const until = rule.until ? rule.until.getTime() : null;
  const maxCount = rule.count || 0;
  let emitted = 0;

  const within = (date) => {
    if (until !== null && date.getTime() > until) return false;
    if (maxCount && emitted >= maxCount) return false;
    return true;
  };

  if (rule.freq === 'WEEKLY') {
    const weekdays = rule.byDay.length ? rule.byDay.map((d) => d.weekday) : [event.start.getDay()];
    const firstWeek = startOfDay(event.start);
    firstWeek.setDate(firstWeek.getDate() - ((firstWeek.getDay() + 6) % 7));
    let cursor = new Date(firstWeek);
    let guard = 0;
    while (cursor.getTime() <= windowEnd.getTime() && guard < limit * 8 && within(cursor)) {
      for (const weekday of weekdays) {
        const day = new Date(cursor);
        day.setDate(day.getDate() + ((weekday + 6) % 7));
        day.setHours(event.start.getHours(), event.start.getMinutes(), event.start.getSeconds(), 0);
        if (day.getTime() < event.start.getTime()) continue;
        if (!within(day)) continue;
        emitted += 1;
        emit(day);
      }
      cursor.setDate(cursor.getDate() + 7 * interval);
      guard += 1;
    }
    return out;
  }

  const step = (date) => {
    if (rule.freq === 'DAILY') {
      const next = new Date(date);
      next.setDate(next.getDate() + interval);
      return next;
    }
    if (rule.freq === 'MONTHLY') return addMonths(date, interval);
    if (rule.freq === 'YEARLY') return addYears(date, interval);
    return null;
  };

  let cursor = new Date(event.start);
  // Jump close to the window so a daily event from 2019 does not run 2,000 steps.
  if (cursor.getTime() < windowStart.getTime()) {
    const spanMs = windowStart.getTime() - cursor.getTime();
    let jumps = 0;
    if (rule.freq === 'DAILY') jumps = Math.max(0, Math.floor(spanMs / (DAY_MS * interval)) - 1);
    else if (rule.freq === 'MONTHLY') jumps = Math.max(0, Math.floor(spanMs / (28 * DAY_MS * interval)) - 1);
    else if (rule.freq === 'YEARLY') jumps = Math.max(0, Math.floor(spanMs / (365 * DAY_MS * interval)) - 1);
    for (let i = 0; i < jumps && cursor.getTime() < windowStart.getTime(); i += 1) {
      const next = step(cursor);
      if (!next) break;
      cursor = next;
    }
  }

  let guard = 0;
  while (cursor.getTime() <= windowEnd.getTime() && guard < limit * 8) {
    if (!within(cursor)) break;
    emitted += 1;
    emit(cursor);
    const next = step(cursor);
    if (!next) break;
    cursor = next;
    guard += 1;
  }
  return out;
}

/** Calendar lines for one day in the board's month grid. */
export function eventsByDay(events, windowStart, windowEnd) {
  const byDay = new Map();
  for (const event of events) {
    for (const occurrence of expandOccurrences(event, windowStart, windowEnd)) {
      const key =
        occurrence.start.getFullYear() + '-' +
        String(occurrence.start.getMonth() + 1).padStart(2, '0') + '-' +
        String(occurrence.start.getDate()).padStart(2, '0');
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push({
        title: event.summary,
        location: event.location,
        time: occurrence.allDay ? '' : String(occurrence.start.getHours()).padStart(2, '0') + ':' + String(occurrence.start.getMinutes()).padStart(2, '0'),
        allDay: occurrence.allDay,
        end: occurrence.allDay ? '' : String(occurrence.end.getHours()).padStart(2, '0') + ':' + String(occurrence.end.getMinutes()).padStart(2, '0'),
      });
    }
  }
  for (const list of byDay.values()) list.sort((a, b) => (a.time || '00:00').localeCompare(b.time || '00:00'));
  return byDay;
}

export { sameDay };
