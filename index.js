/**
 * Host half of the calendar board bundle.
 *
 * This is the canonical store and the single implementation of every board
 * operation. Three callers reach it:
 *
 *  - Agent sessions, through the `calendar_board` tool (list / add / update /
 *    complete / remove).
 *  - The board panel, through the HTTP routes below (GET/POST the whole list).
 *  - Other plugins, through the provided `calendarBoard` service.
 *
 * Items live in `<DSH_HOME>/storages/calendar-board/items.json`, so they survive
 * a cleared browser storage and are readable while the page is closed.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { eventsByDay, parseIcs } from './ics.js';
import { homedir } from 'node:os';
import path from 'node:path';

const ROUTE_ITEMS = '/calendar-board/items';
const ROUTE_SOURCES = '/calendar-board/sources';
const ROUTE_EVENTS = '/calendar-board/events';
const ROUTE_SCHEDULES = '/calendar-board/schedules';
const SCHEDULE_CACHE_MS = 10000;

const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh');
const STORE_DIR = path.join(DSH_HOME, 'storages', 'calendar-board');
const STORE_FILE = path.join(STORE_DIR, 'items.json');
const SOURCES_FILE = path.join(STORE_DIR, 'sources.json');
const STORE_VERSION = 1;

const COLORS = ['', 'red', 'amber', 'green', 'blue'];
const REPEATS = ['none', 'daily'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const MAX_TITLE = 200;
const SOURCE_COLORS = ['blue', 'green', 'amber', 'red', 'gray'];
const ICS_TTL_MS = 10 * 60 * 1000;
const ICS_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ store */

let cache = null;
let queue = Promise.resolve();

function clockToday() {
  const now = new Date();
  return (
    now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0')
  );
}

function isItem(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.title === 'string' && DATE_RE.test(String(value.date));
}

function normalizeItem(raw) {
  const title = String(raw.title == null ? '' : raw.title).trim().slice(0, MAX_TITLE);
  if (!title) throw new Error('title is required');
  const date = String(raw.date || '').trim();
  if (!DATE_RE.test(date)) throw new Error('date must be YYYY-MM-DD');
  const time = String(raw.time == null ? '' : raw.time).trim();
  if (time && !TIME_RE.test(time)) throw new Error('time must be HH:MM or empty');
  const repeat = REPEATS.includes(raw.repeat) ? raw.repeat : 'none';
  const color = COLORS.includes(raw.color) ? raw.color : '';
  const doneDates = Array.isArray(raw.doneDates) ? raw.doneDates.filter((d) => DATE_RE.test(String(d))) : [];
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : 'it' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    date,
    time,
    title,
    repeat,
    doneDates,
    color,
    underline: raw.underline === true,
  };
}

async function readStore() {
  if (cache) return cache;
  try {
    const text = await readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed && parsed.items) ? parsed.items.filter(isItem) : [];
    cache = { version: STORE_VERSION, items };
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn('[calendar-board] store unreadable, starting empty:', error.message);
    }
    cache = { version: STORE_VERSION, items: [] };
  }
  return cache;
}

function persist(next) {
  cache = next;
  queue = queue
    .then(async () => {
      await mkdir(STORE_DIR, { recursive: true });
      const target = STORE_FILE + '.' + process.pid + '.tmp';
      await writeFile(target, JSON.stringify(next, null, 2) + '\n', 'utf8');
      await rename(target, STORE_FILE);
    })
    .catch((error) => {
      console.warn('[calendar-board] store write failed:', error && error.message);
    });
  return queue;
}

function sorted(items) {
  return items.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const at = a.time || '99:99';
    const bt = b.time || '99:99';
    if (at !== bt) return at < bt ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

function isDone(item, date) {
  return Array.isArray(item.doneDates) && item.doneDates.includes(date);
}

function view(item, date) {
  const day = date || item.date;
  return {
    id: item.id,
    date: item.date,
    time: item.time,
    title: item.title,
    repeat: item.repeat,
    color: item.color,
    underline: item.underline,
    done: isDone(item, day),
  };
}

/* ------------------------------------------------------------- operations */

export async function listItems(query = {}) {
  const store = await readStore();
  const single = DATE_RE.test(String(query.date || '')) ? query.date : '';
  const from = DATE_RE.test(String(query.from || '')) ? query.from : '';
  const to = DATE_RE.test(String(query.to || '')) ? query.to : '';
  const includeDone = query.includeDone !== false;

  const matches = store.items.filter((item) => {
    if (single) return item.date === single;
    if (from && item.date < from) return false;
    if (to && item.date > to) return false;
    return true;
  });

  const rows = sorted(matches)
    .map((item) => view(item, single || undefined))
    .filter((row) => includeDone || !row.done);

  return { ok: true, today: clockToday(), count: rows.length, items: rows };
}

/** Raw store rows for the panel: same shape it writes back, no derived fields. */
export async function readItems(query = {}) {
  const store = await readStore();
  const single = DATE_RE.test(String(query.date || '')) ? query.date : '';
  const from = DATE_RE.test(String(query.from || '')) ? query.from : '';
  const to = DATE_RE.test(String(query.to || '')) ? query.to : '';
  const items = sorted(store.items.filter((item) => {
    if (single) return item.date === single;
    if (from && item.date < from) return false;
    if (to && item.date > to) return false;
    return true;
  }));
  return { today: clockToday(), items: items.map((item) => Object.assign({}, item)) };
}

export async function addItem(input = {}) {
  const store = await readStore();
  const item = normalizeItem({
    date: input.date || clockToday(),
    title: input.title,
    time: input.time,
    repeat: input.repeat,
    color: input.color,
    underline: input.underline,
  });
  await persist({ version: STORE_VERSION, items: store.items.concat([item]) });
  return { ok: true, item: view(item) };
}

export async function updateItem(input = {}) {
  const store = await readStore();
  const id = String(input.id || '');
  const index = store.items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error('no item with id ' + id);
  const current = store.items[index];
  const next = store.items.slice();
  next[index] = normalizeItem({
    id: current.id,
    date: input.date === undefined ? current.date : input.date,
    title: input.title === undefined ? current.title : input.title,
    time: input.time === undefined ? current.time : input.time,
    repeat: input.repeat === undefined ? current.repeat : input.repeat,
    color: input.color === undefined ? current.color : input.color,
    underline: input.underline === undefined ? current.underline : input.underline,
    doneDates: current.doneDates,
  });
  await persist({ version: STORE_VERSION, items: next });
  return { ok: true, item: view(next[index]) };
}

export async function setDone(input = {}) {
  const store = await readStore();
  const id = String(input.id || '');
  const index = store.items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error('no item with id ' + id);
  const current = store.items[index];
  const date = DATE_RE.test(String(input.date || '')) ? input.date : current.date;
  const done = input.done !== false;
  const doneDates = (current.doneDates || []).filter((entry) => entry !== date);
  if (done) doneDates.push(date);
  const next = store.items.slice();
  next[index] = Object.assign({}, current, { doneDates });
  await persist({ version: STORE_VERSION, items: next });
  return { ok: true, item: view(next[index], date) };
}

export async function removeItem(input = {}) {
  const store = await readStore();
  const id = String(input.id || '');
  const next = store.items.filter((item) => item.id !== id);
  if (next.length === store.items.length) throw new Error('no item with id ' + id);
  await persist({ version: STORE_VERSION, items: next });
  return { ok: true, removed: id, remaining: next.length };
}

export async function replaceItems(input = {}) {
  const raw = Array.isArray(input.items) ? input.items : [];
  if (raw.length > 5000) throw new Error('too many items');
  const items = raw.map((item) => normalizeItem(item));
  await persist({ version: STORE_VERSION, items });
  return { ok: true, count: items.length };
}

/* --------------------------------------------------------------- sources */

let sourcesCache = null;
let sourceQueue = Promise.resolve();
const icsCache = new Map();

export const BUILTIN_SOURCES = [
  { id: 'local', kind: 'local', color: 'blue', enabled: true },
  { id: 'schedule', kind: 'schedule', color: 'amber', enabled: true },
];

async function readSources() {
  if (sourcesCache) return sourcesCache;
  try {
    const text = await readFile(SOURCES_FILE, 'utf8');
    const parsed = JSON.parse(text);
    const sources = Array.isArray(parsed && parsed.sources) ? parsed.sources : [];
    sourcesCache = { version: 1, sources: sources.filter((item) => item && typeof item.url === 'string' && item.id) };
  } catch (error) {
    if (error && error.code !== 'ENOENT') console.warn('[calendar-board] sources unreadable:', error.message);
    sourcesCache = { version: 1, sources: [] };
  }
  return sourcesCache;
}

function persistSources(next) {
  sourcesCache = next;
  sourceQueue = sourceQueue
    .then(async () => {
      await mkdir(STORE_DIR, { recursive: true });
      const target = SOURCES_FILE + '.' + process.pid + '.tmp';
      await writeFile(target, JSON.stringify(next, null, 2) + '\n', 'utf8');
      await rename(target, SOURCES_FILE);
    })
    .catch((error) => console.warn('[calendar-board] sources write failed:', error && error.message));
  return sourceQueue;
}

function normalizeFeedUrl(raw) {
  const value = String(raw || '').trim().replace(/^webcal:\/\//i, 'https://');
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('url must be an http(s) calendar address');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('url must be an http(s) calendar address');
  return url.toString();
}

function publicSource(source) {
  const cached = icsCache.get(source.id);
  return {
    id: source.id,
    kind: 'ics',
    name: source.name,
    url: source.url,
    color: source.color,
    enabled: source.enabled !== false,
    lastSync: cached ? cached.at : null,
    lastError: cached ? cached.error : null,
    cachedEvents: cached ? cached.events.length : 0,
  };
}

export async function listSources() {
  const store = await readSources();
  return { ok: true, sources: BUILTIN_SOURCES.concat(store.sources.map(publicSource)) };
}

export async function addSource(input = {}) {
  const store = await readSources();
  const url = normalizeFeedUrl(input.url);
  if (store.sources.some((source) => source.url === url)) throw new Error('that calendar is already subscribed');
  const name = String(input.name || '').trim().slice(0, 60) || new URL(url).hostname;
  const color = SOURCE_COLORS.includes(input.color) ? input.color : SOURCE_COLORS[store.sources.length % SOURCE_COLORS.length];
  const source = {
    id: 'src' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    url,
    color,
    enabled: true,
  };
  await persistSources({ version: 1, sources: store.sources.concat([source]) });
  return { ok: true, source: publicSource(source) };
}

export async function removeSource(input = {}) {
  const store = await readSources();
  const id = String(input.id || '');
  const next = store.sources.filter((source) => source.id !== id);
  if (next.length === store.sources.length) throw new Error('no subscribed calendar with id ' + id);
  icsCache.delete(id);
  await persistSources({ version: 1, sources: next });
  return { ok: true, removed: id, remaining: next.length };
}

export async function setSourceEnabled(input = {}) {
  const store = await readSources();
  const id = String(input.id || '');
  const index = store.sources.findIndex((source) => source.id === id);
  if (index < 0) throw new Error('no subscribed calendar with id ' + id);
  const next = store.sources.slice();
  next[index] = Object.assign({}, next[index], { enabled: input.enabled !== false });
  await persistSources({ version: 1, sources: next });
  return { ok: true, source: publicSource(next[index]) };
}

/** Feed text of one source, cached for a few minutes so a month view is cheap. */
async function loadFeed(source) {
  const cached = icsCache.get(source.id);
  const now = Date.now();
  if (cached && now - cached.at < ICS_TTL_MS) return cached;
  try {
    if (typeof fetch !== 'function') throw new Error('fetch unavailable');
    const response = await fetch(source.url, {
      headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'dsh-calendar-board/1.2' },
      signal: AbortSignal.timeout(ICS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const text = await response.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('not an iCalendar feed');
    const events = parseIcs(text);
    const entry = { at: now, events, error: null };
    icsCache.set(source.id, entry);
    return entry;
  } catch (error) {
    const entry = { at: now, events: cached ? cached.events : [], error: String((error && error.message) || error) };
    icsCache.set(source.id, entry);
    return entry;
  }
}

function windowBounds(input = {}) {
  const parse = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  };
  const today = new Date();
  const from = parse(input.from) || new Date(today.getFullYear(), today.getMonth(), 1);
  const to = parse(input.to) || new Date(today.getFullYear(), today.getMonth() + 1, 0);
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

/** Every subscribed calendar, expanded into the window. */
export async function listCalendarEvents(input = {}) {
  const { from, to } = windowBounds(input);
  const store = await readSources();
  const feeds = store.sources.filter((source) => source.enabled !== false);
  const events = [];
  const status = [];
  await Promise.all(feeds.map(async (source) => {
    const feed = await loadFeed(source);
    const byDay = eventsByDay(feed.events, from, to);
    let occurrences = 0;
    for (const list of byDay.values()) occurrences += list.length;
    status.push({ id: source.id, name: source.name, color: source.color, error: feed.error, count: occurrences, days: byDay.size });
    for (const [date, list] of byDay) {
      for (const item of list) {
        events.push(Object.assign({ sourceId: source.id, sourceName: source.name, color: source.color, date }, item));
      }
    }
  }));
  events.sort((a, b) => (a.date === b.date ? (a.time || '00:00').localeCompare(b.time || '00:00') : a.date.localeCompare(b.date)));
  return { ok: true, from: from.toISOString(), to: to.toISOString(), sources: status, events };
}

/* ------------------------------------------------------------------- HTTP */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ apply */

export function apply(ctx) {
  const api = { listItems, addItem, updateItem, setDone, removeItem, replaceItems };
  try {
    ctx.effect(() => ctx.provide('calendarBoard', api), 'calendar-board service');
  } catch (error) {
    console.warn('[calendar-board] service not provided:', error && error.message);
  }

  const tools = ctx.get('tools');
  if (tools && typeof tools.register === 'function') {
    ctx.effect(() => tools.register({
      name: 'calendar_board',
      description:
        'Read and change the user\'s "日历看板 / Calendar Board" entries — one task list per day, the same one the calendar panel edits. ' +
        'Use it whenever the user asks what is on their calendar, today or this week, or asks you to add, reschedule, complete or delete a daily item. ' +
        'Dates are local calendar days (YYYY-MM-DD); "today" is resolved when date is omitted. ' +
        'Actions: list (filter by date or from/to), add (title, optional date/time "HH:MM"/repeat "daily"), update (id + fields), complete (id, optional date, done), remove (id). ' +
        'Calendar subscriptions: sources (list the local, scheduled and subscribed calendars with their colors), events (events of every subscribed iCalendar feed in a window), subscribe (name + iCal url such as a Google/Feishu secret iCal address), unsubscribe (id), toggleSource (id + enabled).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'add', 'update', 'complete', 'remove', 'sources', 'events', 'subscribe', 'unsubscribe', 'toggleSource'],
            description: 'Operation to perform.',
          },
          date: { type: 'string', description: 'YYYY-MM-DD. list: one day. add: defaults to today. complete: defaults to the item date.' },
          from: { type: 'string', description: 'list only: inclusive start date YYYY-MM-DD.' },
          to: { type: 'string', description: 'list only: inclusive end date YYYY-MM-DD.' },
          includeDone: { type: 'boolean', description: 'list only: include completed entries (default true).' },
          id: { type: 'string', description: 'Item id, required for update / complete / remove.' },
          title: { type: 'string', description: 'Item text, required for add.' },
          time: { type: 'string', description: 'Optional HH:MM time, empty string clears it.' },
          repeat: { type: 'string', enum: ['none', 'daily'], description: 'daily repeats the entry every day.' },
          color: { type: 'string', enum: ['', 'red', 'amber', 'green', 'blue'], description: 'Optional text color.' },
          underline: { type: 'boolean', description: 'Optional underline.' },
          done: { type: 'boolean', description: 'complete only: true marks done (default), false unmarks.' },
          url: { type: 'string', description: 'subscribe only: the http(s) iCal address (webcal:// is accepted and rewritten).' },
          name: { type: 'string', description: 'subscribe only: a short label for the calendar; defaults to its host.' },
          enabled: { type: 'boolean', description: 'toggleSource only: show or hide the subscription (default true).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true },
        render(args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        },
      },
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {};
        switch (input.action) {
          case 'list':
            return listItems(input);
          case 'add':
            return addItem(input);
          case 'update':
            return updateItem(input);
          case 'complete':
            return setDone(input);
          case 'remove':
            return removeItem(input);
          case 'sources':
            return listSources();
          case 'events':
            return listCalendarEvents(input);
          case 'subscribe':
            return addSource(input);
          case 'unsubscribe':
            return removeSource(input);
          case 'toggleSource':
            return setSourceEnabled(input);
          default:
            throw new Error('unknown action: ' + String(input.action));
        }
      },
    }), 'calendar-board tool');
  }

  const webServer = ctx.get('webServer');
  if (!webServer || typeof webServer.register !== 'function') return;

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_ITEMS,
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          const query = {};
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          for (const key of ['date', 'from', 'to']) {
            const value = url.searchParams.get(key);
            if (value) query[key] = value;
          }
          const result = await readItems(query);
          sendJson(res, 200, { ok: true, items: result.items });
          return;
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          const text = await readBody(req);
          const payload = text ? JSON.parse(text) : {};
          sendJson(res, 200, await replaceItems(payload));
          return;
        }
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
      }
    },
  }), 'calendar-board items route');

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_SOURCES,
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, await listSources());
          return;
        }
        if (req.method === 'POST') {
          const payload = JSON.parse((await readBody(req)) || '{}');
          if (payload.action === 'add') sendJson(res, 200, await addSource(payload));
          else if (payload.action === 'remove') sendJson(res, 200, await removeSource(payload));
          else if (payload.action === 'toggle') sendJson(res, 200, await setSourceEnabled(payload));
          else sendJson(res, 400, { ok: false, error: 'unknown action' });
          return;
        }
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
      }
    },
  }), 'calendar-board sources route');

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_EVENTS,
    handler: async (req, res) => {
      if (req.method && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        sendJson(res, 200, await listCalendarEvents({
          from: url.searchParams.get('from') || '',
          to: url.searchParams.get('to') || '',
        }));
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
      }
    },
  }), 'calendar-board events route');

  let schedules = { at: 0, entries: null };
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_SCHEDULES,
    handler: async (req, res) => {
      if (req.method && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      try {
        const schedule = ctx.get('schedule');
        if (!schedule || typeof schedule.catalog !== 'function') throw new Error('schedule service unavailable');
        const now = Date.now();
        if (!schedules.entries || now - schedules.at > SCHEDULE_CACHE_MS) {
          const entries = await schedule.catalog();
          schedules = { at: now, entries: Array.isArray(entries) ? entries : [] };
        }
        sendJson(res, 200, { ok: true, entries: schedules.entries });
      } catch (error) {
        sendJson(res, 503, { ok: false, error: String((error && error.message) || error) });
      }
    },
  }), 'calendar-board schedules route');
}
