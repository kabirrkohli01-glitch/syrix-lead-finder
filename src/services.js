'use strict';
/* the consultancy's service lines and the evidence that ties a lead to one of them.
 *
 * A lead is only ever attached to a service when a rule below matches text
 * the source actually published, and the matching words are kept as the
 * evidence. Nothing is inferred from a name, an industry or a guess.
 *
 * Patterns use a LEADING word boundary only. A trailing \b around an
 * alternation forces the match to end on a boundary, so a stem such as
 * "consultan" could never match "consultancy". Short tokens that need a
 * trailing boundary carry their own.
 *
 * `cpv` lists Common Procurement Vocabulary prefixes. Public tenders carry a
 * CPV code chosen by the buyer, which is a stronger signal than wording.
 *
 * Lead finding covers the UK and the Isle of Man. A service tied to another
 * country carries `region`; it stays listed (the consultancy offers it, and SYRIX can
 * describe it) but matchServices never returns it, so it produces no leads.
 */

const FOCUS = 'the UK and the Isle of Man';

const SERVICES = [
  {
    id: 'innovator-founder',
    name: 'UK Innovator Founder visa',
    area: 'Visa routes',
    audience: 'person',
    patterns: [/\binnovator[\s-]+founder/i, /\binnovator visa/i, /\bendorsing bod(y|ies)/i, /\binnovator endorsement/i]
  },
  {
    id: 'global-talent',
    name: 'UK Global Talent visa',
    area: 'Visa routes',
    audience: 'person',
    patterns: [/\bglobal talent/i, /\bGTV\b/, /\bexceptional (talent|promise)\b/i]
  },
  {
    id: 'self-sponsorship',
    name: 'UK self-sponsorship',
    area: 'Visa routes',
    audience: 'person',
    patterns: [/\bself[\s-]?sponsor/i, /\bsponsor (myself|yourself|themselves)\b/i, /\bsponsor me through my own company/i, /\bmy own (uk )?company (to )?sponsor/i]
  },
  {
    id: 'expansion-worker',
    name: 'UK Expansion Worker and global business mobility',
    area: 'Visa routes',
    audience: 'both',
    patterns: [/\bexpansion worker/i, /\bglobal business mobility/i, /\bGBM\b/, /\bsenior (or|and) specialist worker/i, /\bsole representative/i, /\b(uk|british) (branch|subsidiary)\b/i, /\bopen(ing)? (a|an) (uk|british) (office|branch|subsidiary)/i]
  },
  {
    id: 'sponsor-licence',
    name: 'Sponsor licence application',
    area: 'Visa routes',
    audience: 'organisation',
    patterns: [/\bsponsor(ship)? licen[cs]e/i, /\bbecome a (licensed )?sponsor/i, /\bcertificates? of sponsorship/i, /\bCoS\b/]
  },
  {
    id: 'hr-compliance',
    name: 'HR sponsor licence and compliance training',
    area: 'Compliance',
    audience: 'organisation',
    patterns: [/\bright to work check/i, /\bsponsor (duties|compliance)/i, /\bcompliance visit/i, /\bB[- ]rat(ed|ing)\b/i, /\baction plan\b.*\bsponsor/i, /\billegal working/i, /\bcivil penalt/i, /\bsponsor management system/i, /\bauthorising officer/i]
  },
  {
    id: 'uk-company-formation',
    name: 'UK company formation and business start-up',
    area: 'Business setup',
    audience: 'both',
    patterns: [/\b(start|set up|setup|register|open|incorporate|form)(ing)? (a |my |our )?(own )?(new )?(business|company|limited company|ltd) in (the )?(uk|united kingdom|england|london|scotland|wales)/i, /\bcompany formation\b.*\b(uk|united kingdom)/i, /\b(uk|british) company formation/i, /\bnon[- ]resident director/i]
  },
  {
    id: 'isle-of-man',
    name: 'Isle of Man company and visa routes',
    area: 'Business setup',
    audience: 'both',
    patterns: [/\bisle of man\b.*\b(visa|company|business|innovator|start[- ]?up|sole representative|relocat|work permit|incorporat)/i, /\b(visa|company|business|innovator|start[- ]?up|relocat|work permit|incorporat)\w*\b.*\bisle of man\b/i, /\bmanx (company|business|visa|work permit)/i]
  },
  {
    id: 'italy-digital-nomad',
    name: 'Italy Digital Nomad visa',
    area: 'Visa routes',
    region: 'Italy',
    audience: 'person',
    patterns: [/\b(italy|italian)\b.*\bdigital nomad/i, /\bdigital nomad\b.*\b(italy|italian)\b/i, /\bnomadi digitali/i]
  },
  {
    id: 'uae-business-setup',
    name: 'UAE business setup and investor visa',
    area: 'Business setup',
    region: 'UAE',
    audience: 'both',
    patterns: [/\b(free ?zone|mainland) (company|licen[cs]e|setup|set up|business)/i, /\b(set up|setup|start|open|register|form)(ing)? (a |my |our )?(business|company|llc)\b.*\b(dubai|uae|abu dhabi|sharjah|emirates)\b/i, /\b(dubai|uae|abu dhabi)\b.*\b(company formation|business setup|business set up|trade licen[cs]e|investor visa)/i, /\binvestor visa\b.*\b(dubai|uae)\b/i]
  },
  {
    id: 'market-research',
    name: 'Market research',
    area: 'Consultancy',
    audience: 'organisation',
    cpv: ['793'],
    patterns: [/\bmarket research/i, /\bmarket (analysis|assessment|study|sizing|intelligence)/i, /\bfeasibility stud/i, /\bmarket entry\b/i, /\bcompetitor analysis/i, /\bcustomer insight/i, /\b(economic|demand) (study|assessment|analysis)/i]
  },
  {
    id: 'marketing',
    name: 'Marketing strategy and delivery',
    area: 'Consultancy',
    audience: 'organisation',
    cpv: ['7934', '79413', '79416'],
    patterns: [/\bmarketing (strategy|services|support|campaign|consultan|agency|plan)/i, /\bbrand(ing)? (strategy|development|refresh)/i, /\bcommunications strategy/i, /\bdigital marketing/i, /\bcampaign (design|delivery)/i]
  },
  {
    id: 'sales-strategy',
    name: 'Sales strategy and go-to-market',
    area: 'Consultancy',
    audience: 'organisation',
    patterns: [/\bsales strateg/i, /\bgo[- ]to[- ]market/i, /\bbusiness development (support|strategy|programme)/i, /\bcommerciali[sz]ation (support|strategy)/i, /\bexport (support|strategy|growth)/i, /\binternational trade (support|advis)/i]
  },
  {
    id: 'corporate-support',
    name: 'Business and management consultancy',
    area: 'Consultancy',
    audience: 'organisation',
    cpv: ['79410', '79411', '79412', '79414', '79415', '79418', '79419', '7942', '79421', '72221'],
    patterns: [/\bmanagement consultan/i, /\bbusiness consultan/i, /\bbusiness support (programme|services|provider)/i, /\b(process|performance|service) improvement/i, /\boperating model/i, /\bproject management (support|services)/i, /\bprocurement (support|advis|consultan)/i, /\bbusiness (case|plan) (development|support|writing)/i, /\borgani[sz]ational (review|design|development)/i, /\bstart[- ]up (support|programme|advice)/i, /\bbusiness growth (programme|support)/i]
  },
  {
    id: 'it-services',
    name: 'IT and digital technology services',
    area: 'Specialist',
    audience: 'organisation',
    /* Consultancy, software, integration and support codes. The rest of
       division 72 is broadband, hosting and data services, which the consultancy does
       not supply; 72000000 itself is the general "IT services" heading. */
    cpv: ['72000000', '7211', '722', '7231', '7232', '726'],
    patterns: [/\bdigital transformation/i, /\bIT (consultan|strategy|support|services)/, /\bsoftware development/i, /\bcyber ?security (review|assessment|services|consultan)/i, /\bsystems? (architecture|integration)/i, /\bdata (platform|analytics|strategy)/i, /\bautomation (of|services)/i, /\bdiscovery (phase|project)\b/i]
  },
  {
    id: 'training',
    name: 'Training and masterclasses',
    area: 'Specialist',
    audience: 'organisation',
    cpv: ['805', '8042', '8051', '8053', '8054', '8055', '8056', '8057', '8058'],
    /* Training CPV codes also cover first aid, driving and similar courses,
       so a code alone is not enough: the text must name a subject the consultancy teaches. */
    cpvNeedsText: true,
    patterns: [/\b(cyber ?security|information security|software|AI) (skills |awareness )?training/i, /\b(digital|cyber|devops|data|technical|sales|marketing|leadership|innovation|design thinking|compliance|hr) (skills )?training/i, /\btraining (programme|provider|services)\b.*\b(digital|cyber|data|sales|leadership|innovation|business)/i, /\bmasterclass/i, /\bupskilling/i]
  },
  {
    id: 'engineering',
    name: 'Electrical and marine engineering advisory',
    area: 'Specialist',
    audience: 'organisation',
    /* Energy, electrical and mechanical engineering codes only. The parent
       7131 also covers civil and structural engineering, which the consultancy does not do. */
    cpv: ['71314', '71321', '71323', '71334'],
    patterns: [/\bmarine engineering/i, /\belectrical engineering (advis|consultan|services|support)/i, /\b(offshore wind|renewable energy|marine) (advis|consultan|engineering)/i, /\bmaritime (advis|consultan|engineering)/i, /\bvessel (survey|engineering)/i]
  },
  {
    id: 'equipment',
    name: 'Material handling equipment sourcing',
    area: 'Equipment',
    audience: 'organisation',
    /* Lifting and handling equipment only. 34144 (special-purpose vehicles)
       also covers fire engines and refuse trucks, which the consultancy does not source. */
    cpv: ['4241', '42415', '42418', '42417'],
    patterns: [/\bfork ?lift/i, /\bmaterial handling equipment/i, /\bpallet (truck|stacker)/i, /\breach truck/i, /\btelehandler/i, /\b(scissor|boom) lift/i, /\bwarehouse (equipment|racking|truck)/i]
  }
];

const BY_ID = Object.fromEntries(SERVICES.map(s => [s.id, s]));

/* Returns every service whose patterns match, with the matched words and the
   sentence they sit in. `audience` limits the set ('person' leads never get
   organisation-only services such as a tender category). */
function matchServices(text, { audience = null, quote = null } = {}) {
  const t = String(text || '');
  const out = [];
  for (const s of SERVICES) {
    if (s.region) continue;
    if (audience && s.audience !== 'both' && s.audience !== audience) continue;
    for (const re of s.patterns) {
      const m = re.exec(t);
      if (m) {
        out.push({ id: s.id, name: s.name, matched: m[0], quote: quote ? quote(t, m.index, m[0].length) : m[0] });
        break;
      }
    }
  }
  return out;
}

/* Services whose CPV prefix matches a tender's classification code. */
function matchCpv(code) {
  const c = String(code || '').replace(/\D/g, '');
  if (!c) return [];
  return SERVICES.filter(s => (s.cpv || []).some(p => c.startsWith(p))).map(s => ({ id: s.id, name: s.name, matched: 'CPV ' + c, needsText: !!s.cpvNeedsText }));
}

/* Services that can produce leads under the current focus. */
const IN_FOCUS = SERVICES.filter(s => !s.region);

module.exports = { SERVICES, IN_FOCUS, FOCUS, BY_ID, matchServices, matchCpv };
