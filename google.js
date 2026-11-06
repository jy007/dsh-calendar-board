/**
 * Google Calendar read access for the board.
 *
 * Only read-only calls are made: `calendarList` to discover calendars and
 * `events.list` with `singleEvents=true`, which lets Google expand recurring
 * events so the board never re-implements Google's recurrence rules.
 */

const REQUEST_TIMEOUT_MS = 20000;

async function getJson(url, accessToken) {
  const response = await fetch(url, {
    headers: { authorization: 'Bearer ' + accessToken, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (payload && payload.error && payload.error.message) || ('HTTP ' + response.status);
    const error = new Error('google api: ' + message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function listCalendars(provider, accessToken) {
  const url =
    provider.apiBase +
    '/users/me/calendarList?maxResults=100&minAccessRole=reader&fields=' +
    encodeURIComponent('items(id,summary,description,primary,accessRole,backgroundColor,timeZone)');
  const payload = await getJson(url, accessToken);
  const items = Array.isArray(payload.items) ? payload.items : [];
  return items.map((item) => ({
    id: item.id,
    name: item.summary || item.id,
    primary: item.primary === true,
    accessRole: item.accessRole || '',
    backgroundColor: item.backgroundColor || '',
    timeZone: item.timeZone || '',
  }));
}

function parseGoogleDate(value) {
  if (!value) return null;
  if (value.date) {
    const [year, month, day] = String(value.date).split('-').map(Number);
    return { date: new Date(year, month - 1, day), allDay: true };
  }
  if (value.dateTime) {
    const instant = new Date(value.dateTime);
    if (isNaN(instant.getTime())) return null;
    return { date: instant, allDay: false };
  }
  return null;
}

/** One window of events from one Google calendar, in the board's event shape. */
export async function listCalendarEvents(provider, accessToken, options) {
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
    timeMin: options.timeMin.toISOString(),
    timeMax: options.timeMax.toISOString(),
    fields: encodeURIComponent('items(id,summary,location,status,start,end,organizer)'),
  });
  const url =
    provider.apiBase +
    '/calendars/' + encodeURIComponent(options.calendarId) +
    '/events?' + params.toString();
  const payload = await getJson(url, accessToken);
  const items = Array.isArray(payload.items) ? payload.items : [];
  const out = [];
  for (const item of items) {
    if (item.status === 'cancelled') continue;
    const start = parseGoogleDate(item.start);
    if (!start) continue;
    const end = parseGoogleDate(item.end);
    out.push({
      summary: String(item.summary || '(无标题)').trim(),
      location: String(item.location || '').trim(),
      start: start.date,
      end: end ? end.date : new Date(start.date.getTime() + (start.allDay ? 86400000 : 0)),
      allDay: start.allDay,
      rrule: null,
      exdates: [],
      cancelled: false,
    });
  }
  return out;
}
