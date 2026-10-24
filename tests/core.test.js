'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fresh } = require('./helpers');

const text = fresh('text.js');
const { matchServices, matchCpv } = fresh('services.js');
const { assessPost, resolvedQuote } = fresh('intent.js');
const { score } = fresh('score.js');

test('CSV parser handles quoted commas, escaped quotes and CRLF', () => {
  const rows = text.parseCsv('Organisation Name,Town/City\r\n"Smith, Jones & Co ""UK"" Ltd",London\r\nPlain Ltd,Leeds\r\n');
  assert.deepEqual(rows, [['Organisation Name', 'Town/City'], ['Smith, Jones & Co "UK" Ltd', 'London'], ['Plain Ltd', 'Leeds']]);
});

test('company names compare loosely but never merge different firms', () => {
  assert.equal(text.nameKey('ERDINGTON STORE LTD'), text.nameKey('Erdington Store Limited'));
  assert.equal(text.nameKey('The Original Karahi House Ltd'), text.nameKey('ORIGINAL KARAHI HOUSE LIMITED (THE)'));
  assert.notEqual(text.nameKey('Erdington Store Ltd'), text.nameKey('Erdington Stores Ltd'));
  assert.equal(text.registeredPart('Reading Hotel Operating Company Ltd T/A Ibis Styles Reading'), 'Reading Hotel Operating Company Ltd');
});

test('quoteAround returns the sentence containing the match', () => {
  const t = 'Hello there. I am looking for a consultant to help with my Innovator Founder plan. Thanks!';
  const i = t.indexOf('looking');
  assert.equal(text.quoteAround(t, i, 7), 'I am looking for a consultant to help with my Innovator Founder plan.');
});

test('service patterns match stems inside longer words', () => {
  const ids = matchServices('We need management consultancy support and a feasibility study.').map(s => s.id);
  assert.ok(ids.includes('corporate-support'), 'consultancy must match the consultan stem');
  assert.ok(ids.includes('market-research'));
});

test('"it support" in ordinary English is not an IT services lead', () => {
  assert.deepEqual(matchServices('Does it support my case?').map(s => s.id), []);
});

test('training CPV codes need a the consultancy subject in the text', () => {
  const [t] = matchCpv('80500000');
  assert.equal(t.id, 'training');
  assert.equal(t.needsText, true);
});

test('a person asking for help with an Innovator Founder plan is a lead', () => {
  const r = assessPost({ title: 'Looking for a consultant for Innovator Founder business plan', body: 'I want to apply next month and need help with the endorsement.' });
  assert.equal(r.ok, true);
  assert.equal(r.intent, 'explicit');
  assert.ok(r.services.some(s => s.id === 'innovator-founder'));
  assert.match(r.quote, /consultant/i);
});

test('a worker asking about their own CoS is not a sponsor licence lead', () => {
  const r = assessPost({ title: 'My CoS was assigned, what next?', body: 'My employer has a sponsor licence and assigned my CoS yesterday. How long does the visa take?' });
  assert.equal(r.ok, false);
});

test('an employer asking how to get a sponsor licence is a lead', () => {
  const r = assessPost({ title: 'How do I apply for a sponsor licence?', body: 'I am the director of a small care company and we want to sponsor two carers.' });
  assert.equal(r.ok, true);
  assert.ok(r.services.some(s => s.id === 'sponsor-licence'));
});

test('job seekers, sellers and success stories are rejected', () => {
  assert.equal(assessPost({ title: 'Looking for a job with companies that sponsor', body: 'Any company that can sponsor a skilled worker visa? I need a sponsor licence holder.' }).ok, false);
  assert.equal(assessPost({ title: 'Global Talent visa help', body: 'We offer Global Talent endorsement support, DM me for a free consultation.' }).ok, false);
  assert.equal(assessPost({ title: 'Approved! Global Talent endorsement timeline', body: 'Sharing my timeline for others.' }).ok, false);
});

test('sellers, profile posts, US routes and existing-visa paperwork are not leads (real post shapes)', () => {
  assert.equal(assessPost({ title: 'Been doing UAE business setups for years, here if anyone needs a hand', body: 'Need PRO services? Free zone or mainland company setup.' }).ok, false);
  assert.equal(assessPost({ title: 'IMS GLOBAL CONSULTANCY', body: 'We help entrepreneurs planning to set up a company in Dubai.' }).ok, false);
  assert.equal(assessPost({ title: 'Does UK ILR really move to 10 years?', body: 'Innovator Founder and Global Talent holders ask me this.', community: 'r/u/someagency' }).ok, false);
  assert.equal(assessPost({ title: 'How many O1-A applicants game the system?', body: 'Self-sponsorship through your own company for an O-1 needs recommendation letters.' }).ok, false);
  assert.equal(assessPost({ title: 'Global Talent ILR – how can I prove English?', body: 'How do I show this?' }).ok, false);
  assert.equal(assessPost({ title: 'Global Talent Visa (GTV) Extention', body: 'What expiry date should I enter?' }).ok, false);
  assert.equal(assessPost({ title: 'Global Talent Approved - Overall Experience', body: 'Sharing for others.' }).ok, false);
});

test('a post that only mentions a service in passing is not a lead for it', () => {
  const body = 'My flatmate\'s boyfriend keeps turning up. He is here on a global talent visa apparently. ' + 'We have asked him to stop many times and he ignores us. '.repeat(8) + 'Should I report him to the police?';
  assert.equal(assessPost({ title: 'Should I report my flatmate\'s boyfriend?', body }).ok, false);
});

test('a question about a dependant on an existing visa is not a lead', () => {
  assert.equal(assessPost({ title: 'GTV dependent for child born in India', body: 'Can I apply GTV dependent for her?' }).ok, false);
  assert.equal(assessPost({ title: 'Switching from Dependant Visa to Self-Sponsorship Through New Company', body: 'How do I set this up?' }).ok, true);
});

test('a passing mention of marketing is not a lead; asking for an agency is', () => {
  assert.equal(assessPost({ title: 'How is everyone finding marketing strategy this year?', body: 'Just chatting.' }).ok, false);
  const r = assessPost({ title: 'Can anyone recommend a marketing agency?', body: 'We need a marketing strategy for our new shop in Leeds.' });
  assert.equal(r.ok, true);
});

test('resolution wording from the author is detected and quoted', () => {
  assert.match(resolvedQuote('Update: thanks all, my visa was approved yesterday.'), /visa was approved/);
  assert.match(resolvedQuote('We have hired a consultant now, thank you.'), /hired/);
  assert.equal(resolvedQuote('Still waiting to hear back.'), null);
});

test('score explains itself and penalises tenders closing within two days', () => {
  const lead = { signal: { type: 'tender', date: new Date().toISOString() }, services: [{ id: 'a' }], contact: { email: 'x@y.gov.uk' }, deadline: new Date(Date.now() + 86400000).toISOString() };
  const r = score(lead);
  assert.ok(r.reasons.some(x => /under 2 days/.test(x)));
  assert.ok(r.score < 70);
});
