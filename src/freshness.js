'use strict';
/* When the evidence behind a lead was first published, and whether it is
 * still recent enough to act on.
 *
 * The date that matters is the one the source gives for the original event
 * (the post, the first tender notice, the report naming a penalty), never the date
 * this app read it. A register downloaded today lists licences granted in
 * 2022; a tender amended today can be a framework first published in 2021.
 * Showing either as "today" makes old evidence look new.
 *
 * Some sources publish no date for the event itself: the sponsor register
 * says who holds a licence, not since when. Those leads carry the earliest
 * published date that bounds the event (an Expansion Worker sponsor's UK
 * company incorporation date), labelled as such, or say plainly that no date
 * is published. Age limits apply through that bounding date too, so a lead
 * cannot stay current for ever just because its source omits a date.
 *
 * Above the per-kind windows sits one hard limit: nothing whose evidence is
 * dated more than MAX_AGE_MONTHS calendar months before today is shown,
 * whatever its kind or status (see `shown`). The only exceptions are leads
 * the user has already contacted or won, which are the user's own record of
 * a conversation rather than a lead to act on.
 *
 * Every function here is pure: no network, no store.
 */

const DAY = 86400000;

const MAX_AGE_MONTHS = 3;

/* How long each kind of evidence stays current, counted from its original
   date. A lead older than this is retired with the date as its evidence. */
const WINDOW_DAYS = {
  post: 30,                  // the window posts are collected in
  tenderNoDeadline: 90,      // notices with no closing date (planning, market engagement)
  tenderStanding: 365,       // DPS and open frameworks re-amended for years
  penalty: 365,              // from the end of the penalty period
  'sponsor-new': 90,
  'sponsor-removed': 90,
  'sponsor-expansion': 730   // the Expansion Worker route allows at most two years in the UK
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/* "17 August 2022" or "17 Aug 2022" (Companies House, GOV.UK titles) -> ISO
   date at midnight UTC, or null. ISO strings pass through. */
function parseDay(s) {
  const str = String(s || '').trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return Number.isFinite(Date.parse(str)) ? str : null;
  const m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(str);
  if (!m) return null;
  const month = MONTHS.findIndex(x => x.startsWith(m[2].toLowerCase().slice(0, 3)));
  if (month < 0) return null;
  return new Date(Date.UTC(Number(m[3]), month, Number(m[1]))).toISOString();
}

/* "1 January to 31 March 2026" or "1 October 2025 to 31 December 2025"
   -> { from, to } as ISO dates, or null. */
function parsePeriod(text) {
  const m = /(\d{1,2}\s+[A-Za-z]+)(\s+\d{4})?\s+to\s+(\d{1,2}\s+[A-Za-z]+)\s+(\d{4})/.exec(String(text || ''));
  if (!m) return null;
  const to = parseDay(m[3] + ' ' + m[4]);
  let from = parseDay(m[1] + (m[2] || ' ' + m[4]));
  if (!to || !from) return null;
  /* A period written without the first year that crosses new year
     ("1 November to 31 January 2026") starts in the previous year. */
  if (!m[2] && from > to) from = parseDay(m[1] + ' ' + (Number(m[4]) - 1));
  return { from, to };
}

function dayText(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
}

function ageDays(iso, now) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? (now - t) / DAY : null;
}

/* The original date of a lead's evidence.
 *
 * Returns {
 *   at     ISO date the event happened or was first published; null when unknown
 *   from   start of the period, when the source gives a period
 *   label  what `at` is ("Posted", "Tender first published"...)
 *   text   one line for the interface
 *   basis  'source'  the source dates the event itself
 *          'bound'   an earlier published date that bounds the event
 *          'none'    no date is published for the event
 *   note   what the date does and does not show
 *   url    where the date can be checked
 * } */
function originOf(lead) {
  const sig = lead.signal || {};
  const ref = lead.ref || {};
  const type = sig.type;

  if (type === 'post') {
    return dated(sig.date, 'Posted', 'source', '', sig.url);
  }

  if (type === 'tender') {
    if (ref.firstPublished) return dated(ref.firstPublished, 'Tender first published', 'source', '', sig.url);
    /* An amendment's own date is not the tender's. Until the procurement's
       history is read, the latest notice date is shown as exactly that. */
    return dated(sig.date, 'Latest notice', 'source', 'The first publication date is read from the procurement\'s history on the next search.', sig.url);
  }

  if (type === 'penalty') {
    /* The report is the published evidence, so it dates the lead. The
       period the penalties were issued in is months earlier and is given
       alongside it. */
    const p = sig.period || parsePeriod(sig.detail);
    const issued = p ? 'penalties issued between ' + dayText(p.from) + ' and ' + dayText(p.to) : '';
    const published = parseDay(sig.date);
    if (published) {
      return { at: published, from: null, period: p, label: 'Report published', text: 'Named in the Home Office report published ' + dayText(published) + (issued ? ', covering ' + issued : ''), basis: 'source', note: 'The report does not give the date of each penalty' + (issued ? '; it covers ' + issued : '') + '.', url: sig.url };
    }
    if (p) {
      return { at: p.to, from: p.from, period: p, label: 'Penalties issued', text: 'Penalties issued between ' + dayText(p.from) + ' and ' + dayText(p.to), basis: 'source', note: 'The report covers penalties issued in this period; it does not give the date of each one.', url: sig.url };
    }
    return none('Penalty date not published', 'The report does not say when this penalty was issued.', sig.url);
  }

  if (type === 'sponsor-new' || type === 'sponsor-removed') {
    const since = (/since (\d{4}-\d{2}-\d{2})|Listed on (\d{4}-\d{2}-\d{2})/.exec(sig.detail || '') || []).slice(1).find(Boolean) || null;
    const label = type === 'sponsor-new' ? 'Added to the register' : 'Removed from the register';
    return { at: sig.date || null, from: since, label, text: label + (since ? ' between ' + dayText(since) + ' and ' + dayText(sig.date) : ' by ' + dayText(sig.date)), basis: 'source', note: 'Found by comparing two daily registers; the register itself publishes no dates.', url: sig.url };
  }

  if (type === 'sponsor-expansion') {
    const inc = lead.company && parseDay(lead.company.incorporated);
    if (inc) {
      return { at: inc, from: null, label: 'UK company incorporated', text: 'UK company incorporated ' + dayText(inc), basis: 'bound', note: 'The register does not publish when the licence was granted. The UK company had to exist before it, so the expansion began on or after this date.', url: lead.company.url };
    }
    return none('Licence date not published', 'The register does not publish when the licence was granted, and no Companies House record has been matched yet.', sig.url);
  }

  if (type === 'sponsor-b') {
    return none('Downgrade date not published', 'The register shows the B rating is current on the register dated ' + dayText(sig.date) + ' but not when it was given. A B rating lasts only while an action plan is open, so it is current while it stays on the register.', sig.url);
  }

  return sig.date ? dated(sig.date, 'Published', 'source', '', sig.url) : none('Date not published', '', sig.url);
}

function dated(iso, label, basis, note, url) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return none(label + ' date not published', note, url);
  return { at: iso, from: null, label, text: label + ' ' + dayText(iso), basis, note, url };
}

function none(text, note, url) {
  return { at: null, from: null, label: '', text, basis: 'none', note, url };
}

/* The earliest evidence date still shown: today, MAX_AGE_MONTHS calendar
   months back. */
function cutoff(now = Date.now()) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - MAX_AGE_MONTHS);
  return d.getTime();
}

/* True when the lead's evidence is dated before the cutoff. A bounding date
   counts too: a lead must never display a date older than the limit. A lead
   whose source publishes no date at all (a B rating on today's register) is
   not old by this test; its evidence is the current register. */
function tooOld(lead, now = Date.now()) {
  const t = Date.parse(originOf(lead).at || '');
  return Number.isFinite(t) && t < cutoff(now);
}

/* Whether a lead may appear anywhere: the interface, exports and SYRIX. */
function shown(lead, now = Date.now()) {
  if (!lead) return false;
  if (lead.status === 'contacted' || lead.status === 'won') return true;
  return !tooOld(lead, now);
}

/* Whether a lead's evidence is too old to act on. Returns null when it is
 * current, or { reason, url } in the shape the store wants for retiring it. */
function outOfDate(lead, now = Date.now()) {
  const o = originOf(lead);
  const type = (lead.signal || {}).type;
  const age = ageDays(o.at, now);

  if (tooOld(lead, now)) {
    return { reason: (o.label || 'Published') + ' on ' + dayText(o.at) + ', more than ' + MAX_AGE_MONTHS + ' months ago; only evidence from the last ' + MAX_AGE_MONTHS + ' months is shown', url: o.url };
  }
  if (type === 'post' && age > WINDOW_DAYS.post) {
    return { reason: 'Posted on ' + dayText(o.at) + ', more than ' + WINDOW_DAYS.post + ' days ago; posts are treated as current for ' + WINDOW_DAYS.post + ' days', url: o.url };
  }
  if (type === 'tender') {
    const first = lead.ref && lead.ref.firstPublished;
    const firstAge = ageDays(first, now);
    if (firstAge > WINDOW_DAYS.tenderStanding) {
      return { reason: 'First published on ' + dayText(first) + ': a standing list amended for over a year, not a new request for suppliers', url: o.url };
    }
    if (!lead.deadline && age > WINDOW_DAYS.tenderNoDeadline) {
      return { reason: 'Published on ' + dayText(o.at) + ' with no closing date, more than ' + WINDOW_DAYS.tenderNoDeadline + ' days ago', url: o.url };
    }
  }
  if (type === 'penalty' && o.period && ageDays(o.period.to, now) > WINDOW_DAYS.penalty) {
    return { reason: 'The penalty period ended on ' + dayText(o.period.to) + ', more than a year ago', url: o.url };
  }
  if ((type === 'sponsor-new' || type === 'sponsor-removed') && age > WINDOW_DAYS[type]) {
    return { reason: o.label + ' ' + dayText(o.at) + ', more than ' + WINDOW_DAYS[type] + ' days ago', url: o.url };
  }
  if (type === 'sponsor-expansion' && o.basis === 'bound' && age > WINDOW_DAYS['sponsor-expansion']) {
    return { reason: 'Companies House shows the UK company was incorporated on ' + dayText(o.at) + ', more than two years ago. The Expansion Worker route allows at most two years, so the expansion stage has passed', url: o.url };
  }
  return null;
}

module.exports = { originOf, outOfDate, tooOld, shown, cutoff, parseDay, parsePeriod, dayText, WINDOW_DAYS, MAX_AGE_MONTHS };
