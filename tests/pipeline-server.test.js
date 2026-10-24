'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { withFakeHttp, tempDir, fresh } = require('./helpers');

const FUTURE = new Date(Date.now() + 20 * 86400000).toISOString();

function release(ocid, title, cpv) {
  return {
    ocid, id: ocid + '-1', date: new Date().toISOString(),
    tender: { title, status: 'active', classification: { id: cpv }, tenderPeriod: { endDate: FUTURE }, documents: [{ documentType: 'tenderNotice', url: 'https://www.contractsfinder.service.gov.uk/Notice/' + ocid }] },
    buyer: { id: 'B' }, parties: [{ id: 'B', name: 'Council ' + ocid, roles: ['buyer'], contactPoint: { email: 'p@council.gov.uk' } }]
  };
}

test('pipeline: an award notice for a stored tender moves it to Too late with the award as evidence', async () => {
  let awards = [];
  const fake = withFakeHttp({
    'contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?publishedFrom': url => url.includes('stages=award')
      ? { releases: awards, links: {} }
      : { releases: [release('ocds-a', 'Market research study', '79310000'), release('ocds-b', 'Business consultancy support', '79410000')], links: {} }
  });
  const { Store } = fake.load('store.js');
  const { Pipeline } = fake.load('pipeline.js');
  const dir = tempDir();
  const store = new Store(dir);
  const p = new Pipeline(store, { dataDir: dir });
  await p.run({ force: true, only: ['contracts-finder'] });
  assert.equal(store.all().filter(l => l.status === 'active').length, 2);

  awards = [{ ocid: 'ocds-a', id: 'w', awards: [{ date: '2026-10-04', suppliers: [{ name: 'Another Consultancy Ltd' }], documents: [{ url: 'https://www.contractsfinder.service.gov.uk/Notice/award-a' }] }] }];
  await p.run({ force: true, only: ['contracts-finder'] });
  const a = store.all().find(l => l.ref.ocid === 'ocds-a');
  const b = store.all().find(l => l.ref.ocid === 'ocds-b');
  assert.equal(a.status, 'too-late');
  assert.match(a.history.at(-1).reason, /Another Consultancy Ltd/);
  assert.equal(a.history.at(-1).evidenceUrl, 'https://www.contractsfinder.service.gov.uk/Notice/award-a');
  assert.equal(b.status, 'active');
  assert.ok(typeof b.score === 'number' && b.scoreReasons.length);
  store.saveNow();
});

test('pipeline: a tender past its published deadline is retired; one the user marked won is left alone', async () => {
  const fake = withFakeHttp({});
  const { Store } = fake.load('store.js');
  const { Pipeline } = fake.load('pipeline.js');
  const dir = tempDir();
  const store = new Store(dir);
  const base = { source: 'contracts-finder', sourceLabel: 'CF', kind: 'organisation', name: 'C', headline: 'H', services: [], contact: {}, facts: [], ref: {}, deadline: new Date(Date.now() - 3600000).toISOString() };
  store.upsert({ ...base, id: 't:1', signal: { type: 'tender', label: 'L', url: 'https://notice/1' } });
  store.upsert({ ...base, id: 't:2', signal: { type: 'tender', label: 'L', url: 'https://notice/2' } });
  store.setStatus('t:2', 'won');
  const p = new Pipeline(store, { dataDir: dir });
  await p.run({ force: true, only: [] });
  assert.equal(store.get('t:1').status, 'too-late');
  assert.equal(store.get('t:1').history.at(-1).evidenceUrl, 'https://notice/1');
  assert.equal(store.get('t:2').status, 'won');
  store.saveNow();
});

/* ---------- server ---------- */

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: '127.0.0.1:' + port, ...headers } }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('server: refuses foreign hosts and cross-site writes, and serves a strict CSP', async () => {
  const port = 17862 + Math.floor(Math.random() * 1000);
  process.env.LEADS_PORT = String(port);
  const dir = tempDir();
  const { Store } = fresh('store.js');
  const { Pipeline } = fresh('pipeline.js');
  delete require.cache[require.resolve('../server.js')];
  const { createServer } = require('../server.js');
  const store = new Store(dir);
  store.upsert({ id: 'x:1', source: 'x', sourceLabel: 'X', kind: 'organisation', name: 'Acme, "Quoted" Ltd', headline: 'H', signal: { type: 'tender', label: 'L', url: 'https://e', quote: 'Q' }, services: [{ id: 'market-research', name: 'Market research' }], contact: { email: 'a@acme.co.uk' }, facts: [] });
  const server = createServer(store, new Pipeline(store, { dataDir: dir }));
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  try {
    const page = await request(port);
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);

    assert.equal((await request(port, { headers: { host: 'evil.example:' + port } })).status, 421);

    const noHeader = await request(port, { method: 'POST', path: '/api/leads/x%3A1/status', headers: { 'content-type': 'application/json' }, body: { status: 'won' } });
    assert.equal(noHeader.status, 403);

    const ok = await request(port, { method: 'POST', path: '/api/leads/x%3A1/status', headers: { 'content-type': 'application/json', 'x-requested-with': 'syrix-lead-finder' }, body: { status: 'contacted' } });
    assert.equal(ok.status, 200);
    assert.equal(store.get('x:1').status, 'contacted');

    const tooLate = await request(port, { method: 'POST', path: '/api/leads/x%3A1/status', headers: { 'content-type': 'application/json', 'x-requested-with': 'syrix-lead-finder' }, body: { status: 'too-late' } });
    assert.equal(tooLate.status, 400, 'only the system may set too late');

    const csv = await request(port, { method: 'POST', path: '/api/export', headers: { 'content-type': 'application/json', 'x-requested-with': 'syrix-lead-finder' }, body: { ids: ['x:1'] } });
    assert.equal(csv.status, 200);
    assert.match(csv.body, /"Acme, ""Quoted"" Ltd"/);
    assert.match(csv.body, /a@acme\.co\.uk/);

    assert.equal((await request(port, { path: '/../server.js' })).status, 404);

    /* Evidence older than three months reaches no tab, count or export. */
    store.upsert({ id: 'x:old', source: 'x', sourceLabel: 'X', kind: 'organisation', name: 'Old Ltd', headline: 'H', signal: { type: 'tender', label: 'L', url: 'https://e', quote: 'Q', date: '2025-01-10T09:00:00Z' }, ref: { firstPublished: '2025-01-10T09:00:00Z' }, services: [], contact: {}, facts: [] });
    store.setStatus('x:old', 'too-late', { by: 'system', reason: 'old', evidenceUrl: 'https://e' });
    const leads = JSON.parse((await request(port, { path: '/api/leads' })).body).leads;
    assert.deepEqual(leads.map(l => l.id), ['x:1']);
    assert.equal(JSON.parse((await request(port, { path: '/api/state' })).body).counts['too-late'], 0);
    const oldCsv = await request(port, { method: 'POST', path: '/api/export', headers: { 'content-type': 'application/json', 'x-requested-with': 'syrix-lead-finder' }, body: { ids: ['x:old'] } });
    assert.doesNotMatch(oldCsv.body, /Old Ltd/);
  } finally {
    await new Promise(r => server.close(r));
    store.saveNow();
  }
});

test('interface: no inline handlers, and every data-act has an action', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const sx = fs.readFileSync(path.join(__dirname, '..', 'web', 'syrix.js'), 'utf8');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'inline handlers are blocked by the CSP');
  assert.doesNotMatch(html, /\sstyle=/i, 'inline styles are blocked by the CSP');
  assert.doesNotMatch(js + sx, /\son[a-z]+="/i);
  const acts = new Set([...html.matchAll(/data-act="([^"]+)"/g), ...js.matchAll(/data-act="([^"]+)"/g), ...sx.matchAll(/data-act="([^"]+)"/g)].map(m => m[1]));
  const block = js.slice(js.indexOf('const ACTIONS = {'), js.indexOf('document.addEventListener')) +
    sx.slice(sx.indexOf('Object.assign(G.ACTIONS, {'));
  for (const act of acts) {
    const defined = new RegExp("(^|\\n)\\s*(async\\s+)?('" + act + "'|" + act.replace(/-/g, '_') + ')\\s*\\(').test(block);
    assert.ok(defined, 'data-act="' + act + '" has no handler in ACTIONS');
  }
  assert.match(html, /Made by Kabirr Kohli/);
  assert.match(html, /Powered by SYRIX/);
});
