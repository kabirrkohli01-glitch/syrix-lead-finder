'use strict';
/* Finds an organisation's own website and the contact details it publishes.
 *
 * Candidate sites come from likely domains built from the registered name,
 * then from a web search while the search engine allows it. A candidate is
 * accepted only when
 * the site itself proves it belongs to the organisation: its pages show the
 * Companies House number, or the registered postcode, or the exact name
 * together with the town. Directory and social sites are never treated as
 * the organisation's website. Emails and phone numbers are taken only from
 * the accepted site's own pages, and every one keeps the page it came from.
 */

const { getText, hostOf, block, isBlocked } = require('../http');
const { decodeEntities, htmlToText, oneLine, nameKey, registeredPart } = require('../text');

const DIRECTORY_HOSTS = [
  'company-information.service.gov.uk', 'gov.uk', 'opencorporates.com', 'endole.co.uk', 'companycheck.co.uk', 'bizdb.co.uk',
  'cylex-uk.co.uk', 'firmania.co.uk', 'yell.com', 'yelp.com', 'yelp.co.uk', 'tripadvisor.com', 'tripadvisor.co.uk', 'thomsonlocal.com', 'scoot.co.uk',
  'freeindex.co.uk', 'hotfrog.co.uk', 'brownbook.net', 'misterwhat.co.uk', 'locallife.co.uk', 'birminghammail.co.uk', 'directory', 'checkatrade.com',
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'youtube.com', 'pinterest.com',
  'trustpilot.com', 'glassdoor.co.uk', 'glassdoor.com', 'indeed.com', 'indeed.co.uk', 'reed.co.uk', 'totaljobs.com', 'wikipedia.org',
  'bloomberg.com', 'dnb.com', 'zoominfo.com', 'rocketreach.co', 'apollo.io', 'crunchbase.com', 'companieslist.co.uk', 'ukbizdb.com',
  '192.com', 'thegazette.co.uk', 'checkcompany.co.uk', 'company-check.co.uk', 'globaldatabase.co.uk', 'duedil.com', 'pomanda.com',
  'uk.kompass.com', 'kompass.com', 'google.com', 'bing.com', 'duckduckgo.com', 'amazon.co.uk', 'ebay.co.uk', 'just-eat.co.uk',
  'deliveroo.co.uk', 'ubereats.com', 'booking.com', 'rightmove.co.uk', 'zoopla.co.uk', 'sponsorlist.co.uk', 'myvisajobs.co.uk',
  'uksponsorlicencechecker.co.uk', 'reddit.com', 'quora.com', 'medium.com', 'companiesintheuk.co.uk', 'find-and-update.company-information.service.gov.uk'
];

const BAD_EMAIL = /(example\.|sentry|wixpress|godaddy|domain\.com|email\.com|yourdomain|@\d|\.png$|\.jpe?g$|\.gif$|\.webp$|\.svg$|u00|noreply|no-reply|donotreply)/i;

function isDirectory(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return DIRECTORY_HOSTS.some(d => h === d || h.endsWith('.' + d) || (!d.includes('.') && h.includes(d)));
}

function registrable(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length >= 3 && ['co', 'org', 'ac', 'gov', 'ltd', 'plc', 'me', 'net', 'com'].includes(parts[parts.length - 2])) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

/* Likely addresses for an organisation's own site, built from its
   registered name: "AOC Homecare Ltd" -> aochomecare.co.uk, aoc-homecare.com
   and so on. A guess is only ever a candidate; it is accepted solely when
   the site proves it belongs to the organisation. */
function domainGuesses(name) {
  const words = nameKey(registeredPart(name)).split(' ').filter(w => w && !['and', 'of'].includes(w));
  if (!words.length) return [];
  const joined = words.join('');
  if (joined.length < 4 || joined.length > 40) return [];
  const stems = [...new Set([joined, words.join('-'), words.length > 2 ? words.slice(0, 2).join('') : null].filter(Boolean))];
  const out = [];
  for (const stem of stems) for (const tld of ['co.uk', 'com', 'uk']) out.push(stem + '.' + tld);
  return out.slice(0, 7);
}

/* DuckDuckGo's HTML results, with Bing's RSS results as the fallback.
   DuckDuckGo answers bulk use with an "unusual traffic" page served as
   HTTP 202, not an error, so that page is recognised and the engine is left
   alone for six hours rather than asked again. */
async function search(query) {
  if (!isBlocked('html.duckduckgo.com')) try {
    const html = await getText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { ttl: 7 * 86400000, accept: 'text/html' });
    if (/anomaly-modal|unusual traffic|challenge-form/i.test(html) && !/result__a/.test(html)) {
      block('html.duckduckgo.com', 6 * 3600000);
      throw new Error('DuckDuckGo asked this tool to stop for now');
    }
    const urls = [...html.matchAll(/class="result__a" href="([^"]+)"/g)].map(m => {
      const raw = decodeEntities(m[1]);
      const u = /[?&]uddg=([^&]+)/.exec(raw);
      return u ? decodeURIComponent(u[1]) : raw;
    }).filter(u => /^https?:\/\//.test(u));
    if (urls.length) return urls;
  } catch { /* fall through to Bing */ }
  if (isBlocked('www.bing.com')) return [];
  const rss = await getText('https://www.bing.com/search?format=rss&q=' + encodeURIComponent(query), { ttl: 7 * 86400000, accept: 'application/rss+xml' });
  return [...rss.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map(m => decodeEntities(m[1])).filter(u => /^https?:\/\//.test(u));
}

function extractEmails(html, siteHost) {
  const found = new Set();
  const decoded = decodeEntities(String(html || ''));
  for (const m of decoded.matchAll(/mailto:([^"'?\s>]+)/gi)) found.add(decodeURIComponent(m[1]).toLowerCase());
  for (const m of htmlToText(decoded).matchAll(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi)) found.add(m[0].toLowerCase());
  const site = registrable(siteHost);
  const free = /@(gmail|googlemail|outlook|hotmail|yahoo|icloud|live|aol|btinternet|sky|protonmail)\./i;
  return [...found].filter(e => !BAD_EMAIL.test(e) && (registrable(e.split('@')[1]) === site || free.test(e)));
}

/* UK numbers group differently by area: 020 7946 0000, 0113 496 0000,
   01632 960000, 07700 900000, 0300 123 4567. */
function formatUk(n) {
  if (n.length !== 11) return n;
  if (/^02/.test(n)) return n.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1 $2 $3');
  if (/^01\d1|^011/.test(n)) return n.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3');
  if (/^0[389]/.test(n)) return n.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3');
  return n.replace(/^(\d{5})(\d{6})$/, '$1 $2');
}

/* UK numbers in tel: links first, then in the page text. */
function extractPhones(html) {
  const out = [];
  const add = raw => {
    let d = String(raw).replace(/[^\d+]/g, '');
    if (d.startsWith('0044')) d = '+44' + d.slice(4);
    if (d.startsWith('44') && d.length === 12) d = '+' + d;
    if (d.startsWith('+440')) d = '+44' + d.slice(4);
    const national = d.startsWith('+44') ? '0' + d.slice(3) : d;
    if (!/^0[1-37-9]\d{8,9}$/.test(national)) return;
    if (/^0(\d)\1{8,}$/.test(national)) return;
    const pretty = formatUk(national);
    if (!out.includes(pretty)) out.push(pretty);
  };
  const decoded = decodeEntities(String(html || ''));
  for (const m of decoded.matchAll(/href="tel:([^"]+)"/gi)) add(decodeURIComponent(m[1]));
  for (const m of htmlToText(decoded).matchAll(/(?:\+44\s?\(?0?\)?\s?|\b0)(?:\d[\s-]?){9,10}\b/g)) add(m[0]);
  return out.slice(0, 3);
}

function extractLinkedIn(html) {
  const m = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[a-z0-9_%-]+/i.exec(String(html || ''));
  return m ? m[0] : '';
}

function contactLinks(html, base) {
  const out = [];
  for (const m of String(html || '').matchAll(/<a\s[^>]*href="([^"#]+)"[^>]*>([\s\S]{0,80}?)<\/a>/gi)) {
    const label = htmlToText(m[2]).toLowerCase();
    if (!/contact|get in touch|about|find us/.test(label + ' ' + m[1].toLowerCase())) continue;
    try {
      const u = new URL(decodeEntities(m[1]), base);
      if (hostOf(u.href) === hostOf(base) && !out.includes(u.href)) out.push(u.href);
    } catch { /* ignore bad links */ }
  }
  return out.slice(0, 2);
}

/* Does this site prove it belongs to the organisation? */
function proves(text, { name, town, postcode, number }) {
  const t = String(text || '');
  const flat = t.replace(/\s+/g, ' ');
  if (number && new RegExp('\\b0*' + String(number).replace(/^0+/, '') + '\\b').test(flat) && /compan(y|ies)\s*(reg|no|number|house)|registered/i.test(flat)) return 'Companies House number ' + number + ' shown on the site';
  if (postcode) {
    const pc = String(postcode).toUpperCase().replace(/\s+/g, '');
    if (flat.toUpperCase().replace(/\s+/g, '').includes(pc)) return 'Postcode ' + postcode + ' shown on the site';
  }
  const key = nameKey(registeredPart(name));
  if (key && key.length >= 6 && nameKey(flat).includes(key) && town && flat.toLowerCase().includes(String(town).toLowerCase())) return 'Name and town shown on the site';
  return null;
}

/* Returns { website, verifiedBy, emails:[{value,url}], phones:[{value,url}], linkedin } or null. */
async function find({ name, town = '', postcode = '', number = '' }) {
  const reg = registeredPart(name);
  const tried = new Set();
  const guessed = domainGuesses(reg).map(d => ({ host: d, guess: true }));
  const attempt = async ({ host, guess }) => {
    if (isDirectory(host)) return null;
    const root = registrable(host);
    if (tried.has(root)) return null;
    tried.add(root);
    const home = 'https://' + host + '/';
    let html;
    try { html = await getText(home, { ttl: 7 * 86400000, accept: 'text/html', timeout: guess ? 8000 : 12000, retry: false }); } catch { return null; }
    return checkSite(home, html, host, { name, town, postcode, number });
  };
  /* Guessed domains are different hosts, so their home pages are fetched
     together; most do not exist and fail at once, and a slow parked domain
     no longer holds up the rest. They are still judged in order. */
  await Promise.all(guessed.map(c => getText('https://' + c.host + '/', { ttl: 7 * 86400000, accept: 'text/html', timeout: 8000, retry: false }).catch(() => null)));
  for (const c of guessed) {
    const r = await attempt(c);
    if (r) return r;
  }
  let results = [];
  try { results = await search('"' + reg.replace(/"/g, '') + '" ' + (town || postcode || 'UK')); } catch { results = []; }
  for (const url of results) {
    if (tried.size >= guessed.length + 3) break;
    const r = await attempt({ host: hostOf(url), guess: false });
    if (r) return r;
  }
  return null;
}

/* Reads the home page and up to two contact or about pages, and returns the
   published details only if one of them proves the site is the organisation's. */
async function checkSite(home, html, host, who) {
  const pages = [{ url: home, html }];
  for (const link of contactLinks(html, home)) {
    try { pages.push({ url: link, html: await getText(link, { ttl: 7 * 86400000, accept: 'text/html', timeout: 15000 }) }); } catch { /* skip */ }
  }
  let verifiedBy = null;
  for (const p of pages) {
    verifiedBy = proves(htmlToText(p.html), who);
    if (verifiedBy) break;
  }
  if (!verifiedBy) return null;
  const emails = [], phones = [];
  let linkedin = '';
  for (const p of pages) {
    for (const e of extractEmails(p.html, host)) if (!emails.some(x => x.value === e)) emails.push({ value: e, url: p.url });
    for (const ph of extractPhones(p.html)) if (!phones.some(x => x.value === ph)) phones.push({ value: ph, url: p.url });
    linkedin = linkedin || extractLinkedIn(p.html);
  }
  return { website: home, verifiedBy, emails: emails.slice(0, 3), phones: phones.slice(0, 3), linkedin };
}

module.exports = { find, proves, extractEmails, extractPhones, isDirectory, registrable, domainGuesses, oneLine };
