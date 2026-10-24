'use strict';
/* One run: read every source that is due, store what it found, retire leads
 * whose need has verifiably passed, look up contact details for new
 * organisations, retire leads whose evidence is too old to act on, then
 * re-score everything.
 *
 * Progress is reported as named steps, so the interface can show what is
 * happening ("Reading Find a Tender: 300 notices") rather than a spinner.
 */

const tenders = require('./sources/tenders');
const sponsors = require('./sources/sponsors');
const penalties = require('./sources/penalties');
const communities = require('./sources/communities');
const ch = require('./enrich/companies-house');
const website = require('./enrich/website');
const { score } = require('./score');
const { outOfDate } = require('./freshness');
const { BY_ID } = require('./services');

const HOUR = 3600000;

const SOURCES = [
  { id: 'contracts-finder', label: 'Contracts Finder (public tenders)', every: 3 * HOUR, kind: 'organisation' },
  { id: 'find-a-tender', label: 'Find a Tender (public tenders)', every: 3 * HOUR, kind: 'organisation' },
  { id: 'sponsor-register', label: 'Register of licensed sponsors', every: 6 * HOUR, kind: 'organisation' },
  { id: 'illegal-working', label: 'Illegal working penalties report', every: 24 * HOUR, kind: 'organisation' },
  { id: 'reddit', label: 'Reddit', every: 1 * HOUR, kind: 'person' },
  { id: 'immigration-boards', label: 'Immigration Boards forum', every: 1 * HOUR, kind: 'person' }
];

const LIMITS = { enrich: 25, redditChecks: 2, forumChecks: 10, companyChecks: 20, tenderDates: 20 };

class Pipeline {
  constructor(store, { dataDir }) {
    this.store = store;
    this.dataDir = dataDir;
    this.running = false;
    this.steps = [];
    this.lastRun = store.db.meta.lastRun || null;
    this.correctStoredLeads();
  }

  /* Brings leads saved under earlier matching rules up to date without
     waiting for their source to run again. Safe to repeat. */
  correctStoredLeads() {
    let changed = 0;
    for (const lead of this.store.all()) {
      /* Services outside the lead-finding focus (services.js) no longer
         produce leads. An untouched lead resting only on them is removed; one
         the user has acted on keeps its record. */
      const services = lead.services || [];
      const kept = services.filter(s => !(BY_ID[s.id] && BY_ID[s.id].region));
      if (kept.length < services.length) {
        if (!kept.length && lead.status === 'active') { this.store.remove(lead.id); changed++; continue; }
        if (kept.length) { this.store.patch(lead.id, { services: kept }); changed++; }
      }
    }
    for (const lead of this.store.all()) {
      if (lead.source !== 'sponsor-register') continue;
      const services = sponsors.servicesFor(lead);
      if (!services) continue;
      const patch = {};
      if (services.map(s => s.id).join() !== (lead.services || []).map(s => s.id).join()) patch.services = services;
      if (lead.signal.type === 'sponsor-expansion' && lead.signal.label !== 'Overseas business setting up in the UK') {
        patch.headline = 'Overseas business setting up in the UK';
        patch.signal = { ...lead.signal, label: patch.headline, detail: 'Holds a UK Expansion Worker sponsor licence, so it has already formed its UK branch or subsidiary and been licensed. The route\'s next steps are getting the UK operation trading and then moving to a Skilled Worker licence.' };
      }
      if (Object.keys(patch).length) { this.store.patch(lead.id, patch); changed++; }
    }
    const retired = this.retireOutOfDate();
    if (changed || retired) this.store.saveNow();
    return changed + retired;
  }

  /* Retires active leads whose evidence is older than its kind allows
     (freshness.js), and organisations Companies House already lists as
     closing. Needs no network, so it also runs at start-up and stored leads
     are corrected before the first search finishes. A lead the user moved
     back to Active after it was retired is left alone. */
  retireOutOfDate(now = Date.now()) {
    let retired = 0;
    for (const lead of this.store.all()) {
      if (lead.status !== 'active' || userKeptActive(lead)) continue;
      const company = lead.company;
      const r = company && company.url && ch.isClosed(company.status)
        ? { reason: 'Companies House lists the company as ' + company.status, url: company.url }
        : outOfDate(lead, now);
      if (r && this.retire(lead, r)) retired++;
    }
    return retired;
  }

  status() {
    return { running: this.running, steps: this.steps, lastRun: this.lastRun };
  }

  step(name) {
    const s = { name, state: 'running', detail: '', startedAt: new Date().toISOString() };
    this.steps.push(s);
    return {
      report: detail => { s.detail = detail; },
      done: detail => { s.state = 'done'; if (detail != null) s.detail = detail; s.endedAt = new Date().toISOString(); },
      fail: err => { s.state = 'failed'; s.detail = String(err && err.message || err); s.endedAt = new Date().toISOString(); },
      skip: detail => { s.state = 'skipped'; s.detail = detail; s.endedAt = new Date().toISOString(); }
    };
  }

  due(source, force) {
    if (force) return true;
    const st = this.store.sourceState(source.id);
    if (st.enabled === false) return false;
    return !st.lastAttempt || Date.now() - Date.parse(st.lastAttempt) >= source.every;
  }

  /* Stores leads and returns how many were new. */
  absorb(leads) {
    let created = 0;
    for (const lead of leads) {
      /* Evidence already too old is not stored at all. */
      if (!this.store.get(lead.id) && outOfDate(lead)) continue;
      const r = this.store.upsert(lead);
      if (r.created) created++;
    }
    return created;
  }

  retire(lead, { reason, url, quote = '' }) {
    if (!lead || !['active', 'contacted'].includes(lead.status)) return false;
    this.store.setStatus(lead.id, 'too-late', { by: 'system', reason, evidenceUrl: url, quote });
    return true;
  }

  leadsBy(pred) { return this.store.all().filter(pred); }

  async run({ force = false, only = null } = {}) {
    if (this.running) return false;
    this.running = true;
    this.steps = [];
    const summary = { startedAt: new Date().toISOString(), created: 0, retired: 0, enriched: 0, errors: 0 };
    try {
      for (const source of SOURCES) {
        if (only && !only.includes(source.id)) continue;
        if (this.store.sourceState(source.id).enabled === false) continue;
        if (!this.due(source, force)) continue;
        const st = this.step(source.label);
        this.store.setSourceState(source.id, { lastAttempt: new Date().toISOString() });
        try {
          const r = await this.collect(source.id, st.report);
          summary.created += r.created;
          summary.retired += r.retired || 0;
          this.store.setSourceState(source.id, { lastOk: new Date().toISOString(), lastError: '', lastFound: r.found, lastNew: r.created, lastScanned: r.scanned, note: r.note || '' });
          st.done(r.found + ' current leads from ' + (r.scanned || 0).toLocaleString('en-GB') + ' records, ' + r.created + ' new' + (r.note ? '. ' + r.note : ''));
        } catch (err) {
          summary.errors++;
          this.store.setSourceState(source.id, { lastError: String(err.message || err) });
          st.fail(err);
        }
      }

      summary.retired += await this.checks();
      summary.enriched += await this.enrich();

      const age = this.step('Retiring leads that are out of date');
      const aged = this.retireOutOfDate();
      summary.retired += aged;
      age.done(aged + ' moved to Too late');

      const sc = this.step('Scoring');
      for (const lead of this.store.all()) {
        const r = score(lead);
        this.store.patch(lead.id, { score: r.score, scoreReasons: r.reasons });
      }
      const purged = this.store.purge();
      sc.done(this.store.all().length + ' leads scored' + (purged ? '; ' + purged + ' expired personal leads deleted' : ''));
    } finally {
      summary.endedAt = new Date().toISOString();
      this.lastRun = summary;
      this.store.db.meta.lastRun = summary;
      this.store.saveNow();
      this.running = false;
    }
    return summary;
  }

  async collect(id, report) {
    if (id === 'contracts-finder' || id === 'find-a-tender') {
      const startedAt = new Date().toISOString();
      const since = this.store.sourceState(id).sweptTo || null;
      const r = await tenders.collect(id, { since, report });
      const created = this.absorb(r.leads);
      /* An empty answer for a whole window is treated as a failed read, not
         as "nothing published": advancing past it would skip those days. */
      if (!r.partial && r.scanned > 0) this.store.setSourceState(id, { sweptTo: startedAt });
      let retired = 0;
      const byOcid = new Map(this.leadsBy(l => l.source === id && l.ref && l.ref.ocid).map(l => [l.ref.ocid, l]));
      for (const e of r.ended) if (this.retire(byOcid.get(e.ocid), e)) retired++;
      await this.dateTenders(id, report);
      report('Checking recent contract awards');
      let note = r.partial ? 'Read part of the feed before the service asked for a pause; the rest is read next run' : '';
      try {
        const awards = await tenders.recentAwards(id, { days: 30, since, report });
        for (const [ocid, a] of awards) if (this.retire(byOcid.get(ocid), a)) retired++;
      } catch (err) {
        /* The new tenders are already stored; a failed award sweep only
           delays retiring awarded ones until the next run. */
        note = (note ? note + '. ' : '') + 'Award notices could not be read this time (' + err.message + ')';
      }
      return { created, found: r.leads.length, scanned: r.scanned, retired, note };
    }

    if (id === 'sponsor-register') {
      const r = await sponsors.collect({ dataDir: this.dataDir, report });
      const created = this.absorb(r.leads);
      let retired = 0;
      const reg = r.register;
      for (const lead of this.leadsBy(l => l.source === 'sponsor-register')) {
        const key = lead.ref && lead.ref.registerKey;
        const type = lead.ref && lead.ref.sponsorType;
        if (!key) continue;
        const ev = text => ({ reason: text + ' (register dated ' + reg.date + ')', url: reg.url });
        if (type === 'sponsor-b' && reg.has(key) && !reg.isB(key)) { if (this.retire(lead, ev('Back to an A rating on the register'))) retired++; }
        else if (type === 'sponsor-removed' && reg.has(key)) { if (this.retire(lead, ev('Licensed again: back on the register'))) retired++; }
        else if (type !== 'sponsor-removed' && !reg.has(key) && !r.baseline) { if (this.retire(lead, ev('No longer on the sponsor register'))) retired++; }
      }
      const note = r.baseline ? 'Baseline saved; new and removed sponsors are reported from the next register onwards' : r.added + ' new and ' + r.removed + ' removed since the previous register';
      return { created, found: r.leads.length, scanned: r.scanned, retired, note };
    }

    if (id === 'illegal-working') {
      const r = await penalties.collect({ report });
      return { created: this.absorb(r.leads), found: r.leads.length, scanned: r.scanned };
    }

    if (id === 'reddit') {
      const r = await communities.collectReddit({ report });
      return { created: this.absorb(r.leads), found: r.leads.length, scanned: r.scanned, note: (r.warnings || []).join('; ') };
    }

    if (id === 'immigration-boards') {
      const r = await communities.collectForum({ report });
      return { created: this.absorb(r.leads), found: r.leads.length, scanned: r.scanned, note: (r.warnings || []).join('; ') };
    }
    throw new Error('Unknown source ' + id);
  }

  /* Reads the procurement history of open tenders whose first publication
     date is unknown (the notice read was an update), a few per run.
     Find a Tender asks for long gaps between requests, so a refusal stops
     the batch and the rest are dated on a later run. */
  async dateTenders(id, report) {
    const todo = this.leadsBy(l => l.source === id && l.status === 'active' && l.ref && l.ref.ocid && !l.ref.firstPublished).slice(0, LIMITS.tenderDates);
    let i = 0;
    for (const lead of todo) {
      report('Checking when tenders were first published (' + (++i) + ' of ' + todo.length + ')');
      try {
        const first = await tenders.firstPublished(id, lead.ref.ocid);
        if (first) this.store.patch(lead.id, { ref: { ...lead.ref, firstPublished: first } });
      } catch { break; }
    }
  }

  /* Retires leads whose need has passed, each with linked evidence. */
  async checks() {
    const st = this.step('Checking existing leads are still current');
    let retired = 0, checked = 0;
    const now = Date.now();
    const open = this.leadsBy(l => ['active', 'contacted'].includes(l.status));

    for (const lead of open) {
      if (lead.deadline && Date.parse(lead.deadline) < now) {
        if (this.retire(lead, { reason: 'The tender closed on ' + new Date(lead.deadline).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' }) + ', the deadline published in the notice', url: lead.signal.url })) retired++;
      }
    }

    const stale = (l, hours) => !l.checkedAt || now - Date.parse(l.checkedAt) > hours * HOUR;
    const queue = [
      ...open.filter(l => l.source === 'reddit' && l.status !== 'too-late' && stale(l, 6)).slice(0, LIMITS.redditChecks).map(l => [l, communities.checkRedditPost]),
      ...open.filter(l => l.source === 'immigration-boards' && stale(l, 6)).slice(0, LIMITS.forumChecks).map(l => [l, communities.checkForumPost]),
      ...open.filter(l => l.company && l.company.number && stale(l, 72)).slice(0, LIMITS.companyChecks).map(l => [l, checkCompany])
    ];
    for (const [lead, check] of queue) {
      if (this.store.get(lead.id).status === 'too-late') continue;
      st.report('Checked ' + checked + ' of ' + queue.length);
      try {
        const r = await check(lead);
        checked++;
        this.store.patch(lead.id, { checkedAt: new Date().toISOString() });
        if (r.tooLate && this.retire(this.store.get(lead.id), r)) retired++;
      } catch (err) {
        if (err.blocked) { st.report('Paused checks: ' + err.message); break; }
      }
    }
    st.done(checked + ' rechecked, ' + retired + ' moved to Too late');
    return retired;
  }

  /* Companies House and website lookups for organisations that need them,
     strongest leads first. Tender buyers publish their own contact. */
  async enrich() {
    const st = this.step('Looking up contact details');
    /* Expansion Worker sponsors need a Companies House match to be dated
       at all (freshness.js), so one looked up before company numbers were
       read from the entry is tried once more by number. */
    const retryByNumber = l => l.signal.type === 'sponsor-expansion' && !l.company && !l.numberChecked && ch.numberIn((l.ref && l.ref.registeredName) || l.name);
    const todo = this.leadsBy(l => l.kind === 'organisation' && (!l.enrichedAt || retryByNumber(l)) && l.status === 'active' && (l.source === 'sponsor-register' || l.source === 'illegal-working'))
      .sort((a, b) => (b.score || score(b).score) - (a.score || score(a).score))
      .slice(0, LIMITS.enrich);
    let done = 0, found = 0;
    for (const lead of todo) {
      st.report('Looking up ' + lead.name + ' (' + (done + 1) + ' of ' + todo.length + ')');
      try {
        const contact = { ...lead.contact };
        const sources = { ...(contact.sources || {}) };
        const town = (lead.location || '').split(',')[0];
        const registeredName = (lead.ref && lead.ref.registeredName) || lead.name;
        const company = await ch.byNumberIn(registeredName).catch(e => { if (e.blocked) throw e; return null; }) || await ch.lookup({ name: registeredName, town: lead.source === 'sponsor-register' ? town : '', postcode: (lead.ref && lead.ref.postcode) || '' }).catch(e => { if (e.blocked) throw e; return null; });
        const facts = [];
        if (company) {
          if (company.address) { contact.address = company.address; sources.address = company.url; }
          const director = (company.officers || []).find(o => /director/i.test(o.role));
          if (director) { contact.person = director.name; contact.role = director.role + ' (Companies House)'; sources.person = company.url + '/officers'; }
          facts.push({ label: 'Companies House', value: company.number + ' — ' + company.status + (company.incorporated ? ', incorporated ' + company.incorporated : ''), url: company.url });
          if (company.sic.length) facts.push({ label: 'Nature of business', value: company.sic.join('; ') });
          if ((company.officers || []).length) facts.push({ label: 'Current officers', value: company.officers.map(o => o.name + ' (' + [o.role, o.nationality, o.residence && 'lives in ' + o.residence].filter(Boolean).join(', ') + ')').join('; '), url: company.url + '/officers' });
          if (ch.isClosed(company.status)) {
            this.store.patch(lead.id, { company, facts: mergeFacts(lead.facts, facts), contact: { ...contact, sources }, enrichedAt: new Date().toISOString() });
            this.retire(this.store.get(lead.id), { reason: 'Companies House lists the company as ' + company.status, url: company.url });
            done++;
            continue;
          }
        }
        const site = await website.find({ name: registeredName, town, postcode: (lead.ref && lead.ref.postcode) || ch.postcodeOf(company && company.address), number: company && company.number }).catch(e => { if (e.blocked) throw e; return null; });
        if (site) {
          contact.website = site.website; sources.website = site.verifiedBy;
          if (site.emails[0]) { contact.email = site.emails[0].value; sources.email = site.emails[0].url; }
          if (site.phones[0]) { contact.phone = site.phones[0].value; sources.phone = site.phones[0].url; }
          if (site.linkedin) contact.linkedin = site.linkedin;
          if (site.emails.length > 1) facts.push({ label: 'Other published emails', value: site.emails.slice(1).map(e => e.value).join(', ') });
          if (site.phones.length > 1) facts.push({ label: 'Other published phone numbers', value: site.phones.slice(1).map(p => p.value).join(', ') });
          found++;
        }
        this.store.patch(lead.id, { company: company || null, contact: { ...contact, sources }, facts: mergeFacts(lead.facts, facts), enrichedAt: new Date().toISOString(), numberChecked: !!ch.numberIn(registeredName) });
        done++;
      } catch (err) {
        if (err.blocked) { st.report('Paused lookups: ' + err.message); break; }
      }
    }
    st.done(done + ' organisations looked up, ' + found + ' verified websites found');
    return done;
  }
}

function userKeptActive(lead) {
  const h = lead.history || [];
  const lastRetired = h.map(x => x.status).lastIndexOf('too-late');
  return lastRetired >= 0 && h.slice(lastRetired + 1).some(x => x.by === 'user' && x.status === 'active');
}

async function checkCompany(lead) {
  const s = await ch.status(lead.company.number);
  if (ch.isClosed(s.status)) return { tooLate: true, reason: 'Companies House lists the company as ' + s.status + (s.dissolved ? ' (' + s.dissolved + ')' : ''), url: s.url };
  return { tooLate: false };
}

function mergeFacts(a = [], b = []) {
  const map = new Map();
  for (const f of [...(a || []), ...(b || [])]) map.set(f.label, f);
  return [...map.values()];
}

module.exports = { Pipeline, SOURCES, LIMITS };
