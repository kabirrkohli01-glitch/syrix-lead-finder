'use strict';
/* SYRIX in SYRIX Lead Finder: the chat panel and the overview box on each lead.
 *
 * Answers run on the server as jobs; this file polls a job every 250 ms and
 * draws its steps ("Searching the leads: sponsor licence") and its words as
 * they arrive. The page's Content Security Policy forbids inline handlers, so
 * every control uses data-act and is added to app.js's ACTIONS table.
 */

(function () {
  const G = window.LF;
  const { esc, safeUrl, api, toast } = G;
  const $ = s => document.querySelector(s);

  const panel = $('#syrix');
  const body = $('#sx-body');
  const input = $('#sx-input');
  const sendBtn = $('#sx-send');

  const thread = [];          // { role, content }
  let busy = false;
  let paired = null;          // null until the server has been asked
  let isOpen = false;

  const SUGGESTIONS = [
    'Which companies need help with their sponsor licence?',
    'Who is looking for help with a Global Talent or Innovator Founder visa?',
    'Which tenders close in the next two weeks?',
    'Is it legal to email these companies about our services?'
  ];

  /* ---------- formatting ---------- */

  /* A small, safe Markdown reader: text is escaped first, then a fixed set of
     patterns is turned into markup. Links to leads ("lead:ID") become buttons
     that open the lead; other links must be http(s). */
  function inline(s) {
    let t = esc(s);
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      const h = href.replace(/&amp;/g, '&');
      if (/^lead:/.test(h)) return '<button class="sx-lead" data-act="syrix-lead" data-id="' + esc(h.slice(5)) + '" type="button">' + label + '</button>';
      const u = safeUrl(h);
      return u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
    });
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48) + '</a>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    return t;
  }

  function markdown(src) {
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    const out = [];
    let list = null;
    const close = () => { if (list) { out.push('</' + list + '>'); list = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
        if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + inline(m[1]) + '</li>');
      } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
        if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + inline(m[1]) + '</li>');
      } else if ((m = /^#{1,4}\s+(.*)$/.exec(line))) {
        close(); out.push('<h4>' + inline(m[1]) + '</h4>');
      } else if (!line.trim()) {
        close();
      } else {
        close(); out.push('<p>' + inline(line) + '</p>');
      }
    }
    close();
    return out.join('');
  }

  /* ---------- the panel ---------- */

  /* On a wide screen the panel docks beside the app and the app narrows to
     make room, so the leads stay scrollable and clickable while chatting. On
     a narrow screen there is no room beside it, so it covers the app. */
  const narrow = () => window.matchMedia('(max-width: 900px)').matches;
  function setOpen(open) {
    isOpen = open;
    panel.classList.toggle('is-open', open);
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    document.body.classList.toggle('sx-docked', open && !narrow());
    document.body.classList.toggle('sx-locked', open && narrow());
    if (open) {
      checkPaired();
      if (!thread.length && !body.children.length) drawEmpty();
      setTimeout(() => input.focus(), 220);
    }
  }

  async function checkPaired() {
    try {
      const s = await api('/api/syrix');
      paired = !!s.paired;
      $('#sx-sub').textContent = !s.paired ? 'Not connected' : s.online ? 'Lead Finder edition' : 'Offline — check the connection';
    } catch { paired = false; }
    $('#sx-pair').hidden = paired !== false;
    body.hidden = paired === false;
    input.disabled = paired === false;
  }

  function drawEmpty() {
    body.innerHTML =
      '<div class="sx-empty">' +
        '<img src="assets/syrix-mark.png" alt="" width="72" height="72" class="sx-empty-mark">' +
        '<h3>Hi, I’m SYRIX.</h3>' +
        '<p>I can read every lead in this app. Ask me who needs what, where they are, how to reach them, or whether an approach is allowed.</p>' +
        '<div class="sx-chips">' + SUGGESTIONS.map(s => '<button class="sx-chip" data-act="syrix-suggest" type="button">' + esc(s) + '</button>').join('') + '</div>' +
      '</div>';
  }

  function nearBottom() { return body.scrollHeight - body.scrollTop - body.clientHeight < 80; }
  function toBottom(force) { if (force || nearBottom()) body.scrollTop = body.scrollHeight; }

  function addMessage(role, html) {
    const empty = body.querySelector('.sx-empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'sx-msg sx-' + role;
    el.innerHTML = role === 'user'
      ? '<div class="sx-bubble">' + html + '</div>'
      : '<div class="sx-avatar-wrap"><img class="sx-avatar" src="assets/syrix-mark.png" alt=""></div>' +
        '<div class="sx-main">' +
          '<div class="sx-thinking"><span class="sx-think-label">Thinking</span></div>' +
          '<details class="sx-trace" hidden><summary></summary><ol></ol></details>' +
          '<div class="sx-bubble"></div>' +
        '</div>';
    body.appendChild(el);
    toBottom(true);
    return el;
  }

  /* While SYRIX works, one shimmering line shows the step it is on, and the
     new label slides in when the step changes. Once the answer starts, the
     steps fold into a single "Checked …" line that can be opened. */
  function drawThinking(el, steps) {
    const label = el.querySelector('.sx-think-label');
    const cur = [...steps].reverse().find(s => s.state === 'running');
    const text = cur ? cur.label : steps.length ? 'Working out the answer' : 'Thinking';
    if (label.textContent !== text) {
      label.classList.remove('is-in');
      void label.offsetWidth;
      label.textContent = text;
      label.classList.add('is-in');
    }
  }

  function drawTrace(el, steps) {
    const work = steps.filter(s => !/^(Thinking|Working out the answer|Done)$/.test(s.label));
    const trace = el.querySelector('.sx-trace');
    if (!work.length) { trace.hidden = true; return; }
    const short = [...new Set(work.map(s => s.label.split(':')[0]))];
    trace.querySelector('summary').textContent = 'Checked: ' + short.join(' · ');
    trace.querySelector('ol').innerHTML = work.map(s => '<li class="is-' + esc(s.state) + '">' + esc(s.label) + '</li>').join('');
    trace.hidden = false;
  }

  /* Markdown that is still being typed can end half way through a link, a
     bold run or a code span. The unfinished tail is held back until it is
     complete, so raw "](http" or a stray "**" never flashes on screen. */
  function streamGuard(t) {
    let s = t;
    s = s.replace(/\[[^\]\n]*$/, '');                      // "[label" with no closing bracket yet
    s = s.replace(/\[([^\]\n]*)\]\([^)\n]*$/, '$1');       // "[label](partial-url"
    if ((s.match(/\*\*/g) || []).length % 2) s = s.replace(/\*\*(?!.*\*\*)/, '');
    if ((s.match(/`/g) || []).length % 2) s = s.replace(/`(?!.*`)/, '');
    return s;
  }

  /* The caret sits at the end of the last line being written, not on a line
     of its own under it. */
  function withCaret(html) {
    const caret = '<span class="sx-caret"></span>';
    return /(<\/(p|li|h4)>)(<\/(ul|ol)>)?$/.test(html)
      ? html.replace(/(<\/(p|li|h4)>)(<\/(ul|ol)>)?$/, caret + '$1$3')
      : html + caret;
  }

  /* Types text out at a steady, natural pace however it arrives from the
     server — in small pieces, in bursts, or as a whole answer at once.
     Falls further behind, types faster, so it never lags far behind. */
  class Typer {
    constructor(el, onFrame) {
      this.el = el;
      this.onFrame = onFrame || (() => {});
      this.target = '';
      this.shown = 0;
      this.done = false;
      this.raf = null;
      this.finished = null;
      this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    set(text, done) {
      if (text.length < this.target.length && !text.startsWith(this.target.slice(0, text.length))) this.shown = 0;
      this.target = text;
      this.done = !!done;
      if (!this.raf) this.raf = requestAnimationFrame(() => this.tick());
      return new Promise(r => { this.finished = r; if (this.done && this.shown >= this.target.length) this.complete(); });
    }
    tick() {
      this.raf = null;
      const remaining = this.target.length - this.shown;
      if (remaining > 0) {
        const step = this.reduced ? remaining : Math.max(2, Math.ceil(remaining / 24));
        let next = Math.min(this.target.length, this.shown + step);
        const space = this.target.indexOf(' ', next);
        if (space > 0 && space - next < 6) next = space;   // end on a word, not mid-word
        this.shown = next;
        const part = this.target.slice(0, this.shown);
        const live = this.shown < this.target.length || !this.done;
        this.el.innerHTML = live ? withCaret(markdown(streamGuard(part))) : markdown(this.target);
        this.onFrame();
      }
      if (this.shown < this.target.length) this.raf = requestAnimationFrame(() => this.tick());
      else if (this.done) this.complete();
    }
    complete() {
      this.el.innerHTML = markdown(this.target);
      this.onFrame();
      if (this.finished) { this.finished(); this.finished = null; }
    }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function follow(jobId, onUpdate) {
    for (;;) {
      await sleep(150);
      let j;
      try { j = await api('/api/syrix/job/' + encodeURIComponent(jobId)); }
      catch (err) { return { error: err.message }; }
      onUpdate(j);
      if (j.done) return j;
    }
  }

  async function send(text) {
    const q = String(text || '').trim();
    if (!q || busy) return;
    if (paired === false) { checkPaired(); return; }
    busy = true;
    sendBtn.disabled = true;
    input.value = '';
    autosize();
    thread.push({ role: 'user', content: q });
    addMessage('user', esc(q).replace(/\n/g, '<br>'));
    const el = addMessage('syrix');
    el.classList.add('is-thinking');
    const bubble = el.querySelector('.sx-bubble');
    const typer = new Typer(bubble, () => toBottom());
    const stopThinking = () => { el.classList.remove('is-thinking'); el.classList.add('is-answering'); };

    try {
      const { jobId } = await api('/api/syrix/ask', { messages: thread.slice(-20), view: G.currentView() });
      const j = await follow(jobId, job => {
        const steps = job.steps || [];
        drawThinking(el, steps);
        if (job.text) {
          if (el.classList.contains('is-thinking')) { stopThinking(); drawTrace(el, steps); }
          typer.set(job.text, false);
        }
      });
      stopThinking();
      drawTrace(el, j.steps || []);
      if (j.error) {
        bubble.innerHTML = '<p class="sx-error">' + esc(j.code === 'not_paired' ? 'SYRIX is not connected yet.' : j.error) + '</p>';
        if (j.code === 'not_paired') { paired = false; checkPaired(); }
      } else {
        const text = j.text || 'I did not get an answer back. Try again in a moment.';
        await typer.set(text, true);
        thread.push({ role: 'assistant', content: j.text || '' });
      }
    } catch (err) {
      stopThinking();
      bubble.innerHTML = '<p class="sx-error">' + esc(err.message) + '</p>';
    } finally {
      el.classList.remove('is-answering');
      busy = false;
      sendBtn.disabled = false;
      toBottom();
      input.focus();
    }
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen && panel.contains(document.activeElement)) setOpen(false); });
  window.addEventListener('resize', () => { if (isOpen) setOpen(true); });

  /* ---------- the overview box on each lead ---------- */

  const overviews = new Map();   // lead id -> { text, state: 'loading'|'done'|'error', error }

  function drawOverview(id) {
    const box = document.getElementById('ov-box');
    if (!box || box.dataset.id !== id) return;
    const o = overviews.get(id);
    const head = '<div class="ov-head"><img src="assets/syrix-mark.png" alt="" width="22" height="22"><h3>SYRIX AI overview</h3>' +
      (o && o.state === 'done' ? '<button class="ov-refresh" data-act="overview-refresh" data-id="' + esc(id) + '" type="button" title="Write it again">Refresh</button>' : '') + '</div>';
    let inner;
    if (paired === false) inner = '<p class="ov-muted">Connect SYRIX to see an overview of this lead. <button class="sx-lead" data-act="syrix-open" type="button">Connect</button></p>';
    else if (!o || (o.state === 'loading' && !o.text)) inner = '<div class="ov-skeleton"><i></i><i></i><i></i></div>';
    else if (o.state === 'error') inner = '<p class="ov-muted">' + esc(o.error) + ' <button class="sx-lead" data-act="overview-refresh" data-id="' + esc(id) + '" type="button">Try again</button></p>';
    else if (o.state === 'loading') inner = '<div class="ov-text"></div>';
    else inner = '<div class="ov-text">' + markdown(o.text) + '</div>';
    box.innerHTML = head + inner;
  }

  async function loadOverview(id, refresh) {
    const have = overviews.get(id);
    if (!refresh && have && (have.state === 'done' || have.state === 'loading')) { drawOverview(id); return; }
    if (paired === null) await checkPaired();
    if (paired === false) { drawOverview(id); return; }
    const o = { state: 'loading', text: '', typer: null };
    overviews.set(id, o);
    drawOverview(id);

    /* A freshly written overview types itself out like a chat answer. If the
       lead is redrawn meanwhile, typing carries on in the new box. */
    const typeInto = (text, done) => {
      const box = document.getElementById('ov-box');
      if (!box || box.dataset.id !== id) return null;
      let el = box.querySelector('.ov-text');
      if (!el) { drawOverview(id); el = box.querySelector('.ov-text'); }
      if (!el) return null;
      if (!o.typer || o.typer.el !== el) {
        const shown = o.typer ? o.typer.shown : 0;
        o.typer = new Typer(el);
        o.typer.shown = Math.min(shown, text.length);
      }
      return o.typer.set(text, done);
    };

    try {
      const r = await api('/api/syrix/overview', { id, refresh: !!refresh });
      if (r.text != null) { overviews.set(id, { state: 'done', text: r.text }); drawOverview(id); return; }
      const j = await follow(r.jobId, job => {
        if (job.text) { o.text = job.text; typeInto(job.text, false); }
      });
      if (j.error) {
        overviews.set(id, { state: 'error', error: j.code === 'not_paired' ? 'SYRIX is not connected yet.' : j.error });
      } else {
        const text = j.text || 'Nothing to add beyond the details below.';
        o.text = text;
        const typing = typeInto(text, true);
        if (typing) await typing;
        overviews.set(id, { state: 'done', text });
      }
    } catch (err) {
      overviews.set(id, { state: 'error', error: err.message });
    }
    drawOverview(id);
  }

  G.onDetail = lead => { loadOverview(lead.id, false); };

  /* ---------- actions ---------- */

  Object.assign(G.ACTIONS, {
    'syrix-open'() { setOpen(!isOpen); },
    'syrix-close'() { setOpen(false); },
    'syrix-about'() {
      const about = $('#sx-about');
      about.hidden = !about.hidden;
      body.hidden = !about.hidden || paired === false;
    },
    'syrix-new'() {
      if (busy) return;
      thread.length = 0;
      drawEmpty();
      input.focus();
    },
    'syrix-send'() { send(input.value); },
    'syrix-suggest'(el) { send(el.textContent); },
    'syrix-lead'(el) {
      G.openLead(el.dataset.id);
      if (window.matchMedia('(max-width: 900px)').matches) setOpen(false);
    },
    async 'syrix-pair'() {
      const code = $('#sx-code').value.trim();
      const msg = $('#sx-pair-msg');
      if (!code) { msg.textContent = 'Enter the pairing code.'; return; }
      msg.textContent = 'Connecting…';
      try {
        await api('/api/syrix/pair', { code });
        $('#sx-code').value = '';
        msg.textContent = '';
        await checkPaired();
        if (!thread.length) drawEmpty();
        toast('SYRIX is connected');
        if (G.state.selected) loadOverview(G.state.selected, false);
      } catch (err) { msg.textContent = err.message; }
    },
    'overview-refresh'(el) { loadOverview(el.dataset.id, true); }
  });

  checkPaired();
})();
