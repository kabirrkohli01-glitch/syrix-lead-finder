'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withFakeHttp, fresh, tempDir } = require('./helpers');

const FUTURE = new Date(Date.now() + 20 * 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

function release({ ocid = 'ocds-1', title, description = '', cpv, end = FUTURE, status = 'active' }) {
  return {
    ocid, id: ocid + '-1', date: new Date().toISOString(), tag: ['tender'],
    tender: { title, description, status, classification: { id: cpv, description: 'x' }, tenderPeriod: { endDate: end }, value: { amount: 40000, currency: 'GBP' }, documents: [{ documentType: 'tenderNotice', url: 'https://www.contractsfinder.service.gov.uk/Notice/abc' }] },
    buyer: { id: 'B1', name: 'Example Council' },
    parties: [{ id: 'B1', name: 'Example Council', roles: ['buyer'], contactPoint: { name: 'A Buyer', email: 'Buyer@Example.gov.uk', telephone: '+44 1234 567890' }, address: { streetAddress: '1 High St', locality: 'Town', postalCode: 'AB1 2CD' }, details: { url: 'https://example.gov.uk' } }]
  };
}

test('tenders: a market research tender becomes a lead with the published buyer contact', () => {
  const { toLead } = fresh('sources/tenders.js');
  const lead = toLead('contracts-finder', release({ title: 'Market research for town centre', cpv: '79310000' }));
  assert.ok(lead);
  assert.equal(lead.name, 'Example Council');
  assert.equal(lead.contact.email, 'buyer@example.gov.uk');
  assert.equal(lead.contact.person, 'A Buyer');
  assert.ok(lead.services.some(s => s.id === 'market-research'));
  assert.equal(lead.signal.url, 'https://www.contractsfinder.service.gov.uk/Notice/abc');
});

test('tenders: construction, closed and description-only matches are not leads', () => {
  const { toLead } = fresh('sources/tenders.js');
  assert.equal(toLead('contracts-finder', release({ title: 'Flat conversion', cpv: '45000000' })), null);
  assert.equal(toLead('contracts-finder', release({ title: 'Market research', cpv: '79310000', end: PAST })), null);
  assert.equal(toLead('contracts-finder', release({ title: 'Road resurfacing', description: 'Contractor must provide project management services.', cpv: '45233000' })), null);
  assert.equal(toLead('contracts-finder', release({ title: 'First aid courses', cpv: '80500000' })), null, 'training code without a the consultancy subject');
  assert.ok(toLead('contracts-finder', release({ title: 'Cyber security training programme', cpv: '80500000' })));
});

test('tenders: a cancelled notice is reported as ended, awards are matched by ocid', async () => {
  const fake = withFakeHttp({
    'stages=tender': { releases: [release({ ocid: 'ocds-9', title: 'Business support programme', cpv: '79410000', status: 'cancelled' })], links: {} },
    'stages=award': { releases: [{ ocid: 'ocds-7', id: 'x', awards: [{ date: '2026-10-01', suppliers: [{ name: 'Rival Ltd' }], documents: [{ url: 'https://www.contractsfinder.service.gov.uk/Notice/award' }] }] }], links: {} }
  });
  const tenders = fake.load('sources/tenders.js');
  const r = await tenders.collect('contracts-finder', { days: 3 });
  assert.equal(r.leads.length, 0);
  assert.equal(r.ended[0].ocid, 'ocds-9');
  const awards = await tenders.recentAwards('contracts-finder', { days: 30 });
  assert.match(awards.get('ocds-7').reason, /Rival Ltd/);
});

const REGISTER_HEAD = 'Organisation Name,Town/City,County,Type & Rating,Route\n';
function registerCsv(rows) {
  const filler = [];
  for (let i = 0; i < 10001; i++) filler.push('Filler ' + i + ' Ltd,Leeds,,Worker (A rating),Skilled Worker');
  return REGISTER_HEAD + rows.concat(filler).join('\n');
}

test('sponsor register: B ratings and Expansion Worker sponsors are leads; first run is only a baseline', async () => {
  const dir = tempDir();
  const csv = registerCsv([
    '"Smith, Jones Ltd",London,,Worker (B rating),Skilled Worker',
    'Overseas Co UK Ltd,Manchester,,Worker (A rating),Global Business Mobility: UK Expansion Worker'
  ]);
  const fake = withFakeHttp({
    'register-of-licensed-sponsors-workers': { details: { attachments: [{ url: 'https://assets.publishing.service.gov.uk/media/x/Register_-_2026-10-05.csv', content_type: 'text/csv' }] } },
    'Register_-_2026-10-05.csv': csv
  });
  const sponsors = fake.load('sources/sponsors.js');
  const r = await sponsors.collect({ dataDir: dir });
  assert.equal(r.baseline, true);
  const types = r.leads.map(l => l.signal.type).sort();
  assert.deepEqual(types, ['sponsor-b', 'sponsor-expansion']);
  assert.equal(r.leads.find(l => l.signal.type === 'sponsor-b').name, 'Smith, Jones Ltd');
  assert.ok(fs.existsSync(path.join(dir, 'sponsor-register.json')));
});

test('sponsor register: the next register reports new and removed sponsors without inventing a reason', async () => {
  const dir = tempDir();
  const day1 = registerCsv(['Old Firm Ltd,York,,Worker (A rating),Skilled Worker']);
  const day2 = registerCsv(['New Firm Ltd,Hull,,Worker (A rating),Skilled Worker']);
  let file = '2026-10-04';
  const fake = withFakeHttp({
    'register-of-licensed-sponsors-workers': () => ({ details: { attachments: [{ url: 'https://assets.publishing.service.gov.uk/media/x/Register_-_' + file + '.csv', content_type: 'text/csv' }] } }),
    'Register_-_2026-10-04.csv': day1,
    'Register_-_2026-10-05.csv': day2
  });
  const sponsors = fake.load('sources/sponsors.js');
  await sponsors.collect({ dataDir: dir });
  file = '2026-10-05';
  const r = await sponsors.collect({ dataDir: dir });
  assert.equal(r.baseline, false);
  const added = r.leads.find(l => l.signal.type === 'sponsor-new');
  const removed = r.leads.find(l => l.signal.type === 'sponsor-removed');
  assert.equal(added.name, 'New Firm Ltd');
  assert.equal(removed.name, 'Old Firm Ltd');
  assert.match(removed.signal.detail, /does not say whether the licence was revoked, surrendered or expired/);
});

test('penalties report: rows are read by column heading', () => {
  const { parseReport } = fresh('sources/penalties.js');
  const html = '<table><thead><tr><th scope="col">Liable party</th><th scope="col">Business name where illegal workers encountered</th><th scope="col">Address</th><th scope="col">Postcode</th><th scope="col">Final value of penalty</th></tr></thead><tbody>' +
    '<tr><th scope="row">Aberdeen Vapes Ltd</th><td>King Vape</td><td>7a Crown Street, Aberdeen</td><td>AB11 6HA</td><td>£&#8203;45,000.00</td></tr></tbody></table>';
  const rows = parseReport(html);
  assert.deepEqual(rows, [{ party: 'Aberdeen Vapes Ltd', business: 'King Vape', address: '7a Crown Street, Aberdeen', postcode: 'AB11 6HA', value: '£45,000.00' }]);
});

function atom(entries) {
  return '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' + entries.map(e =>
    '<entry><author><name>' + e.author + '</name><uri>https://www.reddit.com/user/x</uri></author><category term="ukvisa" label="r/ukvisa"/>' +
    '<content type="html">' + e.html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</content><id>' + e.id + '</id>' +
    '<link href="' + (e.url || 'https://www.reddit.com/r/ukvisa/comments/abc/post/') + '" /><updated>' + e.date + '</updated><published>' + e.date + '</published><title>' + e.title + '</title></entry>').join('') + '</feed>';
}

test('reddit: only posts asking for something the consultancy does become leads, and only the username is kept', async () => {
  const now = new Date().toISOString();
  const fake = withFakeHttp({
    'reddit.com/r/': atom([
      { id: 't3_a', author: '/u/founder1', title: 'Need help with Innovator Founder business plan', html: '<p>Can anyone recommend a consultant for the endorsement?</p> submitted by /u/founder1 [link] [comments]', date: now },
      { id: 't3_b', author: '/u/worker', title: 'Skilled worker visa processing time', html: '<p>Just waiting.</p>', date: now }
    ]),
    'reddit.com/search.rss': atom([])
  });
  const c = fake.load('sources/communities.js');
  const r = await c.collectReddit({});
  assert.equal(r.leads.length, 1);
  const lead = r.leads[0];
  assert.equal(lead.kind, 'person');
  assert.equal(lead.name, 'u/founder1');
  assert.equal(lead.contact.email, undefined);
  assert.doesNotMatch(lead.facts.find(f => f.label === 'Post').value, /submitted by/);
});

test('reddit: the same question cross-posted to several communities is one lead', async () => {
  const fake = withFakeHttp({
    'reddit.com/search.rss': atom([
      { id: 't3_x1', author: '/u/asker', title: 'Need help with Innovator Founder business plan', html: '<p>Can anyone recommend a consultant?</p>', date: new Date(Date.now() - 3600000).toISOString() },
      { id: 't3_x2', author: '/u/asker', title: 'Need help with Innovator Founder business plan', html: '<p>Can anyone recommend a consultant?</p>', date: new Date().toISOString() }
    ]),
    'reddit.com/r/': atom([])
  });
  const c = fake.load('sources/communities.js');
  const r = await c.collectReddit({});
  assert.equal(r.leads.length, 1);
  assert.ok(r.leads[0].facts.some(f => f.label === 'Also posted in'));
});

test('reddit check: the author saying the visa was approved retires the lead with a quote', async () => {
  const fake = withFakeHttp({
    'comments/abc/post/.rss': atom([
      { id: 't3_abc', author: '/u/founder1', title: 'Need help with Innovator Founder business plan', html: '<p>Original post</p>', date: '2026-10-01T10:00:00Z' },
      { id: 't1_c1', author: '/u/someone', title: 'reply', html: '<p>Good luck</p>', date: '2026-10-02T10:00:00Z' },
      { id: 't1_c2', author: '/u/founder1', title: 'reply', html: '<p>Update: my endorsement was approved today, thanks all!</p>', date: '2026-10-03T10:00:00Z', url: 'https://www.reddit.com/r/ukvisa/comments/abc/post/c2/' }
    ])
  });
  const c = fake.load('sources/communities.js');
  const r = await c.checkRedditPost({ ref: { postUrl: 'https://www.reddit.com/r/ukvisa/comments/abc/post/', author: 'u/founder1' } });
  assert.equal(r.tooLate, true);
  assert.match(r.quote, /endorsement was approved/);
});

test('reddit check: someone else saying "approved" does not retire the lead', async () => {
  const fake = withFakeHttp({
    'comments/abc/post/.rss': atom([
      { id: 't3_abc', author: '/u/founder1', title: 'Innovator Founder help', html: '<p>Original post</p>', date: '2026-10-01T10:00:00Z' },
      { id: 't1_c1', author: '/u/someone', title: 'reply', html: '<p>Mine was approved last week.</p>', date: '2026-10-02T10:00:00Z' }
    ])
  });
  const c = fake.load('sources/communities.js');
  const r = await c.checkRedditPost({ ref: { postUrl: 'https://www.reddit.com/r/ukvisa/comments/abc/post/', author: 'u/founder1' } });
  assert.equal(r.tooLate, false);
});

test('forum titles: replies are told apart from new topics', () => {
  const { splitForumTitle } = fresh('sources/communities.js');
  assert.deepEqual(splitForumTitle('Start-up and Innovator Visas • Re: Need advice'), { forum: 'Start-up and Innovator Visas', topic: 'Re: Need advice', isReply: true });
  assert.equal(splitForumTitle('Global Talent Visas (GTV) • Applying GTV in the UK').isReply, false);
});
