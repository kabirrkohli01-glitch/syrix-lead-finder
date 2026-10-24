'use strict';
/* People asking for help in public: Reddit and the Immigration Boards forum.
 *
 * Both are read through the public Atom feeds each site publishes for feed
 * readers, at feed-reader pace: a handful of requests per run. Reddit
 * rate-limits these feeds hard, so its subreddits are combined into one
 * multi-subreddit feed and its searches into one query.
 *
 * What is kept about a person is only what they posted publicly: their
 * username, the post and its link. The app does not look for their real
 * name, email address or other accounts, and the way to reach them is the
 * way the site itself provides — a reply or a message on that site.
 */

const { getText } = require('../http');
const { makeLead } = require('../lead');
const { parseAtom } = require('./feed');
const { assessPost, resolvedQuote } = require('../intent');
const { clip, oneLine, htmlToText, nameKey } = require('../text');

/* Communities read in full. General city and travel subreddits (r/dubai,
   r/UAE, r/digitalnomad) were tried and are almost entirely unrelated
   chatter that crowds the UK communities out of a 100-post feed; their
   relevant posts are reached through the search below instead. */
const REDDIT_SUBS = ['ukvisa', 'smallbusinessuk', 'IsleOfMan', 'ukstartups', 'UKBusiness'];
/* UK and Isle of Man routes only (FOCUS in services.js). */
const REDDIT_QUERY = '"innovator founder" OR "global talent visa" OR "self sponsorship" OR "self-sponsorship" OR "expansion worker" OR "sponsor licence" OR "sponsor license" OR "isle of man visa" OR "isle of man work permit" OR "isle of man company"';

const FORUM = 'https://www.immigrationboards.com';
const FORUM_FEEDS = [
  { id: 56, name: 'Start-up and Innovator Visas' },
  { id: 48, name: 'Global Talent Visas' },
  { id: 39, name: 'Skilled Worker Visas (Employer Sponsored)' },
  { id: 3, name: 'General UK Immigration' }
];

const MAX_AGE_DAYS = 30;

function redditFeeds() {
  /* The search goes first: it reaches every community and a month of posts,
     so it is the feed that matters if Reddit only answers one request. */
  return [
    { url: 'https://www.reddit.com/search.rss?q=' + encodeURIComponent(REDDIT_QUERY) + '&sort=new&t=month&limit=100', label: 'search' },
    { url: 'https://www.reddit.com/r/' + REDDIT_SUBS.join('+') + '/new/.rss?limit=100', label: 'new posts' }
  ];
}

/* Reddit appends "submitted by /u/x [link] [comments]" to every post body. */
function redditBody(text) {
  return String(text || '').replace(/\bsubmitted by\s+\/u\/[\s\S]*$/i, '').trim();
}

function redditUser(author) {
  return oneLine(author).replace(/^\/u\//, '');
}

function postLead({ source, sourceLabel, key, author, authorUrl, community, communityUrl, title, body, url, published, assessed, channel }) {
  const intentLabel = { explicit: 'Is looking for professional help', planning: 'Is planning a move the consultancy supports', question: 'Is asking how to do something the consultancy supports' }[assessed.intent];
  return makeLead({
    source,
    sourceLabel,
    key,
    kind: 'person',
    name: author,
    headline: clip(title, 160),
    location: '',
    signal: { type: 'post', intent: assessed.intent, label: intentLabel, detail: clip(title, 200), quote: assessed.quote, date: published, url },
    services: assessed.services,
    contact: { handle: author, profileUrl: authorUrl, channel, provenance: url },
    facts: [
      { label: 'Posted in', value: community, url: communityUrl },
      ...(assessed.alsoIn && assessed.alsoIn.length ? [{ label: 'Also posted in', value: assessed.alsoIn.join(', ') }] : []),
      { label: 'Post', value: clip(body, 900) || '(title only)' }
    ],
    ref: { postUrl: url, author }
  });
}

function fresh(published, now) {
  const t = Date.parse(published || '');
  return Number.isFinite(t) && now - t <= MAX_AGE_DAYS * 86400000;
}

async function collectReddit({ report, now = Date.now() } = {}) {
  const seen = new Map();
  const errors = [];
  for (const feed of redditFeeds()) {
    try {
      const xml = await getText(feed.url, { ttl: 45 * 60 * 1000, accept: 'application/atom+xml' });
      const entries = parseAtom(xml);
      if (report) report('Reddit ' + feed.label + ': ' + entries.length + ' posts');
      for (const e of entries) if (/^t3_/.test(e.id)) seen.set(e.id, e);
    } catch (err) {
      errors.push('Reddit ' + feed.label + ': ' + err.message);
    }
  }
  /* The same question is often posted to several communities at once. It is
     one person with one need, so it becomes one lead (the earliest post),
     with the other communities listed. */
  const groups = new Map();
  for (const e of [...seen.values()].sort((a, b) => String(a.published).localeCompare(String(b.published)))) {
    const k = redditUser(e.author).toLowerCase() + '|' + nameKey(e.title);
    if (!groups.has(k)) groups.set(k, { first: e, others: [] });
    else groups.get(k).others.push(e.category);
  }
  const leads = [];
  let scanned = 0;
  for (const { first: e, others } of groups.values()) {
    scanned++;
    if (!fresh(e.published, now)) continue;
    const author = redditUser(e.author);
    if (!author || author === '[deleted]') continue;
    const body = redditBody(e.text);
    const assessed = assessPost({ title: e.title, body, community: e.category || '' });
    if (!assessed.ok) continue;
    const sub = e.category ? (e.category.startsWith('r/') ? e.category : 'r/' + e.category) : 'Reddit';
    if (others.length) assessed.alsoIn = [...new Set(others.filter(Boolean))];
    leads.push(postLead({
      source: 'reddit',
      sourceLabel: 'Reddit',
      key: e.id,
      author: 'u/' + author,
      authorUrl: e.authorUrl || 'https://www.reddit.com/user/' + encodeURIComponent(author),
      community: sub,
      communityUrl: 'https://www.reddit.com/' + sub + '/',
      title: e.title,
      body,
      url: e.url,
      published: e.published,
      assessed,
      channel: 'Reply on the post or send a Reddit chat message. Read the community\'s rules on promotion first and write to the person, not a template.'
    }));
  }
  if (errors.length && !seen.size) throw new Error(errors.join('; '));
  return { leads, scanned, warnings: errors };
}

/* phpBB titles look like "Forum name • Topic" or "Forum name • Re: Topic". */
function splitForumTitle(title) {
  const parts = String(title || '').split(' • ');
  const topic = parts.length > 1 ? parts.slice(1).join(' • ') : parts[0];
  return { forum: parts.length > 1 ? parts[0] : '', topic, isReply: /^Re:/i.test(topic) };
}

function forumPostId(url) {
  const m = /[?&]p=(\d+)/.exec(url || '');
  return m ? m[1] : null;
}

async function collectForum({ report, now = Date.now() } = {}) {
  const leads = [];
  const errors = [];
  let scanned = 0;
  for (const f of FORUM_FEEDS) {
    try {
      const xml = await getText(FORUM + '/app.php/feed/forum/' + f.id, { ttl: 45 * 60 * 1000, accept: 'application/atom+xml' });
      const entries = parseAtom(xml);
      if (report) report('Immigration Boards, ' + f.name + ': ' + entries.length + ' posts');
      for (const e of entries) {
        scanned++;
        const { topic, isReply } = splitForumTitle(e.title);
        if (isReply || !fresh(e.published, now)) continue;
        const body = String(e.text || '').replace(/Statistics: Posted by[\s\S]*$/i, '').trim();
        const assessed = assessPost({ title: topic, body, community: 'Immigration Boards' });
        if (!assessed.ok) continue;
        const postId = forumPostId(e.url);
        if (!postId || !e.author) continue;
        leads.push(postLead({
          source: 'immigration-boards',
          sourceLabel: 'Immigration Boards forum',
          key: postId,
          author: e.author,
          authorUrl: '',
          community: 'Immigration Boards — ' + f.name,
          communityUrl: FORUM + '/viewforum.php?f=' + f.id,
          title: topic,
          body,
          url: e.url,
          published: e.published,
          assessed,
          channel: 'Reply on the forum topic, or send a private message from a forum account. Check the forum\'s rules on advertising first.'
        }));
      }
    } catch (err) {
      errors.push(f.name + ': ' + err.message);
    }
  }
  if (errors.length === FORUM_FEEDS.length) throw new Error(errors.join('; '));
  return { leads, scanned, warnings: errors };
}

/* ---------- checking whether a post's need has passed ---------- */

/* Reddit: the post's own comment feed. The first entry is the post itself;
   the rest are comments. Evidence the need has passed is the post being
   deleted or removed, or the original author saying so in the thread. */
async function checkRedditPost(lead) {
  const url = String(lead.ref && lead.ref.postUrl || '').replace(/\/?$/, '/') + '.rss';
  let xml;
  try { xml = await getText(url, { ttl: 3 * 60 * 60 * 1000, accept: 'application/atom+xml' }); }
  catch (e) {
    if (e.status === 404) return { tooLate: true, reason: 'The post no longer exists on Reddit', url: lead.ref.postUrl };
    throw e;
  }
  const entries = parseAtom(xml);
  if (!entries.length) return { tooLate: false };
  const post = entries[0];
  const postBody = redditBody(post.text);
  if (/^\/u\/\[deleted\]$/i.test(post.author) || /^\[(deleted|removed)\]$/i.test(postBody) || /^\[(deleted by user|removed by reddit)\]/i.test(post.title)) {
    return { tooLate: true, reason: 'The author deleted the post, or Reddit removed it', url: lead.ref.postUrl };
  }
  const op = String(lead.ref.author || '').replace(/^u\//, '').toLowerCase();
  const titleDone = resolvedQuote(post.title) || (/\b(solved|resolved)\b/i.test(post.title) ? post.title : null);
  if (titleDone) return { tooLate: true, reason: 'The author updated the post title to say it is resolved', url: lead.ref.postUrl, quote: titleDone };
  for (const c of entries.slice(1)) {
    if (redditUser(c.author).toLowerCase() !== op) continue;
    const q = resolvedQuote(redditBody(c.text));
    if (q) return { tooLate: true, reason: 'The author said in the thread that the need has passed', url: c.url || lead.ref.postUrl, quote: q };
  }
  const editDone = resolvedQuote((postBody.match(/\b(edit|update)\b\s*:?[\s\S]*$/i) || [''])[0]);
  if (editDone) return { tooLate: true, reason: 'The author edited the post to say the need has passed', url: lead.ref.postUrl, quote: editDone };
  return { tooLate: false };
}

/* Immigration Boards: the topic page. phpBB marks every post with its
   author; a later post by the topic's author saying it is resolved, or a
   "solved" title, is the evidence. A missing topic is too. */
async function checkForumPost(lead) {
  let html;
  try { html = await getText(lead.ref.postUrl.replace(/#.*$/, ''), { ttl: 3 * 60 * 60 * 1000, accept: 'text/html' }); }
  catch (e) {
    if (e.status === 404) return { tooLate: true, reason: 'The topic no longer exists on the forum', url: lead.ref.postUrl };
    throw e;
  }
  if (/The requested (topic|post) does not exist/i.test(html)) return { tooLate: true, reason: 'The topic no longer exists on the forum', url: lead.ref.postUrl };
  const title = htmlToText((html.match(/<h2[^>]*class="topic-title"[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || '');
  if (/\[?\b(solved|resolved)\b\]?/i.test(title)) return { tooLate: true, reason: 'The topic is marked solved', url: lead.ref.postUrl, quote: title };
  const author = String(lead.ref.author || '').toLowerCase();
  const posts = String(html).split(/<div id="p\d+" class="post /).slice(1);
  for (const p of posts.slice(1)) {
    const who = htmlToText((p.match(/class="username(?:-coloured)?"[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '').toLowerCase();
    if (!who || who !== author) continue;
    const content = htmlToText((p.match(/<div class="content">([\s\S]*?)<\/div>\s*(?:<div|<dl)/i) || [])[1] || '');
    const q = resolvedQuote(content);
    if (q) return { tooLate: true, reason: 'The author said in the topic that the need has passed', url: lead.ref.postUrl, quote: q };
  }
  return { tooLate: false };
}

module.exports = { collectReddit, collectForum, checkRedditPost, checkForumPost, redditBody, splitForumTitle, REDDIT_SUBS, FORUM_FEEDS };
