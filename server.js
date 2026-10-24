'use strict';
/* SYRIX Lead Finder — local server.
 *
 * Binds to 127.0.0.1 only, so nothing outside this computer can reach it.
 * Requests must carry this machine's own Host header (stops DNS rebinding)
 * and every change must carry a custom header a web page on another site
 * cannot send without permission (stops cross-site requests).
 *
 *   node server.js            start, run due sources, open the browser
 *   node server.js --no-open  start without opening a browser window
 *   node server.js --no-run   start without reading any source (tests)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { Store, USER_STATUSES } = require('./src/store');
const { Pipeline, SOURCES } = require('./src/pipeline');
const { IN_FOCUS } = require('./src/services');
const { originOf, shown } = require('./src/freshness');
const { evidenceLinks } = require('./src/lead');
const { setCacheDir, stats } = require('./src/http');
const { toCsv } = require('./src/text');
const syrixGateway = require('./src/syrix/gateway');
const syrixChat = require('./src/syrix/chat');

/* SYRIX turns run as jobs the panel polls, so a twenty-second answer shows
   its steps and its words as they arrive instead of a spinner. */
const jobs = new Map();
let jobSeq = 0;

function startJob(run) {
  const id = 'j' + (++jobSeq) + '-' + Date.now().toString(36);
  const job = { id, steps: [], text: '', done: false, error: null, startedAt: Date.now() };
  jobs.set(id, job);
  if (jobs.size > 30) for (const k of [...jobs.keys()].slice(0, jobs.size - 30)) jobs.delete(k);
  run(job).then(() => { job.done = true; }, err => { job.error = err.message || String(err); job.code = err.code || ''; job.done = true; });
  return job;
}

const args = process.argv.slice(2);
const flag = name => args.includes('--' + name);
const opt = (name, fallback) => {
  const a = args.find(x => x.startsWith('--' + name + '='));
  return a ? a.split('=').slice(1).join('=') : fallback;
};

const APP = 'syrix-lead-finder';
const PORT = Number(opt('port', process.env.LEADS_PORT || 7862));
const HOST = '127.0.0.1';
const DATA = path.resolve(opt('data', process.env.LEADS_DATA || path.join(__dirname, 'data')));
const WEB = path.join(__dirname, 'web');
const SCHEDULE_MS = 15 * 60 * 1000;

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cache-Control': 'no-store'
};

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
  res.end(data);
}

function readBodyLarge(req) { return readBody(req, 5 * 1024 * 1024); }

function readBody(req, limit = 100000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Body must be JSON')); }
    });
    req.on('error', reject);
  });
}

/* Every lead the app may show. Evidence older than the age limit
   (freshness.js) stays in the store, so it is never picked up again as new,
   but it reaches no tab, count, export or SYRIX answer. */
function visible(store) {
  return store.all().filter(l => shown(l));
}

function counts(store) {
  const c = { active: 0, contacted: 0, won: 0, dismissed: 0, 'too-late': 0 };
  for (const l of visible(store)) c[l.status] = (c[l.status] || 0) + 1;
  return c;
}

/* Leads as the interface receives them: with the original date of their
   evidence worked out, so the page never has to guess it from the date the
   app found the lead, and the links that open that evidence. */
function present(lead) {
  return lead ? { ...lead, origin: originOf(lead), links: evidenceLinks(lead) } : lead;
}

function exportRows(leads) {
  const head = ['Status', 'Score', 'Type', 'Name', 'Why', 'Evidence', 'Likely services', 'Contact person', 'Role', 'Email', 'Phone', 'Website', 'LinkedIn', 'Address', 'Username', 'Profile', 'How to reach', 'Source', 'Source link', 'Deadline', 'Originally published', 'Date basis', 'Found by the app', 'Notes'];
  const rows = leads.map(l => {
    const c = l.contact || {};
    const o = originOf(l);
    return [
      l.status, l.score, l.kind === 'person' ? 'Person' : 'Organisation', l.name, l.signal.label + ': ' + l.headline, l.signal.quote,
      (l.services || []).map(s => s.name).join('; '), c.person, c.role, c.email, c.phone, c.website, c.linkedin, c.address,
      c.handle, c.profileUrl, c.channel, l.sourceLabel, l.signal.url, l.deadline ? l.deadline.slice(0, 16).replace('T', ' ') : '',
      (o.at || '').slice(0, 10), o.text, (l.foundAt || '').slice(0, 10), l.notes
    ];
  });
  return [head, ...rows];
}

function openBrowser(url) {
  const child = process.platform === 'win32'
    ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

/* If a copy is already running on the port, bring it up instead of starting
   a second server racing the first over the same data folder. */
function alreadyRunning() {
  return new Promise(resolve => {
    const req = http.get({ host: HOST, port: PORT, path: '/api/ping', timeout: 1500 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body).app === APP); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function createServer(store, pipeline) {
  const allowedHosts = new Set([HOST + ':' + PORT, 'localhost:' + PORT]);

  return http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 421, { error: 'Wrong host' });
      const url = new URL(req.url, 'http://' + req.headers.host);
      const p = url.pathname;

      if (req.method === 'POST') {
        if (req.headers['x-requested-with'] !== APP || !/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 403, { error: 'Refused' });
      }

      if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { app: APP });

      if (req.method === 'GET' && p === '/api/state') {
        return send(res, 200, {
          pipeline: pipeline.status(),
          counts: counts(store),
          sources: SOURCES.map(s => ({ ...s, ...store.sourceState(s.id), enabled: store.sourceState(s.id).enabled !== false })),
          services: IN_FOCUS.map(s => ({ id: s.id, name: s.name, area: s.area })),
          network: stats
        });
      }

      if (req.method === 'GET' && p === '/api/leads') return send(res, 200, { leads: visible(store).map(present) });

      if (req.method === 'POST' && p === '/api/export') {
        const { ids } = await readBodyLarge(req);
        const leads = (Array.isArray(ids) ? ids : []).map(id => store.get(String(id))).filter(l => shown(l));
        /* The byte-order mark makes Excel read the file as UTF-8, so names
           with accents and the pound sign survive. */
        return send(res, 200, '﻿' + toCsv(exportRows(leads)), 'text/csv; charset=utf-8');
      }

      if (req.method === 'POST' && p === '/api/run') {
        if (pipeline.running) return send(res, 409, { error: 'A run is already in progress' });
        pipeline.run({ force: true }).catch(err => console.error('Run failed:', err));
        return send(res, 202, { started: true });
      }

      if (req.method === 'GET' && p === '/api/syrix') return send(res, 200, await syrixGateway.health());

      if (req.method === 'POST' && p === '/api/syrix/pair') {
        const { code } = await readBody(req);
        await syrixGateway.pair(code);
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/syrix/ask') {
        const { messages, view } = await readBodyLarge(req);
        if (!Array.isArray(messages) || !messages.length) return send(res, 400, { error: 'Nothing to answer' });
        const job = startJob(async j => {
          await syrixChat.answer({ store, pipeline }, {
            history: messages,
            view,
            /* A new running step closes the previous one; a finished step
               closes its own entry; "Done" closes everything. */
            onStep: s => {
              if (s.state === 'running') {
                for (const x of j.steps) if (x.state === 'running') x.state = 'done';
                j.steps.push({ label: s.label, state: 'running' });
                return;
              }
              const open = [...j.steps].reverse().find(x => x.label === s.label && x.state === 'running');
              if (open) open.state = s.state;
              if (s.label === 'Done') for (const x of j.steps) if (x.state === 'running') x.state = 'done';
            },
            onText: t => { j.text = t; }
          });
        });
        return send(res, 202, { jobId: job.id });
      }

      if (req.method === 'POST' && p === '/api/syrix/overview') {
        const { id, refresh } = await readBody(req);
        const lead = store.get(String(id || ''));
        if (!lead) return send(res, 404, { error: 'No such lead' });
        const key = syrixChat.overviewKey(lead);
        if (!refresh && lead.overview && lead.overview.key === key) return send(res, 200, { text: lead.overview.text, at: lead.overview.at, cached: true });
        const job = startJob(async j => {
          j.steps.push({ label: 'Reading the lead', state: 'running' });
          const text = await syrixChat.overview(lead, { onText: t => { j.text = t; } });
          j.steps[0].state = 'done';
          if (text) store.patch(lead.id, { overview: { key, text, at: new Date().toISOString() } });
        });
        return send(res, 202, { jobId: job.id });
      }

      let m;
      if (req.method === 'GET' && (m = /^\/api\/syrix\/job\/([\w-]+)$/.exec(p))) {
        const job = jobs.get(m[1]);
        if (!job) return send(res, 404, { error: 'That answer has expired' });
        return send(res, 200, { steps: job.steps, text: job.text, done: job.done, error: job.error, code: job.code });
      }

      if (req.method === 'POST' && (m = /^\/api\/leads\/([^/]+)\/status$/.exec(p))) {
        const { status } = await readBody(req);
        if (!USER_STATUSES.includes(status)) return send(res, 400, { error: 'Not a status you can set' });
        const lead = store.setStatus(decodeURIComponent(m[1]), status, { by: 'user', reason: 'Set by the user' });
        return send(res, 200, { lead: present(lead) });
      }

      if (req.method === 'POST' && (m = /^\/api\/leads\/([^/]+)\/notes$/.exec(p))) {
        const { notes } = await readBody(req);
        return send(res, 200, { lead: present(store.setNotes(decodeURIComponent(m[1]), notes)) });
      }

      if (req.method === 'POST' && (m = /^\/api\/sources\/([^/]+)$/.exec(p))) {
        const { enabled } = await readBody(req);
        if (!SOURCES.some(s => s.id === m[1])) return send(res, 404, { error: 'No such source' });
        store.setSourceState(m[1], { enabled: !!enabled });
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && !p.startsWith('/api/')) {
        const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
        const file = path.resolve(WEB, rel);
        if (!file.startsWith(WEB + path.sep)) return send(res, 404, 'Not found', 'text/plain');
        return fs.readFile(file, (err, data) => {
          if (err) return send(res, 404, 'Not found', 'text/plain');
          send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
        });
      }

      send(res, 404, { error: 'Not found' });
    } catch (err) {
      send(res, /No such lead|Unknown status|Only the system/.test(err.message) || err.code ? 400 : 500, { error: err.message, code: err.code || undefined });
    }
  });
}

async function main() {
  const url = 'http://' + HOST + ':' + PORT + '/';
  if (await alreadyRunning()) {
    if (!flag('no-open')) openBrowser(url);
    console.log('SYRIX Lead Finder is already running at ' + url);
    return;
  }

  fs.mkdirSync(DATA, { recursive: true });
  setCacheDir(path.join(DATA, 'cache'));
  syrixGateway.setDataDir(DATA);
  const store = new Store(DATA);
  const pipeline = new Pipeline(store, { dataDir: DATA });
  const server = createServer(store, pipeline);

  server.listen(PORT, HOST, () => {
    console.log('SYRIX Lead Finder running at ' + url);
    if (!flag('no-open')) openBrowser(url);
    if (!flag('no-run')) {
      setTimeout(() => pipeline.run().catch(err => console.error('Run failed:', err)), 1500);
      setInterval(() => { if (!pipeline.running) pipeline.run().catch(err => console.error('Run failed:', err)); }, SCHEDULE_MS);
    }
  });

  const stop = () => { try { store.saveNow(); } catch { /* exiting anyway */ } process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();

module.exports = { createServer, exportRows, APP };
