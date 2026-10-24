'use strict';
/* Reads a public post and decides whether its author is a person with a
 * current need the consultancy serves, and keeps the exact words that show it.
 *
 * A post is a lead only when BOTH hold:
 *   1. It names something the consultancy does (services.js), and
 *   2. Its author is asking, planning or looking for help — not sharing a
 *      success story, posting news, or offering services themselves.
 *
 * For consultancy services that anyone might mention in passing (marketing,
 * IT, training), the bar is higher: the author must be explicitly looking
 * for a provider.
 */

const { matchServices } = require('./services');
const { quoteAround, oneLine } = require('./text');

const EXPLICIT = [
  /\b(looking for|need|needs|seeking|searching for)\b (a |an |some |any )?(good |reliable |reputable |trusted |recommended )?(immigration |business |visa |uk )?(consultan\w*|advis[eo]r\w*|agenc\w*|agent|firm|lawyer|solicitor|expert|specialist|professional|someone to help|help (with|getting|to|on)|support with|assistance with)/i,
  /\b(can|could|does|would) anyone (recommend|suggest)|\bany (recommendations|suggestions) for (a|an)\b|\brecommend (a|an|any) (good |reliable )?(consultan|advis|agenc|firm|lawyer|solicitor|company)|\bwho (do|did|would) you (use|recommend)/i,
  /\b(hire|hiring|engage|engaging|pay for|paying for)\b[^.?!\n]{0,30}\b(consultan\w*|advis[eo]r\w*|agenc\w*|someone|expert|specialist)/i,
  /\b(help|support) (me |us )?(with|writing|prepare|preparing) (my |our |a |the )?(business plan|application|endorsement|sponsor licen[cs]e)/i
];

const QUESTION = [
  /\b(how (do|can|should|would|to) (i|we)|what (is|are) the (best|steps|requirements|options)|is it possible|can (i|we|my)|should (i|we)|do (i|we) need|any advice|advice (needed|please|on|regarding)|help (needed|please|with)|need (help|advice|guidance)|please help|confused|stuck|unsure|not sure)\b/i
];

const PLANNING = [
  /\b(planning to|plan to|planning on|thinking (of|about)|want to|wanting to|looking to|intend(ing)? to|considering|hoping to|would like to)\b[^.?!\n]{0,50}\b(apply|start|set up|setup|open|move|relocate|expand|register|form|launch|incorporate|sponsor|switch)/i
];

/* The author is selling, not buying. Taken from real posts by consultancies
   and law firms advertising in the same communities. */
const OFFERING = [
  /\b(we offer|we provide|we specialise|we specialize|our (firm|company|agency|team|services|consultancy|clients)|dm me (for|if)|i can help (you|anyone)|hire me|for hire|contact us|book a (free )?(call|consultation) with (me|us)|i am an? (immigration )?(adviser|advisor|consultant|lawyer|solicitor|attorney))\b/i,
  /\b(here (if|for) anyone (who )?needs|if anyone needs (a hand|help|assistance)|happy to help (anyone|out|you)|been (doing|helping with|handling)\b[^.\n]{0,40}\bfor (years|\d+\+? years)|feel free to (dm|message|reach out|contact)|(dm|message|pm) me\b|i (help|assist|support) (clients|people|businesses|founders|applicants)|we (help|assist|support|have helped)\b|free (consultation|assessment|eligibility check)|book (a|your) (call|consultation)|link in (bio|comments))/i,
  /\[(for hire|offer|service|promo)\]/i
];

/* The author has already got what they needed, or is sharing information
   rather than asking for anything. */
const ALREADY_DONE_TITLE = [
  /\b(approved|granted|success|successful|happy news|good news|finally got)\b/i,
  /\b(my experience|overall experience|timeline|tips|guide|here'?s (what|how)|what i learned|lessons learned|AMA)\b/i
];

/* Questions about a visa the author already holds: settlement, extensions,
   dependants, travel and waiting times. Paperwork on an existing route, not
   a new engagement. */
const EXISTING_ROUTE = /\b(ILR|indefinite leave|settlement|citizenship|naturali[sz]ation|exten[st]ion|extend|renew(al)?|stay outside|outside the (uk|uae|country) for|biometrics?|processing times?|still (no|waiting)|no decision|waiting (for|on)|stage 2|BRP|e-?visa|re-?entry|absences?|travel(ling)? (to|outside|abroad))\b/i;

/* United States routes share vocabulary ("self-petition", "talent") with
   UK ones and are not the consultancy's work. */
const US_ONLY = /\b(uscis|o-?1a?|eb-?1a?|eb-?2|niw|h-?1b|green ?card|i-140|i-129)\b/i;
const UK_CONTEXT = /\b(uk|united kingdom|britain|british|england|scotland|wales|london|home office|ukvi|isle of man|manx)\b/i;
/* Communities that are about the UK or the Isle of Man by their name
   (r/ukvisa, r/UniUK, r/IsleOfMan, the Immigration Boards forum). */
const UK_COMMUNITY = /(^|r\/)uk(?!raine)|uk$|britain|england|scotland|wales|london|isleofman|manx|immigration boards/i;
/* Routes with namesakes elsewhere: Australia also ran a "Global Talent"
   visa. These count only when the post or its community is about the UK. */
const NAMESAKE_SERVICES = new Set(['global-talent']);

/* Words in a later update by the same author showing the need has passed. */
const RESOLVED = /\b(solved|resolved|sorted (it|now|out)|all sorted|(visa|endorsement|application|licen[cs]e) (was |has been |got |is )?(approved|granted)|got (my|the|our) (visa|endorsement|licen[cs]e|approval)|found (a|an|someone|the right) (consultant|adviser|advisor|agency|company|firm|person|solicitor|lawyer)|(we|i)('ve| have)? (hired|engaged|appointed|gone with|decided to go with)|no longer (need|needed|required)|not needed any ?more|withdrew (my|the|our) application|decided not to (apply|go ahead|proceed))\b/i;

const PROVIDER_SERVICES = new Set(['market-research', 'marketing', 'sales-strategy', 'corporate-support', 'it-services', 'training', 'engineering', 'equipment']);

/* Sponsor licences, sponsor compliance and expansion are employer needs.
   Most posts that mention a CoS or a sponsor licence are written by workers
   about their own visa, who are not the consultancy's client for these services. They
   count only when the author writes as the business. */
const EMPLOYER_SERVICES = new Set(['sponsor-licence', 'hr-compliance', 'expansion-worker']);
const WRITES_AS_EMPLOYER = /\b((my|our) (own )?(company|business|firm|restaurant|shop|startup|start-up|agency|practice|clinic|care home|limited company|ltd)\b|we (want|need|are looking|plan|would like|are planning|are hoping) to (sponsor|hire|recruit|bring|get a sponsor|apply for a sponsor)|(i am|i'm|im) (a |the )?(director|owner|founder|co-founder|ceo|hr manager|employer|business owner)\b|as an employer\b|(our|my) (parent|overseas|foreign) company\b)/i;

/* Job seekers asking which employers sponsor visas. */
const JOB_SEEKER = /\b(looking for|find|finding|get|getting|searching for) (a |an )?((sponsored|sponsorship|visa) )?(job|role|employer|position)s?\b|\bcompan(y|ies) (that|who|which|willing to) (can |will )?sponsor\b/i;
/* Someone on a dependant visa moving to a route of their own is a new
   engagement, so these words lift the dependant rule. */
const SWITCHING = /\b(switch|switching|my own (company|business)|self[- ]?sponsor|start(ing)? (a|my) (company|business)|set(ting)? up (a|my) (company|business))/i;
const DEPENDANT_ONLY = /\b(dependa?n[ct]s?|spouse|partner|child|children|baby|wife|husband)\b/i;
const FOUNDER_SERVICES = new Set(['innovator-founder', 'global-talent', 'self-sponsorship', 'uk-company-formation', 'isle-of-man', 'italy-digital-nomad', 'uae-business-setup']);

function firstMatch(patterns, text) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m;
  }
  return null;
}

/* Returns { ok, services, intent, quote, reason }. `reason` explains a
   rejection, which the tests use and the live report prints. */
function assessPost({ title = '', body = '', community = '' }) {
  const t = oneLine(title);
  const text = t + '\n' + String(body || '');

  /* Posts on a personal profile page ("r/u/name") are the account owner's
     own announcements, in practice advertising. */
  if (/^(r\/)?u\//i.test(community)) return { ok: false, reason: 'posted on a personal profile page' };
  if (firstMatch(OFFERING, text)) return { ok: false, reason: 'offering services, not looking for them' };
  if (firstMatch(ALREADY_DONE_TITLE, t) && !/\?/.test(t)) return { ok: false, reason: 'reports an outcome or shares information, not a need' };
  if (US_ONLY.test(text) && !UK_CONTEXT.test(t)) return { ok: false, reason: 'about United States immigration' };
  if (EXISTING_ROUTE.test(t) && !SWITCHING.test(t)) return { ok: false, reason: 'about a visa the author already holds' };

  const ukPost = UK_CONTEXT.test(text) || UK_COMMUNITY.test(community);
  const services = matchServices(text, { quote: quoteAround }).filter(s => !NAMESAKE_SERVICES.has(s.id) || ukPost);
  if (!services.length) return { ok: false, reason: 'names no the consultancy service for the UK or the Isle of Man' };

  const explicit = firstMatch(EXPLICIT, text);
  const planning = firstMatch(PLANNING, text);
  const question = firstMatch(QUESTION, text) || (/\?\s*$/.test(t) ? { index: 0, 0: t } : null);

  const asEmployer = WRITES_AS_EMPLOYER.test(text);
  let usable = services.filter(s => !PROVIDER_SERVICES.has(s.id) || explicit);
  if (!usable.length) return { ok: false, reason: 'mentions a consultancy service without looking for a provider' };
  usable = usable.filter(s => !EMPLOYER_SERVICES.has(s.id) || asEmployer);
  if (!usable.length) return { ok: false, reason: 'an employer service mentioned by someone not writing as the employer' };
  if (JOB_SEEKER.test(text) && !usable.some(s => FOUNDER_SERVICES.has(s.id))) return { ok: false, reason: 'looking for a sponsored job' };
  /* A question about adding a child or partner to a visa someone already
     holds is paperwork for an existing route, not a new engagement. */
  if (DEPENDANT_ONLY.test(t) && !SWITCHING.test(text) && !EXPLICIT.some(re => re.test(text))) return { ok: false, reason: 'about a dependant on an existing visa' };

  let intent, m;
  if (explicit) { intent = 'explicit'; m = explicit; }
  else if (planning) { intent = 'planning'; m = planning; }
  else if (question) { intent = 'question'; m = question; }
  else return { ok: false, reason: 'not asking, planning or looking for help' };

  const quote = m.index === 0 && m[0] === t ? t : quoteAround(text, m.index, m[0].length);

  /* The need must be about the service, not beside it: the service is named
     in the title or in the very sentence that asks. A long post that asks
     about rent and mentions in passing that a friend holds a Global Talent
     visa is not a Global Talent lead. */
  const about = usable.filter(s => matchServices(t + '\n' + quote).some(x => x.id === s.id) || (intent === 'explicit' && text.length < 400));
  if (!about.length) return { ok: false, reason: 'the question is not about the the consultancy service it mentions' };
  return { ok: true, services: about, intent, quote };
}

/* Checks a later message by the original author for a statement that the
   need has passed. Returns the quote or null. */
function resolvedQuote(text) {
  const t = String(text || '');
  const m = RESOLVED.exec(t);
  return m ? quoteAround(t, m.index, m[0].length) : null;
}

module.exports = { assessPost, resolvedQuote };
