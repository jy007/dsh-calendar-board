/**
 * Host half of the calendar board bundle.
 *
 * The board itself is a Client panel. This half adds one Host-answerable entry
 * point for the panel: a read-only JSON route that returns the active and
 * inactive scheduled reminders with their original Session bindings, read from
 * the Host `schedule` service. The panel prefers the Client remote face of that
 * service and falls back to this route when the remote namespace is unavailable.
 */

const ROUTE_PATH = '/calendar-board/schedules';
const CACHE_MS = 10000;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function apply(ctx) {
  let cache = { at: 0, entries: null };

  async function readCatalog() {
    const now = Date.now();
    if (cache.entries && now - cache.at < CACHE_MS) return cache.entries;
    const schedule = ctx.get('schedule');
    if (!schedule || typeof schedule.catalog !== 'function') {
      throw new Error('schedule service unavailable');
    }
    const entries = await schedule.catalog();
    const value = Array.isArray(entries) ? entries : [];
    cache = { at: now, entries: value };
    return value;
  }

  const webServer = ctx.get('webServer');
  if (!webServer || typeof webServer.register !== 'function') return;

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      if (req.method && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      try {
        const entries = await readCatalog();
        sendJson(res, 200, { ok: true, entries });
      } catch (error) {
        sendJson(res, 503, { ok: false, error: String((error && error.message) || error) });
      }
    },
  }));
}
