'use strict';
/* The lead database: one JSON file in the data folder, written atomically
 * (temp file, then rename) so a crash mid-write can never leave half a file.
 *
 * Status rules:
 *   active     found and still current
 *   contacted  the user has reached out
 *   won        became a client
 *   dismissed  the user decided it is not a fit
 *   too-late   the system found published evidence the need has passed,
 *              or the evidence is older than its kind allows (freshness.js)
 *
 * Only the user moves a lead to contacted, won or dismissed. The system only
 * ever moves a lead to too-late, and only with evidence it can link to. It
 * never touches a lead the user has marked won or dismissed.
 *
 * Retention: leads about private individuals are deleted 30 days after they
 * become too-late or dismissed. A tombstone of the ID (no personal data) is
 * kept so the same post is not picked up again.
 */

const fs = require('node:fs');
const path = require('node:path');

const PERSON_RETENTION_DAYS = 30;
const STATUSES = ['active', 'contacted', 'won', 'dismissed', 'too-late'];
const USER_STATUSES = ['active', 'contacted', 'won', 'dismissed'];

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'leads.json');
    fs.mkdirSync(dir, { recursive: true });
    this.db = this.load();
    this.timer = null;
  }

  load() {
    const empty = { version: 1, leads: {}, tombstones: {}, sources: {}, meta: {} };
    try {
      const db = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...empty, ...db };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        /* A corrupt file is kept aside rather than overwritten, so nothing
           the user recorded is lost silently. */
        try { fs.renameSync(this.file, this.file + '.corrupt-' + Date.now()); } catch { /* keep going */ }
      }
      return empty;
    }
  }

  saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file);
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.saveNow(), 500);
  }

  all() { return Object.values(this.db.leads); }
  get(id) { return this.db.leads[id] || null; }

  /* Adds a lead or refreshes one already known. Fresh source data replaces
     the old; what the user wrote (status, notes) is never overwritten. */
  upsert(incoming, now = new Date().toISOString()) {
    if (this.db.tombstones[incoming.id]) return { lead: null, created: false };
    const existing = this.db.leads[incoming.id];
    if (!existing) {
      const lead = {
        ...incoming,
        status: 'active',
        history: [{ status: 'active', at: now, by: 'system', reason: 'Found by ' + incoming.sourceLabel }],
        notes: '',
        foundAt: now,
        updatedAt: now
      };
      this.db.leads[lead.id] = lead;
      this.save();
      return { lead, created: true };
    }
    const keep = { status: existing.status, statusAt: existing.statusAt, history: existing.history, notes: existing.notes, foundAt: existing.foundAt, enrichedAt: existing.enrichedAt, checkedAt: existing.checkedAt, score: existing.score, scoreReasons: existing.scoreReasons };
    const merged = {
      ...existing,
      ...incoming,
      ...keep,
      /* Details looked up from Companies House or the organisation's own
         site are more specific than the source's, so they win once found. */
      contact: existing.enrichedAt ? mergeContact(incoming.contact, existing.contact) : mergeContact(existing.contact, incoming.contact),
      company: incoming.company || existing.company,
      /* A date or key looked up later (a tender's first publication) stays
         when the source sends the lead again without it. */
      ref: mergeContact(existing.ref, incoming.ref),
      facts: mergeFacts(existing.facts, incoming.facts),
      /* The source's current reading of which services fit replaces the old
         one, so a corrected rule takes effect on the next refresh. */
      services: incoming.services && incoming.services.length ? incoming.services : existing.services,
      updatedAt: now
    };
    this.db.leads[merged.id] = merged;
    this.save();
    return { lead: merged, created: false };
  }

  /* Enrichment and checks write here: a shallow patch, never the status. */
  patch(id, fields) {
    const lead = this.db.leads[id];
    if (!lead) return null;
    const { status, history, ...rest } = fields;
    Object.assign(lead, rest);
    this.save();
    return lead;
  }

  setStatus(id, status, { by = 'user', reason = '', evidenceUrl = '', quote = '' } = {}, now = new Date().toISOString()) {
    const lead = this.db.leads[id];
    if (!lead) throw new Error('No such lead');
    if (!STATUSES.includes(status)) throw new Error('Unknown status ' + status);
    if (by === 'user' && !USER_STATUSES.includes(status)) throw new Error('Only the system can mark a lead too late, and only with evidence');
    if (by === 'system') {
      if (status !== 'too-late') throw new Error('The system may only mark leads too late');
      if (!evidenceUrl || !reason) throw new Error('Too late needs a reason and a link to the evidence');
      if (lead.status === 'won' || lead.status === 'dismissed' || lead.status === 'too-late') return lead;
    }
    if (lead.status === status) return lead;
    lead.status = status;
    lead.statusAt = now;
    lead.history = [...(lead.history || []), { status, at: now, by, reason, evidenceUrl, quote }];
    lead.updatedAt = now;
    this.save();
    return lead;
  }

  setNotes(id, notes) {
    const lead = this.db.leads[id];
    if (!lead) throw new Error('No such lead');
    lead.notes = String(notes || '').slice(0, 5000);
    lead.updatedAt = new Date().toISOString();
    this.save();
    return lead;
  }

  /* Deletes a lead the current rules would never have created, leaving a
     tombstone (the ID only) so it is not picked up again. */
  remove(id, now = Date.now()) {
    if (!this.db.leads[id]) return false;
    delete this.db.leads[id];
    this.db.tombstones[id] = new Date(now).toISOString().slice(0, 10);
    this.save();
    return true;
  }

  /* Deletes person leads past their retention window and leaves a tombstone. */
  purge(now = Date.now()) {
    let removed = 0;
    for (const lead of this.all()) {
      if (lead.kind !== 'person') continue;
      if (lead.status !== 'too-late' && lead.status !== 'dismissed') continue;
      const since = Date.parse(lead.statusAt || lead.updatedAt || 0);
      if (now - since > PERSON_RETENTION_DAYS * 86400000) {
        delete this.db.leads[lead.id];
        this.db.tombstones[lead.id] = new Date(now).toISOString().slice(0, 10);
        removed++;
      }
    }
    if (removed) this.save();
    return removed;
  }

  sourceState(name) { return this.db.sources[name] || {}; }
  setSourceState(name, state) {
    this.db.sources[name] = { ...(this.db.sources[name] || {}), ...state };
    this.save();
  }
}

function mergeContact(a = {}, b = {}) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

function mergeFacts(a = [], b = []) {
  const map = new Map();
  for (const f of [...(a || []), ...(b || [])]) map.set(f.label, f);
  return [...map.values()];
}

module.exports = { Store, STATUSES, USER_STATUSES, PERSON_RETENTION_DAYS };
