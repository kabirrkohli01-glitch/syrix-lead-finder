'use strict';
/* The shape every source produces, so the store, scorer and interface only
 * ever deal with one kind of object. */

const crypto = require('node:crypto');

function leadId(source, key) {
  return source + ':' + crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 14);
}

/* kind: 'organisation' or 'person'.
 * signal: why this is a lead — { type, label, detail, quote, date, url }.
 *   `quote` is the published wording the lead rests on.
 * services: [{ id, name, matched, quote }] from services.js.
 * contact: { person, role, email, phone, website, address, postcode,
 *            handle, profileUrl, channel } — only what a source published.
 * facts: [{ label, value, url }] extra published details.
 */
function makeLead(f) {
  if (!f.source || !f.key || !f.name || !f.signal) throw new Error('A lead needs a source, key, name and signal');
  return {
    id: leadId(f.source, f.key),
    source: f.source,
    sourceLabel: f.sourceLabel || f.source,
    kind: f.kind === 'person' ? 'person' : 'organisation',
    name: f.name,
    headline: f.headline || f.signal.label,
    location: f.location || '',
    signal: f.signal,
    services: f.services || [],
    contact: f.contact || {},
    company: f.company || null,
    facts: f.facts || [],
    deadline: f.deadline || null,
    value: f.value || null,
    ref: f.ref || {}
  };
}

/* Where the evidence can be read, named for what it opens. A sponsor
 * lead's signal URL is the register's CSV download, which saves a file of
 * every sponsor rather than showing the entry, so those leads open the
 * register's GOV.UK page and, once matched, the company's own record. */
const SPONSOR_REGISTER_PAGE = 'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers';

function evidenceLinks(lead) {
  const sig = lead.signal || {};
  const company = lead.company && lead.company.url ? { url: lead.company.url, label: 'Companies House record' } : null;
  const out = [];
  if (sig.type === 'post') {
    out.push({ url: sig.url, label: lead.source === 'reddit' ? 'Open the post on Reddit' : 'Open the thread on ' + lead.sourceLabel });
  } else if (sig.type === 'tender') {
    out.push({ url: sig.url, label: 'Open the tender on ' + lead.sourceLabel });
  } else if (sig.type === 'penalty') {
    out.push({ url: sig.url, label: 'Open the Home Office report' });
  } else if (/^sponsor-/.test(sig.type || '')) {
    if (company) out.push({ ...company, label: 'Open on Companies House' });
    out.push({ url: SPONSOR_REGISTER_PAGE, label: 'Sponsor register on GOV.UK' });
    return out;
  } else if (sig.url) {
    out.push({ url: sig.url, label: 'Open on ' + lead.sourceLabel });
  }
  if (company) out.push(company);
  return out.filter(l => l.url);
}

module.exports = { makeLead, leadId, evidenceLinks, SPONSOR_REGISTER_PAGE };
