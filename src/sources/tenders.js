'use strict';
/* Public-sector buyers asking suppliers to bid: Contracts Finder (England,
 * below and above threshold) and Find a Tender (the UK-wide high-value
 * service). Both publish Open Contracting (OCDS) JSON with no key.
 *
 * A tender is the clearest lead there is: an organisation has written down
 * that it is looking for a supplier, what for, by when, and who to contact.
 *
 * A tender becomes a lead only when its CPV code is one of the consultancy's services,
 * or the consultancy's service is named in the title, or named in the description of a
 * services tender. A word in the description of a construction or vehicle
 * tender is not a lead.
 */

const { getJson } = require('../http');
const { makeLead } = require('../lead');
const { matchServices, matchCpv } = require('../services');
const { clip, oneLine, quoteAround } = require('../text');

const FEEDS = {
  'contracts-finder': {
    label: 'Contracts Finder',
    search: (from, stage) => 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?publishedFrom=' + from.slice(0, 10) + '&stages=' + stage + '&limit=100',
    noticeUrl: r => ((r.tender && r.tender.documents) || []).find(d => d.documentType === 'tenderNotice' && d.url)?.url || 'https://www.contractsfinder.service.gov.uk/Search',
    awardUrl: r => ((r.awards || [])[0]?.documents || []).find(d => d.url)?.url || null
  },
  'find-a-tender': {
    label: 'Find a Tender',
    /* Find a Tender's stage filter returns a fraction of the matching
       notices (40 tenders over ten days, against about 20 a day in the
       unfiltered feed). So the whole feed is read once and filtered here by
       each release's own tags; the same sweep also supplies the awards. */
    filterLocally: true,
    search: from => 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?updatedFrom=' + from.slice(0, 13) + ':00:00&limit=100',
    noticeUrl: r => 'https://www.find-tender.service.gov.uk/Notice/' + encodeURIComponent(r.id),
    /* Every release of one procurement, oldest first: the first is when it
       was originally published. */
    record: ocid => 'https://www.find-tender.service.gov.uk/api/1.0/ocdsRecordPackages/' + encodeURIComponent(ocid),
    awardUrl: r => 'https://www.find-tender.service.gov.uk/Notice/' + encodeURIComponent(r.id)
  }
};

/* Services divisions: a the consultancy service named in the description only counts
   when the tender itself is for services of this kind. */
const SERVICE_DIVISIONS = ['79', '72', '80', '71', '73', '75'];

const MAX_PAGES = 40;
const SWEEP_DAYS = 10;

async function fetchReleases(feedName, from, stage, report) {
  const feed = FEEDS[feedName];
  let url = feed.search(from, stage);
  const releases = [];
  let partial = null;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    let pkg;
    try {
      pkg = await getJson(url, { ttl: 30 * 60 * 1000, timeout: 45000 });
    } catch (err) {
      /* Keep what was read. A service that asks the tool to slow down part
         way through still gave real notices, and the next run carries on
         from the same point. */
      if (!releases.length) throw err;
      partial = err.message;
      break;
    }
    releases.push(...(pkg.releases || []));
    if (report) report(feed.label + ': read ' + releases.length + ' notices');
    const next = pkg.links && pkg.links.next;
    if (!next || !(pkg.releases || []).length) break;
    url = next;
  }
  const wanted = stage === 'award' ? /^award/ : /^tender/;
  const out = feed.filterLocally ? releases.filter(r => (r.tag || []).some(t => wanted.test(t))) : releases;
  out.partial = partial;
  return out;
}

function cpvCodes(tender) {
  const codes = new Set();
  if (tender.classification && tender.classification.id) codes.add(String(tender.classification.id));
  for (const item of tender.items || []) {
    if (item.classification && item.classification.id) codes.add(String(item.classification.id));
    for (const c of item.additionalClassifications || []) if (c.id && (c.scheme || 'CPV') === 'CPV') codes.add(String(c.id));
  }
  return [...codes];
}

/* Physical works and goods that buyers sometimes file under research,
   survey or engineering categories ("asbestos survey" under survey
   services, a fumigation lobby under engineering). When the title names one
   of these and no the consultancy service, the category code alone is not trusted. */
const WORKS_TITLE = /\b(asbestos|construction|refurbish\w*|works|cleaning|catering|waste|vehicles?|fumigation|laundry|bus shelters?|uniforms?|roofing|grounds maintenance|plumbing|demolition|resurfacing|fencing|lifts?|boilers?|hvac|air handling|lighting|furniture|food|fuel|pharmacy|clinical|ambulance|taxi|security guarding|scaffolding|drainage|paving|windows|doors)\b/i;

/* Decides which the consultancy services a tender is genuinely for. */
function relevantServices(tender) {
  const title = oneLine(tender.title);
  const description = String(tender.description || '');
  const codes = cpvCodes(tender);
  const inTitle = matchServices(title, { audience: 'organisation', quote: () => title });
  if (!inTitle.length && WORKS_TITLE.test(title)) return [];
  const inDescription = matchServices(description, { audience: 'organisation', quote: quoteAround });
  const textIds = new Set([...inTitle, ...inDescription].map(s => s.id));
  const isServicesTender = codes.some(c => SERVICE_DIVISIONS.some(d => c.startsWith(d)));

  const found = new Map();
  for (const code of codes) {
    for (const s of matchCpv(code)) {
      if (s.needsText && !textIds.has(s.id)) continue;
      if (!found.has(s.id)) found.set(s.id, { ...s, quote: 'Tender classified as CPV ' + code + (tender.classification && tender.classification.id === code && tender.classification.description ? ' (' + tender.classification.description + ')' : '') });
    }
  }
  for (const s of inTitle) if (!found.has(s.id)) found.set(s.id, s);
  if (isServicesTender) for (const s of inDescription) if (!found.has(s.id)) found.set(s.id, s);
  return [...found.values()];
}

function buyerOf(release) {
  const buyerId = release.buyer && release.buyer.id;
  return (release.parties || []).find(p => p.id === buyerId) || (release.parties || []).find(p => (p.roles || []).includes('buyer')) || null;
}

function addressLine(a) {
  if (!a) return '';
  return [a.streetAddress, a.locality, a.postalCode].filter(Boolean).map(oneLine).join(', ');
}

function money(v) {
  if (!v || !Number.isFinite(Number(v.amount))) return null;
  return { amount: Number(v.amount), currency: v.currency || 'GBP' };
}

function toLead(feedName, release, now = Date.now()) {
  const feed = FEEDS[feedName];
  const tender = release.tender || {};
  if (!tender.title) return null;
  if (tender.status && tender.status !== 'active' && tender.status !== 'planned') return null;
  const deadline = tender.tenderPeriod && tender.tenderPeriod.endDate;
  if (deadline && Date.parse(deadline) < now) return null;

  const services = relevantServices(tender);
  if (!services.length) return null;

  const buyer = buyerOf(release);
  if (!buyer) return null;
  const cp = buyer.contactPoint || {};
  const url = feed.noticeUrl(release);
  /* Find a Tender's newer notices put value, dates and suitability on each
     lot rather than on the tender, so the first lot is used when the tender
     itself carries none. */
  const lots = tender.lots || [];
  const lot = lots[0] || {};
  const value = money(tender.value) || money(tender.minValue) || money(lot.value);
  const period = tender.contractPeriod || lot.contractPeriod;
  const codes = cpvCodes(tender);
  const facts = [];
  if (tender.classification && tender.classification.id) facts.push({ label: 'Category', value: tender.classification.id + ' ' + (tender.classification.description || '') });
  else if (codes.length) facts.push({ label: 'Category codes', value: codes.slice(0, 4).join(', ') });
  if (value) facts.push({ label: 'Estimated value', value: '£' + value.amount.toLocaleString('en-GB') + (lots.length > 1 ? ' (first of ' + lots.length + ' lots)' : '') });
  if (period && period.startDate) facts.push({ label: 'Contract period', value: period.startDate.slice(0, 10) + (period.endDate ? ' to ' + period.endDate.slice(0, 10) : '') });
  if ((tender.suitability && tender.suitability.sme) || lots.some(l => l.suitability && l.suitability.sme)) facts.push({ label: 'Suitable for small businesses', value: 'Yes, per the notice' });
  if (tender.procurementMethodDetails) facts.push({ label: 'Procedure', value: oneLine(tender.procurementMethodDetails) });

  return makeLead({
    source: feedName,
    sourceLabel: feed.label,
    key: release.ocid || release.id,
    kind: 'organisation',
    name: oneLine(buyer.name),
    headline: 'Tender: ' + clip(tender.title, 140),
    location: [buyer.address && buyer.address.locality, buyer.address && buyer.address.postalCode].filter(Boolean).join(', '),
    signal: {
      type: 'tender',
      label: 'Is inviting suppliers to bid',
      detail: clip(tender.title, 200),
      quote: clip(tender.description || tender.title, 600),
      date: tender.datePublished || release.date || null,
      url
    },
    services,
    contact: {
      person: oneLine(cp.name),
      email: oneLine(cp.email).toLowerCase(),
      phone: oneLine(cp.telephone),
      website: (buyer.details && buyer.details.url) || '',
      address: addressLine(buyer.address),
      postcode: buyer.address && buyer.address.postalCode ? oneLine(buyer.address.postalCode) : '',
      channel: 'Respond through the tender notice; the named contact is published for supplier questions',
      provenance: url
    },
    facts,
    deadline: deadline || null,
    value,
    ref: { ocid: release.ocid, feed: feedName, firstPublished: firstPublishedIn(release) }
  });
}

/* The date the procurement was first published, when this release shows
   it: the buyer's own datePublished, or the release itself when it is the
   original notice. An update or amendment carries its own date, not the
   tender's, so it gives null and the procurement's history is read
   instead (firstPublished below). A framework first published in 2021 and
   amended today must not look like today's tender. */
function firstPublishedIn(release) {
  const t = release.tender || {};
  if (t.datePublished) return t.datePublished;
  const tags = release.tag || [];
  if (tags.includes('tender') && !tags.some(x => /Update|Amendment/.test(x))) return release.date || null;
  return null;
}

/* Reads a procurement's full history and returns its earliest release
   date, or null when the feed offers no history. */
async function firstPublished(feedName, ocid) {
  const feed = FEEDS[feedName];
  if (!feed || !feed.record || !ocid) return null;
  const pkg = await getJson(feed.record(ocid), { ttl: 30 * 86400000, timeout: 45000 });
  const releases = ((pkg.records || [])[0] || {}).releases || [];
  const dates = releases.map(r => r.date).filter(d => Number.isFinite(Date.parse(d || ''))).sort((a, b) => Date.parse(a) - Date.parse(b));
  return dates[0] || null;
}

/* Sweeps the last `days` days of tender notices. */
/* `since` lets a run read only what was published after the last complete
   sweep (the earlier notices are already stored); the first run reads ten
   days. */
function sweepStart(since) {
  const floor = Date.now() - SWEEP_DAYS * 86400000;
  const t = Date.parse(since || '');
  return new Date(Number.isFinite(t) ? Math.max(floor, t - 2 * 3600000) : floor).toISOString();
}

async function collect(feedName, { since = null, report } = {}) {
  const from = sweepStart(since);
  const releases = await fetchReleases(feedName, from, 'tender', report);
  /* The newest release for each procurement wins, so an amended deadline or
     a cancellation replaces the original notice. */
  const latest = new Map();
  for (const r of releases) {
    const prev = latest.get(r.ocid);
    if (!prev || String(r.date || '') >= String(prev.date || '')) latest.set(r.ocid, r);
  }
  const leads = [];
  const ended = [];
  for (const r of latest.values()) {
    const status = r.tender && r.tender.status;
    if (status && ['cancelled', 'unsuccessful', 'complete', 'withdrawn'].includes(status)) {
      ended.push({ ocid: r.ocid, reason: 'The buyer marked this tender ' + status, url: FEEDS[feedName].noticeUrl(r) });
      continue;
    }
    const lead = toLead(feedName, r);
    if (lead) leads.push(lead);
  }
  return { leads, ended, scanned: latest.size, partial: releases.partial, from };
}

/* Award notices published recently, used to retire tenders already won by
   another supplier. */
async function recentAwards(feedName, { days = 30, since = null, report } = {}) {
  /* Find a Tender's awards come from the same cached sweep as its tenders. */
  const from = FEEDS[feedName].filterLocally ? sweepStart(since) : new Date(Date.now() - days * 86400000).toISOString();
  const releases = await fetchReleases(feedName, from, 'award', report);
  const out = new Map();
  for (const r of releases) {
    const award = (r.awards || [])[0];
    if (!award) continue;
    const suppliers = (award.suppliers || []).map(s => s.name).filter(Boolean).join(', ');
    out.set(r.ocid, {
      reason: 'Contract awarded' + (suppliers ? ' to ' + suppliers : '') + (award.date ? ' on ' + String(award.date).slice(0, 10) : ''),
      url: FEEDS[feedName].awardUrl(r) || FEEDS[feedName].noticeUrl(r)
    });
  }
  return out;
}

module.exports = { collect, recentAwards, toLead, relevantServices, firstPublished, firstPublishedIn, FEEDS };
