'use strict';
/* Live check of SYRIX against the real gateway and the leads in data/.
 * Opens no window. Makes real model calls, so run it once, not in a loop.
 *
 *   node tests/syrix-live.js                 the standard conversation
 *   node tests/syrix-live.js "question" ...  your own questions, in order
 */

const path = require('node:path');
const { setCacheDir } = require('../src/http');
const { Store } = require('../src/store');
const { Pipeline } = require('../src/pipeline');
const gateway = require('../src/syrix/gateway');
const chat = require('../src/syrix/chat');

const DATA = path.join(__dirname, '..', 'data');
const QUESTIONS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'hi',
  'Which companies need help with their sponsor licence?',
  'Which of those have an email address or phone number?',
  'Is it legal for the consultancy to email these companies about compliance training?',
  'Are there any people looking for help with a Global Talent visa?'
];

(async () => {
  setCacheDir(path.join(DATA, 'cache'));
  gateway.setDataDir(DATA);
  const store = new Store(DATA);
  const pipeline = new Pipeline(store, { dataDir: DATA });
  const ctx = { store, pipeline };
  const history = [];

  for (const q of QUESTIONS) {
    const started = Date.now();
    history.push({ role: 'user', content: q });
    const steps = [];
    const r = await chat.answer(ctx, { history, onStep: s => { if (s.state === 'running') steps.push(s.label); } });
    history.push({ role: 'assistant', content: r.text });
    console.log('\n> ' + q + '   (' + ((Date.now() - started) / 1000).toFixed(1) + 's)');
    console.log('  steps: ' + steps.join(' → '));
    console.log(r.text.split('\n').map(l => '  ' + l).join('\n'));
  }

  const sample = [
    store.all().find(l => l.signal.type === 'sponsor-b' && l.contact && l.contact.email),
    store.all().find(l => l.signal.type === 'tender'),
    store.all().find(l => l.kind === 'person')
  ].filter(Boolean);
  for (const lead of sample) {
    const started = Date.now();
    const text = await chat.overview(lead);
    console.log('\n[overview] ' + lead.name + '   (' + ((Date.now() - started) / 1000).toFixed(1) + 's)');
    console.log(text.split('\n').map(l => '  ' + l).join('\n'));
  }
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
