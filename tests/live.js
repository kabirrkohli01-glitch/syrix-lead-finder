'use strict';
/* Live check against the real sources. Opens no window.
 *
 *   node tests/live.js                 every source, into a temporary folder
 *   node tests/live.js reddit forum    only the named sources
 *   node tests/live.js --data=DIR      use (and keep) a given data folder
 *
 * Prints what each source returned, then samples of the leads with their
 * evidence, so a person can judge whether they are real and relevant.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { setCacheDir, stats } = require('../src/http');
const { Store } = require('../src/store');
const { Pipeline, SOURCES } = require('../src/pipeline');

const args = process.argv.slice(2);
const dataArg = args.find(a => a.startsWith('--data='));
const dir = dataArg ? path.resolve(dataArg.slice(7)) : fs.mkdtempSync(path.join(os.tmpdir(), 'leads-live-'));
const alias = { forum: 'immigration-boards', cf: 'contracts-finder', fts: 'find-a-tender', sponsors: 'sponsor-register', penalties: 'illegal-working' };
const only = args.filter(a => !a.startsWith('--')).map(a => alias[a] || a);

(async () => {
  setCacheDir(path.join(dir, 'cache'));
  const store = new Store(dir);
  const p = new Pipeline(store, { dataDir: dir });
  const started = Date.now();
  const ticker = setInterval(() => {
    const s = p.steps.find(x => x.state === 'running');
    if (s) process.stdout.write('  … ' + s.name + (s.detail ? ': ' + s.detail : '') + '\n');
  }, 15000);
  await p.run({ force: true, only: only.length ? only : null });
  clearInterval(ticker);

  console.log('\nData folder: ' + dir);
  console.log('Took ' + Math.round((Date.now() - started) / 1000) + 's, ' + stats.requests + ' requests, ' + stats.cacheHits + ' from cache, ' + stats.errors + ' errors\n');
  for (const s of p.steps) console.log((s.state === 'done' ? 'OK   ' : s.state.toUpperCase().padEnd(5)) + s.name + ' — ' + s.detail);

  const leads = store.all();
  console.log('\n' + leads.length + ' leads stored');
  for (const src of SOURCES) {
    const mine = leads.filter(l => l.source === src.id).sort((a, b) => (b.score || 0) - (a.score || 0));
    if (!mine.length) continue;
    console.log('\n=== ' + src.label + ' — ' + mine.length + ' leads (' + mine.filter(l => l.status === 'too-late').length + ' too late)');
    for (const l of mine.slice(0, 6)) {
      const c = l.contact || {};
      console.log('  [' + l.score + '] ' + l.name + ' — ' + l.headline);
      console.log('       why: ' + l.signal.label + ' | services: ' + l.services.map(s => s.name).join(', '));
      console.log('       evidence: ' + String(l.signal.quote || '').slice(0, 220));
      console.log('       contact: ' + [c.person, c.email, c.phone, c.website, c.handle].filter(Boolean).join(' | ') + (l.deadline ? ' | closes ' + l.deadline.slice(0, 10) : ''));
      console.log('       source: ' + l.signal.url);
    }
  }
  store.saveNow();
})().catch(err => { console.error(err); process.exit(1); });
