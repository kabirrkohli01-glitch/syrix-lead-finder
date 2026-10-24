'use strict';
/* The Home Office's quarterly report naming employers given civil penalties
 * for illegal working, published on GOV.UK.
 *
 * The report does not name every employer fined, only those meeting the
 * Home Office's publication criteria, so the app says "named in the report"
 * and nothing more about the circumstances. The need it evidences is right
 * to work compliance, which the consultancy's HR compliance training covers.
 */

const { getJson, getText } = require('../http');
const { makeLead } = require('../lead');
const { BY_ID } = require('../services');
const { decodeEntities, oneLine, nameKey } = require('../text');
const { parsePeriod } = require('../freshness');

const PUBLICATION = 'https://www.gov.uk/api/content/government/publications/illegal-working-penalties-uk-report';

function cell(html) {
  return oneLine(decodeEntities(String(html).replace(/<[^>]+>/g, ' '))).replace(/​/g, '');
}

/* Reads every table row of the report page. Columns are found by heading,
   so a reordered table still parses correctly. */
function parseReport(html) {
  const out = [];
  for (const table of String(html).match(/<table[\s\S]*?<\/table>/gi) || []) {
    const heads = [...table.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/gi)].map(m => cell(m[1]).toLowerCase());
    const at = re => heads.findIndex(h => re.test(h));
    const iParty = at(/liable party/), iBusiness = at(/business name/), iAddress = at(/^address/), iPostcode = at(/postcode/), iValue = at(/value|penalty/);
    if (iParty < 0 || iAddress < 0) continue;
    const body = (table.match(/<tbody[\s\S]*?<\/tbody>/i) || [''])[0];
    for (const tr of body.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cells = [...tr.matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)].map(m => cell(m[2]));
      if (cells.length < heads.length) continue;
      out.push({
        party: cells[iParty],
        business: iBusiness >= 0 ? cells[iBusiness] : cells[iParty],
        address: cells[iAddress],
        postcode: iPostcode >= 0 ? cells[iPostcode] : '',
        value: iValue >= 0 ? cells[iValue] : ''
      });
    }
  }
  return out;
}

function toLead(row, report) {
  const name = row.business || row.party;
  const tradingDiffers = row.business && nameKey(row.business) !== nameKey(row.party);
  return makeLead({
    source: 'illegal-working',
    sourceLabel: 'Home Office illegal working penalties report',
    key: nameKey(row.party) + '|' + row.postcode.toUpperCase(),
    kind: 'organisation',
    name,
    headline: 'Named for an illegal working civil penalty',
    location: [row.address, row.postcode].filter(Boolean).join(', '),
    signal: {
      type: 'penalty',
      label: 'Named in the Home Office illegal working penalties report',
      detail: report.title + (row.value ? '. Penalty: ' + row.value : ''),
      quote: 'Report entry: ' + row.party + (tradingDiffers ? ' (trading as ' + row.business + ')' : '') + ', ' + row.address + ' ' + row.postcode + (row.value ? ', ' + row.value : ''),
      /* The period the penalties were issued in, from the report's title.
         `date` is when GOV.UK published the report, which is months later. */
      period: parsePeriod(report.title),
      date: report.date,
      url: report.url
    },
    services: [{ id: 'hr-compliance', name: BY_ID['hr-compliance'].name, matched: 'illegal working civil penalty', quote: 'Named in ' + report.title }],
    contact: {
      address: [row.address, row.postcode].filter(Boolean).join(', '),
      postcode: row.postcode,
      channel: 'Business contact details are looked up on Companies House and the business\'s own website'
    },
    facts: [
      { label: 'Liable party', value: row.party },
      ...(tradingDiffers ? [{ label: 'Trading as', value: row.business }] : []),
      ...(row.value ? [{ label: 'Penalty', value: row.value }] : [])
    ],
    ref: { registeredName: row.party, postcode: row.postcode }
  });
}

async function collect({ report } = {}) {
  const pub = await getJson(PUBLICATION, { ttl: 6 * 60 * 60 * 1000 });
  const attachments = ((pub.details && pub.details.attachments) || []).filter(a => a.attachment_type === 'html' || /^\/government\//.test(a.url || ''));
  const leads = [];
  let scanned = 0;
  for (const att of attachments.slice(0, 2)) {
    const url = att.url.startsWith('http') ? att.url : 'https://www.gov.uk' + att.url;
    if (report) report('Reading ' + att.title);
    const html = await getText(url, { ttl: 6 * 60 * 60 * 1000 });
    const rows = parseReport(html);
    scanned += rows.length;
    const meta = { title: oneLine(att.title), url, date: (pub.public_updated_at || '').slice(0, 10) };
    for (const row of rows) leads.push(toLead(row, meta));
  }
  return { leads, scanned };
}

module.exports = { collect, parseReport, toLead };
