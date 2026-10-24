'use strict';
/* Original dates, out-of-date leads, the UK and Isle of Man focus, and the
 * interface filters that depend on them. No network. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { tempDir, fresh } = require('./helpers');

const DAY = 86400000;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const daysAgo = n => new Date(NOW - n * DAY).toISOString();

function lead(fields) {
  return {
    id: fields.id || 'x:' + Math.random().toString(36).slice(2),
    source: 'reddit', sourceLabel: 'Reddit', kind: 'organisation', name: 'Example', headline: 'h', location: '',
    services: [{ id: 'hr-compliance', name: 'HR' }], contact: {}, facts: [], ref: {}, deadline: null,
    status: 'active', history: [{ status: 'active', at: daysAgo(1), by: 'system', reason: 'Found' }], foundAt: daysAgo(1),
    ...fields,
    signal: { label: 'l', detail: '', quote: '', url: 'https://example.org/evidence', ...fields.signal }
  };
}

test('dates: GOV.UK and Companies House dates and penalty periods parse', () => {
  const { parseDay, parsePeriod } = fresh('freshness.js');
  assert.equal(parseDay('17 August 2022'), '2022-08-17T00:00:00.000Z');
  assert.equal(parseDay('3 Feb 2023'), '2023-02-03T00:00:00.000Z');
  assert.equal(parseDay('not a date'), null);
  assert.deepEqual(parsePeriod('Illegal working civil penalties for UK employers: 1 January to 31 March 2026'),
    { from: '2026-01-01T00:00:00.000Z', to: '2026-03-31T00:00:00.000Z' });
  assert.deepEqual(parsePeriod('1 October 2025 to 31 December 2025'), { from: '2025-10-01T00:00:00.000Z', to: '2025-12-31T00:00:00.000Z' });
  assert.equal(parsePeriod('1 November to 31 January 2026').from, '2025-11-01T00:00:00.000Z', 'a period across new year starts the year before');
});

test('origin: each lead carries the date of the original event, not the date it was found', () => {
  const { originOf } = fresh('freshness.js');
  const post = originOf(lead({ signal: { type: 'post', date: '2026-09-07T13:20:29+00:00' } }));
  assert.equal(post.label, 'Posted');
  assert.equal(post.basis, 'source');

  const tender = originOf(lead({ signal: { type: 'tender', date: daysAgo(0) }, ref: { firstPublished: '2021-09-30T09:36:46+01:00' } }));
  assert.equal(tender.at, '2021-09-30T09:36:46+01:00', 'an amended tender is dated by its first publication');

  const penalty = originOf(lead({ signal: { type: 'penalty', date: '2026-09-09', detail: 'Illegal working civil penalties for UK employers: 1 January to 31 March 2026. Penalty: £45,000.00' } }));
  assert.equal(penalty.at, '2026-09-09', 'the report naming the employer is the published evidence');
  assert.match(penalty.text, /report published 9 September 2026, covering penalties issued between 1 January 2026 and 31 March 2026/);
  assert.equal(originOf(lead({ signal: { type: 'penalty', detail: '1 January to 31 March 2026' } })).at, '2026-03-31T00:00:00.000Z', 'with no report date, the period still dates it');

  const expansion = originOf(lead({ signal: { type: 'sponsor-expansion', date: '2026-10-05' }, company: { incorporated: '17 August 2022', url: 'https://find-and-update.company-information.service.gov.uk/company/1' } }));
  assert.equal(expansion.basis, 'bound');
  assert.match(expansion.text, /incorporated 17 August 2022/);

  const undated = originOf(lead({ signal: { type: 'sponsor-expansion', date: '2026-10-05' } }));
  assert.equal(undated.at, null, 'a register read today is not a licence granted today');
  assert.equal(originOf(lead({ signal: { type: 'sponsor-b', date: '2026-10-05' } })).at, null);
});

test('out of date: old evidence is retired with its date as the reason', () => {
  const { outOfDate } = fresh('freshness.js');
  assert.ok(outOfDate(lead({ signal: { type: 'post', date: daysAgo(31) } }), NOW));
  assert.equal(outOfDate(lead({ signal: { type: 'post', date: daysAgo(29) } }), NOW), null);

  const exp = outOfDate(lead({ signal: { type: 'sponsor-expansion' }, company: { incorporated: '17 August 2022', url: 'https://find-and-update.company-information.service.gov.uk/company/1' } }), NOW);
  assert.match(exp.reason, /17 August 2022/);
  assert.equal(exp.url, 'https://find-and-update.company-information.service.gov.uk/company/1', 'the evidence link is the dated record');
  assert.equal(outOfDate(lead({ signal: { type: 'sponsor-expansion' }, company: { incorporated: '2 September 2026' } }), NOW), null);
  assert.equal(outOfDate(lead({ signal: { type: 'sponsor-expansion' } }), NOW), null, 'no date is never treated as old');

  assert.ok(outOfDate(lead({ signal: { type: 'tender', date: daysAgo(1) }, ref: { firstPublished: '2021-09-30' }, deadline: new Date(NOW + 30 * DAY).toISOString() }), NOW), 'a standing list from 2021 is not a new tender');
  assert.ok(outOfDate(lead({ signal: { type: 'tender', date: daysAgo(100) }, ref: { firstPublished: daysAgo(100) } }), NOW), 'no deadline and over 90 days old');
  assert.equal(outOfDate(lead({ signal: { type: 'tender', date: daysAgo(5) }, ref: { firstPublished: daysAgo(5) } }), NOW), null);

  assert.ok(outOfDate(lead({ signal: { type: 'penalty', date: daysAgo(20), detail: 'for UK employers: 1 January to 31 March 2025' } }), NOW), 'a penalty period over a year old');
  assert.equal(outOfDate(lead({ signal: { type: 'penalty', date: daysAgo(20), detail: 'for UK employers: 1 January to 31 March 2026' } }), NOW), null);
});

test('three-month limit: nothing dated before it is shown, whatever its kind', () => {
  const { tooOld, shown, outOfDate, cutoff } = fresh('freshness.js');
  assert.equal(new Date(cutoff(NOW)).toISOString().slice(0, 10), '2026-07-06', 'three calendar months before today');

  const stale = [
    lead({ signal: { type: 'post', date: '2026-07-01T09:00:00Z' } }),
    lead({ signal: { type: 'tender', date: daysAgo(1) }, ref: { firstPublished: '2026-06-20' }, deadline: new Date(NOW + 30 * DAY).toISOString() }),
    lead({ signal: { type: 'penalty', date: '2026-06-30', detail: '1 January to 31 March 2026' } }),
    lead({ signal: { type: 'sponsor-expansion' }, company: { incorporated: '14 August 2025' } }),
    lead({ signal: { type: 'sponsor-new', date: '2026-05-01' } })
  ];
  for (const l of stale) {
    assert.ok(tooOld(l, NOW), l.signal.type + ' dated before the limit is too old');
    assert.equal(shown(l, NOW), false);
    assert.match(outOfDate(l, NOW).reason, /more than 3 months ago/);
    assert.equal(shown({ ...l, status: 'too-late' }, NOW), false, 'not even in the Too late tab');
  }
  assert.ok(shown({ ...stale[0], status: 'contacted' }, NOW), 'a lead the user contacted stays in Contacted');
  assert.ok(shown({ ...stale[0], status: 'won' }, NOW));

  assert.ok(shown(lead({ signal: { type: 'post', date: '2026-07-10T09:00:00Z' } }), NOW), 'inside the limit');
  assert.ok(shown(lead({ signal: { type: 'sponsor-b', date: '2026-10-05' } }), NOW), 'a B rating on the current register has no older date to judge');
});

test('pipeline: stored leads are corrected at start-up, but never one the user acted on', () => {
  const { Store } = fresh('store.js');
  const { Pipeline } = require(path.join(__dirname, '..', 'src', 'pipeline.js'));
  const dir = tempDir();
  const store = new Store(dir);
  const add = l => { store.upsert(l); return l.id; };
  const oldPost = add(lead({ id: 'reddit:old', kind: 'person', signal: { type: 'post', date: '2022-05-01T10:00:00Z' } }));
  const newPost = add(lead({ id: 'reddit:new', kind: 'person', signal: { type: 'post', date: new Date().toISOString() } }));
  const contacted = add(lead({ id: 'reddit:contacted', kind: 'person', signal: { type: 'post', date: '2022-05-01T10:00:00Z' } }));
  store.setStatus(contacted, 'contacted');
  const kept = add(lead({ id: 'reddit:kept', kind: 'person', signal: { type: 'post', date: '2022-05-01T10:00:00Z' } }));
  store.setStatus(kept, 'too-late', { by: 'system', reason: 'old', evidenceUrl: 'https://example.org' });
  store.setStatus(kept, 'active');
  const striking = add(lead({ id: 'illegal-working:s', source: 'illegal-working', signal: { type: 'penalty', detail: '1 January to 31 March 2026' }, company: { status: 'Active — Active proposal to strike off', url: 'https://find-and-update.company-information.service.gov.uk/company/2' } }));
  const italy = add(lead({ id: 'reddit:italy', kind: 'person', signal: { type: 'post', date: new Date().toISOString() }, services: [{ id: 'italy-digital-nomad', name: 'Italy Digital Nomad visa' }] }));

  new Pipeline(store, { dataDir: dir });
  assert.equal(store.get(oldPost).status, 'too-late');
  assert.match(store.get(oldPost).history.at(-1).reason, /Posted on 1 May 2022/);
  assert.equal(store.get(newPost).status, 'active');
  assert.equal(store.get(contacted).status, 'contacted', 'a lead the user contacted is not aged out');
  assert.equal(store.get(kept).status, 'active', 'a lead the user moved back to Active stays there');
  assert.equal(store.get(striking).status, 'too-late');
  assert.equal(store.get(italy), null, 'a lead resting only on a route outside the UK and Isle of Man is removed');
});

test('store: a looked-up first publication date survives the source sending the lead again', () => {
  const { Store } = fresh('store.js');
  const store = new Store(tempDir());
  const base = lead({ id: 'find-a-tender:1', signal: { type: 'tender', date: daysAgo(0) }, ref: { ocid: 'ocds-1', firstPublished: null } });
  store.upsert(base);
  store.patch(base.id, { ref: { ocid: 'ocds-1', firstPublished: '2026-09-09T09:35:03+01:00' } });
  store.upsert({ ...base, ref: { ocid: 'ocds-1', firstPublished: null } });
  assert.equal(store.get(base.id).ref.firstPublished, '2026-09-09T09:35:03+01:00');
});

test('tenders: an update or amendment is not taken as the first publication', () => {
  const { firstPublishedIn } = fresh('sources/tenders.js');
  assert.equal(firstPublishedIn({ tag: ['tender'], date: '2026-09-09T09:35:03+01:00' }), '2026-09-09T09:35:03+01:00');
  assert.equal(firstPublishedIn({ tag: ['tenderUpdate'], date: '2026-10-02T12:12:50+01:00' }), null);
  assert.equal(firstPublishedIn({ tag: ['tenderAmendment'], date: '2026-10-05', tender: { datePublished: '2021-09-30T09:36:46+01:00' } }), '2021-09-30T09:36:46+01:00');
});

test('companies: a number written into a register entry is read, a year in a name is not', () => {
  const ch = fresh('enrich/companies-house.js');
  assert.equal(ch.numberIn('Lemas Real Estate UK Ltd 15362523'), '15362523');
  assert.equal(ch.numberIn('EXAMPLE UK LIMITED (15373821)'), '15373821');
  assert.equal(ch.numberIn('EXAMPLE CONSULTANTS UK LTD-14648180'), '14648180');
  assert.equal(ch.numberIn('Example Ltd (SC123456)'), 'SC123456');
  assert.equal(ch.numberIn('Example 2020 Ltd'), null);
  assert.ok(ch.isClosed('Active — Active proposal to strike off'));
  assert.ok(!ch.isClosed('Active'));
});

test('focus: leads come only from the UK and the Isle of Man', () => {
  const { assessPost } = fresh('intent.js');
  assert.equal(assessPost({ title: 'Italy Digital Nomad Visa', body: 'How do I apply for the Italy digital nomad visa?', community: 'r/UAE' }).ok, false);
  assert.equal(assessPost({ title: 'Global Talent visa: how long does it take?', body: 'Can I apply for the Global Talent visa as a researcher?', community: 'r/AusVisa' }).ok, false, 'Australia had a Global Talent visa too');
  assert.equal(assessPost({ title: 'Global Talent visa: how do I apply?', body: 'Can I apply for the Global Talent visa as a researcher?', community: 'r/ukvisa' }).ok, true);
  assert.equal(assessPost({ title: 'Moving my business to the Isle of Man', body: 'How do I set up a company in the Isle of Man and get a work permit?', community: 'r/IsleOfMan' }).ok, true);
});

/* ---------- interface ---------- */

function loadInterface(leads, values = {}) {
  const els = new Map();
  const get = sel => {
    if (!els.has(sel)) els.set(sel, { id: sel, innerHTML: '', textContent: '', value: values[sel] || '', hidden: false, dataset: {}, options: [{ outerHTML: '<option value="">All</option>' }], classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, scrollIntoView() {} });
    return els.get(sel);
  };
  const sandbox = {
    console, URL, setTimeout: () => 0, clearTimeout: () => {},
    window: { matchMedia: () => ({ matches: false }) }, navigator: {},
    fetch: async () => ({ ok: true, json: async () => ({ leads, counts: {}, pipeline: { steps: [] }, sources: [], services: [] }) }),
    document: { querySelector: get, querySelectorAll: () => [], addEventListener() {}, createElement: () => get('a'), body: get('body') }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8') + '\n;this.__ = { state, renderList, renderDetail, filtered };', sandbox);
  sandbox.__.state.leads = leads;
  sandbox.__.state.services = [{ id: 'hr-compliance', name: 'HR compliance' }, { id: 'global-talent', name: 'Global Talent' }];
  sandbox.__.state.sources = [{ id: 'reddit', label: 'Reddit' }, { id: 'find-a-tender', label: 'Find a Tender' }];
  return { api: sandbox.__, get };
}

const UI_LEADS = [
  lead({ id: 'a', source: 'reddit', kind: 'person', score: 60, signal: { type: 'post', date: daysAgo(2) }, services: [{ id: 'global-talent', name: 'Global Talent' }], origin: { at: new Date(Date.now() - 2 * DAY).toISOString(), label: 'Posted', text: 'Posted recently', basis: 'source' } }),
  lead({ id: 'b', source: 'find-a-tender', score: 90, signal: { type: 'tender', date: daysAgo(1) }, deadline: new Date(Date.now() + 9 * DAY).toISOString(), origin: { at: new Date(Date.now() - 200 * DAY).toISOString(), label: 'Tender first published', text: 'Tender first published', basis: 'source' } }),
  lead({ id: 'c', source: 'find-a-tender', score: 80, signal: { type: 'tender', date: daysAgo(1) }, origin: { at: null, text: 'Date not published', basis: 'none' } })
];

test('interface: cards show the original date, and "most recent" sorts by it', () => {
  const { api, get } = loadInterface(UI_LEADS, { '#f-sort': 'newest' });
  api.renderList();
  assert.match(get('#list').innerHTML, /Posted \d+ \w+ \d{4}/);
  assert.match(get('#list').innerHTML, /Date not published/);
  assert.deepEqual(api.filtered().map(l => l.id), ['a', 'b', 'c'], 'newest original date first, undated last, whatever the date found');
});

test('interface: closing-soonest sort puts leads without a deadline last', () => {
  const { api } = loadInterface(UI_LEADS, { '#f-sort': 'deadline' });
  assert.deepEqual(api.filtered().map(l => l.id), ['b', 'c', 'a'], 'no deadline sorts last, then by score');
});

test('interface: the age filter uses the original date and quick-view counts follow the filters', () => {
  const { api, get } = loadInterface(UI_LEADS, { '#f-age': '30' });
  assert.deepEqual(api.filtered().map(l => l.id), ['a'], 'a tender first published 200 days ago is not "last 30 days" because it was found yesterday');
  api.renderList();
  assert.match(get('#views').innerHTML, /Actively looking<span>1</, 'the view count matches the filtered list');

  const none = loadInterface(UI_LEADS, { '#f-age': 'none' });
  assert.deepEqual(none.api.filtered().map(l => l.id), ['c']);
});

test('interface: service and source lists offer only what the tab holds', () => {
  const { api, get } = loadInterface(UI_LEADS);
  api.renderList();
  const services = get('#f-service').innerHTML;
  assert.match(services, /Global Talent \(1\)/);
  assert.match(services, /HR compliance \(2\)/);
  assert.match(get('#f-source').innerHTML, /Find a Tender \(2\)/);
  const before = get('#f-service').innerHTML;
  api.renderList();
  assert.equal(get('#f-service').innerHTML, before, 'unchanged options are not rebuilt');
});

test('interface: a lead opens its evidence by name and offers every published way to reach them', () => {
  const tender = lead({ id: 't', source: 'find-a-tender', sourceLabel: 'Find a Tender', headline: 'Business support framework', signal: { type: 'tender', date: daysAgo(1), url: 'https://www.find-tender.service.gov.uk/Notice/1' },
    links: [{ url: 'https://www.find-tender.service.gov.uk/Notice/1', label: 'Open the tender on Find a Tender' }],
    contact: { person: 'Ann Buyer', email: 'ann@council.gov.uk', phone: '+44 (0)20 7946 0000', website: 'https://council.gov.uk' } });
  const post = lead({ id: 'p', kind: 'person', source: 'reddit', signal: { type: 'post', date: daysAgo(1), url: 'https://www.reddit.com/r/ukvisa/comments/abc/x/' },
    links: [{ url: 'https://www.reddit.com/r/ukvisa/comments/abc/x/', label: 'Open the post on Reddit' }],
    contact: { handle: 'u/founder', profileUrl: 'https://www.reddit.com/user/founder' } });
  const { api, get } = loadInterface([tender, post]);
  api.state.leads = [tender, post];

  api.state.selected = 't';
  api.renderDetail();
  const t = get('#detail').innerHTML;
  assert.match(t, /Open the tender on Find a Tender/);
  assert.doesNotMatch(t, /Open the source/);
  assert.match(t, /href="mailto:ann@council\.gov\.uk\?subject=Re%3A%20Business%20support%20framework"/);
  assert.match(t, /href="tel:\+4402079460000"/);
  assert.match(t, />Email Ann</);

  api.state.selected = 'p';
  api.renderDetail();
  const p = get('#detail').innerHTML;
  assert.match(p, /Open the post on Reddit/);
  assert.match(p, /Reply on Reddit/);
  assert.match(p, /View u\/founder/);
  assert.doesNotMatch(p, /mailto:/, 'people are reached only where they posted');
});

test('links: sponsor leads open the register page and Companies House, not the CSV download', () => {
  const { evidenceLinks } = fresh('lead.js');
  const links = evidenceLinks(lead({ source: 'sponsor-register', sourceLabel: 'Sponsor register', signal: { type: 'sponsor-b', url: 'https://assets.publishing.service.gov.uk/media/x/register.csv' }, company: { url: 'https://find-and-update.company-information.service.gov.uk/company/1' } }));
  assert.deepEqual(links.map(l => l.label), ['Open on Companies House', 'Sponsor register on GOV.UK']);
  assert.ok(links.every(l => !/\.csv$/.test(l.url)));
  assert.equal(evidenceLinks(lead({ source: 'illegal-working', signal: { type: 'penalty', url: 'https://www.gov.uk/r' } }))[0].label, 'Open the Home Office report');
});
