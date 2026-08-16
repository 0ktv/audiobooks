// Слушаю 98 — Yandex Disk audio gateway for Cloudflare Workers
// Deploy this as a Worker and paste the resulting https://...workers.dev URL into the app.
// It only proxies Yandex Disk public resources and is not a general-purpose open proxy.

const YANDEX_API = 'https://cloud-api.yandex.net/v1/disk';
const ALLOWED_ORIGIN = 'https://0ktv.github.io';

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowed = !origin || origin === ALLOWED_ORIGIN ? (origin || ALLOWED_ORIGIN) : '';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Range,Content-Type,If-Range,If-None-Match',
    'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type,ETag,Last-Modified',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(data, status, request) {
  const headers = new Headers(corsHeaders(request));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

function allowedRequest(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === ALLOWED_ORIGIN;
}

function pathVariants(raw = '') {
  if (!String(raw || '').trim()) return [''];
  const out = [];
  const add = value => {
    value = String(value || '').trim();
    if (value && !out.includes(value)) out.push(value);
  };
  add(raw);
  let p = String(raw || '').trim().replace(/^disk:/i, '').replace(/^public:/i, '');
  if (p) {
    add(p);
    add(p.startsWith('/') ? p : '/' + p);
    add(p.replace(/^\/+/, ''));
  }
  return out;
}

function yandexUrl(endpoint, publicKey, path, extra = {}) {
  const u = new URL(`${YANDEX_API}/${endpoint}`);
  u.searchParams.set('public_key', publicKey);
  if (path) u.searchParams.set('path', path);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') u.searchParams.set(key, String(value));
  }
  return u;
}

async function fetchYandexJson(endpoint, publicKey, rawPath, extra = {}) {
  let last = null;
  for (const path of pathVariants(rawPath)) {
    const response = await globalThis.fetch(yandexUrl(endpoint, publicKey, path, extra), {
      headers: { 'Accept': 'application/json' },
      redirect: 'follow'
    });
    const text = await response.text();
    if (response.ok) {
      try { return { data: JSON.parse(text), path }; }
      catch { throw new Error('Yandex returned invalid JSON'); }
    }
    last = { status: response.status, text, path };
  }
  const error = new Error(last ? `Yandex HTTP ${last.status}` : 'Yandex request failed');
  error.status = last?.status || 502;
  error.details = last?.text || '';
  throw error;
}

function copyHeader(from, to, name) {
  const value = from.get(name);
  if (value) to.set(name, value);
}

async function handleMeta(request, url) {
  const publicKey = url.searchParams.get('public_key');
  const path = url.searchParams.get('path') || '';
  if (!publicKey) return json({ error: 'public_key is required' }, 400, request);
  try {
    const { data, path: workingPath } = await fetchYandexJson('public/resources', publicKey, path, {
      limit: url.searchParams.get('limit') || 200,
      offset: url.searchParams.get('offset') || 0
    });
    data.__gateway_path = workingPath;
    const headers = new Headers(corsHeaders(request));
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch (error) {
    return json({ error: error.message, details: error.details || '' }, error.status || 502, request);
  }
}

async function handleAudio(request, url) {
  const publicKey = url.searchParams.get('public_key');
  const path = url.searchParams.get('path') || '';
  if (!publicKey) return json({ error: 'public_key is required' }, 400, request);

  let href;
  let workingPath = path;
  try {
    const result = await fetchYandexJson('public/resources/download', publicKey, path);
    href = result.data?.href;
    workingPath = result.path;
    if (!href) throw new Error('Yandex did not return a download href');
  } catch (error) {
    return json({ error: error.message, details: error.details || '', path }, error.status || 502, request);
  }

  const upstreamHeaders = new Headers();
  for (const name of ['Range', 'If-Range', 'If-None-Match']) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }
  upstreamHeaders.set('Accept', '*/*');

  let upstream;
  try {
    upstream = await globalThis.fetch(href, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
      redirect: 'follow'
    });
  } catch (error) {
    return json({ error: 'Failed to fetch Yandex download', details: String(error) }, 502, request);
  }

  if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304) {
    const details = await upstream.text().catch(() => '');
    return json({ error: `Yandex download HTTP ${upstream.status}`, details: details.slice(0, 500) }, upstream.status, request);
  }

  const headers = new Headers(corsHeaders(request));
  for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    copyHeader(upstream.headers, headers, name);
  }
  let contentType = upstream.headers.get('Content-Type') || '';
  if (!/^audio\//i.test(contentType)) {
    const lower = workingPath.toLowerCase();
    if (lower.endsWith('.m4a') || lower.endsWith('.m4b')) contentType = 'audio/mp4';
    else if (lower.endsWith('.aac')) contentType = 'audio/aac';
    else if (lower.endsWith('.ogg') || lower.endsWith('.oga')) contentType = 'audio/ogg';
    else if (lower.endsWith('.wav')) contentType = 'audio/wav';
    else contentType = 'audio/mpeg';
  }
  headers.set('Content-Type', contentType);
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Slushayu-Path', workingPath);
  if (!headers.has('Accept-Ranges') && request.headers.has('Range')) headers.set('Accept-Ranges', 'bytes');

  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

export default {
  async fetch(request) {
    if (!allowedRequest(request)) return new Response('Forbidden', { status: 403 });
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed' }, 405, request);
    if (url.pathname === '/health') return json({ ok: true, service: 'slushayu98-audio-gateway', version: 1 }, 200, request);
    if (url.pathname === '/meta') return handleMeta(request, url);
    if (url.pathname === '/audio') return handleAudio(request, url);
    return json({ ok: true, message: 'Slushayu 98 Yandex audio gateway', endpoints: ['/health', '/meta', '/audio'] }, 200, request);
  }
};
