/**
 * OAuth 2.0 authorization-code + PKCE for a desktop app, with Google Calendar as
 * the first provider.
 *
 * The browser is redirected to a loopback URL this process owns
 * (http://127.0.0.1:19871/calendar-board/oauth/callback), which exists only while
 * an attempt is running. Tokens go to DSH's credential store when it is mounted,
 * otherwise to a 0600 file under the board's storage directory.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CALLBACK_PORT = 19871;
export const CALLBACK_PATH = '/calendar-board/oauth/callback';
export const REDIRECT_URI = 'http://127.0.0.1:' + CALLBACK_PORT + CALLBACK_PATH;

const ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;

export const PROVIDERS = {
  google: {
    id: 'google',
    label: 'Google Calendar',
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    authorizeUrl: process.env.CALENDAR_BOARD_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.CALENDAR_BOARD_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    apiBase: process.env.CALENDAR_BOARD_GOOGLE_API_BASE || 'https://www.googleapis.com/calendar/v3',
    clientIdEnv: 'CALENDAR_BOARD_GOOGLE_CLIENT_ID',
    clientSecretEnv: 'CALENDAR_BOARD_GOOGLE_CLIENT_SECRET',
  },
};

export function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(provider, options) {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', provider.scopes.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function callbackPage(title, detail, ok) {
  const color = ok ? '#1a7f37' : '#b42318';
  return (
    '<!doctype html><meta charset="utf-8"><title>' + title + '</title>' +
    '<body style="font:15px -apple-system,Segoe UI,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#f7f8fa;color:#1f2328">' +
    '<div style="text-align:center;padding:32px 40px;border-radius:16px;background:#fff;box-shadow:0 8px 32px rgba(0,0,0,.08)">' +
    '<div style="font-size:20px;font-weight:600;color:' + color + '">' + title + '</div>' +
    '<div style="margin-top:8px;color:#5b6470">' + detail + '</div></div></body>'
  );
}

/**
 * Run one authorization attempt: listen on the loopback callback, hand the URL to
 * the caller, exchange the returned code for tokens.
 *
 * @returns {{ url: string, wait: Promise<{ code: string }>, close: () => void }}
 */
export function beginAttempt(provider, options) {
  const state = base64url(randomBytes(16));
  const pkce = createPkce();
  const clientId = options.clientId;
  const clientSecret = options.clientSecret || '';

  let settle = null;
  const wait = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  let closed = false;
  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch (error) {
      res.writeHead(400).end('bad request');
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end('not found');
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const got = url.searchParams.get('state');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (error) {
      res.end(callbackPage('授权被取消', '可以关掉这个页面，回到 DSH 重试。', false));
      if (settle) settle.reject(new Error('authorization denied: ' + error));
      return;
    }
    if (got !== state || !code) {
      res.end(callbackPage('回调校验失败', 'state 不匹配或缺少 code，请重新发起授权。', false));
      if (settle) settle.reject(new Error('state mismatch or missing code'));
      return;
    }
    res.end(callbackPage('授权成功', '可以关掉这个页面，回到 DSH 的日历看板。', true));
    if (settle) settle.resolve({ code });
  });

  const timer = setTimeout(() => {
    if (settle) settle.reject(new Error('authorization timed out'));
  }, ATTEMPT_TIMEOUT_MS);

  let listening = null;
  listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(CALLBACK_PORT, '127.0.0.1', () => resolve());
  });

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    try { server.close(); } catch (error) { /* already closed */ }
  };

  const url = buildAuthorizeUrl(provider, {
    clientId,
    state,
    challenge: pkce.challenge,
  });

  return {
    url,
    state,
    async exchange() {
      try {
        await listening;
        const { code } = await wait;
        return await exchangeCode(provider, {
          code,
          clientId,
          clientSecret,
          verifier: pkce.verifier,
        });
      } finally {
        close();
      }
    },
    close,
  };
}

export async function exchangeCode(provider, input) {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
    code_verifier: input.verifier,
  });
  if (input.clientSecret) body.set('client_secret', input.clientSecret);
  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error('token exchange failed: HTTP ' + response.status + ' ' + (payload.error_description || payload.error || ''));
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || '',
    expiresAt: Date.now() + Math.max(30, Number(payload.expires_in) || 3600) * 1000,
    scope: payload.scope || provider.scopes.join(' '),
  };
}

export async function refreshAccessToken(provider, tokens, client) {
  if (!tokens.refreshToken) throw new Error('no refresh token stored; authorize again');
  const body = new URLSearchParams({
    refresh_token: tokens.refreshToken,
    client_id: client.clientId,
    grant_type: 'refresh_token',
  });
  if (client.clientSecret) body.set('client_secret', client.clientSecret);
  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error('token refresh failed: HTTP ' + response.status + ' ' + (payload.error_description || payload.error || ''));
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || tokens.refreshToken,
    expiresAt: Date.now() + Math.max(30, Number(payload.expires_in) || 3600) * 1000,
    scope: payload.scope || tokens.scope,
  };
}

/* ------------------------------------------------------------------ storage */

const KEY_PREFIX = 'calendar-board:';

function fileFor(dir, providerId) {
  return path.join(dir, providerId + '-oauth.json');
}

async function readFileRecord(dir, providerId) {
  try {
    return JSON.parse(await readFile(fileFor(dir, providerId), 'utf8'));
  } catch (error) {
    return null;
  }
}

async function writeFileRecord(dir, providerId, record) {
  await mkdir(dir, { recursive: true });
  const target = fileFor(dir, providerId);
  const temp = target + '.tmp';
  await writeFile(temp, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
}

/**
 * Token storage: the DSH credential store when it is mounted, otherwise a 0600
 * JSON file, so the plugin still works on hosts without that service.
 */
export function createTokenStore(options) {
  const { dir, credentials } = options;

  async function read(providerId) {
    if (credentials && typeof credentials.readRecord === 'function') {
      try {
        const record = await credentials.readRecord(KEY_PREFIX + providerId);
        if (record && record.kind === 'grant' && record.payload) return record.payload;
      } catch (error) {
        /* fall back to the file */
      }
    }
    return readFileRecord(dir, providerId);
  }

  async function write(providerId, payload) {
    if (credentials && typeof credentials.modifyRecord === 'function') {
      try {
        await credentials.modifyRecord(KEY_PREFIX + providerId, async function () {
          return { kind: 'grant', payload };
        });
        return { backend: 'credentials' };
      } catch (error) {
        /* fall back to the file */
      }
    }
    await writeFileRecord(dir, providerId, payload);
    return { backend: 'file' };
  }

  async function remove(providerId) {
    if (credentials && typeof credentials.deleteRecord === 'function') {
      try { await credentials.deleteRecord(KEY_PREFIX + providerId); } catch (error) { /* ignore */ }
    }
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(fileFor(dir, providerId));
    } catch (error) {
      /* already gone */
    }
  }

  return { read, write, remove };
}
