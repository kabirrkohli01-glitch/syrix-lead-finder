'use strict';
/* Runs the interface script against a minimal stand-in for the page, so the
 * rendering code is exercised without opening a browser. Catches runtime
 * errors in rendering, broken markup and unescaped text. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

function element(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', hidden: false, dataset: {}, options: [{ outerHTML: '<option value="">All</option>' }],
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, scrollIntoView() {}, appendChild() {}, remove() {}, click() {}
  };
}

function loadInterface(leads) {
  const els = new Map();
  const get = sel => { if (!els.has(sel)) els.set(sel, element(sel)); return els.get(sel); };
  const sandbox = {
    console,
    URL,
    setTimeout: () => 0,
    clearTimeout: () => {},
    window: { matchMedia: () => ({ matches: false }), location: {} },
    navigator: {},
    fetch: async () => ({ ok: true, json: async () => ({ leads, counts: {}, pipeline: { steps: [] }, sources: [], services: [] }) }),
    document: {
      querySelector: get,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => element('a'),
      body: element('body')
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE + '\n;this.__ = { state, renderList, renderDetail, esc };', sandbox);
  return { api: sandbox.__, get };
}

/* Every opened tag that needs closing is closed, in order. */
function balanced(html) {
  const voids = new Set(['br', 'img', 'input', 'hr', 'meta', 'link']);
  const stack = [];
  for (const m of html.matchAll(/<\/?([a-z0-9]+)[^>]*>/gi)) {
    const tag = m[1].toLowerCase();
    if (voids.has(tag)) continue;
    if (m[0][1] === '/') { if (stack.pop() !== tag) return false; }
    else stack.push(tag);
  }
  return stack.length === 0;
}

const LEADS = [
  {
    id: 'find-a-tender:1', source: 'find-a-tender', sourceLabel: 'Find a Tender', kind: 'organisation', status: 'active',
    name: 'Example <Council> & "Partners"', headline: 'Tender: Market research', location: 'Town, AB1 2CD', score: 88, scoreReasons: ['An organisation has published a request for suppliers'],
    signal: { type: 'tender', label: 'Is inviting suppliers to bid', detail: 'Market research', quote: 'We need <b>research</b>', date: new Date().toISOString(), url: 'https://www.find-tender.service.gov.uk/Notice/1' },
    services: [{ id: 'market-research', name: 'Market research', quote: 'market research' }],
    contact: { person: 'A Buyer', email: 'buyer@example.gov.uk', phone: '+44 1234 567890', website: 'https://example.gov.uk', provenance: 'https://www.find-tender.service.gov.uk/Notice/1', sources: {} },
    facts: [{ label: 'Estimated value', value: '£40,000' }], deadline: new Date(Date.now() + 5 * 86400000).toISOString(),
    history: [{ status: 'active', at: new Date().toISOString(), by: 'system', reason: 'Found by Find a Tender' }], notes: '', foundAt: new Date().toISOString()
  },
  {
    id: 'reddit:2', source: 'reddit', sourceLabel: 'Reddit', kind: 'person', status: 'too-late',
    name: 'u/founder', headline: 'Innovator Founder help', location: '', score: 70, scoreReasons: [],
    signal: { type: 'post', intent: 'explicit', label: 'Is looking for professional help', detail: 'x', quote: 'need help', date: new Date().toISOString(), url: 'javascript:alert(1)' },
    services: [], contact: { handle: 'u/founder', profileUrl: 'https://www.reddit.com/user/founder', channel: 'Reply on the post' }, facts: [],
    history: [{ status: 'too-late', at: new Date().toISOString(), by: 'system', reason: 'The author said in the thread that the need has passed', evidenceUrl: 'https://www.reddit.com/r/x', quote: 'my visa was approved' }], notes: 'n', foundAt: new Date().toISOString()
  }
];

test('interface: list and detail render, escape text and refuse unsafe links', () => {
  const { api, get } = loadInterface(LEADS);
  api.state.leads = LEADS;
  api.state.status = 'active';
  api.renderList();
  const list = get('#list').innerHTML;
  assert.match(list, /1 lead/);
  assert.match(list, /Example &lt;Council&gt; &amp; &quot;Partners&quot;/);
  assert.ok(balanced(list), 'list markup is balanced');

  api.state.selected = 'find-a-tender:1';
  api.renderDetail();
  const detail = get('#detail').innerHTML;
  assert.ok(balanced(detail), 'detail markup is balanced');
  assert.match(detail, /mailto:buyer@example\.gov\.uk/);
  assert.match(detail, /We need &lt;b&gt;research&lt;\/b&gt;/);
  assert.match(detail, /Deadline/);

  api.state.status = 'too-late';
  api.state.selected = 'reddit:2';
  api.renderDetail();
  const tooLate = get('#detail').innerHTML;
  assert.ok(balanced(tooLate));
  assert.match(tooLate, /Too late:/);
  assert.match(tooLate, /my visa was approved/);
  assert.doesNotMatch(tooLate, /href="javascript:/i, 'a javascript: URL must never become a link');
});

test('interface: an empty view explains what to do', () => {
  const { api, get } = loadInterface([]);
  api.state.leads = [];
  api.renderList();
  assert.match(get('#list').innerHTML, /Find leads now/);
});
