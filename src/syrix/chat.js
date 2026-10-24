'use strict';
/* SYRIX for SYRIX Lead Finder: one conversation turn.
 *
 * The model works through the gateway with the tools in tools.js. Each round
 * is streamed; a round that ends asking for tools has its tools run and the
 * results added, and the next round continues. The round that ends without
 * tool calls is the answer.
 *
 * Lessons carried over from the SYRIX in the education tracker:
 *   - A short preamble in front of a tool call ("let me check") is held back
 *     rather than shown and then taken back. Text is published once it is
 *     clearly an answer, and published text is never withdrawn.
 *   - The answer-shape instruction is attached immediately before the
 *     generation it governs, not only in the system prompt, where a long
 *     context drowns it.
 *   - No worked example answers anywhere in the prompts: small models
 *     reproduce example content as if it were a finding.
 *   - Greetings get a conversational setting and no tools, so "hi" is not
 *     answered with a statistics readout.
 */

const gateway = require('./gateway');
const tools = require('./tools');
const { originOf, shown } = require('../freshness');

const MAX_ROUNDS = 6;
const PUBLISH_AFTER = 160;

const SMALL_TALK = /^\s*(hi|hey|hello|yo|hiya|sup|good (morning|afternoon|evening)|thanks|thank you|cheers|ok(ay)?|nice|great|cool|how are you|how's it going|who are you|what are you|who made you|who built you|who created you|what is syrix)[\s!.?,]*$/i;

function systemPrompt(ctx, view) {
  const { store } = ctx;
  const all = store.all().filter(l => shown(l));
  const active = all.filter(l => l.status === 'active');
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const lines = [
    'You are SYRIX. Kabirr Kohli made SYRIX: it is his own AI assistant, not something made for any company. This is one version of SYRIX — an agent of SYRIX that Kabirr placed inside SYRIX Lead Finder to answer questions, find leads and make the app easier to use. The main SYRIX runs on Kabirr\'s own computer with the strongest models, the full feature set and its v3 core; this version is tuned only for this app. If asked who made you or what you are, answer in two or three natural sentences: Kabirr Kohli made SYRIX as his own assistant; you are a version of SYRIX working inside this app to help find leads and answer questions; the main SYRIX runs on his own computer with the strongest models and the v3 core. Never say you were built for the consultancy.',
    'SYRIX Lead Finder is a lead-finding app that runs on this computer for a London business-immigration and expansion consultancy.',
    'the consultancy\'s work: UK, Isle of Man and UAE business setup; business support for UK visa routes (Innovator Founder, Global Talent, self-sponsorship, UK Expansion Worker); sponsor licence applications and HR sponsor-compliance training; the Italy Digital Nomad visa; market research; marketing; sales strategy; IT and digital services; training masterclasses; electrical and marine engineering advisory; and material handling equipment sourcing. The consultancy is not a law firm and does not give legal or tax advice; regulated legal partners handle immigration paperwork. This app finds leads in the UK and the Isle of Man only. A lead\'s date is when the source first published the evidence, not when the app found it. Only evidence published in the last three months is shown; older leads are not in the app.',
    'You help the user understand and work the leads in this app: who needs which service, where they are, how strong the evidence is, how to reach them, and whether an approach is allowed.',
    '',
    'How to work:',
    '- For any question about the leads, call find_leads, count_leads, lead_details or app_overview first. Never state a number, name, contact detail or fact about a lead that a tool did not return.',
    '- When you mention a lead, write it as a link in this exact form: [Lead name](lead:LEAD_ID), using the id from the tool result, so the user can open it.',
    '- Follow-ups such as "them", "that one", "the second", "those in London" refer to the leads in your previous answer; use their ids.',
    '- For law, rules or "is it allowed" questions, call search_official_guidance, read the most relevant page with read_page when the excerpt is not enough, name the source, and say it is general information rather than legal advice.',
    '- To verify something about a company, use company_record or read the lead\'s source link. For anything outside the app, use web_search.',
    '- You can read the app but cannot change it. If the user wants a lead marked contacted or not a fit, tell them which button to press.',
    '- If the tools do not hold the answer, say so plainly and say what would find it.',
    '',
    'Style: British English. Warm, direct and human, never stiff. Lead with the answer in one plain sentence, then the detail. Use short bullet lists for several leads or facts. No headings in short answers. Do not describe your tools or how you work unless asked. Do not narrate your plan.',
    '',
    'Today is ' + today + '.',
    'Right now the app holds ' + all.length + ' leads, ' + active.length + ' of them active (' + active.filter(l => l.kind === 'organisation').length + ' organisations, ' + active.filter(l => l.kind === 'person').length + ' people).'
  ];
  if (view) {
    const bits = [];
    if (view.tab) bits.push('viewing the "' + view.tab + '" tab');
    if (view.filters) bits.push('with filters: ' + view.filters);
    if (view.selected) {
      const l = store.get(view.selected);
      if (l) bits.push('with the lead [' + l.name + '](lead:' + l.id + ') open');
    }
    if (bits.length) lines.push('The user is ' + bits.join(', ') + '. "This lead" or "this one" means the open lead.');
  }
  return lines.join('\n');
}

/* Planning text some lanes write in front of the answer ("We need to answer
   the user… Let's craft"). Cut only from the start, and only whole lines. */
const NARRATION = /^(we need to|we should|let'?s (craft|write|answer|produce|think)|let me (think|craft|figure)|the user (asks|asked|wants|is asking)|i (should|need to|will now)|now (craft|write|produce|answer)|okay,? (so|let'?s)|analysis:|plan:)/i;
function stripNarration(text) {
  const lines = String(text || '').split('\n');
  let i = 0;
  while (i < lines.length && (NARRATION.test(lines[i].trim()) || (i > 0 && lines[i].trim() === '' && i < 3))) i++;
  const out = lines.slice(i).join('\n').trim();
  return out || String(text || '').trim();
}

const TOOL_WORDS = { app_overview: 'the app overview', find_leads: 'a lead search', count_leads: 'a count', lead_details: 'the lead\'s details', consultancy_services: 'the consultancy\'s services', company_record: 'Companies House', search_official_guidance: 'official guidance', web_search: 'a web search', read_page: 'the page' };
function scrubToolNames(text) {
  return String(text).replace(/\b(app_overview|find_leads|count_leads|lead_details|consultancy_services|company_record|search_official_guidance|web_search|read_page)\b(\(\))?/g, (m, n) => TOOL_WORDS[n]);
}

/* Older tool results are shortened so the newest ones and the answer fit in
   the gateway lanes' combined context and output budget. */
function compact(messages) {
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i >= 0);
  const keep = new Set(toolIdx.slice(-3));
  return messages.map((m, i) => {
    if (m.role !== 'tool') return m;
    const cut = keep.has(i) ? 6000 : 1500;
    return m.content.length <= cut ? m : { ...m, content: m.content.slice(0, cut) + ' …[shortened]' };
  });
}

const ANSWER_SHAPE = 'Now answer the user from the tool results above. Use only what they contain; do not invent leads, figures, contacts or rules. Link every lead you name as [Name](lead:ID). If a result says there are more matches than it returned, give the total and say these are the strongest. One plain opening sentence, then the detail, then stop — offer one useful next step only if there is an obvious one.';
const CHAT_SHAPE = 'Reply to what the user said, in the same register, in a line or two. Nothing was looked up this turn, so give no figures, lists or summaries. Be warm and natural.';

/* Runs one turn. `history` is [{ role: 'user'|'assistant', content }].
   Callbacks: onStep({ label, state }), onText(fullTextSoFar). */
async function answer(ctx, { history, view, onStep = () => {}, onText = () => {} }) {
  const recent = history.slice(-20).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 6000) }));
  const last = [...recent].reverse().find(m => m.role === 'user');
  const chatting = !!(last && SMALL_TALK.test(last.content));
  const messages = [{ role: 'system', content: systemPrompt(ctx, view) }, ...recent];
  const used = [];
  let committed = '';

  const join = (a, b) => (!a ? b : !b ? a : a.replace(/\s+$/, '') + '\n\n' + b.trim());

  onStep({ label: 'Thinking', state: 'running' });
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const request = compact(messages);
    request.push({ role: 'user', content: used.length ? ANSWER_SHAPE : chatting ? CHAT_SHAPE : 'Answer the user\'s last message. If it concerns the leads, the law or anything you would need to check, call the right tool first instead of answering from memory.' });

    let publishing = false;
    const reply = await withRetry(() => gateway.streamChat({
      messages: request,
      tools: chatting || round === MAX_ROUNDS - 1 ? undefined : tools.TOOLS,
      mode: 'zenith',
      maxTokens: 1600,
      temperature: chatting ? 0.7 : 0.3
    }, (piece, whole) => {
      if (!publishing && whole.length >= PUBLISH_AFTER) publishing = true;
      if (publishing) onText(scrubToolNames(join(committed, stripNarration(whole))));
    }));

    const calls = (reply.toolCalls || []).filter(c => c && c.name);
    /* A streamed answer that stops mid-sentence was cut off by the lane, not
       finished. It is asked for again whole, and the whole one is used if it
       is complete. */
    if (!calls.length && !chatting && reply.text && !/[.!?)"’”:*_`]\s*$/.test(reply.text.trim())) {
      try {
        const whole = await gateway.chat({ messages: request, mode: 'zenith', maxTokens: 1600, temperature: 0.3 });
        if (whole.text && /[.!?)"’”:*_`]\s*$/.test(whole.text.trim()) && !(whole.toolCalls || []).length) reply.text = whole.text;
      } catch { /* keep what streamed */ }
    }
    if (!calls.length) {
      const final = scrubToolNames(join(committed, stripNarration(reply.text)));
      onText(final);
      onStep({ label: 'Done', state: 'done' });
      return { text: final, used };
    }

    if (publishing) committed = join(committed, stripNarration(reply.text));
    messages.push({ role: 'assistant', content: reply.text || '', tool_calls: calls.map(c => ({ id: c.id, name: c.name, args: c.args })) });
    for (const call of calls.slice(0, 4)) {
      const label = tools.describe(call.name, call.args);
      onStep({ label, state: 'running' });
      let result;
      try { result = await tools.run(ctx, call.name, call.args || {}); }
      catch (err) { result = { error: err.message }; }
      used.push({ name: call.name, label });
      onStep({ label, state: result && result.error ? 'failed' : 'done' });
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify(result).slice(0, 12000) });
    }
    onStep({ label: 'Working out the answer', state: 'running' });
  }
  const text = committed || 'I looked through what I could but did not reach an answer in time. Try asking a narrower question.';
  onText(text);
  return { text, used };
}

/* ---------- the overview box on each lead ----------
 *
 * One short generation from the lead's own stored record, with no tools:
 * everything it may say is in the record handed to it, so it cannot drift
 * into facts about the lead that nothing published. Saved on the lead and
 * reused until the lead's data changes.
 */

const OVERVIEW_PROMPT = [
  'You are SYRIX, Kabirr Kohli\'s AI assistant, writing the overview box for one lead in SYRIX Lead Finder, a lead-finding app for a London business-immigration and expansion consultancy.',
  'Using ONLY the record below, write 3 to 5 short bullet points covering, where the record supports it:',
  '- who they are (organisation or person, what they do, where they are based);',
  '- what they need or are looking for, and why the record says so;',
  '- which the consultancy service fits;',
  '- where they are based; most organisations here are already in the UK. Say an organisation is moving or expanding into the UK only when the record says it is an overseas business, and never invent where it is coming from;',
  '- anything time-sensitive (a deadline, a recent downgrade) and the best way to reach them.',
  'Write about the lead itself; never mention the record, its labels or the app\'s fields. Never add a fact the record does not contain. If something is unknown, leave it out rather than guess. No heading, no closing remark, no advice beyond the record. British English. Each bullet one sentence, starting with "- ".'
].join('\n');

/* Written as plain labelled lines rather than JSON: a model handed JSON
   keys repeats them ("as shown in the whyALead field"). */
function overviewRecord(lead) {
  const c = lead.contact || {};
  const lines = [
    ['Type', lead.kind === 'person' ? 'An individual person' : 'An organisation'],
    ['Name', lead.name],
    ['Based in', lead.location],
    ['Why this is a lead', lead.signal.label],
    ['Detail', lead.signal.detail],
    ['Published wording', String(lead.signal.quote || '').slice(0, 900)],
    /* The original date of the evidence, with what it does and does not
       show; never the date a register file was read. */
    ['Original date', originOf(lead).text],
    ['About that date', originOf(lead).note],
    ['Deadline', lead.deadline ? new Date(lead.deadline).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' }) : ''],
    ['the consultancy services that fit', (lead.services || []).map(s => s.name).join('; ')],
    ['Contact person', [c.person, c.role].filter(Boolean).join(', ')],
    ['Email', c.email],
    ['Phone', c.phone],
    ['Website', c.website],
    ['Username', c.handle],
    ['How to reach them', c.channel],
    ['Company status', lead.company && [lead.company.status, lead.company.incorporated && 'incorporated ' + lead.company.incorporated].filter(Boolean).join(', ')],
    ['Nature of business', lead.company && (lead.company.sic || []).join('; ')],
    ['Directors', lead.company && (lead.company.officers || []).map(o => [o.name, o.nationality, o.residence && 'lives in ' + o.residence].filter(Boolean).join(', ')).join('; ')],
    ...(lead.facts || []).filter(f => !/^(Post|Companies House|Current officers|Nature of business)$/.test(f.label)).map(f => [f.label, String(f.value).slice(0, 300)]),
    ['Their post', ((lead.facts || []).find(f => f.label === 'Post') || {}).value ? String(lead.facts.find(f => f.label === 'Post').value).slice(0, 700) : '']
  ];
  return lines.filter(([, v]) => v && String(v).trim()).map(([k, v]) => k + ': ' + String(v).replace(/\s+/g, ' ').trim()).join('\n');
}

/* A last bullet cut off by the length limit ends without punctuation; it is
   dropped rather than shown as half a sentence. */
function dropTrailingFragment(text) {
  const lines = text.split('\n');
  const last = lines[lines.length - 1] || '';
  if (lines.length > 1 && last && !/[.!?)"’”]$/.test(last.trim())) lines.pop();
  return lines.join('\n');
}

/* A key that changes whenever the lead's facts change, so a saved overview
   is reused exactly as long as it still describes the record. */
function overviewKey(lead) {
  return require('node:crypto').createHash('sha1').update(overviewRecord(lead)).digest('hex').slice(0, 16);
}

/* Overviews are requested whole rather than streamed. Measured on real
   leads: some gateway lanes end a stream early without an error, which
   produced overviews of "- " and half a first sentence. A whole response is
   complete or fails visibly, and the panel types it out on screen anyway.
   An answer that still looks unfinished is asked for once more on the other
   tier before giving up. */
function tidyOverview(raw) {
  return dropTrailingFragment(stripNarration(raw)
    .split('\n').map(l => l.trim()).filter(l => l)
    .map(l => (/^[-•*]\s*/.test(l) ? '- ' + l.replace(/^[-•*]\s*/, '') : l))
    .join('\n'));
}

function looksComplete(text) {
  const bullets = text.split('\n').filter(l => /^- \S/.test(l) && l.length > 25);
  return bullets.length >= 2 && /[.!?)"’”]$/.test(text.trim());
}

async function overview(lead, { onText = () => {} } = {}) {
  const messages = [{ role: 'system', content: OVERVIEW_PROMPT }, { role: 'user', content: 'Lead record:\n' + overviewRecord(lead) }];
  let text = '';
  for (const mode of ['spark', 'zenith']) {
    try {
      const reply = await gateway.chat({ messages, mode, maxTokens: 900, temperature: 0.2 });
      text = tidyOverview(reply.text);
      if (looksComplete(text)) break;
    } catch (err) {
      if (err.code === 'not_paired' || /not connected|Could not reach/.test(err.message)) throw err;
    }
  }
  if (!looksComplete(text)) throw new Error('SYRIX could not write a complete overview just now.');
  onText(text);
  return text;
}

/* The gateway occasionally returns nothing from a lane ("SYRIX did not
   manage an answer that time"); a second attempt usually lands on another
   lane. Connection and pairing errors are not retried. */
async function withRetry(call) {
  try { return await call(); }
  catch (err) {
    if (err.code === 'not_paired' || /not connected|Could not reach/.test(err.message)) throw err;
    await new Promise(r => setTimeout(r, 1200));
    return call();
  }
}

module.exports = { answer, overview, overviewKey, systemPrompt, stripNarration, scrubToolNames, SMALL_TALK };
