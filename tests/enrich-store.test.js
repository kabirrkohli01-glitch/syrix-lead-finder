'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fresh, tempDir } = require('./helpers');

test('Companies House: search results and officers parse from the public pages', () => {
  const ch = fresh('enrich/companies-house.js');
  const search = '<ul id="results" class="results-list"><li class="type-company"><h3><a class="govuk-link" href="/company/15391457" title="View company"> ERDINGTON STORE LTD </a></h3><p class="meta crumbtrail"> 15391457 - Incorporated on 5 January 2024 </p><p>210 High Street, Erdington, Birmingham, United Kingdom, B23 6SJ</p></li></ul>';
  const r = ch.parseSearch(search);
  assert.deepEqual(r[0], { number: '15391457', name: 'ERDINGTON STORE LTD', meta: '15391457 - Incorporated on 5 January 2024', address: '210 High Street, Erdington, Birmingham, United Kingdom, B23 6SJ' });
  const officers = '<div class="appointment-1"><h2><span id="officer-name-1"><a href="#">RASUL, Kochar</a></span></h2><dt>Role <span id="officer-status-tag-1" class="status-tag">Active</span></dt><dd id="officer-role-1" class="data"> Director </dd><dd id="officer-nationality-1" class="data"> British </dd><dd id="officer-country-of-residence-1" class="data"> England </dd></div>' +
    '<div class="appointment-2"><h2><span id="officer-name-2"><a href="#">GONE, Person</a></span></h2><dt>Role <span id="officer-status-tag-2" class="status-tag">Resigned</span></dt><dd id="officer-role-2" class="data"> Director </dd></div>';
  const o = ch.parseOfficers(officers);
  assert.equal(o.length, 1);
  assert.equal(o[0].name, 'Kochar Rasul');
  assert.equal(o[0].residence, 'England');
});

test('Companies House: a name match needs the place to agree, and ambiguity is refused', () => {
  const { choose } = fresh('enrich/companies-house.js');
  const results = [
    { number: '1', name: 'ACME LTD', meta: '1 - Incorporated', address: '1 Road, Leeds, LS1 1AA' },
    { number: '2', name: 'ACME LIMITED', meta: '2 - Incorporated', address: '2 Road, York, YO1 1AA' },
    { number: '3', name: 'ACME TRADING LTD', meta: '3', address: 'Leeds' }
  ];
  assert.equal(choose(results, { name: 'Acme Ltd', town: 'York' }).number, '2');
  assert.equal(choose(results, { name: 'Acme Ltd', postcode: 'LS1 1AA' }).number, '1');
  assert.equal(choose(results, { name: 'Acme Ltd' }), null, 'two live companies with the name and no place: no guess');
  assert.equal(choose(results, { name: 'Acme Ltd', town: 'Bristol' }), null);
});

test('Companies House: Group and a bracketed place make a different company; live beats dissolved', () => {
  const { choose } = fresh('enrich/companies-house.js');
  const results = [
    { number: '06607875', name: 'EXCELLENCE CARE LTD', meta: '06607875 - Incorporated on 2 June 2008', address: 'Unit 1, Ipswich, IP1 1AA' },
    { number: '16934022', name: 'EXCELLENCE CARE GROUP LIMITED', meta: 'Incorporated', address: 'London' },
    { number: '12415637', name: 'EXCELLENCE CARE (OXFORD) LIMITED', meta: 'Incorporated', address: 'Oxford' }
  ];
  assert.equal(choose(results, { name: 'EXCELLENCE CARE LTD', town: 'Colchester' }).number, '06607875');
  const namesakes = [
    { number: '00000101', name: 'EXAMPLE ADVISORY LIMITED', meta: '00000101 - Dissolved on 17 January 2017', address: '1 Street, London, E1 1AA' },
    { number: '00000202', name: 'EXAMPLE ADVISORY LTD', meta: '00000202 - Incorporated on 15 October 2019', address: 'Office, Reading, RG1 1AA' }
  ];
  assert.equal(choose(namesakes, { name: 'Example Advisory Ltd', town: 'London' }).number, '00000202');
});

test('website: a site must prove it belongs to the organisation', () => {
  const w = fresh('enrich/website.js');
  assert.match(w.proves('Erdington Store Ltd. Company registration number 15391457.', { name: 'Erdington Store Ltd', number: '15391457' }), /Companies House number/);
  assert.match(w.proves('Visit us at 210 High Street, B23 6SJ', { name: 'X', postcode: 'B23 6SJ' }), /Postcode/);
  assert.equal(w.proves('A different business in Leeds', { name: 'Erdington Store Ltd', town: 'Birmingham', postcode: 'B23 6SJ', number: '15391457' }), null);
  assert.equal(w.isDirectory('www.yell.com'), true);
  assert.equal(w.isDirectory('birmingham.cylex-uk.co.uk'), true);
  assert.equal(w.isDirectory('erdingtonstores.co.uk'), false);
});

test('website: only the site\'s own or personal-mailbox emails, and valid UK phone numbers', () => {
  const w = fresh('enrich/website.js');
  const html = '<a href="mailto:info@acme.co.uk">Email</a> sales@acme.co.uk owner@gmail.com someone@othercompany.com image@2x.png noreply@acme.co.uk <a href="tel:+44 (0)113 496 0000">call</a> 0113 496 0001 00000000000';
  assert.deepEqual(w.extractEmails(html, 'www.acme.co.uk').sort(), ['info@acme.co.uk', 'owner@gmail.com', 'sales@acme.co.uk']);
  assert.deepEqual(w.extractPhones(html), ['0113 496 0000', '0113 496 0001']);
});

function sample(id = 'x:1', kind = 'organisation') {
  return { id, source: 'x', sourceLabel: 'X', kind, name: 'N', headline: 'H', signal: { type: 'tender', label: 'L', url: 'https://e' }, services: [], contact: { email: 'a@b.c' }, facts: [] };
}

test('store: refreshing a lead keeps the user\'s status and notes', () => {
  const { Store } = fresh('store.js');
  const s = new Store(tempDir());
  s.upsert(sample());
  s.setStatus('x:1', 'contacted');
  s.setNotes('x:1', 'Called on Monday');
  s.upsert({ ...sample(), headline: 'New headline' });
  const l = s.get('x:1');
  assert.equal(l.status, 'contacted');
  assert.equal(l.notes, 'Called on Monday');
  assert.equal(l.headline, 'New headline');
  s.saveNow();
});

test('store: the system can only mark too late, only with evidence, and never over won or dismissed', () => {
  const { Store } = fresh('store.js');
  const s = new Store(tempDir());
  s.upsert(sample('x:1'));
  s.upsert(sample('x:2'));
  assert.throws(() => s.setStatus('x:1', 'won', { by: 'system', reason: 'r', evidenceUrl: 'u' }));
  assert.throws(() => s.setStatus('x:1', 'too-late', { by: 'system', reason: 'closed' }), /evidence/);
  assert.throws(() => s.setStatus('x:1', 'too-late', { by: 'user' }), /Only the system/);
  s.setStatus('x:2', 'won');
  s.setStatus('x:2', 'too-late', { by: 'system', reason: 'closed', evidenceUrl: 'https://e' });
  assert.equal(s.get('x:2').status, 'won');
  s.setStatus('x:1', 'too-late', { by: 'system', reason: 'closed', evidenceUrl: 'https://e', quote: 'q' });
  const h = s.get('x:1').history.at(-1);
  assert.deepEqual([h.status, h.by, h.evidenceUrl, h.quote], ['too-late', 'system', 'https://e', 'q']);
  s.saveNow();
});

test('store: people past their retention window are deleted and not re-added', () => {
  const { Store } = fresh('store.js');
  const s = new Store(tempDir());
  s.upsert(sample('r:1', 'person'));
  s.setStatus('r:1', 'dismissed', {}, new Date(Date.now() - 31 * 86400000).toISOString());
  assert.equal(s.purge(), 1);
  assert.equal(s.get('r:1'), null);
  assert.equal(s.upsert(sample('r:1', 'person')).lead, null);
  s.saveNow();
});
