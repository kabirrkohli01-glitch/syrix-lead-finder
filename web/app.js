'use strict';
/* SYRIX Lead Finder — interface.
 *
 * The page's Content Security Policy forbids inline event handlers, so every
 * control carries a data-act attribute and one delegated listener on the
 * document dispatches it through ACTIONS.
 */

const state = {
  leads: [],
  status: 'active',
  selected: null,
  services: [],
  sources: [],
  running: false,
  lastRunEnd: null,
  showSources: false,
  showSteps: false,
  view: 'all',
  limit: 150
};

/* Quick views: the questions people actually start with, one click each.
   "Actively looking" means the lead itself asked (a tender or a post);
   everything else has an evidenced need but has not asked. */
const LOOKING = new Set(['tender', 'post']);
const VIEWS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'looking', label: 'Actively looking', test: l => LOOKING.has(l.signal.type) },
  { id: 'licence', label: 'Sponsor licence problems', test: l => l.signal.type === 'sponsor-b' || l.signal.type === 'sponsor-removed' },
  { id: 'expanding', label: 'Expanding into the UK', test: l => l.signal.type === 'sponsor-expansion' },
  { id: 'new-sponsors', label: 'New sponsors', test: l => l.signal.type === 'sponsor-new' },
  { id: 'fines', label: 'Compliance fines', test: l => l.signal.type === 'penalty' },
  { id: 'people', label: 'People', test: l => l.kind === 'person' },
  { id: 'reachable', label: 'Ready to contact', test: l => !!(l.contact && (l.contact.email || l.contact.phone)) },
  { id: 'closing', label: 'Closing in 14 days', test: l => { const d = Date.parse(l.deadline || ''); return Number.isFinite(d) && d > Date.now() && d - Date.now() < 14 * 86400000; } }
];

/* The dropdown filters. "Who" and "contact" dropdowns were dropped: the
   People and Ready to contact views answer the same questions, and the
   duplicates could combine into views that are always empty. */
const FILTERS = ['#f-q', '#f-service', '#f-source', '#f-age'];

const $ = sel => document.querySelector(sel);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function safeUrl(u) {
  try {
    const url = new URL(String(u || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch { return ''; }
}

function link(u, label) {
  const href = safeUrl(u);
  if (!href) return esc(label || u || '');
  return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(label || href) + '</a>';
}

function ago(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const h = Math.round(mins / 60);
  if (h < 24) return h + ' h ago';
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d + ' days ago';
}

function dateShort(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
}

function monthShort(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
}

/* The original date of a lead's evidence (worked out by the server, see
   src/freshness.js), never the date the app found it. */
function originOf(l) {
  return l.origin || { at: null, text: 'Date not published', basis: 'none' };
}

function originAt(l) {
  const t = Date.parse(originOf(l).at || '');
  return Number.isFinite(t) ? t : null;
}

/* One line for a card: "Posted 7 Sep 2026 · 29 days ago", or a period
   such as "Penalties issued Jan–Mar 2026". */
function originShort(l) {
  const o = originOf(l);
  if (!o.at) return o.text;
  if (o.from) {
    const a = monthShort(o.from), b = monthShort(o.at);
    const start = a.slice(-4) === b.slice(-4) ? a.slice(0, -5) : a;
    return o.label + ' ' + (a === b ? b : start + '–' + b);
  }
  return o.label + ' ' + dateShort(o.at) + ' · ' + ago(o.at);
}

function dateLong(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function untilText(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const days = Math.ceil((t - Date.now()) / 86400000);
  if (days < 0) return 'closed';
  if (days === 0) return 'closes today';
  return 'closes in ' + days + (days === 1 ? ' day' : ' days');
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'syrix-lead-finder' },
    body: JSON.stringify(body)
  };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
  return data;
}

/* ---------- filtering ---------- */

/* Leads in the current tab that pass the dropdown filters and the search.
   The quick views count from this list, so a view's number always matches
   what it shows. */
function inFilters() {
  const q = $('#f-q').value.trim().toLowerCase();
  const service = $('#f-service').value;
  const source = $('#f-source').value;
  const age = $('#f-age').value;
  let out = state.leads.filter(l => l.status === state.status);
  if (service) out = out.filter(l => (l.services || []).some(s => s.id === service));
  if (source) out = out.filter(l => l.source === source);
  if (age === 'none') out = out.filter(l => originAt(l) == null);
  else if (age) {
    const since = Date.now() - Number(age) * 86400000;
    out = out.filter(l => { const t = originAt(l); return t != null && t >= since; });
  }
  if (q) {
    out = out.filter(l => [l.name, l.headline, l.location, l.sourceLabel, l.signal && l.signal.label, l.signal && l.signal.quote, l.signal && l.signal.detail,
      l.contact && l.contact.person, l.company && l.company.number, (l.services || []).map(s => s.name).join(' '), l.notes]
      .join(' ').toLowerCase().includes(q));
  }
  return out;
}

/* Every comparison returns a number: a lead with no date or no deadline
   sorts after the rest. Infinity minus Infinity is NaN, which left the
   order of those leads to chance. */
function last(a, b, key) {
  const x = key(a), y = key(b);
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return x - y;
}

const SORTS = {
  score: (a, b) => (b.score || 0) - (a.score || 0),
  newest: (a, b) => last(a, b, l => { const t = originAt(l); return t == null ? null : -t; }) || (b.score || 0) - (a.score || 0),
  deadline: (a, b) => last(a, b, l => { const t = Date.parse(l.deadline || ''); return Number.isFinite(t) ? t : null; }) || (b.score || 0) - (a.score || 0)
};

function filtered() {
  const view = VIEWS.find(v => v.id === state.view) || VIEWS[0];
  return inFilters().filter(view.test).sort(SORTS[$('#f-sort').value] || SORTS.score);
}

/* ---------- rendering ---------- */

function scoreClass(s) { return s >= 70 ? '' : s >= 55 ? 'mid' : 'low'; }

const SCORE_HELP = 'SYRIX score, 0 to 100: how strong and current the evidence of need is — whether they asked directly, how recent it is, how many the consultancy services fit, and whether contact details are known. It ranks leads; it is not a chance of winning the work.';

/* Marks the layout while a lead is open (used for styling the open state). */
function syncLayout() {
  const open = !!state.selected && state.leads.some(l => l.id === state.selected);
  $('.layout').classList.toggle('has-detail', open);
}

function anyFilter() {
  return state.view !== 'all' || FILTERS.some(id => $(id).value);
}

function renderViews() {
  const inTab = inFilters();
  $('#views').innerHTML = VIEWS.map(v => {
    const n = inTab.filter(v.test).length;
    if (!n && v.id !== 'all' && state.view !== v.id) return '';
    return '<button class="view' + (state.view === v.id ? ' is-on' : '') + '" data-act="view" data-view="' + v.id + '" type="button">' + esc(v.label) + '<span>' + n.toLocaleString('en-GB') + '</span></button>';
  }).join('');
  $('#clear-filters').hidden = !anyFilter();
}

function card(l) {
  const c = l.contact || {};
  const chips = [LOOKING.has(l.signal.type) ? '<span class="chip tag-looking">Actively looking</span>' : '<span class="chip tag-need">Has a need</span>'];
  chips.push(...(l.services || []).slice(0, 2).map(s => '<span class="chip">' + esc(s.name) + '</span>'));
  if (c.email) chips.push('<span class="chip contact">Email</span>');
  if (c.phone) chips.push('<span class="chip contact">Phone</span>');
  if (!c.email && !c.phone && c.handle) chips.push('<span class="chip contact">Message on site</span>');
  if (l.deadline && l.status === 'active') chips.push('<span class="chip deadline">' + esc(untilText(l.deadline)) + '</span>');
  return '<button class="card' + (state.selected === l.id ? ' is-selected' : '') + '" data-act="select" data-id="' + esc(l.id) + '" type="button">' +
    '<div class="score-wrap" title="' + esc(SCORE_HELP) + '"><div class="score ' + scoreClass(l.score || 0) + '">' + esc(l.score == null ? '–' : l.score) + '</div><div class="score-label">SYRIX score</div></div>' +
    '<div>' +
      '<div class="card-kind">' + (l.kind === 'person' ? 'Person' : 'Organisation') + ' · ' + esc(l.signal.label) + '</div>' +
      '<div class="card-title">' + esc(l.name) + '</div>' +
      '<div class="card-headline">' + esc(l.headline) + '</div>' +
      '<div class="chips">' + chips.join('') + '</div>' +
      '<div class="card-meta"><span class="card-date' + (originOf(l).at ? '' : ' is-undated') + '">' + esc(originShort(l)) + '</span><span>' + esc(l.sourceLabel) + '</span>' + (l.location ? '<span>' + esc(l.location) + '</span>' : '') + '</div>' +
    '</div>' +
  '</button>';
}

function renderList() {
  renderFilterOptions();
  renderViews();
  const items = filtered();
  const list = $('#list');
  if (!items.length) {
    const msg = state.leads.length
      ? 'Nothing here matches. Try another view or clear the filters.'
      : state.running ? 'SYRIX is searching the sources now. Leads appear here as they are found.' : 'No leads yet. Press “Find leads now” to search every source.';
    list.innerHTML = '<div class="empty">' + esc(msg) + '</div>';
    return;
  }
  const shown = items.slice(0, state.limit);
  const sortLabel = { score: 'highest SYRIX score first', newest: 'most recently published first', deadline: 'closing soonest first' }[$('#f-sort').value];
  list.innerHTML = '<p class="list-note">' + items.length.toLocaleString('en-GB') + ' lead' + (items.length === 1 ? '' : 's') + ' · ' + sortLabel + '</p>' +
    shown.map(card).join('') +
    (items.length > shown.length ? '<button class="btn btn-line more" data-act="more" type="button">Show ' + Math.min(150, items.length - shown.length) + ' more of ' + (items.length - shown.length).toLocaleString('en-GB') + ' remaining</button>' : '');
}

function contactRow(label, value, source, extra = '') {
  if (!value) return '';
  return '<dt>' + esc(label) + '</dt><dd>' + value + extra + (source ? '<span class="prov">' + (safeUrl(source) ? 'Found on ' + link(source, new URL(source).host + new URL(source).pathname.replace(/\/$/, '')) : esc(source)) + '</span>' : '') + '</dd>';
}

/* Links that open the evidence (the post, the tender, the report), named
   by the server for what they open. Older data without them falls back to
   the signal's own link. */
function evidenceLinks(l) {
  if (Array.isArray(l.links) && l.links.length) return l.links.filter(x => safeUrl(x.url));
  return safeUrl(l.signal && l.signal.url) ? [{ url: l.signal.url, label: 'Open on ' + l.sourceLabel }] : [];
}

function outLink(u, label, cls) {
  const href = safeUrl(u);
  if (!href) return '';
  return '<a class="btn ' + cls + '" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '<span class="ext" aria-hidden="true">↗</span></a>';
}

/* A subject line that tells the recipient straight away why the consultancy is
   writing: the tender's title, or the service the evidence points to. */
function emailHref(l, email) {
  const service = (l.services || [])[0];
  const subject = l.signal.type === 'tender' ? 'Re: ' + l.headline : 'Enquiry' + (service ? ': ' + service.name : '');
  return 'mailto:' + email + '?subject=' + encodeURIComponent(subject.slice(0, 140));
}

function telHref(phone) {
  return 'tel:' + String(phone).replace(/[^\d+]/g, '');
}

/* One row of actions at the top of a lead: open the evidence, then every
   published way to reach them, most direct first. People are reached only
   where they posted (see the guidance under Sources). */
function reachBar(l) {
  const c = l.contact || {};
  const links = evidenceLinks(l);
  const open = links.length ? outLink(links[0].url, links[0].label, 'btn-navy') : '';
  const contact = [];
  if (l.kind === 'person') {
    if (safeUrl(l.signal.url)) contact.push(outLink(l.signal.url, l.source === 'reddit' ? 'Reply on Reddit' : 'Reply in the thread', 'btn-gold'));
    if (c.handle && safeUrl(c.profileUrl)) contact.push(outLink(c.profileUrl, 'View ' + c.handle, 'btn-line'));
  } else {
    if (c.email) contact.push('<a class="btn btn-gold" href="' + esc(emailHref(l, c.email)) + '">Email ' + esc(c.person ? c.person.split(' ')[0] : c.email) + '</a>');
    if (c.phone) contact.push('<a class="btn btn-gold" href="' + esc(telHref(c.phone)) + '">Call ' + esc(c.phone) + '</a>');
    if (c.website) contact.push(outLink(c.website, 'Website', 'btn-line'));
    if (c.linkedin) contact.push(outLink(c.linkedin, 'LinkedIn', 'btn-line'));
  }
  const more = links.slice(1).map(x => outLink(x.url, x.label, 'btn-line')).join('');
  if (!open && !contact.length && !more) return '';
  return '<div class="reach">' + open + contact.join('') + more +
    (l.kind === 'organisation' && !c.email && !c.phone ? '<span class="reach-note">' + esc(l.enrichedAt ? 'No published email or phone number' : 'Looking up contact details') + '</span>' : '') +
    '</div>';
}

function renderDetail() {
  const l = state.leads.find(x => x.id === state.selected);
  const box = $('#detail');
  syncLayout();
  if (!l) {
    box.dataset.id = '';
    box.innerHTML = '<div class="empty-detail"><h2>Select a lead</h2><p>Each lead shows a SYRIX overview, how to reach them, why it is a lead with the published words that prove it, and what the consultancy could help with.</p><p class="muted">Tip: use the ↑ and ↓ keys to move through the list, and O to open the selected lead’s source.</p></div>';
    return;
  }
  const c = l.contact || {};
  const src = c.sources || {};
  const statusButtons = [
    ['active', 'Active'], ['contacted', 'Mark contacted'], ['won', 'Mark won'], ['dismissed', 'Not a fit']
  ].map(([s, label]) => '<button class="btn btn-line btn-small' + (l.status === s ? ' is-on' : '') + '" data-act="status" data-status="' + s + '" type="button">' + esc(label) + '</button>').join('');

  const tooLate = l.status === 'too-late' ? (l.history || []).slice().reverse().find(h => h.status === 'too-late') : null;
  const services = (l.services || []).map(s => '<div class="service"><div class="service-name">' + esc(s.name) + '</div><div class="service-why">' + esc(s.quote ? '“' + s.quote + '”' : s.matched) + '</div></div>').join('');

  const copyBtn = v => '<button class="btn btn-line btn-small copy" data-act="copy" data-value="' + esc(v) + '" type="button">Copy</button>';
  const contactRows = [
    contactRow('Contact', esc(c.person) + (c.role ? ' <span class="muted">— ' + esc(c.role) + '</span>' : ''), src.person, ''),
    contactRow('Email', c.email ? '<a href="' + esc(emailHref(l, c.email)) + '">' + esc(c.email) + '</a>' : '', src.email || (c.email ? c.provenance : ''), c.email ? copyBtn(c.email) : ''),
    contactRow('Phone', c.phone ? '<a href="' + esc(telHref(c.phone)) + '">' + esc(c.phone) + '</a>' : '', src.phone || (c.phone ? c.provenance : ''), c.phone ? copyBtn(c.phone) : ''),
    contactRow('Website', c.website ? link(c.website) : '', src.website ? (safeUrl(src.website) ? src.website : 'Verified: ' + src.website) : ''),
    contactRow('LinkedIn', c.linkedin ? link(c.linkedin, 'Company page') : ''),
    contactRow('Address', c.address ? esc(c.address) : '', src.address),
    contactRow('Username', c.handle ? (c.profileUrl ? link(c.profileUrl, c.handle) : esc(c.handle)) : '', '', c.handle ? copyBtn(c.handle) : ''),
    contactRow('How to reach', c.channel ? esc(c.channel) : '')
  ].join('');

  const facts = (l.facts || []).map(f => '<dt>' + esc(f.label) + '</dt><dd>' + (f.url ? link(f.url, f.value) : esc(f.value)) + '</dd>').join('');
  const history = (l.history || []).slice().reverse().map(h =>
    '<li><div><span class="' + (h.by === 'system' && h.status === 'too-late' ? 'by-system' : '') + '">' + esc(statusLabel(h.status)) + '</span> — ' + esc(h.reason || '') + '</div>' +
    (h.quote ? '<div class="quote">' + esc(h.quote) + '</div>' : '') +
    (h.evidenceUrl ? '<div>' + link(h.evidenceUrl, 'See the evidence') + '</div>' : '') +
    '<div class="when">' + esc(dateLong(h.at)) + (h.by === 'system' ? ' · by the system' : h.by === 'user' ? ' · by you' : '') + '</div></li>').join('');

  /* The same lead redrawn by a background refresh keeps its scroll position
     and any unsaved notes; only a different lead starts at the top. */
  const sameLead = box.dataset.id === l.id;
  const keepScroll = sameLead ? box.scrollTop : 0;
  const draft = sameLead && $('#notes') ? $('#notes').value : null;
  const looking = LOOKING.has(l.signal.type);

  box.innerHTML =
    '<div class="d-inner' + (sameLead ? '' : ' is-new') + '">' +
    '<div class="d-head">' +
      '<button class="d-close" data-act="close-detail" type="button" title="Close (Esc)" aria-label="Close the lead">×</button>' +
      '<div class="d-kind">' + (l.kind === 'person' ? 'Person' : 'Organisation') + ' · ' + esc(l.sourceLabel) + '<span class="d-tag ' + (looking ? 'tag-looking' : 'tag-need') + '">' + (looking ? 'Actively looking' : 'Has a need') + '</span></div>' +
      '<div class="d-name">' + esc(l.name) + '</div>' +
      '<div class="d-sub">' + esc([l.location, originShort(l)].filter(Boolean).join(' · ')) +
        (l.score != null ? '<span class="d-score" title="' + esc(SCORE_HELP) + '"><b>' + esc(l.score) + '</b> SYRIX score</span>' : '') + '</div>' +
      reachBar(l) +
      '<div class="d-actions">' + statusButtons + '<button class="btn btn-line btn-small" data-act="export-one" type="button">Export</button></div>' +
    '</div>' +
    (tooLate ? '<div class="note-banner too-late"><strong>Too late:</strong> ' + esc(tooLate.reason) + (tooLate.evidenceUrl ? ' — ' + link(tooLate.evidenceUrl, 'evidence') : '') + '</div>' : '') +
    (l.deadline && l.status !== 'too-late' ? '<div class="note-banner"><strong>Deadline:</strong> ' + esc(dateLong(l.deadline)) + ' (' + esc(untilText(l.deadline)) + ')</div>' : '') +
    '<div class="d-section ov" id="ov-box" data-id="' + esc(l.id) + '"></div>' +
    '<div class="d-section"><h3>How to reach them</h3>' + (contactRows ? '<dl class="kv">' + contactRows + '</dl>' : '<p class="muted">' + (l.kind === 'organisation' && !l.enrichedAt ? 'Contact details are being looked up on Companies House and the organisation’s own website, strongest leads first.' : 'No published contact details were found.') + '</p>') + '</div>' +
    '<div class="d-section"><h3>Why this is a lead</h3>' +
      '<div class="d-signal">' + esc(l.signal.label) + '</div>' +
      '<div>' + esc(l.signal.detail) + '</div>' +
      (l.signal.quote ? '<div class="quote">' + esc(l.signal.quote) + '</div>' : '') +
      '<div class="evidence-links">' + evidenceLinks(l).map(x => outLink(x.url, x.label, 'btn-line btn-small')).join('') + '</div>' +
    '</div>' +
    renderDates(l) +
    '<div class="d-section"><h3>What the consultancy could help with</h3>' + (services || '<p class="muted">No service matched.</p>') + '</div>' +
    (facts ? '<div class="d-section"><h3>More about them</h3><dl class="kv">' + facts + '</dl></div>' : '') +
    '<div class="d-section"><h3>Notes</h3><textarea id="notes" placeholder="Calls, emails, next steps…">' + esc(draft != null ? draft : l.notes || '') + '</textarea><div class="notes-row"><button class="btn btn-line btn-small" data-act="save-notes" type="button">Save notes</button></div></div>' +
    '<details class="d-section d-fold"><summary><h3>Why the SYRIX score is ' + esc(l.score == null ? '–' : l.score) + '</h3></summary><ul class="reasons">' + (l.scoreReasons || []).map(r => '<li>' + esc(r) + '</li>').join('') + '</ul><p class="muted score-note">The SYRIX score ranks leads by how strong and current the evidence is. It is not a chance of winning the work.</p></details>' +
    '<details class="d-section d-fold"><summary><h3>History</h3></summary><ul class="history">' + history + '</ul></details>' +
    '</div>';
  box.dataset.id = l.id;
  box.scrollTop = keepScroll;
  if (window.LF && window.LF.onDetail) window.LF.onDetail(l);
}

/* When the evidence was first published, kept apart from when the app found
   it: for register-based leads the two can be years apart. */
function renderDates(l) {
  const o = originOf(l);
  const original = o.at
    ? esc(o.text) + (o.from ? '' : ' <span class="muted">(' + esc(ago(o.at)) + ')</span>')
    : esc(o.text);
  return '<div class="d-section"><h3>When</h3><dl class="kv">' +
    '<dt>Original date</dt><dd>' + original + (o.note ? '<span class="prov">' + esc(o.note) + (o.basis === 'bound' && safeUrl(o.url) ? ' ' + link(o.url, 'Companies House record') : '') + '</span>' : '') + '</dd>' +
    '<dt>Found by this app</dt><dd>' + esc(dateLong(l.foundAt)) + '</dd>' +
    '</dl></div>';
}

/* Opens a lead from anywhere (SYRIX links to leads by id): switches to the
   tab it sits in, clears filters that would hide it, and selects it. */
function openLead(id) {
  const l = state.leads.find(x => x.id === id);
  if (!l) { toast('That lead is no longer in the app'); return; }
  if (state.status !== l.status) {
    state.status = l.status;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-on', t.dataset.status === l.status);
  }
  for (const f of FILTERS) $(f).value = '';
  state.view = 'all';
  state.selected = id;
  renderList();
  renderDetail();
  const card = document.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
  if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* What SYRIX is told about the screen, so "this lead" means the open one. */
function currentView() {
  const view = VIEWS.find(v => v.id === state.view);
  const filters = [['#f-q', 'search'], ['#f-service', 'service'], ['#f-source', 'source'], ['#f-age', 'originally published']]
    .map(([id, label]) => { const el = $(id); const v = el.value; if (!v) return ''; const text = el.options ? (el.options[el.selectedIndex] || {}).text : v; return label + ' = ' + (text || v); })
    .filter(Boolean).concat(view && view.id !== 'all' ? ['view = ' + view.label] : []).join('; ');
  return { tab: statusLabel(state.status), filters, selected: state.selected };
}

function statusLabel(s) {
  return { active: 'Active', contacted: 'Contacted', won: 'Won', dismissed: 'Not a fit', 'too-late': 'Too late' }[s] || s;
}

function renderCounts(counts) {
  for (const el of document.querySelectorAll('[data-count]')) el.textContent = (counts[el.dataset.count] || 0).toLocaleString('en-GB');
}

/* Search progress opens as a small panel from the status in the top bar, so
   a search starting or finishing never pushes the page up or down. */
function renderSteps(pipeline) {
  const box = $('#steps');
  const steps = pipeline.steps || [];
  box.hidden = !state.showSteps;
  if (!steps.length) { $('#step-list').innerHTML = '<li class="is-skipped">No search has run since the app started.</li>'; return; }
  $('#step-list').innerHTML = steps.map(s => '<li class="is-' + esc(s.state) + '">' + esc(s.name) + (s.detail ? '<span class="step-detail">' + esc(s.detail) + '</span>' : '') + '</li>').join('');
}

function renderSources() {
  $('#source-list').innerHTML = state.sources.map(s =>
    '<div class="source"><div class="source-head"><span class="source-name">' + esc(s.label) + '</span>' +
    '<button class="btn btn-line btn-small' + (s.enabled ? ' is-on' : '') + '" data-act="toggle-source" data-id="' + esc(s.id) + '" data-enabled="' + (s.enabled ? '1' : '0') + '" type="button">' + (s.enabled ? 'On' : 'Off') + '</button></div>' +
    '<div class="source-meta">' + (s.lastOk ? 'Last read ' + esc(ago(s.lastOk)) + ' · ' + esc((s.lastFound || 0).toLocaleString('en-GB')) + ' current leads' + (s.lastScanned ? ' from ' + esc(Number(s.lastScanned).toLocaleString('en-GB')) + ' records' : '') : 'Not read yet') + ' · checks every ' + esc(Math.round(s.every / 3600000)) + ' h</div>' +
    (s.note ? '<div class="source-meta">' + esc(s.note) + '</div>' : '') +
    (s.lastError ? '<div class="source-error">Last attempt failed: ' + esc(s.lastError) + '</div>' : '') +
    '</div>').join('');
}

function renderRunStatus(p) {
  const el = $('#run-status');
  const btn = $('#run-btn');
  el.classList.toggle('is-running', p.running);
  btn.disabled = p.running;
  /* A fixed phrase while searching: the step-by-step detail lives in the
     strip below the bar, and text that changes length on every poll made the
     bar re-wrap and jump. */
  if (p.running) {
    el.textContent = 'SYRIX is searching for leads…';
  } else if (p.lastRun && p.lastRun.endedAt) {
    el.textContent = 'Last search ' + ago(p.lastRun.endedAt) + ' · ' + p.lastRun.created + ' new';
  } else el.textContent = 'Not searched yet';
}

/* Rebuilds a dropdown only when its options change. Rewriting it on every
   poll closed it while it was open. A chosen option with no leads left
   stays listed, so the filter never changes silently under the user. */
function fillSelect(id, options) {
  const sel = $(id);
  const current = sel.value;
  if (current && !options.some(([v]) => v === current)) options = [...options, [current, labelFor(id, current) + ' (0)']];
  const html = options.map(([v, t]) => '<option value="' + esc(v) + '">' + esc(t) + '</option>').join('');
  if (sel.dataset.built === html) return;
  sel.dataset.built = html;
  sel.innerHTML = sel.options[0].outerHTML + html;
  sel.value = current;
}

function labelFor(id, value) {
  if (id === '#f-service') return (state.services.find(s => s.id === value) || {}).name || value;
  if (id === '#f-source') return (state.sources.find(s => s.id === value) || {}).label || value;
  return value;
}

/* Service and source lists offer only what the current tab holds, with
   counts, so no option leads to an empty list. */
function renderFilterOptions() {
  const inTab = state.leads.filter(l => l.status === state.status);
  const bySvc = new Map(), bySrc = new Map();
  for (const l of inTab) {
    for (const s of l.services || []) bySvc.set(s.id, (bySvc.get(s.id) || 0) + 1);
    bySrc.set(l.source, (bySrc.get(l.source) || 0) + 1);
  }
  const named = (list, counts, name) => list.filter(x => counts.get(x.id)).map(x => [x.id, x[name] + ' (' + counts.get(x.id).toLocaleString('en-GB') + ')']);
  fillSelect('#f-service', named(state.services, bySvc, 'name'));
  fillSelect('#f-source', named(state.sources, bySrc, 'label'));
}

/* ---------- data ---------- */

async function loadLeads() {
  const { leads } = await api('/api/leads');
  state.leads = leads;
  renderList();
  renderDetail();
}

async function poll() {
  try {
    const s = await api('/api/state');
    const wasRunning = state.running;
    state.running = s.pipeline.running;
    const firstState = !state.services.length;
    state.services = s.services;
    state.sources = s.sources;
    if (firstState) renderFilterOptions();
    renderCounts(s.counts);
    renderRunStatus(s.pipeline);
    renderSteps(s.pipeline);
    if (state.showSources) renderSources();
    const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
    if ((wasRunning && !state.running) || total !== state.leads.length || (state.running && Date.now() - (poll.lastLoad || 0) > 8000)) {
      poll.lastLoad = Date.now();
      await loadLeads();
    }
  } catch (err) {
    $('#run-status').textContent = 'Cannot reach the app: ' + err.message;
  }
  clearTimeout(poll.timer);
  poll.timer = setTimeout(poll, state.running ? 2000 : 15000);
}

/* The export is posted rather than put in a link, because a view can hold
   thousands of leads and their IDs would not fit in a URL. */
async function download(ids, name) {
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'syrix-lead-finder' },
      body: JSON.stringify({ ids })
    });
    if (!res.ok) throw new Error('Export failed (' + res.status + ')');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name + ' ' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Exported ' + ids.length + ' lead' + (ids.length === 1 ? '' : 's') + ' — opens in Excel or Google Sheets');
  } catch (err) { toast(err.message); }
}

/* ---------- actions ---------- */

const ACTIONS = {
  async run() {
    try { await api('/api/run', {}); toast('Searching every source'); state.running = true; poll(); }
    catch (err) { toast(err.message); }
  },
  tab(el) {
    state.status = el.dataset.status;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-on', t === el);
    state.selected = null;
    state.limit = 150;
    renderList();
    renderDetail();
  },
  view(el) {
    state.view = el.dataset.view;
    state.limit = 150;
    renderList();
  },
  'clear-filters'() {
    state.view = 'all';
    state.limit = 150;
    for (const f of FILTERS) $(f).value = '';
    renderList();
  },
  more() {
    state.limit += 150;
    renderList();
  },
  'toggle-steps'() {
    state.showSteps = !state.showSteps;
    $('#steps').hidden = !state.showSteps;
  },
  select(el) {
    state.selected = el.dataset.id;
    for (const c of document.querySelectorAll('.card')) c.classList.toggle('is-selected', c === el);
    renderDetail();
    if (window.matchMedia('(max-width: 900px)').matches) $('#detail').scrollIntoView({ behavior: 'smooth' });
    else el.scrollIntoView({ block: 'nearest' });
  },
  'close-detail'() {
    const was = state.selected;
    state.selected = null;
    renderDetail();
    for (const c of document.querySelectorAll('.card')) c.classList.remove('is-selected');
    const card = was && document.querySelector('.card[data-id="' + CSS.escape(was) + '"]');
    if (card) card.scrollIntoView({ block: 'center' });
  },
  async status(el) {
    try {
      const { lead } = await api('/api/leads/' + encodeURIComponent(state.selected) + '/status', { status: el.dataset.status });
      const i = state.leads.findIndex(l => l.id === lead.id);
      if (i >= 0) state.leads[i] = lead;
      toast('Moved to ' + statusLabel(lead.status));
      renderList();
      renderDetail();
      poll();
    } catch (err) { toast(err.message); }
  },
  async 'save-notes'() {
    try {
      const { lead } = await api('/api/leads/' + encodeURIComponent(state.selected) + '/notes', { notes: $('#notes').value });
      const i = state.leads.findIndex(l => l.id === lead.id);
      if (i >= 0) state.leads[i] = lead;
      toast('Notes saved');
    } catch (err) { toast(err.message); }
  },
  async copy(el) {
    try { await navigator.clipboard.writeText(el.dataset.value); toast('Copied'); }
    catch { toast('Copy is not available here'); }
  },
  export() {
    const ids = filtered().map(l => l.id);
    if (!ids.length) { toast('Nothing to export in this view'); return; }
    download(ids, 'Leads ' + statusLabel(state.status));
  },
  'export-one'() {
    const l = state.leads.find(x => x.id === state.selected);
    if (l) download([l.id], 'Lead ' + l.name.replace(/[^\w .-]+/g, ' ').trim());
  },
  'toggle-sources'() {
    state.showSources = !state.showSources;
    $('#sources').hidden = !state.showSources;
    if (state.showSources) renderSources();
  },
  async 'toggle-source'(el) {
    try {
      await api('/api/sources/' + encodeURIComponent(el.dataset.id), { enabled: el.dataset.enabled !== '1' });
      await poll();
    } catch (err) { toast(err.message); }
  }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});

for (const id of [...FILTERS, '#f-sort']) {
  $(id).addEventListener(id === '#f-q' ? 'input' : 'change', () => { state.limit = 150; renderList(); });
}

/* ↑ and ↓ move through the list when the focus is not in a text field;
   Escape closes the open lead. */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.selected && !(e.target.closest && e.target.closest('.syrix'))) { ACTIONS['close-detail'](); return; }
  if (e.target.closest && e.target.closest('input, textarea, select, .syrix')) return;
  if ((e.key === 'o' || e.key === 'O') && !e.ctrlKey && !e.metaKey && !e.altKey && state.selected) {
    const l = state.leads.find(x => x.id === state.selected);
    const first = l && evidenceLinks(l)[0];
    if (first) { e.preventDefault(); window.open(first.url, '_blank', 'noopener'); }
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const cards = [...document.querySelectorAll('.card')];
  if (!cards.length) return;
  e.preventDefault();
  const i = cards.findIndex(c => c.dataset.id === state.selected);
  const next = cards[Math.max(0, Math.min(cards.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)))];
  ACTIONS.select(next);
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

/* Shared with syrix.js, which adds its own actions to ACTIONS rather than a
   second click listener. */
window.LF = { ACTIONS, api, esc, safeUrl, toast, openLead, currentView, state, onDetail: null };

poll();
loadLeads().catch(() => {});
