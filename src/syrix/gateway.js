'use strict';
/* The connection between this app's SYRIX and the Kohli Core gateway.
 *
 * The gateway (set by SYRIX_GATEWAY_URL) holds the model keys as
 * Cloudflare secrets and issues revocable tokens per device. This app holds
 * one such token and nothing else: no provider key is copied here, and
 * revoking the token stops this app without affecting any other.
 *
 * The token is kept in data/syrix.json, which never leaves this computer and
 * is excluded from version control.
 *
 * Calls:
 *   POST /v1/device/register  { code, label, deviceId } -> { token }
 *   POST /v1/chat             streamed (SSE) or whole; tool calling supported
 *   POST /v1/search           { query } -> { results } and { read: url } -> page
 */

const fs = require('node:fs');
const path = require('node:path');
const { UA } = require('../http');

const DEFAULT_ENDPOINT = process.env.SYRIX_GATEWAY_URL || '';
const DEVICE_ID = 'syrix-lead-finder';

let file = null;

function setDataDir(dir) { file = path.join(dir, 'syrix.json'); }

function settings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not paired yet */ }
  return { endpoint: s.endpoint || DEFAULT_ENDPOINT, token: s.token || '', pairedAt: s.pairedAt || null };
}

function save(next) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
}

async function post(pathname, body, { token = true, timeout = 60000 } = {}) {
  const s = settings();
  const headers = { 'Content-Type': 'application/json', 'User-Agent': UA };
  if (token) {
    if (!s.token) {
      const err = new Error('SYRIX is not connected yet.');
      err.code = 'not_paired';
      throw err;
    }
    headers['X-Syrix-Token'] = s.token;
  }
  let res;
  try {
    res = await fetch(s.endpoint + pathname, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new Error('Could not reach SYRIX (' + (e.name === 'TimeoutError' ? 'timed out' : e.message) + ').');
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* handled below */ }
  if (!res.ok || !parsed || parsed.error) {
    const err = new Error((parsed && (parsed.message || parsed.error)) || 'SYRIX answered ' + res.status + '.');
    if (parsed && parsed.error) err.code = parsed.error;
    throw err;
  }
  return parsed;
}

async function pair(code) {
  const s = settings();
  const r = await post('/v1/device/register', { code: String(code || '').trim(), label: 'SYRIX Lead Finder (PC app)', deviceId: DEVICE_ID }, { token: false, timeout: 20000 });
  if (!r.token) throw new Error(r.message || 'That pairing code was not accepted.');
  save({ endpoint: s.endpoint, token: r.token, deviceId: r.deviceId || DEVICE_ID, pairedAt: new Date().toISOString() });
  return { ok: true };
}

function unpair() {
  const s = settings();
  save({ endpoint: s.endpoint, token: '', pairedAt: null });
}

function isPaired() { return !!settings().token; }

/* A streamed chat round. Tokens arrive as they are written; tool calls
   arrive at the end. Returns { text, toolCalls }. */
async function streamChat(payload, onToken) {
  const s = settings();
  if (!s.token) {
    const err = new Error('SYRIX is not connected yet.');
    err.code = 'not_paired';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  let res;
  try {
    res = await fetch(s.endpoint + '/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Syrix-Token': s.token, 'User-Agent': UA },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error('Could not reach SYRIX (' + e.message + ').');
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const detail = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(detail); } catch { /* not JSON */ }
    const err = new Error((parsed && (parsed.message || parsed.error)) || 'SYRIX answered ' + res.status + '.');
    if (parsed && parsed.error) err.code = parsed.error;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '';
  const toolCalls = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        const line = frame.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let event;
        try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (event.type === 'token' && event.text) {
          text += event.text;
          if (onToken) onToken(event.text, text);
        } else if (event.type === 'tool_call') {
          toolCalls.push({ id: event.id, name: event.name, args: event.args || {} });
        } else if (event.type === 'error') {
          throw new Error(event.message || 'SYRIX stopped part way through.');
        }
      }
    }
  } finally {
    clearTimeout(timer);
    try { reader.cancel(); } catch { /* already closed */ }
  }
  return { text, toolCalls };
}

/* A whole (non-streamed) chat round. Some gateway lanes end a stream early
   without an error, leaving half a sentence; a whole response either arrives
   complete or fails visibly. */
async function chat(payload) {
  const r = await post('/v1/chat', { ...payload, stream: false }, { timeout: 90000 });
  return { text: String(r.text || ''), toolCalls: r.toolCalls || [] };
}

async function search(query) {
  const r = await post('/v1/search', { query: String(query || '').slice(0, 300) }, { timeout: 45000 });
  return r.results || [];
}

async function readPage(url) {
  return post('/v1/search', { read: String(url || '') }, { timeout: 45000 });
}

async function health() {
  const s = settings();
  try {
    const res = await fetch(s.endpoint + '/v1/health', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    const j = await res.json();
    return { online: !!j.ok, paired: !!s.token };
  } catch (e) {
    return { online: false, paired: !!s.token, error: e.message };
  }
}

module.exports = { setDataDir, settings, pair, unpair, isPaired, streamChat, chat, search, readPage, health };
