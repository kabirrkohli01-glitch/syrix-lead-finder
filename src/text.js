'use strict';
/* Text helpers shared by every source: HTML to plain text, CSV parsing,
 * company-name normalisation and quoting the sentence that matched. */

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', pound: '£', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·' };

function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, code.toLowerCase()) ? NAMED[code.toLowerCase()] : m;
  });
}

/* HTML to readable text. Block-level tags become line breaks so sentences in
   different paragraphs never run together into one false match. */
function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th|blockquote|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/​/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function clip(s, n) {
  s = oneLine(s);
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const space = cut.lastIndexOf(' ');
  return (space > n * 0.6 ? cut.slice(0, space) : cut) + '…';
}

/* RFC 4180 CSV: quoted fields may contain commas, quotes ("") and newlines.
   The sponsor register needs this — organisation names carry commas. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toCsv(rows) {
  return rows.map(r => r.map(v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

/* Company names compared the way Companies House compares them: case,
   punctuation, "&"/"and", "the", and the legal ending (Ltd, Limited, PLC,
   LLP, Co, Company) do not distinguish two companies. Words that do — Group,
   Holdings, UK, a place in brackets — are kept, or "Excellence Care Ltd"
   would collide with "Excellence Care Group Ltd" and "Excellence Care
   (Oxford) Ltd". Used for matching, never shown. */
const NOISE = /\b(limited|ltd|plc|llp|lp|cic|cio|co|company|the)\b/g;
function nameKey(name) {
  return oneLine(String(name || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(NOISE, ' '));
}

/* Only the registered name before any trading-name clause: "X Ltd T/A Y"
   is registered at Companies House as "X Ltd". */
function registeredPart(name) {
  let s = String(name || '').split(/\s+(?:t\/a|trading as|operating as|o\/a)\s+/i)[0].replace(/\((?:the )?operating name of.*$/i, '');
  /* "ELEADA LIMITED/ELEADA CARE SERVICES LIMITED" lists two companies; the
     first is the licence holder. */
  const parts = s.split(/\s*\/\s*/);
  if (parts.length > 1 && /\b(ltd|limited|llp|plc)\b/i.test(parts[0])) s = parts[0];
  return oneLine(s);
}

function titleCase(s) {
  return oneLine(s).toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase())
    .replace(/\b(Ltd|Llp|Plc|Uk|Cic)\b/g, m => m.toUpperCase().replace('LTD', 'Ltd'));
}

/* The sentence around a match, so every claim the app makes can show the
   exact words it rests on. */
function quoteAround(text, index, length, max = 240) {
  const t = String(text || '');
  if (index < 0) return '';
  let start = Math.max(0, t.lastIndexOf('\n', index) + 1);
  for (const stop of ['. ', '? ', '! ']) {
    const p = t.lastIndexOf(stop, index);
    if (p + 2 > start && p >= 0) start = p + 2;
  }
  let end = t.length;
  const nl = t.indexOf('\n', index + length);
  if (nl >= 0) end = Math.min(end, nl);
  for (const stop of ['. ', '? ', '! ']) {
    const p = t.indexOf(stop, index + length);
    if (p >= 0 && p + 1 < end) end = p + 1;
  }
  let q = oneLine(t.slice(start, end));
  if (q.length > max) {
    const rel = index - start;
    const from = Math.max(0, rel - Math.floor(max / 2));
    q = (from > 0 ? '…' : '') + oneLine(t.slice(start + from, start + from + max)) + '…';
  }
  return q;
}

module.exports = { decodeEntities, htmlToText, oneLine, clip, parseCsv, toCsv, nameKey, registeredPart, titleCase, quoteAround };
