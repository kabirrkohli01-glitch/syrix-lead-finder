'use strict';
/* Orders leads by how strong and current the evidence of need is, and says
 * why. The score is a sorting aid with its reasons printed beside it; it is
 * never shown as a probability of winning work. */

const BASE = {
  tender: [70, 'An organisation has published a request for suppliers'],
  'sponsor-b': [68, 'A downgraded sponsor licence must be fixed under a Home Office action plan'],
  'sponsor-removed': [58, 'A business that recently lost its place on the sponsor register'],
  'sponsor-new': [56, 'A newly licensed sponsor taking on sponsor duties'],
  'sponsor-expansion': [52, 'An overseas business setting up in the UK'],
  penalty: [45, 'Named for an illegal working penalty, so right to work checks have failed before']
};

const { originOf } = require('./freshness');

const POST = {
  explicit: [72, 'The person is explicitly looking for professional help'],
  planning: [58, 'The person is planning a move the consultancy supports'],
  question: [50, 'The person is asking how to do something the consultancy supports']
};

function score(lead, now = Date.now()) {
  const reasons = [];
  const base = lead.signal.type === 'post'
    ? POST[lead.signal.intent] || POST.question
    : BASE[lead.signal.type] || [40, 'Published signal'];
  let s = base[0];
  reasons.push(base[1]);

  /* Recency counts from the original event, never from when this app found
     the lead: a register read today says nothing about how new a licence is. */
  const origin = originOf(lead);
  const t = Date.parse(origin.at || '');
  if (Number.isFinite(t)) {
    const days = (now - t) / 86400000;
    const what = origin.label || 'Published';
    if (days <= 3) { s += 10; reasons.push(what + ' in the last 3 days'); }
    else if (days <= 14) { s += 5; reasons.push(what + ' in the last 2 weeks'); }
    else if (days > 90) { s -= 15; reasons.push(what + ' over 3 months ago'); }
    else if (days > 30) { s -= 10; reasons.push(what + ' over a month ago'); }
  } else {
    reasons.push('The source does not publish a date for this, so recency adds nothing');
  }

  const n = (lead.services || []).length;
  if (n > 1) { s += Math.min(10, (n - 1) * 5); reasons.push('Matches ' + n + ' the consultancy services'); }

  const c = lead.contact || {};
  if (c.email || c.phone) { s += 8; reasons.push('Has a published email or phone number'); }
  else if (c.website || c.handle) { s += 4; reasons.push('Has a website or a way to message'); }

  if (lead.deadline) {
    const left = (Date.parse(lead.deadline) - now) / 86400000;
    if (left < 2) { s -= 25; reasons.push('Closes in under 2 days'); }
    else if (left <= 14) { s += 4; reasons.push('Closes within 2 weeks'); }
  }
  if (lead.value && lead.value.amount > 5000000) { s -= 12; reasons.push('Over £5m: likely beyond a consultancy of the consultancy\'s size'); }

  if (lead.company && lead.company.officers && lead.company.officers.some(o => o.residence && !/united kingdom|england|scotland|wales|northern ireland/i.test(o.residence))) {
    s += 4; reasons.push('Has a director living outside the UK');
  }
  return { score: Math.max(0, Math.min(100, Math.round(s))), reasons };
}

module.exports = { score };
