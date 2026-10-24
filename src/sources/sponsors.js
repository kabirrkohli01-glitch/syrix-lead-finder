'use strict';
/* The Home Office register of licensed sponsors (workers), published as a
 * CSV on GOV.UK and replaced almost every day.
 *
 * What the register can and cannot say:
 *   - "Worker (B rating)" is published. A B rating means the licence has been
 *     downgraded and the sponsor is working through a Home Office action
 *     plan. That is a current, specific compliance need.
 *   - A sponsor on the "UK Expansion Worker" route is an overseas business
 *     that has formed its first UK branch or subsidiary and been licensed,
 *     and is getting it trading. That is published too.
 *   - New and removed sponsors are NOT published as such. They are found by
 *     comparing today's file with the last one this app saved. The first run
 *     can only save a baseline; new and removed sponsors appear from the
 *     second register onwards.
 *   - The register never says WHY a sponsor disappeared (revoked, surrendered
 *     or expired), so the app never claims a reason.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getJson, getText } = require('../http');
const { makeLead } = require('../lead');
const { BY_ID } = require('../services');
const { parseCsv, oneLine, nameKey, titleCase } = require('../text');

const PUBLICATION = 'https://www.gov.uk/api/content/government/publications/register-of-licensed-sponsors-workers';
const PAGE = 'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers';
const EXPANSION_ROUTE = 'Global Business Mobility: UK Expansion Worker';

function svc(id, quote) {
  return { id, name: BY_ID[id].name, matched: quote, quote };
}

/* Turns CSV rows into one entry per organisation and town. An organisation
   holding several routes appears on several rows. */
function parseRegister(csvText) {
  const rows = parseCsv(csvText);
  const header = rows.shift() || [];
  const col = name => header.findIndex(h => oneLine(h).toLowerCase() === name);
  const iName = col('organisation name'), iTown = col('town/city'), iCounty = col('county'), iType = col('type & rating'), iRoute = col('route');
  if (iName < 0 || iType < 0 || iRoute < 0) throw new Error('The sponsor register columns have changed; expected Organisation Name, Type & Rating and Route');
  const orgs = new Map();
  for (const r of rows) {
    const name = oneLine(r[iName]);
    if (!name) continue;
    const town = oneLine(r[iTown]);
    const key = nameKey(name) + '|' + town.toLowerCase();
    const type = oneLine(r[iType]);
    const route = oneLine(r[iRoute]);
    const org = orgs.get(key) || { key, name, town, county: oneLine(r[iCounty]), types: [], routes: [] };
    if (type && !org.types.includes(type)) org.types.push(type);
    if (route && !org.routes.includes(route)) org.routes.push(route);
    orgs.set(key, org);
  }
  return orgs;
}

function isB(org) { return org.types.some(t => /\bB rating\b/i.test(t)); }

/* The compact snapshot kept between runs: key -> [name, town, county, b, routes]. */
function toSnapshot(orgs) {
  const out = {};
  for (const o of orgs.values()) out[o.key] = [o.name, o.town, o.county, isB(o) ? 1 : 0, o.routes];
  return out;
}

function fromSnapshotEntry(key, e) {
  return { key, name: e[0], town: e[1], county: e[2], types: e[3] ? ['Worker (B rating)'] : ['Worker (A rating)'], routes: e[4] || [] };
}

function location(org) {
  return [titleCase(org.town), titleCase(org.county)].filter(Boolean).join(', ');
}

function baseLead(org, type, label, detail, services, registerUrl, registerDate) {
  return makeLead({
    source: 'sponsor-register',
    sourceLabel: 'Register of licensed sponsors',
    key: type + '|' + org.key,
    kind: 'organisation',
    name: oneLine(org.name),
    headline: label,
    location: location(org),
    signal: {
      type,
      label,
      detail,
      quote: 'Register entry: ' + oneLine(org.name) + ', ' + (org.town || 'no town given') + ' — ' + org.types.join('; ') + ' — ' + org.routes.join('; '),
      date: registerDate,
      url: registerUrl
    },
    services,
    contact: { address: location(org), channel: 'Business contact details are looked up on Companies House and the organisation\'s own website' },
    facts: [
      { label: 'Licence', value: org.types.join('; ') },
      { label: 'Routes', value: org.routes.join('; ') }
    ],
    ref: { registerKey: org.key, sponsorType: type }
  });
}

function bLead(org, url, date) {
  return baseLead(org, 'sponsor-b', 'Sponsor licence downgraded to a B rating',
    'The register lists this sponsor with a B rating, which means it must follow a Home Office action plan to regain an A rating.',
    [svc('hr-compliance', 'Register shows ' + org.types.find(t => /B rating/i.test(t)))], url, date);
}

/* What the consultancy can still offer a business that already holds an Expansion
 * Worker licence. The consultancy's Expansion Worker service covers the steps BEFORE the
 * licence (company formation, the licence, the visa), so a business on the
 * register has already done them and is already set up in the UK. What
 * remains, in the consultancy's own route and Global Mobility offer: sponsor compliance
 * (it now holds a licence), the Skilled Worker licence the route moves to
 * once the UK operation trades (unless it already has one), and market
 * entry research. */
function expansionServices(org) {
  const services = [svc('hr-compliance', 'Holds a UK sponsor licence (' + EXPANSION_ROUTE + ')')];
  if (!org.routes.includes('Skilled Worker')) services.push(svc('sponsor-licence', 'Holds only Global Business Mobility routes; the Expansion Worker route moves to a Skilled Worker licence once the UK operation is trading'));
  services.push(svc('market-research', 'Starting to trade in the UK on the Expansion Worker route (market entry research)'));
  return services;
}

function expansionLead(org, url, date) {
  return baseLead(org, 'sponsor-expansion', 'Overseas business setting up in the UK',
    'Holds a UK Expansion Worker sponsor licence, so it has already formed its UK branch or subsidiary and been licensed. The route\'s next steps are getting the UK operation trading and then moving to a Skilled Worker licence.',
    expansionServices(org), url, date);
}

function newLead(org, url, date, previousDate) {
  const services = org.routes.includes(EXPANSION_ROUTE)
    ? expansionServices(org)
    : [svc('hr-compliance', 'Newly added to the register since ' + previousDate)];
  return baseLead(org, 'sponsor-new', 'Newly licensed sponsor',
    'Appeared on the register since ' + previousDate + '. A new sponsor takes on sponsor duties, Sponsor Management System use and right to work checks from day one.',
    services, url, date);
}

/* The services a stored sponsor lead should carry under the rules above,
   used to correct leads saved under earlier rules. */
function servicesFor(lead) {
  const facts = Object.fromEntries((lead.facts || []).map(f => [f.label, f.value]));
  const org = { routes: String(facts.Routes || '').split(';').map(s => s.trim()).filter(Boolean) };
  if (lead.signal.type === 'sponsor-expansion') return expansionServices(org);
  if (lead.signal.type === 'sponsor-new' && org.routes.includes(EXPANSION_ROUTE)) return expansionServices(org);
  return null;
}

function removedLead(org, url, date, previousDate) {
  return baseLead(org, 'sponsor-removed', 'No longer on the sponsor register',
    'Listed on ' + previousDate + ' and missing from the register dated ' + date + '. The register does not say whether the licence was revoked, surrendered or expired.',
    [svc('sponsor-licence', 'Missing from the register dated ' + date)], url, date);
}

/* Finds the newest register file on GOV.UK. */
async function latestFile() {
  const pub = await getJson(PUBLICATION, { ttl: 60 * 60 * 1000 });
  const att = ((pub.details && pub.details.attachments) || []).find(a => /csv/i.test(a.content_type || '') || /\.csv$/i.test(a.url || ''));
  if (!att) throw new Error('No CSV attachment on the sponsor register page');
  const date = ((att.url.match(/(\d{4}-\d{2}-\d{2})/) || [])[1]) || (pub.public_updated_at || '').slice(0, 10);
  return { url: att.url, date };
}

/* Reads the latest register and compares it with the saved one.
 * Returns leads for current B-rated and Expansion Worker sponsors, plus new
 * and removed sponsors when a previous snapshot exists, and the facts the
 * checker needs to retire leads (who is back to A, who reappeared). */
async function collect({ dataDir, report } = {}) {
  const file = await latestFile();
  const snapPath = path.join(dataDir, 'sponsor-register.json');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(snapPath, 'utf8')); } catch { /* first run */ }

  if (report) report('Downloading the sponsor register dated ' + file.date);
  const csv = await getText(file.url, { ttl: 12 * 60 * 60 * 1000, timeout: 120000 });
  const orgs = parseRegister(csv);
  if (orgs.size < 10000) throw new Error('The sponsor register looks incomplete (' + orgs.size + ' organisations); not used');
  if (report) report('Read ' + orgs.size.toLocaleString('en-GB') + ' sponsors from the register');

  const leads = [];
  for (const org of orgs.values()) {
    if (isB(org)) leads.push(bLead(org, file.url, file.date));
    if (org.routes.includes(EXPANSION_ROUTE)) leads.push(expansionLead(org, file.url, file.date));
  }

  let added = 0, removed = 0;
  let comparable = !!(previous && previous.date && previous.date !== file.date && previous.orgs);
  if (comparable) {
    const fresh = [...orgs.values()].filter(o => !previous.orgs[o.key]);
    const gone = Object.entries(previous.orgs).filter(([key]) => !orgs.has(key));
    /* A day-to-day change in the thousands is a change of format or naming
       in the file, not thousands of real licence events. Report nothing
       rather than flood the list with false new and removed sponsors. */
    if (fresh.length > 2000 || gone.length > 2000) {
      comparable = false;
      if (report) report('The register changed format since ' + previous.date + '; new and removed sponsors skipped this time');
    } else {
      for (const org of fresh) { leads.push(newLead(org, file.url, file.date, previous.date)); added++; }
      for (const [key, e] of gone) { leads.push(removedLead(fromSnapshotEntry(key, e), file.url, file.date, previous.date)); removed++; }
    }
  }

  /* The snapshot is only replaced by a newer register, so two runs on the
     same day still compare against yesterday's file. */
  if (!previous || previous.date !== file.date) {
    const snap = { date: file.date, url: file.url, savedAt: new Date().toISOString(), orgs: toSnapshot(orgs) };
    if (previous && previous.date !== file.date) snap.previousDate = previous.date;
    const tmp = snapPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, snapPath);
  }

  return {
    leads,
    register: { date: file.date, url: file.url, page: PAGE, has: key => orgs.has(key), isB: key => orgs.has(key) && isB(orgs.get(key)) },
    baseline: !comparable,
    added,
    removed,
    scanned: orgs.size
  };
}

module.exports = { collect, parseRegister, isB, servicesFor, EXPANSION_ROUTE };
