# How lead finders work, and the design this one follows

Written October 2026 before the build. It records what existing tools do, which
of their methods can be used here legally and for free, and why each source was
chosen or left out.

## How existing tools find leads

| Approach | Typical tools | How it works | Fit for the consultancy |
|---|---|---|---|
| **Contact databases** | Apollo, ZoomInfo, Lusha, RocketReach | Very large databases of people and companies, built largely by crawling the web and from data partnerships, searched by job title, industry and size. | Shows who exists, not who needs anything now. Free tiers allow only a handful of exports a month. Much of the data is scraped, which conflicts with UK GDPR transparency duties and with email platforms' rules on imported lists. **Not used.** |
| **Enrichment and waterfalls** | Clay, Hunter | Start from a company name or domain and fill in website, emails and phone by querying several providers in turn. | The method is sound when every value keeps its source. Used here in a free form: Companies House for the company, and the organisation's own website for contact details. |
| **Intent data** | Bombora, 6sense, Demandbase | Infer buying intent from content consumption across publisher networks and from website visits. | Needs paid data co-ops and tracking scripts. **Not available free.** |
| **Social listening** | Syften, F5Bot, Octolens, Common Room | Watch public communities for posts asking for a recommendation or describing a problem, then alert the seller. | The strongest free signal for individuals: the person says in their own words that they need help. Used, through the communities' public feeds. |
| **Trigger events** | Sales tools' "signals" features | Act on public events: funding, hiring, new office, regulatory action, a tender. | The strongest free signal for organisations, because UK government publishes many of these events as open data. Used as the core of this tool. |

The conclusion: a list of names is not a lead. A **lead** is an organisation or person
with a current, evidenced need, a way to reach them, and a reason the timing is now.
Every lead this tool shows carries the published words that prove the need.

## Sources

### Used

| Source | Signal | Access | Notes |
|---|---|---|---|
| Find a Tender (GOV.UK) | Public bodies inviting bids for consultancy, research, marketing, IT, training, engineering and equipment | OCDS JSON API, no key | The main tender source since the Procurement Act 2023 moved most notices here. Its stage filter drops most notices, so the whole feed is read and filtered locally. It rate-limits, so requests are spaced four seconds apart and partial sweeps are kept. |
| Contracts Finder (GOV.UK) | As above, for procurements still on the older regime | OCDS JSON API, no key | Low volume now; kept because notices still appear. |
| Register of licensed sponsors (Home Office) | B-rated sponsors (downgraded, under an action plan); sponsors on the UK Expansion Worker route (overseas businesses setting up in the UK); new and removed sponsors | Daily CSV on GOV.UK | New and removed sponsors are found by comparing with the previous day's file. The register never says why a sponsor was removed, so the tool never claims a reason. |
| Illegal working civil penalties report (Home Office) | Employers named for illegal working penalties: a right-to-work compliance need | Quarterly HTML report on GOV.UK | The report names only employers that meet the Home Office's publication criteria. |
| Companies House | Registered number, status, incorporation date, registered office, nature of business, current officers | Public website pages, no key | A match needs the exact registered name, and the place where one is known. A dissolved company never stands in for a live one. |
| Organisation websites | Published email, phone and LinkedIn page | Direct fetch | A site is accepted only when it shows the company number, the postcode, or the name with the town. |
| Reddit | People asking about UK visa routes, sponsor licences, and company setup in the UK or the Isle of Man | Public RSS feeds | Reddit stopped unauthenticated JSON access in 2026 and limits RSS sharply, so the tool makes two feed requests per run, twelve seconds apart. Only the username, post and link are kept. |
| Immigration Boards forum | The same, in the Start-up and Innovator, Global Talent, Skilled Worker and general forums | Public Atom feeds | New topics only, not replies. |

### Considered and left out

| Source | Why not |
|---|---|
| LinkedIn | Requires a login, and its terms forbid automated collection. Leads link to an organisation's LinkedIn page when its own website links to it. |
| X (Twitter) | Search needs a paid API tier. |
| Facebook groups | Require a login and offer no public search API. |
| Bluesky | The public search endpoint refused requests from this machine (HTTP 403). |
| Stack Exchange | Questions are public, but the site offers no way to contact the asker, and promotional answers are against its rules. |
| Search engines for bulk lookups | DuckDuckGo answers repeated lookups with an "unusual traffic" page. The tool respects that and pauses it for six hours. Likely domains are checked directly instead. |
| Bought or rented lists | Cannot be used for email marketing under PECR, and email platforms suspend accounts that import them. |

## Rules the tool keeps

- **Evidence or nothing.** Every lead, every service match and every "too late" decision links to the published source and quotes the words it rests on.
- **Too late means verified.** A lead moves there only when a source shows the need has passed: the tender closed or was awarded or cancelled, the sponsor's A rating was restored, the company was dissolved or is being struck off, the post was deleted, or the person said so in the thread. A lead the user marked won or not a fit is never moved.
- **Dated by the source, not by the finder.** A register downloaded today lists licences granted years ago, and a tender amended today can date from years before. Each lead is dated by when the source first published the evidence, and evidence older than its kind allows (`src/freshness.js`) is retired with that date as the reason. Where a source publishes no date, the lead says so rather than borrowing the date it was found.
- **People are contacted where they posted.** For individuals, the tool keeps only what they published (username, post, link) and never looks for their email address or other accounts. Personal leads are deleted 30 days after they become too late or not a fit.
- **Organisations are contacted at their business address.** In the UK, electronic marketing to a limited company's business address is allowed when the sender is identified, the message is relevant, and every message offers an opt-out. Sole traders and partnerships are treated as individuals and need consent or the soft opt-in.
- **Polite access.** One honest User-Agent, spacing between requests, caching, and an immediate stop when a source asks for one.

## References

- ICO, business-to-business marketing: https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/
- Find a Tender data and API documentation: https://www.find-tender.service.gov.uk/Developer/Documentation
- Register of licensed sponsors: https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers
- Illegal working penalties report: https://www.gov.uk/government/publications/illegal-working-penalties-uk-report
- Brevo anti-spam policy (purchased and scraped lists): https://www.brevo.com/legal/antispampolicy/
