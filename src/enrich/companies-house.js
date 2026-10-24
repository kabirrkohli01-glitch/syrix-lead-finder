'use strict';
/* Companies House: the public register of UK companies.
 *
 * Read from the public "Find and update company information" pages, which
 * need no key. Gives the registered number, status, incorporation date,
 * registered office, nature of business and current officers. All of it is
 * published by statute for anyone to read.
 *
 * Matching a name to a company is where a lead finder can quietly go wrong,
 * so a match is accepted only when the normalised names are equal AND, when
 * the source gave a town or postcode, the registered office agrees with it.
 * A near miss is reported as "no confident match", never guessed.
 */

const { getText } = require('../http');
const { decodeEntities, oneLine, nameKey, registeredPart, htmlToText } = require('../text');

const BASE = 'https://find-and-update.company-information.service.gov.uk';

function text(html) { return oneLine(decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '))); }

function parseSearch(html) {
  const out = [];
  const list = (String(html).match(/<ul id="results"[\s\S]*?<\/ul>|class="results-list"[\s\S]*?<\/ul>/i) || [''])[0];
  for (const li of list.match(/<li class="type-company">[\s\S]*?<\/li>/gi) || []) {
    const link = /href="\/company\/([A-Z0-9]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(li);
    if (!link) continue;
    const meta = text((li.match(/<p class="meta crumbtrail">([\s\S]*?)<\/p>/i) || [])[1]);
    const ps = li.match(/<p>([\s\S]*?)<\/p>/gi) || [];
    out.push({ number: link[1], name: text(link[2]), meta, address: text(ps.length ? ps[ps.length - 1] : '') });
  }
  return out;
}

function field(html, id) {
  const m = new RegExp('id="' + id + '"[^>]*>([\\s\\S]*?)</(dd|span|p)>', 'i').exec(html);
  return m ? text(m[1]) : '';
}

function parseProfile(html, number) {
  const sic = [];
  for (let i = 0; i < 6; i++) {
    const v = field(html, 'sic' + i);
    if (v) sic.push(v);
  }
  return {
    number,
    name: text((String(html).match(/<p class="heading-xlarge"[^>]*>([\s\S]*?)<\/p>/i) || String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]),
    status: field(html, 'company-status'),
    type: field(html, 'company-type-value') || field(html, 'company-type'),
    incorporated: field(html, 'company-creation-date') || field(html, 'company-birth-date'),
    dissolved: field(html, 'cessation-date'),
    address: field(html, 'roa-address') || field(html, 'reg-address'),
    sic,
    url: BASE + '/company/' + number
  };
}

/* Officers page: each appointment is a block with a name, role, status and
   (for people) nationality and country of residence. Only current
   appointments are kept. */
function parseOfficers(html) {
  const out = [];
  const blocks = String(html).split(/<div class="appointment-\d+">/i).slice(1);
  for (const b of blocks) {
    const name = text((b.match(/<span id="officer-name-\d+">([\s\S]*?)<\/span>/i) || [])[1]);
    if (!name) continue;
    const role = text((b.match(/id="officer-role-\d+"[^>]*>([\s\S]*?)<\/dd>/i) || [])[1]);
    const status = text((b.match(/id="officer-status-tag-\d+"[^>]*>([\s\S]*?)<\/span>/i) || [])[1]);
    const resigned = /id="officer-resigned-on-\d+"/i.test(b) || /resigned/i.test(status);
    if (resigned) continue;
    out.push({
      name: displayName(name),
      role,
      nationality: text((b.match(/id="officer-nationality-\d+"[^>]*>([\s\S]*?)<\/dd>/i) || [])[1]),
      residence: text((b.match(/id="officer-country-of-residence-\d+"[^>]*>([\s\S]*?)<\/dd>/i) || [])[1]),
      appointed: text((b.match(/id="officer-appointed-on-\d+"[^>]*>([\s\S]*?)<\/dd>/i) || [])[1])
    });
  }
  return out;
}

/* Companies House writes people as "SURNAME, Forenames"; corporate officers
   have no comma and are left as published. */
function displayName(raw) {
  const m = /^([^,]+),\s*(.+)$/.exec(raw);
  if (!m) return raw;
  const surname = m[1].toLowerCase().replace(/(^|[\s'-])([a-z])/g, (x, a, b) => a + b.toUpperCase());
  return m[2] + ' ' + surname;
}

function postcodeOf(s) {
  const m = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i.exec(String(s || ''));
  return m ? (m[1] + ' ' + m[2]).toUpperCase() : '';
}

/* Picks the one result that is unambiguously the named organisation. */
function choose(results, { name, town = '', postcode = '' }) {
  const want = nameKey(registeredPart(name));
  if (!want) return null;
  const named = results.filter(r => nameKey(r.name) === want);
  if (!named.length) return null;
  /* A live company is always preferred: an old dissolved company with the
     same name at the same address must not stand in for the trading one.
     Only when no live company has the name is a dissolved one considered. */
  const liveNamed = named.filter(r => !/dissolved|closed|converted/i.test(r.meta));
  const exact = liveNamed.length ? liveNamed : named;
  const pc = postcodeOf(postcode);
  if (pc) {
    const byPc = exact.filter(r => postcodeOf(r.address) === pc);
    if (byPc.length === 1) return { ...byPc[0], matchedOn: 'name and postcode' };
    if (byPc.length > 1) return null;
  }
  const t = oneLine(town).toLowerCase();
  if (t) {
    const byTown = exact.filter(r => r.address.toLowerCase().includes(t));
    if (byTown.length === 1) return { ...byTown[0], matchedOn: 'name and town' };
    if (byTown.length > 1) return null;
  }
  /* Companies House does not register two live companies whose names are
     the same once "Ltd", punctuation and "the" are ignored, so a single live
     company with exactly the normalised name is that organisation even when
     its registered office (often an accountant's) is in another town.
     Dissolved namesakes are common and never counted. */
  if (liveNamed.length === 1) return { ...liveNamed[0], matchedOn: pc || t ? 'exact registered name (registered office elsewhere)' : 'exact registered name' };
  return null;
}

async function lookup({ name, town, postcode }) {
  const q = registeredPart(name);
  const html = await getText(BASE + '/search/companies?q=' + encodeURIComponent(q), { ttl: 7 * 86400000, accept: 'text/html' });
  const pick = choose(parseSearch(html), { name, town, postcode });
  if (!pick) return null;
  return profile(pick.number, pick.matchedOn);
}

async function profile(number, matchedOn = 'company number') {
  const html = await getText(BASE + '/company/' + encodeURIComponent(number), { ttl: 24 * 60 * 60 * 1000, accept: 'text/html' });
  const company = parseProfile(html, number);
  company.matchedOn = matchedOn;
  try {
    const off = await getText(BASE + '/company/' + encodeURIComponent(number) + '/officers', { ttl: 7 * 86400000, accept: 'text/html' });
    company.officers = parseOfficers(off).slice(0, 8);
  } catch { company.officers = []; }
  return company;
}

/* Fresh status only, for the too-late check. */
async function status(number) {
  const html = await getText(BASE + '/company/' + encodeURIComponent(number), { ttl: 12 * 60 * 60 * 1000, accept: 'text/html' });
  const p = parseProfile(html, number);
  return { status: p.status, dissolved: p.dissolved, url: p.url };
}

/* A company number written at the end of a register entry, as some
   sponsors give it ("Example UK Ltd 15362523", "EXAMPLE LTD (SC123456)",
   "EXAMPLE LTD-14648180"). Numbers are eight characters; a leading zero
   dropped by the writer is restored. */
const NUMBER_AT_END = /[\s(\-–]+((?:SC|NI|OC|SO|NC|FC|R0)?\d{6,8})\)?\s*$/i;

function numberIn(name) {
  const m = NUMBER_AT_END.exec(String(name || ''));
  if (!m) return null;
  const raw = m[1].toUpperCase();
  return /^\d+$/.test(raw) ? raw.padStart(8, '0') : raw;
}

/* Reads the company a register entry names by number. The number is the
   sponsor's own, but a typo would point at another company, so the
   profile is accepted only when its name starts with the same word. */
async function byNumberIn(name) {
  const number = numberIn(name);
  if (!number) return null;
  const company = await profile(number, 'company number in the register entry');
  const first = s => nameKey(s).split(' ')[0];
  return company.name && first(company.name) === first(String(name).replace(NUMBER_AT_END, '')) ? company : null;
}

/* Closed, or on its way: an active proposal to strike off means the
   company is about to be removed from the register (voluntarily, or for
   failing to file), which is not a business about to buy services. */
function isClosed(statusText) {
  return /\b(dissolved|liquidation|closed|converted|proposal to strike off)\b/i.test(statusText || '');
}

module.exports = { lookup, profile, status, isClosed, numberIn, byNumberIn, parseSearch, parseProfile, parseOfficers, choose, postcodeOf, htmlToText };
