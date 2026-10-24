'use strict';
/* The only module that talks to the internet.
 *
 * Every request goes through here so four rules hold everywhere:
 *
 *   1. The app identifies itself. A plain, honest User-Agent, never a copied
 *      browser string. A source that wants to refuse this tool must be able
 *      to see that it is this tool.
 *   2. It is polite. Requests to one host are serialised with a gap between
 *      them. Public services stay open to tools that do not hammer them.
 *   3. It caches on disk. A page fetched recently is not fetched again, which
 *      keeps a full run to a modest number of requests.
 *   4. Failures are remembered. A failed fetch is cached for a short time, so
 *      a broken source cannot turn a retry loop into a flood.
 *
 * There is no bot-defence handling and there must never be: no CAPTCHA
 * solving, no cookie replay, no headless browser. A source that puts up a
 * wall is reported as blocked and the run carries on without it.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UA = 'SYRIXLeadFinder/1.0 (business lead research tool; single user; low volume)';
const DEFAULT_TIMEOUT = 25000;
const MAX_BODY = 32 * 1024 * 1024;   // the sponsor register is ~12 MB
const FAILURE_TTL = 10 * 60 * 1000;

/* Per-host manners. Anything not listed gets one request at a time with a
   one-second gap, which is gentle enough for a small business website. */
const HOST_LIMITS = {
  'www.contractsfinder.service.gov.uk': { gap: 400, concurrency: 1 },
  'www.find-tender.service.gov.uk': { gap: 4000, concurrency: 1 },
  'www.gov.uk': { gap: 300, concurrency: 1 },
  'assets.publishing.service.gov.uk': { gap: 300, concurrency: 1 },
  'find-and-update.company-information.service.gov.uk': { gap: 700, concurrency: 1 },
  'www.reddit.com': { gap: 30000, concurrency: 1 },
  'www.immigrationboards.com': { gap: 1500, concurrency: 1 },
  'html.duckduckgo.com': { gap: 2500, concurrency: 1 },
  'www.bing.com': { gap: 2500, concurrency: 1 }
};

function limitsFor(host) {
  return HOST_LIMITS[host] || { gap: 1000, concurrency: 1 };
}

let cacheDir = null;
const lastHit = new Map();
const active = new Map();
const queues = new Map();
const blockedUntil = new Map();

const stats = { requests: 0, cacheHits: 0, errors: 0, bytes: 0 };

function setCacheDir(dir) {
  cacheDir = dir;
  fs.mkdirSync(dir, { recursive: true });
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'invalid'; }
}

function cacheFile(key) {
  return path.join(cacheDir, crypto.createHash('sha1').update(key).digest('hex') + '.json');
}

function readCache(key, ttl) {
  if (!cacheDir || !ttl) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(cacheFile(key), 'utf8'));
    const life = entry.ok ? ttl : Math.min(ttl, FAILURE_TTL);
    if (Date.now() - entry.at > life) return null;
    return entry;
  } catch { return null; }
}

function writeCache(key, entry) {
  if (!cacheDir) return;
  const file = cacheFile(key);
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, file);
  } catch { try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ } }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Waits for a slot on the host, honouring its gap and concurrency. */
async function acquire(host) {
  const { gap, concurrency } = limitsFor(host);
  while ((active.get(host) || 0) >= concurrency) {
    await new Promise(r => {
      if (!queues.has(host)) queues.set(host, []);
      queues.get(host).push(r);
    });
  }
  active.set(host, (active.get(host) || 0) + 1);
  const wait = (lastHit.get(host) || 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

function release(host) {
  active.set(host, Math.max(0, (active.get(host) || 1) - 1));
  const q = queues.get(host);
  if (q && q.length) q.shift()();
}

class FetchError extends Error {
  constructor(message, { status = 0, url = '', blocked = false } = {}) {
    super(message);
    this.status = status;
    this.url = url;
    this.blocked = blocked;
  }
}

/* Fetches a URL as text. Options:
 *   ttl      cache lifetime in ms (0 = never cache)
 *   accept   Accept header
 *   method, body, headers  for the few POST endpoints
 */
async function fetchText(url, opts = {}) {
  const { ttl = 0, fresh = false, accept = '*/*', method = 'GET', body = null, headers = {}, timeout = DEFAULT_TIMEOUT } = opts;
  const key = method + ' ' + url + (body ? ' ' + body : '');
  const cached = fresh ? null : readCache(key, ttl);
  if (cached) {
    stats.cacheHits++;
    if (!cached.ok) throw new FetchError(cached.error, { status: cached.status, url, blocked: cached.blocked });
    return cached.text;
  }

  const host = hostOf(url);
  const until = blockedUntil.get(host) || 0;
  if (until > Date.now()) {
    throw new FetchError(host + ' asked this tool to slow down; skipped until ' + new Date(until).toLocaleTimeString('en-GB'), { url, blocked: true });
  }

  await acquire(host);
  try {
    stats.requests++;
    const res = await fetch(url, {
      method,
      body,
      headers: { 'user-agent': UA, accept, ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout)
    });
    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_BODY) throw new FetchError('Response too large (' + length + ' bytes)', { status: res.status, url });
    const text = await res.text();
    stats.bytes += text.length;

    if (res.status === 429 || res.status === 403) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      const pause = Math.max(retryAfter * 1000, res.status === 429 ? 15 * 60 * 1000 : 60 * 60 * 1000);
      blockedUntil.set(host, Date.now() + pause);
      const err = new FetchError(host + ' refused the request (HTTP ' + res.status + ')', { status: res.status, url, blocked: true });
      writeCache(key, { ok: false, at: Date.now(), status: res.status, error: err.message, blocked: true });
      throw err;
    }
    if (!res.ok) {
      const err = new FetchError('HTTP ' + res.status + ' from ' + host, { status: res.status, url });
      writeCache(key, { ok: false, at: Date.now(), status: res.status, error: err.message });
      throw err;
    }
    if (ttl) writeCache(key, { ok: true, at: Date.now(), status: res.status, text });
    return text;
  } catch (e) {
    stats.errors++;
    if (e instanceof FetchError) throw e;
    const reason = e.name === 'TimeoutError' ? 'timed out' : (e.cause && e.cause.code) || e.message;
    const err = new FetchError(host + ' could not be reached (' + reason + ')', { url });
    writeCache(key, { ok: false, at: Date.now(), status: 0, error: err.message });
    throw err;
  } finally {
    release(host);
  }
}

/* Gateway errors and timeouts from large public services are usually
   momentary (Find a Tender returns the odd 502 mid-sweep), so they are
   retried twice with a growing pause. Refusals and 404s are not retried. */
async function getText(url, opts = {}) {
  if (opts.retry === false) return fetchText(url, opts);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchText(url, attempt ? { ...opts, fresh: true } : opts);
    } catch (e) {
      const transient = !e.blocked && (e.status >= 500 || e.status === 0);
      if (!transient || attempt >= 2) throw e;
      await sleep(attempt ? 6000 : 2000);
    }
  }
}

/* For sources that refuse with a normal-looking page (a search engine's
   "unusual traffic" page) rather than an error code. */
function block(host, ms) {
  blockedUntil.set(host, Date.now() + ms);
}

function isBlocked(host) {
  return (blockedUntil.get(host) || 0) > Date.now();
}

async function getJson(url, opts = {}) {
  const text = await getText(url, { accept: 'application/json', ...opts });
  try { return JSON.parse(text); } catch {
    throw new FetchError('Expected JSON from ' + hostOf(url) + ' and got something else', { url });
  }
}

module.exports = { getText, getJson, setCacheDir, stats, FetchError, UA, hostOf, block, isBlocked };
