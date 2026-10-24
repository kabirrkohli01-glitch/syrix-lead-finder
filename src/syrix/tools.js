'use strict';
/* What SYRIX can see. The tool list is the complete list of things it can
 * reach: the leads in this app, the consultancy's service lines, Companies House, and
 * the web through the gateway's search. Every tool reads; none writes.
 * Changing a lead stays on screen, where the user can see what changed. */

const gateway = require('./gateway');
const ch = require('../enrich/companies-house');
const { SERVICES } = require('../services');
const { SOURCES } = require('../pipeline');
const { originOf, shown } = require('../freshness');

const STATUS_LABEL = { active: 'Active', contacted: 'Contacted', won: 'Won', dismissed: 'Not a fit', 'too-late': 'Too late' };
const SIGNAL_LABEL = {
  tender: 'Public tender inviting bids',
  'sponsor-b': 'Sponsor licence downgraded to a B rating',
  'sponsor-expansion': 'Overseas business setting up in the UK (Expansion Worker route)',
  'sponsor-new': 'Newly licensed sponsor',
  'sponsor-removed': 'No longer on the sponsor register',
  penalty: 'Named for an illegal working penalty',
  post: 'Person asking for help in a public community'
};

const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const FILTERS = {
  text: { type: 'string', description: 'Words to look for in the name, headline, evidence, location or notes' },
  kind: { type: 'string', enum: ['organisation', 'person'], description: 'Organisations or individual people' },
  status: { type: 'string', enum: ['active', 'contacted', 'won', 'dismissed', 'too-late', 'any'], description: 'Default active' },
  service: { type: 'string', description: 'A the consultancy service, by id or name, e.g. "sponsor licence", "global talent", "market research"' },
  signal: { type: 'string', enum: Object.keys(SIGNAL_LABEL), description: 'Why it is a lead' },
  source: { type: 'string', enum: SOURCES.map(s => s.id) },
  location: { type: 'string', description: 'Town, county or postcode area, matched against the lead\'s location and address' },
  country: { type: 'string', description: 'Nationality or country of residence of a company\'s directors (from Companies House), e.g. "Indian", "India"' },
  has_email: { type: 'boolean' },
  has_phone: { type: 'boolean' },
  closing_within_days: { type: 'number', description: 'Tenders whose deadline falls within this many days' },
  published_within_days: { type: 'number', description: 'Leads whose evidence was originally published (posted, first tendered, penalty period) within this many days. Leads whose source publishes no date are excluded.' },
  min_score: { type: 'number' }
};

const TOOLS = [
  fn('app_overview', 'Totals in SYRIX Lead Finder right now: leads by status, type, source, reason and service, when the last search ran, and each source\'s state. Call this for any question about the app as a whole or "how many".'),
  fn('find_leads', 'Search the leads stored in this app and return the matching ones, strongest first unless sorted otherwise. Use for "which", "show me", "who is looking for".', {
    ...FILTERS,
    sort: { type: 'string', enum: ['score', 'newest', 'deadline'] },
    limit: { type: 'number', description: 'How many to return, up to 25 (default 10)' }
  }),
  fn('count_leads', 'Count leads matching the filters, optionally grouped. Use for breakdowns: by service, source, reason, location, type, status, or directors\' nationality.', {
    ...FILTERS,
    group_by: { type: 'string', enum: ['service', 'source', 'signal', 'location', 'kind', 'status', 'nationality'] }
  }),
  fn('lead_details', 'Everything about one lead: the evidence and its source link, matched services with the words that matched, contact details with where each was found, Companies House facts, status history and notes.', {
    id: { type: 'string', description: 'The lead id from find_leads' },
    name: { type: 'string', description: 'Or the lead\'s name if the id is not known' }
  }),
  fn('consultancy_services', 'The service lines the consultancy offers, as this app matches them.'),
  fn('company_record', 'Look a UK company up on Companies House now: number, status, incorporation date, registered office, nature of business and current officers.', {
    name: { type: 'string' },
    number: { type: 'string', description: 'Companies House number, if known' },
    town: { type: 'string' }
  }),
  fn('search_official_guidance', 'Search UK official sources only — GOV.UK, legislation.gov.uk and the ICO — for rules and law: immigration routes, sponsor duties, marketing and data protection, company law. Use for any legal or "is it allowed" question.', {
    query: { type: 'string' }
  }, ['query']),
  fn('web_search', 'Search the web for current information about an organisation, a market, a news item or anything not in the app.', {
    query: { type: 'string' }
  }, ['query']),
  fn('read_page', 'Open one web page and read its text, to verify what a search result or a lead\'s source actually says.', {
    url: { type: 'string' }
  }, ['url'])
];

/* ---------- filtering ---------- */

function serviceIds(q) {
  if (!q) return null;
  const s = String(q).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
  const hits = SERVICES.filter(x => x.id === s || x.id.replace(/-/g, ' ').includes(s) || x.name.toLowerCase().includes(s) || s.split(' ').filter(w => w.length > 3).every(w => x.name.toLowerCase().includes(w)));
  return hits.length ? new Set(hits.map(x => x.id)) : new Set(['__none__']);
}

function officerText(lead) {
  return ((lead.company && lead.company.officers) || []).map(o => [o.nationality, o.residence].join(' ')).join(' ').toLowerCase();
}

function applyFilters(leads, a = {}) {
  const status = a.status || 'active';
  const services = serviceIds(a.service);
  const text = a.text ? String(a.text).toLowerCase() : '';
  const loc = a.location ? String(a.location).toLowerCase() : '';
  const country = a.country ? String(a.country).toLowerCase().replace(/n$/, '') : '';
  const now = Date.now();
  return leads.filter(l => {
    if (status !== 'any' && l.status !== status) return false;
    if (a.kind && l.kind !== a.kind) return false;
    if (a.signal && l.signal.type !== a.signal) return false;
    if (a.source && l.source !== a.source) return false;
    if (services && !(l.services || []).some(s => services.has(s.id))) return false;
    if (a.has_email && !(l.contact && l.contact.email)) return false;
    if (a.has_phone && !(l.contact && l.contact.phone)) return false;
    if (a.min_score && (l.score || 0) < a.min_score) return false;
    if (a.closing_within_days) {
      const d = Date.parse(l.deadline || '');
      if (!Number.isFinite(d) || d < now || d - now > a.closing_within_days * 86400000) return false;
    }
    if (a.published_within_days) {
      const t = Date.parse(originOf(l).at || '');
      if (!Number.isFinite(t) || now - t > a.published_within_days * 86400000) return false;
    }
    if (loc && !((l.location || '') + ' ' + ((l.contact && l.contact.address) || '')).toLowerCase().includes(loc)) return false;
    if (country && !officerText(l).includes(country)) return false;
    if (text) {
      const hay = [l.name, l.headline, l.location, l.signal.quote, l.signal.detail, l.contact && l.contact.person, l.notes, ...(l.facts || []).map(f => f.value)].join(' ').toLowerCase();
      if (!text.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  });
}

function compact(l) {
  const c = l.contact || {};
  return {
    id: l.id,
    name: l.name,
    type: l.kind,
    status: STATUS_LABEL[l.status],
    why: l.signal.label,
    headline: l.headline,
    services: (l.services || []).map(s => s.name),
    location: l.location || undefined,
    score: l.score,
    contact: Object.fromEntries(Object.entries({ person: c.person, role: c.role, email: c.email, phone: c.phone, website: c.website, username: c.handle }).filter(([, v]) => v)),
    deadline: l.deadline ? l.deadline.slice(0, 16).replace('T', ' ') : undefined,
    originallyPublished: originOf(l).text,
    source: l.sourceLabel
  };
}

function sortLeads(list, sort) {
  const by = {
    newest: (a, b) => (Date.parse(originOf(b).at || '') || 0) - (Date.parse(originOf(a).at || '') || 0),
    deadline: (a, b) => (Date.parse(a.deadline || '') || 8.64e15) - (Date.parse(b.deadline || '') || 8.64e15),
    score: (a, b) => (b.score || 0) - (a.score || 0)
  };
  return list.sort(by[sort] || by.score);
}

function groupKey(l, by) {
  if (by === 'service') return (l.services || []).map(s => s.name);
  if (by === 'source') return [l.sourceLabel];
  if (by === 'signal') return [SIGNAL_LABEL[l.signal.type] || l.signal.type];
  if (by === 'kind') return [l.kind];
  if (by === 'status') return [STATUS_LABEL[l.status]];
  if (by === 'location') return [((l.location || '').split(',')[0] || 'Not given').trim() || 'Not given'];
  if (by === 'nationality') {
    const n = [...new Set(((l.company && l.company.officers) || []).map(o => o.nationality).filter(Boolean))];
    return n.length ? n : [l.company ? 'Not stated' : 'Not looked up yet'];
  }
  return ['All'];
}

function trimText(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ---------- running a tool ---------- */

async function run(ctx, name, args = {}) {
  const { store, pipeline } = ctx;
  /* Only what the interface shows: evidence past the age limit is never
     offered as a lead. */
  const leads = store.all().filter(l => shown(l));

  if (name === 'app_overview') {
    const tally = (keyFn) => {
      const out = {};
      for (const l of leads) for (const k of [].concat(keyFn(l))) out[k] = (out[k] || 0) + 1;
      return out;
    };
    const active = leads.filter(l => l.status === 'active');
    return {
      total: leads.length,
      byStatus: tally(l => STATUS_LABEL[l.status]),
      activeByType: { organisations: active.filter(l => l.kind === 'organisation').length, people: active.filter(l => l.kind === 'person').length },
      activeByReason: Object.fromEntries(Object.entries(tally(l => l.status === 'active' ? SIGNAL_LABEL[l.signal.type] : [])).sort((a, b) => b[1] - a[1])),
      activeByService: Object.fromEntries(Object.entries(tally(l => l.status === 'active' ? (l.services || []).map(s => s.name) : [])).sort((a, b) => b[1] - a[1])),
      activeWithEmail: active.filter(l => l.contact && l.contact.email).length,
      activeWithPhone: active.filter(l => l.contact && l.contact.phone).length,
      tendersClosingIn7Days: active.filter(l => l.deadline && Date.parse(l.deadline) - Date.now() < 7 * 86400000 && Date.parse(l.deadline) > Date.now()).length,
      lastSearch: pipeline.lastRun ? { finished: pipeline.lastRun.endedAt, newLeads: pipeline.lastRun.created, movedToTooLate: pipeline.lastRun.retired } : null,
      searchRunningNow: pipeline.running,
      sources: SOURCES.map(s => {
        const st = store.sourceState(s.id);
        return { source: s.label, checksEveryHours: s.every / 3600000, lastRead: st.lastOk || null, currentLeads: st.lastFound || 0, lastError: st.lastError || undefined, note: st.note || undefined };
      }),
      howItWorks: 'Organisations come from public tenders, the Home Office sponsor register and the illegal working penalties report; people come from public Reddit and Immigration Boards posts asking for help. Contact details come from the tender notice, Companies House and the organisation\'s own website (accepted only when the site shows the company number, postcode, or name and town). A lead is moved to Too late only with linked evidence the need has passed. The app runs only on this computer.'
    };
  }

  if (name === 'find_leads') {
    const matched = sortLeads(applyFilters(leads, args), args.sort);
    const limit = Math.max(1, Math.min(25, Number(args.limit) || 10));
    return { total: matched.length, shown: Math.min(limit, matched.length), leads: matched.slice(0, limit).map(compact) };
  }

  if (name === 'count_leads') {
    const matched = applyFilters(leads, args);
    if (!args.group_by) return { total: matched.length };
    const groups = {};
    for (const l of matched) for (const k of groupKey(l, args.group_by)) groups[k] = (groups[k] || 0) + 1;
    const sorted = Object.entries(groups).sort((a, b) => b[1] - a[1]);
    const out = { total: matched.length, groupedBy: args.group_by, groups: Object.fromEntries(sorted.slice(0, 20)) };
    if (sorted.length > 20) out.otherGroups = sorted.length - 20;
    if (args.group_by === 'nationality') out.note = 'Nationality comes from Companies House officer records, which exist only for organisations already looked up.';
    return out;
  }

  if (name === 'lead_details') {
    let lead = args.id ? leads.find(l => l.id === String(args.id)) || null : null;
    if (!lead && args.name) {
      const q = String(args.name).toLowerCase();
      lead = leads.find(l => l.name.toLowerCase() === q) || leads.find(l => l.name.toLowerCase().includes(q));
    }
    if (!lead) return { error: 'No lead with that id or name.' };
    const c = lead.contact || {};
    return {
      ...compact(lead),
      evidence: { reason: lead.signal.label, detail: lead.signal.detail, quote: trimText(lead.signal.quote, 900), sourceLink: lead.signal.url },
      matchedServices: (lead.services || []).map(s => ({ service: s.name, matchedOn: trimText(s.quote || s.matched, 240) })),
      contactDetails: { ...c, sources: undefined, provenance: undefined, whereFound: c.sources || (c.provenance ? { all: c.provenance } : undefined) },
      company: lead.company ? { number: lead.company.number, status: lead.company.status, incorporated: lead.company.incorporated, address: lead.company.address, natureOfBusiness: lead.company.sic, officers: lead.company.officers, link: lead.company.url, matchedOn: lead.company.matchedOn } : undefined,
      facts: (lead.facts || []).map(f => ({ [f.label]: trimText(f.value, 500) })),
      scoreReasons: lead.scoreReasons,
      history: (lead.history || []).map(h => ({ status: STATUS_LABEL[h.status], when: h.at, by: h.by, reason: h.reason, evidence: h.evidenceUrl || undefined, quote: h.quote || undefined })),
      notes: lead.notes || undefined,
      foundByTheApp: lead.foundAt,
      aboutTheDate: originOf(lead).note || undefined
    };
  }

  if (name === 'consultancy_services') {
    return { services: SERVICES.map(s => ({ id: s.id, name: s.name, area: s.area, for: s.audience === 'person' ? 'individuals' : s.audience === 'organisation' ? 'organisations' : 'individuals and organisations' })) };
  }

  if (name === 'company_record') {
    if (!args.number && !args.name) return { error: 'Give a company name or number.' };
    const company = args.number ? await ch.profile(String(args.number)) : await ch.lookup({ name: String(args.name), town: args.town || '' });
    if (!company) return { found: false, note: 'No confident Companies House match for that exact name' + (args.town ? ' and town' : '') + '.' };
    return { found: true, ...company };
  }

  if (name === 'search_official_guidance' || name === 'web_search') {
    const q = String(args.query || '').trim();
    if (!q) return { error: 'No query given.' };
    const query = name === 'search_official_guidance' ? q + ' site:gov.uk OR site:legislation.gov.uk OR site:ico.org.uk' : q;
    let results = await gateway.search(query);
    if (name === 'search_official_guidance') {
      const official = results.filter(r => /(^|\.)(gov\.uk|legislation\.gov\.uk|ico\.org\.uk)$/i.test(hostname(r.url)));
      if (official.length) results = official;
    }
    return { query: q, results: results.slice(0, 5).map(r => ({ title: r.title, url: r.url, published: r.published || 'date unknown', excerpt: trimText(r.text || r.snippet || r.content, 700) })) };
  }

  if (name === 'read_page') {
    const page = await gateway.readPage(String(args.url || ''));
    return { title: page.title, url: page.url || args.url, text: trimText(page.text, 3500) };
  }

  return { error: 'Unknown tool ' + name };
}

function hostname(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}

/* A short label for each step, shown live in the chat panel. */
function describe(name, a = {}) {
  const bits = [a.service, a.signal && SIGNAL_LABEL[a.signal], a.kind === 'person' ? 'people' : a.kind === 'organisation' ? 'organisations' : '', a.location, a.country, a.text].filter(Boolean).join(', ');
  switch (name) {
    case 'app_overview': return 'Reading the app';
    case 'find_leads': return 'Searching the leads' + (bits ? ': ' + bits : '');
    case 'count_leads': return 'Counting leads' + (a.group_by ? ' by ' + a.group_by : '') + (bits ? ': ' + bits : '');
    case 'lead_details': return 'Opening ' + (a.name || 'the lead');
    case 'consultancy_services': return 'Checking the consultancy\'s services';
    case 'company_record': return 'Checking Companies House' + (a.name ? ': ' + a.name : '');
    case 'search_official_guidance': return 'Checking official guidance: ' + trimText(a.query, 60);
    case 'web_search': return 'Searching the web: ' + trimText(a.query, 60);
    case 'read_page': return 'Reading ' + (hostname(a.url) || 'a page');
    default: return 'Working';
  }
}

module.exports = { TOOLS, run, describe, applyFilters, SIGNAL_LABEL };
