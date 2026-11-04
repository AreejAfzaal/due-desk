// Due Desk — frontend (vanilla JS, no build step)
(() => {
  'use strict';

  const TZ = 'Asia/Karachi';
  const TYPES = ['Quiz', 'Assignment', 'Project', 'Exam'];
  const COURSE_COLORS = ['#0198CC', '#133197', '#019832', '#B42318', '#7A5C00', '#00729F', '#6B4BC2', '#C2410C'];
  const AVATAR_COLORS = ['#133197', '#00729F', '#007A29', '#B42318', '#7A5C00', '#5B3FB0'];

  const state = { deadlines: [], projects: [], members: [], tasks: [], ai: false, loaded: false, error: null };
  const ui = { openGroups: new Set(), filter: 'All', day: null, suggestions: null, suggestLoading: false, suggestError: null, offline: false, newIds: new Set() };
  // signed-in Google user from the session cookie: { sub, name, email, picture } or null
  let user = null, me = '';
  const auth = { problem: null };
  let done = new Set(JSON.parse(localStorage.getItem('qkh_done') || '[]'));

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const courseColor = (c) => COURSE_COLORS[hash(c.toLowerCase()) % COURSE_COLORS.length];
  const avatarColor = (n) => AVATAR_COLORS[hash(n.toLowerCase()) % AVATAR_COLORS.length];
  const initials = (n) => n.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  // ---------- dates (always Asia/Karachi) ----------
  const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayKey = (d) => dayKeyFmt.format(new Date(d));
  const keyToUTC = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
  const dayDiff = (d) => Math.round((keyToUTC(dayKey(d)) - keyToUTC(dayKey(Date.now()))) / 86400000);
  const fmtTime = (d) => new Date(d).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const fmtDay = (d) => new Date(d).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
  function fmtDue(d) {
    const diff = dayDiff(d);
    if (diff === 0) return `Today, ${fmtTime(d)}`;
    if (diff === 1) return `Tomorrow, ${fmtTime(d)}`;
    if (diff === -1) return `Yesterday, ${fmtTime(d)}`;
    return `${fmtDay(d)}, ${fmtTime(d)}`;
  }
  function countdown(d) {
    const ms = new Date(d) - Date.now();
    const abs = Math.abs(ms), m = Math.round(abs / 60000), h = Math.round(abs / 3600000), dd = Math.abs(dayDiff(d));
    // Past 24 hours, count calendar days so "Sunday" reads as 4 days away on a Wednesday, not 5
    const t = m < 60 ? `${m} min` : h < 24 || !dd ? `${h} h` : `${dd} ${dd === 1 ? 'day' : 'days'}`;
    return ms >= 0 ? `in ${t}` : `${t} ago`;
  }
  function urgency(dl) {
    if (done.has(dl.id)) return { key: 'done', label: 'Done', cls: 'b-done' };
    if (new Date(dl.due_at) < Date.now()) return { key: 'overdue', label: 'Overdue', cls: 'b-overdue' };
    const diff = dayDiff(dl.due_at);
    if (diff === 0) return { key: 'today', label: 'Today', cls: 'b-today' };
    if (diff === 1) return { key: 'tomorrow', label: 'Tomorrow', cls: 'b-tomorrow' };
    if (diff <= 6) return { key: 'week', label: new Date(dl.due_at).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' }), cls: 'b-week' };
    return { key: 'later', label: 'Later', cls: 'b-later' };
  }
  const timeAgo = (d) => {
    const s = (Date.now() - new Date(d)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  };
  function toLocalInput(date) {
    const d = new Date(date), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- api ----------
  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && !path.startsWith('/api/auth/')) { setUser(null); askSignIn(); }
    if (!r.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }
  const upsert = (list, item) => { const i = list.findIndex((x) => x.id === item.id); if (i >= 0) list[i] = item; else list.push(item); };
  const remove = (list, itemId) => { const i = list.findIndex((x) => x.id === itemId); if (i >= 0) list.splice(i, 1); };

  // ---------- sync: poll a cheap version number, refetch everything when it changes ----------
  const clientId = (() => {
    try { let c = localStorage.getItem('qkh_client'); if (!c) { c = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('qkh_client', c); } return c; }
    catch { return Math.random().toString(36).slice(2); }
  })();
  let version = -1, loading = null, polls = 0, lastSync = 0;

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const next = await api('/api/state');
        if (state.loaded) {
          const known = new Set(state.deadlines.map((d) => d.id));
          next.deadlines.filter((d) => !known.has(d.id)).forEach((d) => {
            ui.newIds.add(d.id); setTimeout(() => ui.newIds.delete(d.id), 1500);
            if (!user || d.posted_by_sub !== user.sub) toast(`${d.posted_by} just posted: ${d.course} ${d.type.toLowerCase()}, “${d.title}”`);
          });
          const knownP = new Set(state.projects.map((p) => p.id));
          next.projects.filter((p) => !knownP.has(p.id) && (!user || p.created_by_sub !== user.sub)).forEach((p) => toast(`${p.created_by} started a group project: “${p.title}”`));
        }
        version = next.version; lastSync = Date.now();
        Object.assign(state, next, { loaded: true, error: null });
      } catch (e) {
        if (!state.loaded) state.error = /Database/.test(e.message) ? e.message : "Couldn't load deadlines. Check your connection and refresh.";
      }
      render();
      loading = null;
    })();
    return loading;
  }

  async function poll() {
    const withPresence = polls++ % 4 === 0; // presence every ~10 s keeps database usage low
    try {
      const r = await api(`/api/version${withPresence ? `?client=${clientId}` : ''}`);
      if (r.online != null) { $('#presence-count').textContent = r.online; $('#presence').classList.add('on'); }
      lastSync = Date.now(); $('#offline-bar').hidden = true;
      if (r.version !== version) await load();
    } catch {
      $('#presence').classList.remove('on');
      // say so when live updates stop, instead of quietly showing a stale board
      if (state.loaded) { $('#offline-bar').textContent = `Offline · showing deadlines from ${fmtTime(lastSync)}. Reconnecting…`; $('#offline-bar').hidden = false; }
    }
  }
  function connect() {
    poll();
    setInterval(() => { if (!document.hidden) poll(); }, 2500);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  }
  // after this device writes something, refresh right away instead of waiting for the next poll
  const mutate = async (path, opts) => { const r = await api(path, opts); load(); return r; };

  // errors stay until dismissed; toasts with an action (Undo) stay 10 s, the rest 4.5 s
  function toast(msg, err = false, action = null) {
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.innerHTML = `<span class="tdot"></span><span class="tmsg">${esc(msg)}</span>`;
    const close = () => el.remove();
    if (action) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'toast-btn'; b.textContent = action.label;
      b.addEventListener('click', () => { action.run(); close(); });
      el.appendChild(b);
    }
    if (err) {
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'toast-x'; x.textContent = '✕'; x.setAttribute('aria-label', 'Dismiss');
      x.addEventListener('click', close);
      el.appendChild(x);
    } else setTimeout(close, action ? 10000 : 4500);
    // an open modal makes the rest of the page inert, so toasts move inside it to stay visible and clickable
    const box = $('#toasts'), host = document.querySelector('dialog[open]') || document.body;
    if (box.parentElement !== host) host.appendChild(box);
    box.appendChild(el);
  }
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('close', () => {
    const box = $('#toasts');
    if (box.parentElement === d) document.body.appendChild(box);
  }));

  // deletes wait 10 s so a mis-tap can be undone; anything still waiting is sent if the page closes
  const pendingDeletes = new Map();
  const live = (list) => list.filter((x) => !pendingDeletes.has(x.id));
  function deleteLater(id, label, path) {
    const run = () => {
      pendingDeletes.delete(id);
      mutate(path, { method: 'DELETE', keepalive: true }).catch((err) => { toast(err.message, true); render(); });
    };
    pendingDeletes.set(id, { run, timer: setTimeout(run, 10000) });
    render();
    toast(`Deleted “${label}”`, false, { label: 'Undo', run: () => {
      const p = pendingDeletes.get(id);
      if (p) { clearTimeout(p.timer); pendingDeletes.delete(id); render(); }
    } });
  }
  window.addEventListener('pagehide', () => pendingDeletes.forEach((p) => { clearTimeout(p.timer); p.run(); }));

  // ---------- rendering ----------
  function render() {
    // keep focus and typing intact when live updates re-render the view
    const a = document.activeElement;
    const focusKey = a && a.dataset && a.dataset.key;
    const sel = focusKey && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;

    const route = location.hash.replace(/^#/, '') || '/';
    const tab = route.startsWith('/projects') ? 'projects' : route.startsWith('/todo') ? 'todo' : 'home';
    document.querySelectorAll('.tabs a').forEach((t) => { t.classList.toggle('active', t.dataset.tab === tab); t.toggleAttribute('aria-current', t.dataset.tab === tab); });
    const todayLeft = live(state.deadlines).filter((d) => !done.has(d.id) && dayKey(d.due_at) === dayKey(Date.now())).length;
    $('#todo-count').textContent = todayLeft || '';
    $('#todo-count').hidden = !todayLeft;
    $('#me-btn').innerHTML = user ? `${avatar(user.name)}<span>${esc(user.name.split(' ')[0])}</span>` : 'Sign in';
    $('#me-btn').setAttribute('aria-label', user ? `Your account, ${user.name}` : 'Sign in');
    $('#fab').hidden = route.startsWith('/projects/');
    $('#fab').title = $('#fab-label').textContent = route.startsWith('/projects') ? 'New project' : 'Add deadline';

    const view = $('#view');
    const landing = auth.checked && !user && !ui.browse;
    document.body.classList.toggle('landing-mode', landing);
    if (landing) {
      // build the landing once, then only patch its live bits so typing in the form is never lost
      if (!view.querySelector('.landing')) mountLanding(view);
      updateLanding();
      return;
    }
    if (!auth.checked) { view.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`; return; }
    if (state.error) view.innerHTML = `<div class="empty"><strong>Can't reach the board</strong>${esc(state.error)}</div>`;
    else if (!state.loaded) view.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    else if (route.startsWith('/projects/')) view.innerHTML = projectView(route.split('/')[2]);
    else if (route.startsWith('/projects')) view.innerHTML = projectsView();
    else view.innerHTML = homeView(tab);

    const addInput = view.querySelector('#add-member');
    if (addInput) {
      const pid = addInput.closest('.member-add').dataset.project;
      peopleSearch(addInput, view.querySelector('#add-member-results'), async (person) => {
        try { await mutate(`/api/projects/${pid}/members`, { method: 'POST', body: { user_id: person.id } }); toast(`${person.name} added to the group`); }
        catch (ex) { toast(ex.message, true); }
      }, () => state.members.filter((m) => m.project_id === pid).map((m) => m.user_id));
    }
    if (focusKey) {
      const el = view.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch {} }
    }
  }

  // the main action as a button beside the page heading (desktop); phones keep the floating + button
  const heroAction = (label) => `<button type="button" class="btn primary hero-action" data-hero-add><svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>${label}</button>`;

  // tab: 'home' (shared deadlines board) or 'todo' (your personal checklist by day)
  function homeView(tab = 'home') {
    const all = live(state.deadlines).sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
    const upcoming = all.filter((d) => !done.has(d.id) && new Date(d.due_at) >= Date.now());
    const thisWeek = upcoming.filter((d) => dayDiff(d.due_at) <= 6).length;
    const first = me ? me.split(' ')[0] : 'everyone';

    // day strip: next 7 days
    const days = [...Array(7)].map((_, i) => {
      const d = new Date(Date.now() + i * 86400000);
      const key = dayKey(d);
      return { key, d, items: all.filter((x) => dayKey(x.due_at) === key) };
    });
    if (!ui.day || !days.some((d) => d.key === ui.day)) ui.day = days[0].key;
    const sel = days.find((d) => d.key === ui.day);
    const selLabel = sel.key === days[0].key ? 'today' : sel.key === days[1].key ? 'tomorrow' : new Date(sel.d).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' });

    const strip = days.map((d, i) => {
      const open = d.items.filter((x) => !done.has(x.id)).length;
      const name = i === 0 ? 'Today' : new Date(d.d).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
      const num = new Date(d.d).toLocaleDateString('en-US', { timeZone: TZ, day: 'numeric' });
      return `<button type="button" class="day" data-day="${d.key}" aria-pressed="${d.key === ui.day}" aria-label="${esc(name)} ${num}, ${open} due">
        <span class="dname">${esc(name)}</span><span class="dnum">${num}</span><span class="dcount ${open ? 'has' : 'zero'}" aria-hidden="true">${open}</span></button>`;
    }).join('');

    const left = sel.items.filter((x) => !done.has(x.id)).length;
    const todoHead = `<div class="todo-head"><h3>Due ${sel.key === days[0].key || sel.key === days[1].key ? '' : 'on '}${esc(selLabel)}</h3><span>${sel.items.length ? `${left} left` : 'All clear'}</span></div>`;
    const todo = todoHead + (sel.items.length
      ? sel.items.map((x) => {
          const isDone = done.has(x.id), late = !isDone && new Date(x.due_at) < Date.now();
          return `<label class="todo-row ${isDone ? 'done' : ''}">
          <input type="checkbox" class="check" data-done="${x.id}" ${isDone ? 'checked' : ''} aria-label="Mark ${esc(x.title)} done">
          <span class="t"><strong>${esc(x.title)}</strong><span class="muted" style="font-size:13px">${esc(x.course)} · ${esc(x.type)} · ${fmtTime(x.due_at)}</span></span>
          ${isDone ? '' : `<span class="todo-when ${late ? 'late' : ''}">${countdown(x.due_at)}</span>`}
        </label>`;
        }).join('')
      : `<div class="todo-empty">Nothing due ${esc(selLabel)}. Free time, enjoy it.</div>`);

    // grouped list
    const filtered = all.filter((d) => ui.filter === 'All' || d.type === ui.filter);
    const groups = [['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Next 7 days'], ['later', 'Later'], ['overdue', 'Past due'], ['done', 'Done']];
    const collapsible = new Set(['overdue', 'done']); // finished business stays out of the way until opened
    const byGroup = Object.fromEntries(groups.map(([k]) => [k, []]));
    filtered.forEach((d) => byGroup[urgency(d).key].push(d));
    const listHtml = filtered.length
      ? groups.filter(([k]) => byGroup[k].length).map(([k, label]) => {
          const title = `${label} <span class="count">${byGroup[k].length}</span>`, list = `<div class="list">${byGroup[k].map(card).join('')}</div>`;
          return collapsible.has(k)
            ? `<details class="group" data-group="${k}" ${ui.openGroups.has(k) ? 'open' : ''}><summary class="section-title st-${k}">${title}</summary>${list}</details>`
            : `<h2 class="section-title st-${k}">${title}</h2>${list}`;
        }).join('')
      : all.length
        ? `<div class="empty" style="margin-top:16px"><strong>No ${esc(ui.filter.toLowerCase())}${ui.filter === 'Quiz' ? 'zes' : 's'} on the board</strong><button type="button" class="btn small" data-filter="All" style="margin-top:10px">Show all deadlines</button></div>`
        : (user && !(user.courses || []).length
          ? `<div class="empty" style="margin-top:16px"><strong>Your board is empty</strong>Pick your courses and deadlines for them will show up here.<br><button type="button" class="btn small primary" data-open-account style="margin-top:12px">Pick my courses</button></div>`
          : `<div class="empty" style="margin-top:16px"><strong>All quiet for now</strong>Nothing has been posted for ${esc((user?.courses || []).slice(0, 3).join(', '))}${(user?.courses || []).length > 3 ? ' and more' : ''} or your group projects yet. Be the first to post a deadline.</div>`);

    if (tab === 'todo') return `
      <section class="hero has-action"><div>
        <h1>Your to-do</h1>
        <p>Pick a day and tick things off as you finish them. Only you see your ticks.</p>
      </div>${heroAction('Add deadline')}</section>
      <div class="daystrip" role="group" aria-label="Pick a day" style="margin-top:20px">${strip}</div>
      <div class="todo">${todo}</div>`;

    return `
      <section class="hero has-action"><div>
        <h1>What's due, ${esc(first)}?</h1>
        <p>${upcoming.length ? `${thisWeek} due in the next 7 days · ${upcoming.length} upcoming in total` : 'Nothing upcoming. Post a deadline to start the board.'}</p>
      </div>${heroAction('Add deadline')}</section>
      <div class="chips" role="group" aria-label="Filter by type">
        ${['All', ...TYPES].map((t) => `<button type="button" class="chip" data-filter="${t}" aria-pressed="${ui.filter === t}">${t === 'All' ? 'All' : t + (t === 'Quiz' ? 'zes' : 's')}</button>`).join('')}
      </div>
      ${listHtml}`;
  }

  function card(d) {
    const u = urgency(d);
    const isDone = done.has(d.id);
    return `<article class="card u-${u.key} ${ui.newIds.has(d.id) ? 'new' : ''} ${isDone ? 'is-done' : ''}">
      <input type="checkbox" class="check" data-done="${d.id}" ${isDone ? 'checked' : ''} aria-label="Mark ${esc(d.title)} done">
      <div class="body">
        <div class="meta"><span class="course-dot" style="background:${courseColor(d.course)}"></span>${esc(d.course)} · ${esc(d.type)}</div>
        <h3>${esc(d.title)}</h3>
        ${d.notes ? `<p class="notes">${esc(d.notes)}</p>` : ''}
        <div class="foot"><span><b>${fmtDue(d.due_at)}</b> · ${countdown(d.due_at)}</span><span>Posted by ${esc(d.posted_by)} · ${timeAgo(d.created_at)}</span></div>
      </div>
      <div class="side"><span class="badge ${u.cls}">${u.label}</span>
        ${user && d.posted_by_sub === user.sub ? `<button type="button" class="icon-btn" data-del-deadline="${d.id}" aria-label="Delete ${esc(d.title)}">✕</button>` : ''}
      </div>
    </article>`;
  }

  function projectStats(p) {
    const tasks = live(state.tasks).filter((t) => t.project_id === p.id);
    const doneCount = tasks.filter((t) => t.done).length;
    return { tasks, doneCount, pct: tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0 };
  }
  const avatar = (n) => `<span class="avatar" style="background:${avatarColor(n)}" title="${esc(n)}">${esc(initials(n))}</span>`;

  function projectsView() {
    const list = [...state.projects].sort((a, b) => new Date(a.due_at || 8.64e15) - new Date(b.due_at || 8.64e15));
    const cards = list.map((p) => {
      const { tasks, doneCount, pct } = projectStats(p);
      const members = live(state.members).filter((m) => m.project_id === p.id);
      return `<a class="pcard" href="#/projects/${p.id}">
        <div class="meta" style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-muted)">${esc(p.course || 'Group project')}${p.due_at ? ` · due ${esc(fmtDue(p.due_at))}` : ''}</div>
        <h3>${esc(p.title)}</h3>
        <div class="progress" aria-label="${pct}% done"><span style="width:${pct}%"></span></div>
        <div class="prow"><span>${doneCount} of ${tasks.length} tasks done</span><span class="avatars">${members.slice(0, 5).map((m) => avatar(m.name)).join('')}</span></div>
      </a>`;
    }).join('');
    return `<section class="hero has-action"><div><h1>Group projects</h1><p>Split the work, see who's doing what, and stop chasing people on WhatsApp.</p></div>${heroAction('New project')}</section>
      <div class="list" style="margin-top:16px">${cards || `<div class="empty"><strong>No group projects yet</strong>Start one with “+ New project”, or ask a groupmate to add you.</div>`}</div>`;
  }

  function projectView(pid) {
    const p = state.projects.find((x) => x.id === pid);
    if (!p) return `<a class="back" href="#/projects">← All projects</a><div class="empty"><strong>Project not found</strong>It may have been removed.</div>`;
    const members = live(state.members).filter((m) => m.project_id === p.id);
    const { tasks, doneCount, pct } = projectStats(p);
    const options = (sel) => `<option value="">Unassigned</option>` + members.map((m) => `<option value="${esc(m.name)}" ${sel === m.name ? 'selected' : ''}>${esc(m.name)}</option>`).join('');

    const hrs = (h) => (h ? `${h} ${h === 1 ? 'hr' : 'hrs'}` : 'Not set');
    const taskRows = tasks.map((t) => `<div class="task ${t.done ? 'done' : ''}">
        <input type="checkbox" class="check" data-task-done="${t.id}" ${t.done ? 'checked' : ''} aria-label="Mark ${esc(t.title)} done">
        <div class="tcell t-title"><span class="slabel">Task${t.source === 'ai' ? ' · <span class="ai-tag">AI suggested</span>' : ''}</span><strong>${esc(t.title)}</strong></div>
        <div class="tcell t-hours"><span class="slabel">Est. time</span><span class="t-hours-val">${hrs(t.estimate_hours)}</span></div>
        <label class="tcell t-assign"><span class="slabel">Assigned to</span><select data-assign="${t.id}" aria-label="Assign ${esc(t.title)}">${options(t.assignee)}</select></label>
        <button type="button" class="icon-btn" data-del-task="${t.id}" aria-label="Delete task ${esc(t.title)}">✕</button>
      </div>`).join('');

    let suggest = '';
    if (ui.suggestLoading && ui.suggestFor === p.id) {
      const ghost = (i) => `<div class="srow" aria-hidden="true"><div class="sfield s-title"><span class="slabel">Task ${i}</span><div class="skeleton"></div></div><div class="sfield s-hours"><span class="slabel">Est. time</span><div class="skeleton"></div></div><div class="sfield s-assign"><span class="slabel">Assign to</span><div class="skeleton"></div></div></div>`;
      suggest = `<div class="suggest" aria-busy="true"><h3>Thinking about your project…</h3><p>Splitting it into tasks with time estimates.</p>${[1, 2, 3].map(ghost).join('')}</div>`;
    } else if (ui.suggestions && ui.suggestFor === p.id) {
      suggest = `<div class="suggest"><h3>Suggested tasks</h3>
        <p>${ui.offline ? 'Offline suggestions: add an Anthropic API key on the server for real AI. ' : ''}Edit, remove or assign them, then add them to the project.</p>
        ${ui.suggestions.map((s, i) => `<div class="srow">
          <label class="sfield s-title"><span class="slabel">Task ${i + 1}</span><input name="title" data-key="s-t-${i}" data-s-title="${i}" value="${esc(s.title)}"></label>
          <label class="sfield s-hours"><span class="slabel">Est. time</span><span class="hours-box"><input name="hours" data-key="s-h-${i}" data-s-hours="${i}" type="number" min="0.5" step="0.5" inputmode="decimal" value="${esc(s.estimate_hours)}"><span class="hours-unit" aria-hidden="true">hrs</span></span></label>
          <label class="sfield s-assign"><span class="slabel">Assign to</span><select data-s-assign="${i}">${options(s.assignee)}</select></label>
          <button type="button" class="icon-btn" data-s-del="${i}" aria-label="Remove task ${i + 1}">✕</button></div>`).join('')}
        <div class="actions"><button type="button" class="btn small" data-s-discard>Discard</button><button type="button" class="btn small primary" data-s-accept>Add ${ui.suggestions.length} tasks</button></div></div>`;
    } else if (ui.suggestError && ui.suggestFor === p.id) {
      suggest = `<p class="form-error" style="margin-top:12px">${esc(ui.suggestError)}</p>`;
    }

    return `<a class="back" href="#/projects">← All projects</a>
      <section class="hero"><div class="muted" style="font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase">${esc(p.course || 'Group project')}${p.due_at ? ` · due ${esc(fmtDue(p.due_at))}` : ''}</div>
        <h1>${esc(p.title)}</h1>${p.description ? `<p>${esc(p.description)}</p>` : ''}</section>

      <div class="panel"><h2>Members</h2>
        <div class="members">${members.map((m) => `<span class="member">${avatar(m.name)}${esc(m.name)}<button type="button" data-del-member="${m.id}" aria-label="Remove ${esc(m.name)}">✕</button></span>`).join('') || '<span class="muted">No members yet.</span>'}</div>
        <div class="member-add" data-project="${p.id}"><label class="sr-only" for="add-member">Add a member</label><input id="add-member" data-key="add-member" placeholder="Add a classmate who has signed up" maxlength="40" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="add-member-results"><div class="people-results" id="add-member-results" role="listbox" hidden></div></div>
      </div>

      <div class="panel"><h2>Tasks</h2>
        <div class="progress" aria-label="${pct}% done"><span style="width:${pct}%"></span></div>
        <div class="prow" style="margin-bottom:6px"><span>${doneCount} of ${tasks.length} done</span><span>${pct}%</span></div>
        <div class="task-actions">
        <button type="button" class="btn ai" data-suggest="${p.id}" ${ui.suggestLoading ? 'disabled' : ''}><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>Suggest tasks with AI</button>
        <button type="button" class="btn" data-open-add-task aria-expanded="${!!ui.addTaskOpen}" aria-controls="add-task-form"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add task manually</button>
        </div>
        ${suggest}
        <div style="margin-top:8px">${taskRows || '<p class="muted" style="margin:12px 0 0">No tasks yet. Ask the AI for a breakdown, or add one manually.</p>'}</div>
        ${ui.addTaskOpen ? `<form class="add-task-form" id="add-task-form" data-add-task="${p.id}">
          <p class="add-task-title">Add a task</p>
          <label class="sfield at-title"><span class="slabel">Task</span><input id="add-task" name="title" data-key="add-task" placeholder="e.g. Design the login screen" maxlength="120" required value="${esc(ui.addDraft?.['add-task'] || '')}"></label>
          <label class="sfield at-hours"><span class="slabel">Est. time</span><span class="hours-box"><input name="hours" data-key="add-task-hours" type="number" min="0.5" step="0.5" inputmode="decimal" placeholder="2" value="${esc(ui.addDraft?.['add-task-hours'] || '')}"><span class="hours-unit" aria-hidden="true">hrs</span></span></label>
          <label class="sfield at-assign"><span class="slabel">Assign to</span><select name="assignee" data-key="add-task-assignee">${options(ui.addDraft?.['add-task-assignee'] || '')}</select></label>
          <div class="at-btns"><button class="btn small" type="button" data-close-add-task>Cancel</button><button class="btn small primary" type="submit">Add task</button></div>
        </form>` : ''}
      </div>`;
  }

  // ---------- events ----------
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-day]');
    if (!t) return;
    try {
      if (t.dataset.day) { ui.day = t.dataset.day; return render(); }
      if (t.dataset.filter) { ui.filter = t.dataset.filter; return render(); }
      if (t.dataset.delDeadline) { const id = t.dataset.delDeadline; return deleteLater(id, state.deadlines.find((x) => x.id === id)?.title || 'deadline', `/api/deadlines/${id}`); }
      if (t.dataset.delTask) { const id = t.dataset.delTask; return deleteLater(id, state.tasks.find((x) => x.id === id)?.title || 'task', `/api/tasks/${id}`); }
      if (t.dataset.delMember) { const id = t.dataset.delMember; return deleteLater(id, state.members.find((x) => x.id === id)?.name || 'member', `/api/members/${id}`); }
      if (t.dataset.suggest) {
        Object.assign(ui, { suggestFor: t.dataset.suggest, suggestLoading: true, suggestions: null, suggestError: null }); render();
        try {
          const r = await api(`/api/projects/${t.dataset.suggest}/breakdown`, { method: 'POST' });
          ui.suggestions = r.tasks.map((x) => ({ ...x, assignee: '' })); ui.offline = r.offline;
        } catch (err) { ui.suggestError = err.message; }
        ui.suggestLoading = false; return render();
      }
      if (t.dataset.sDel !== undefined) { ui.suggestions.splice(+t.dataset.sDel, 1); if (!ui.suggestions.length) ui.suggestions = null; return render(); }
      if (t.hasAttribute('data-s-discard')) { ui.suggestions = null; return render(); }
      if (t.hasAttribute('data-s-accept')) {
        const list = ui.suggestions.filter((s) => s.title.trim()).map((s) => ({ ...s, project_id: ui.suggestFor, source: 'ai' }));
        ui.suggestions = null; render();
        await mutate('/api/tasks', { method: 'POST', body: { tasks: list } });
        toast(`Added ${list.length} tasks`); return;
      }
      if (t.id === 'me-btn') return user ? openAccount() : askSignIn();
      if (t.id === 'fab') return location.hash.startsWith('#/projects') ? openProject() : openDeadline();
      if (t.hasAttribute('data-close')) return t.closest('dialog').close();
    } catch (err) { toast(err.message, true); }
  });

  document.addEventListener('toggle', (e) => {
    const g = e.target.dataset && e.target.dataset.group;
    if (g) e.target.open ? ui.openGroups.add(g) : ui.openGroups.delete(g);
  }, true);

  document.addEventListener('change', async (e) => {
    const t = e.target;
    try {
      if (t.dataset.done) {
        t.checked ? done.add(t.dataset.done) : done.delete(t.dataset.done);
        localStorage.setItem('qkh_done', JSON.stringify([...done]));
        return render();
      }
      if (t.dataset.taskDone) { await mutate(`/api/tasks/${t.dataset.taskDone}`, { method: 'PATCH', body: { done: t.checked } }); return; }
      if (t.dataset.assign) { await mutate(`/api/tasks/${t.dataset.assign}`, { method: 'PATCH', body: { assignee: t.value } }); return; }
      if (t.dataset.sAssign !== undefined) ui.suggestions[+t.dataset.sAssign].assignee = t.value;
    } catch (err) { toast(err.message, true); render(); } // put the checkbox/select back to what the server has
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.sTitle !== undefined) ui.suggestions[+t.dataset.sTitle].title = t.value;
    if (t.dataset.sHours !== undefined) ui.suggestions[+t.dataset.sHours].estimate_hours = Number(t.value) || null;
    // keep the manual task draft through live re-renders
    if (t.dataset.key && t.dataset.key.startsWith('add-task')) (ui.addDraft = ui.addDraft || {})[t.dataset.key] = t.value;
  });
  document.addEventListener('change', (e) => { const t = e.target; if (t.dataset.key === 'add-task-assignee') (ui.addDraft = ui.addDraft || {})['add-task-assignee'] = t.value; });

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.dataset.addTask) {
      e.preventDefault();
      const input = f.querySelector('[name=title]');
      const value = input.value.trim();
      if (!value) return;
      const hours = Number(f.querySelector('[name=hours]').value) || null, assignee = f.querySelector('[name=assignee]').value || null;
      try {
        await mutate('/api/tasks', { method: 'POST', body: { project_id: f.dataset.addTask, title: value, estimate_hours: hours, assignee, source: 'manual' } });
        ui.addTaskOpen = false; ui.addDraft = {}; render();
        toast(`Added “${value}”`);
      } catch (err) { toast(err.message, true); }
    }
  });

  // ---------- landing page (signed out) ----------
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const L = { words: ['quiz', 'assignment', 'lab report', 'viva', 'project', 'deadline'], wordIdx: 0, counted: false, front: 0, pingIdx: 0, timers: [] };
  // Example cards for the landing page. Always these, never real posts, so the stack is never empty or thin.
  const inH = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const sampleCards = () => [
    { title: 'Quiz 3: Trees and heaps', course: 'Data Structures', type: 'Quiz', posted_by: 'Ali', due_at: inH(5) },
    { title: 'Assignment 2: Inheritance', course: 'Object Oriented Programming', type: 'Assignment', posted_by: 'Fatima', due_at: inH(30) },
    { title: 'Lab 5: Process scheduling', course: 'Operating Systems', type: 'Assignment', posted_by: 'Hamza', due_at: inH(52) },
    { title: 'Project proposal', course: 'Software Engineering', type: 'Project', posted_by: 'Ayesha', due_at: inH(80) },
    { title: 'Mid-term exam', course: 'Linear Algebra', type: 'Exam', posted_by: 'CR', due_at: inH(140) },
    { title: 'Viva: ER diagrams', course: 'Database Systems', type: 'Quiz', posted_by: 'Usman', due_at: inH(200) },
  ];
  const upcomingForLanding = () => sampleCards();
  // decorative countdown: a random time a few hours away, restarted with the next example when it runs out
  const newTarget = () => Date.now() + (2 + Math.random() * 7) * 3600e3 + Math.random() * 3600e3;

  function mountLanding(view) {
    L.timers.forEach(clearInterval); L.timers = [];
    view.innerHTML = `
    <section class="landing">
      <div class="l-bg" aria-hidden="true"><span class="l-blob b1" data-depth="18"></span><span class="l-blob b2" data-depth="-26"></span><span class="l-blob b3" data-depth="34"></span></div>

      <div class="l-grid">
      <div class="l-hero">
        <span class="l-live"><span class="dot"></span><b id="l-online">1</b>&nbsp;online right now</span>
        <h1 class="l-title">Never miss a <span class="l-rotator"><span id="l-word">quiz</span></span><br>ever again.</h1>
        <p class="l-sub">One shared board for your whole batch. Someone posts a deadline, everyone sees it instantly. No more scrolling 400 WhatsApp messages to find the date.</p>
        <button type="button" class="l-next" id="l-next" data-l-jump="signup"><span class="l-next-label">Next up</span><span id="l-next-title"></span><span class="l-clock" id="l-clock">--:--:--</span></button>
      </div>

        <div class="l-auth" id="l-auth">
          <div class="l-seg" role="tablist" aria-label="Sign in or create an account" data-mode="signup">
            <span class="l-seg-pill" aria-hidden="true"></span>
            <button type="button" role="tab" id="l-tab-signup" data-l-mode="signup" aria-selected="true">I'm new</button>
            <button type="button" role="tab" id="l-tab-login" data-l-mode="login" aria-selected="false">I have an account</button>
          </div>
          <form id="form-landing" class="l-form" data-mode="signup" novalidate>
            <h2 id="l-form-title">Claim your spot ✨</h2>
            <p class="muted" id="l-form-sub">Takes 20 seconds. Your name shows on what you post.</p>
            <label class="field l-signup-only"><span>Your name</span><input name="name" maxlength="40" autocomplete="name" placeholder="Ali, Fatima, CR bhai…"></label>
            <label class="field"><span>Email</span><input name="email" type="email" maxlength="254" autocomplete="email" placeholder="you@lhr.nu.edu.pk" required></label>
            <div class="field">
              <label for="l-password">Password</label>
              <div class="l-pass"><input id="l-password" name="password" type="password" minlength="8" maxlength="200" autocomplete="new-password" required>
                <button type="button" class="l-eye" id="l-eye" aria-label="Show password" aria-pressed="false">Show</button></div>
              <div class="l-meter l-signup-only" aria-hidden="true"><span id="l-meter-bar"></span></div>
              <small class="muted l-signup-only" id="l-meter-text">At least 8 characters.</small>
            </div>
            <div class="field l-signup-only"><span class="field-label">Your courses</span><div class="cp" id="l-picker"></div></div>
            <p class="form-error" id="l-error" hidden></p>
            <button type="submit" class="btn primary welcome-btn l-submit" id="l-submit">Create account →</button>
          </form>
        </div>

        <div class="l-preview" id="l-preview" aria-hidden="true">
          <svg class="l-pattern" viewBox="0 0 520 400" preserveAspectRatio="xMidYMid meet" focusable="false">
            <defs>
              <clipPath id="lp-clip"><rect x="20" y="24" width="480" height="352" rx="28"/></clipPath>
              <pattern id="lp-dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.6" class="lp-dot"/></pattern>
            </defs>
            <rect x="20" y="24" width="480" height="352" rx="28" class="lp-slab"/>
            <g clip-path="url(#lp-clip)">
              <rect x="20" y="24" width="200" height="140" fill="url(#lp-dots)"/>
              <circle cx="500" cy="376" r="96" class="lp-ring"/>
              <circle cx="500" cy="376" r="148" class="lp-ring"/>
              <circle cx="500" cy="376" r="200" class="lp-ring"/>
              <circle cx="500" cy="376" r="252" class="lp-ring faint"/>
              <rect x="372" y="44" width="104" height="24" rx="12" class="lp-pill"/>
              <rect x="400" y="80" width="76" height="24" rx="12" class="lp-pill soft"/>
            </g>
            <circle cx="64" cy="340" r="36" class="lp-gold"/>
            <circle cx="122" cy="364" r="10" class="lp-green"/>
            <circle cx="476" cy="190" r="6" class="lp-navy"/>
          </svg>
          <div class="l-stack" id="l-stack"></div>
          <p class="l-hint">What your board looks like · tap the cards</p>
        </div>
      </div>

      <div class="l-stats">
        <div class="l-stat"><b data-count="deadlines">0</b><span>deadlines posted so far</span></div>
        <div class="l-stat"><b data-count="projects">0</b><span>group projects</span></div>
        <div class="l-stat"><b data-count="online">0</b><span>people online now</span></div>
      </div>

      <ol class="l-steps">
        <li><span class="l-step-n">1</span><strong>Someone posts</strong><span>The CR, a topper, anyone. Title, course, due date. Done.</span></li>
        <li><span class="l-step-n">2</span><strong>Everyone sees it</strong><span>It pops up live on every phone, sorted by what's due first.</span></li>
        <li><span class="l-step-n">3</span><strong>AI splits group work</strong><span>Paste the brief, get tasks, assign them. No more "who's doing what?"</span></li>
      </ol>
      <p class="l-foot">Made for FAST NUCES Lahore students · built live with Claude</p>
    </section>`;

    L.counted = false;
    renderStack();
    // rotating word
    if (!reduceMotion) L.timers.push(setInterval(() => {
      const el = $('#l-word'); if (!el) return;
      el.classList.add('out');
      setTimeout(() => { L.wordIdx = (L.wordIdx + 1) % L.words.length; el.textContent = L.words[L.wordIdx]; el.classList.remove('out'); }, 260);
    }, 2200));
    // live countdown + online mirror
    L.timers.push(setInterval(tickLanding, 1000));
    // parallax blobs + tilting card stack
    if (!reduceMotion) {
      $('.landing').addEventListener('pointermove', (e) => {
        const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
        document.querySelectorAll('.l-blob').forEach((b) => { const d = +b.dataset.depth; b.style.transform = `translate(${x * d}px, ${y * d}px)`; });
      });
      const prev = $('#l-preview'), stack = $('#l-stack');
      prev.addEventListener('pointermove', (e) => {
        const r = prev.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        stack.style.transform = `rotateY(${x * 14}deg) rotateX(${-y * 12}deg)`;
      });
      prev.addEventListener('pointerleave', () => { stack.style.transform = ''; });
    }
    $('#l-stack').addEventListener('click', () => { L.front = (L.front + 1) % upcomingForLanding().length; renderStack(); });
    $('#l-eye').addEventListener('click', (e) => {
      const p = $('#l-password'), show = p.type === 'password';
      p.type = show ? 'text' : 'password';
      e.currentTarget.textContent = show ? 'Hide' : 'Show';
      e.currentTarget.setAttribute('aria-pressed', String(show));
      e.currentTarget.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    $('#l-password').addEventListener('input', meter);
    $('#form-landing').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      await submitAuth(f, f.dataset.mode === 'signup', $('#l-error'), $('#l-submit'), () => confetti($('#l-submit')));
    });
    initPicker($('#l-picker'));
    if (auth.problem) { $('#l-error').textContent = auth.problem; $('#l-error').hidden = false; }
    tickLanding();
  }

  function setLandingMode(mode) {
    const f = $('#form-landing'); if (!f) return;
    const signup = mode === 'signup';
    f.dataset.mode = mode;
    $('.l-seg').dataset.mode = mode;
    $('#l-tab-signup').setAttribute('aria-selected', String(signup));
    $('#l-tab-login').setAttribute('aria-selected', String(!signup));
    $('#l-form-title').textContent = signup ? 'Claim your spot ✨' : 'Kya scene hai? 👀';
    $('#l-form-sub').textContent = signup ? 'Takes 20 seconds. Your name shows on what you post.' : 'Welcome back. Your batch has been busy.';
    $('#l-submit').textContent = signup ? 'Create account →' : "Let's go →";
    f.password.autocomplete = signup ? 'new-password' : 'current-password';
    $('#l-error').hidden = true;
    f.classList.remove('swap'); void f.offsetWidth; f.classList.add('swap');
    (signup ? f.name : f.email).focus({ preventScroll: true });
  }

  function meter() {
    const v = $('#l-password').value;
    let s = 0;
    if (v.length >= 8) s++;
    if (v.length >= 12) s++;
    if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
    if (/\d/.test(v) || /[^A-Za-z0-9]/.test(v)) s++;
    const labels = ['At least 8 characters.', 'Okay, that works.', 'Nice.', 'Strong. Respect.', 'Unhackable vibes.'];
    const bar = $('#l-meter-bar');
    bar.style.width = `${v ? Math.max(8, s * 25) : 0}%`;
    bar.dataset.level = String(s);
    $('#l-meter-text').textContent = v.length && v.length < 8 ? `${8 - v.length} more to go.` : labels[s];
  }

  function renderStack() {
    const list = upcomingForLanding();
    const order = [0, 1, 2].map((i) => list[(i + L.front) % list.length]);
    $('#l-stack').innerHTML = order.map((d, i) => {
      const u = urgency(d);
      return `<article class="l-mini" style="--i:${i}">
        <div class="meta"><span class="course-dot" style="background:${courseColor(d.course)}"></span>${esc(d.course)} · ${esc(d.type)}</div>
        <h3>${esc(d.title)}</h3>
        <div class="l-mini-foot"><span>${fmtDue(d.due_at)}</span><span class="badge ${u.cls}">${u.label}</span></div>
        <div class="l-mini-by">Posted by ${esc(d.posted_by)}</div>
      </article>`;
    }).join('');
  }

  function tickLanding() {
    if (!$('#l-clock')) { L.timers.forEach(clearInterval); L.timers = []; return; }
    const cards = upcomingForLanding();
    if (!L.target || L.target <= Date.now()) { L.target = newTarget(); L.nextIdx = ((L.nextIdx ?? -1) + 1) % cards.length; }
    const next = cards[L.nextIdx];
    const ms = Math.max(0, L.target - Date.now());
    const p = (n) => String(n).padStart(2, '0');
    const dd = Math.floor(ms / 86400e3), hh = Math.floor(ms / 3600e3) % 24, mm = Math.floor(ms / 60e3) % 60, ss = Math.floor(ms / 1e3) % 60;
    $('#l-clock').textContent = `${dd ? dd + 'd ' : ''}${p(hh)}:${p(mm)}:${p(ss)}`;
    $('#l-next-title').textContent = `${next.title} · ${next.course}`;
    $('#l-online').textContent = $('#presence-count').textContent || '1';
    const os = document.querySelector('[data-count="online"]'); if (os && L.counted) os.textContent = $('#presence-count').textContent || '1';
  }

  function updateLanding() {
    if (!$('.landing')) return;
    const counts = { deadlines: state.stats?.deadlines ?? 0, projects: state.stats?.projects ?? 0, online: +($('#presence-count').textContent || 1) };
    document.querySelectorAll('[data-count]').forEach((el) => {
      const target = counts[el.dataset.count];
      if (!L.counted && state.loaded && !reduceMotion) {
        const start = performance.now();
        const step = (t) => { const k = Math.min(1, (t - start) / 900); el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
        requestAnimationFrame(step);
      } else el.textContent = target;
    });
    if (state.loaded) L.counted = true;
    renderStack();
    tickLanding();
  }

  function confetti(from) {
    if (reduceMotion || !from) return;
    const r = from.getBoundingClientRect(), colors = ['#0198CC', '#133197', '#FECC00', '#019832'];
    for (let i = 0; i < 36; i++) {
      const s = document.createElement('span');
      s.className = 'confetti';
      s.style.left = `${r.left + r.width / 2}px`; s.style.top = `${r.top}px`;
      s.style.background = colors[i % 4];
      s.style.setProperty('--dx', `${(Math.random() - 0.5) * 360}px`);
      s.style.setProperty('--dy', `${-120 - Math.random() * 220}px`);
      s.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 1300);
    }
  }

  document.addEventListener('click', (e) => {
    const m = e.target.closest('[data-l-mode]');
    if (m) return setLandingMode(m.dataset.lMode);
    const j = e.target.closest('[data-l-jump]');
    if (j) { setLandingMode(j.dataset.lJump); $('#l-auth').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    if (e.target.closest('[data-open-account]')) return openAccount();
    if (e.target.closest('[data-hero-add]')) return location.hash.startsWith('#/projects') ? openProject() : openDeadline();
    if (e.target.closest('[data-open-add-task]')) { ui.addTaskOpen = !ui.addTaskOpen; render(); if (ui.addTaskOpen) $('#add-task')?.focus(); return; }
    if (e.target.closest('[data-close-add-task]')) { ui.addTaskOpen = false; ui.addDraft = {}; render(); return; }
  });

  // ---------- dialogs ----------
  // ---------- sign in / create account ----------
  async function submitAuth(f, signup, err, btn, onSuccess) {
    const fail = (msg, field) => { err.textContent = msg; err.hidden = false; if (field) field.focus(); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake'); };
    if (signup && !f.name.value.trim()) return fail('Enter your name.', f.name);
    if (!f.email.validity.valid || !f.email.value) return fail('Enter a valid email address.', f.email);
    if (signup ? f.password.value.length < 8 : !f.password.value) return fail(signup ? 'Use a password of at least 8 characters.' : 'Enter your password.', f.password);
    const courses = picked(f.querySelector('.cp'));
    if (signup && !courses.length) return fail('Pick at least one course so your board can fill up.', f.querySelector('.cp-search'));
    const label = btn.textContent;
    btn.disabled = true; err.hidden = true; btn.textContent = signup ? 'Creating your account…' : 'Signing you in…';
    try {
      const r = await api(signup ? '/api/auth/signup' : '/api/auth/login', { method: 'POST',
        body: { name: f.name.value, email: f.email.value, password: f.password.value, courses } });
      if (onSuccess) onSuccess();
      f.reset();
      setUser(r.user);
      toast(signup ? `Welcome, ${r.user.name.split(' ')[0]}! Your account is ready.` : `Signed in as ${r.user.name}`);
      btn.disabled = false; btn.textContent = label;
      return true;
    } catch (ex) { fail(ex.message, f.password); }
    btn.disabled = false; btn.textContent = label;
    return false;
  }
  function setUser(u) { user = u; me = u ? u.name : ''; render(); }
  function setAuthMode(mode) {
    const f = $('#form-auth'), signup = mode === 'signup';
    f.dataset.mode = mode;
    $('#auth-kicker').textContent = signup ? 'Join the batch' : 'Oye, welcome back';
    $('#auth-title').textContent = signup ? 'Claim your spot ✨' : 'Kya scene hai? 👀';
    $('#auth-sub').textContent = signup ? 'Your name shows on what you post, so the batch knows who dropped that surprise quiz.' : 'Sign in to drop deadlines and squad up on group projects.';
    $('#auth-sticker').textContent = signup ? 'takes 20 seconds' : 'no more “quiz kab hai?”';
    $('#auth-submit').textContent = signup ? 'Create account →' : "Let's go →";
    $('#auth-switch-text').textContent = signup ? 'Already one of us?' : 'New here?';
    $('#auth-switch').textContent = signup ? 'Sign in' : 'Make an account';
    f.password.autocomplete = signup ? 'new-password' : 'current-password';
    $('#signin-error').hidden = true;
  }
  function askSignIn(mode = 'login') {
    // on the landing page, use its built-in form instead of the pop-up
    if (document.body.classList.contains('landing-mode') && $('#form-landing')) {
      setLandingMode(mode);
      $('#l-auth').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const d = $('#dlg-signin');
    setAuthMode(mode);
    if (!$('#auth-picker')._picked) initPicker($('#auth-picker'));
    if (auth.problem) { $('#signin-error').textContent = auth.problem; $('#signin-error').hidden = false; }
    if (!d.open) d.showModal();
    (mode === 'signup' ? $('#form-auth').name : $('#form-auth').email).focus();
  }
  $('#auth-switch').addEventListener('click', () => askSignIn($('#form-auth').dataset.mode === 'login' ? 'signup' : 'login'));
  $('#form-auth').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    await submitAuth(f, f.dataset.mode === 'signup', $('#signin-error'), $('#auth-submit'), () => $('#dlg-signin').close());
  });
  function openAccount() {
    $('#account-avatar').innerHTML = avatar(user.name);
    $('#account-name').textContent = user.name;
    $('#account-email').textContent = user.email;
    $('#account-name-input').value = user.name;
    $('#account-error').hidden = true;
    initPicker($('#account-picker'), user.courses || []);
    $('#dlg-account').showModal();
  }
  $('#signout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    $('#dlg-account').close();
    ui.browse = false;
    setUser(null);
    window.scrollTo(0, 0);
    toast('Signed out');
  });

  // ---------- course picker (sign-up and account) ----------
  let catalog = [];
  function initPicker(el, selected = []) {
    if (!el) return;
    el._picked = new Set(selected);
    el._custom = selected.filter((c) => !catalog.some((x) => x.toLowerCase() === c.toLowerCase()));
    el._q = '';
    el.innerHTML = `<input type="search" class="cp-search" placeholder="Search, or type a course and press Enter" aria-label="Search courses" autocomplete="off">
      <div class="cp-chips" role="group" aria-label="Courses"></div><small class="cp-count muted"></small>`;
    el.querySelector('.cp-search').addEventListener('input', (e) => { el._q = e.target.value.trim().toLowerCase(); drawPicker(el); });
    el.querySelector('.cp-search').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = e.target.value.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!v) return;
      const match = [...catalog, ...el._custom].find((c) => c.toLowerCase() === v.toLowerCase());
      if (match) el._picked.add(match); else { el._custom.push(v); el._picked.add(v); }
      e.target.value = ''; el._q = ''; drawPicker(el);
    });
    el.querySelector('.cp-chips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-course]'); if (!b) return;
      const c = b.dataset.course;
      el._picked.has(c) ? el._picked.delete(c) : el._picked.add(c);
      const err = el.closest('form, .sheet-body')?.querySelector('.form-error'); if (err) err.hidden = true;
      drawPicker(el);
    });
    drawPicker(el);
  }
  function drawPicker(el) {
    const all = [...el._custom, ...catalog];
    const shown = all.filter((c) => !el._q || c.toLowerCase().includes(el._q));
    // picked first so they're easy to see and undo
    shown.sort((a, b) => (el._picked.has(b) - el._picked.has(a)));
    el.querySelector('.cp-chips').innerHTML = shown.map((c) => `<button type="button" class="cp-chip" data-course="${esc(c)}" aria-pressed="${el._picked.has(c)}">${el._picked.has(c) ? '✓ ' : ''}${esc(c)}</button>`).join('')
      || `<span class="muted" style="font-size:13px">No match. Press Enter to add “${esc(el.querySelector('.cp-search').value.trim())}”.</span>`;
    const n = el._picked.size;
    el.querySelector('.cp-count').textContent = n ? `${n} course${n === 1 ? '' : 's'} picked` : 'Pick the courses you are taking this semester.';
  }
  const picked = (el) => (el && el._picked ? [...el._picked] : []);

  // ---------- account: edit courses ----------
  $('#save-courses').addEventListener('click', async () => {
    const err = $('#account-error'), list = picked($('#account-picker')), name = $('#account-name-input').value.trim();
    err.hidden = true;
    if (!name) { err.textContent = 'Enter your name.'; err.hidden = false; $('#account-name-input').focus(); return; }
    if (!list.length) { err.textContent = 'Pick at least one course.'; err.hidden = false; return; }
    const btn = $('#save-courses'); btn.disabled = true;
    try {
      const renamed = name !== user.name;
      const r = await api('/api/auth/me', { method: 'PATCH', body: { name, courses: list } });
      user = { ...user, ...r.user }; me = user.name;
      $('#dlg-account').close();
      await load();
      render();
      toast(renamed ? `Done. You're ${user.name} now.` : 'Saved. Your board is updated.');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false;
  });

  function fillCourses() {
    const courses = [...new Set([...(user?.courses || []), ...state.projects.map((p) => p.course)].filter(Boolean))].sort();
    $('#course-list').innerHTML = courses.map((c) => `<option value="${esc(c)}">`).join('');
  }
  function openDeadline() {
    if (!user) return askSignIn();
    if (!user.courses || !user.courses.length) { openAccount(); toast('Pick your courses first, then post.'); return; }
    const f = $('#form-deadline'); f.reset(); f.querySelector('.form-error').hidden = true;
    $('#deadline-course').innerHTML = user.courses.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    const projects = state.projects;
    $('#deadline-project-field').hidden = !projects.length;
    $('#deadline-project').innerHTML = `<option value="">None</option>` + projects.map((p) => `<option value="${p.id}">${esc(p.title)}</option>`).join('');
    const d = new Date(Date.now() + 86400000); d.setHours(23, 59, 0, 0);
    f.due_at.value = toLocalInput(d);
    $('#dlg-deadline').showModal(); f.title.focus();
  }
  $('#form-deadline').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('[type=submit]'), err = f.querySelector('.form-error');
    btn.disabled = true; err.hidden = true;
    try {
      await mutate('/api/deadlines', { method: 'POST', body: { title: f.title.value, course: f.course.value, type: f.type.value,
        project_id: f.project_id.value || null, due_at: new Date(f.due_at.value).toISOString(), notes: f.notes.value } });
      $('#dlg-deadline').close();
      if (location.hash && location.hash !== '#/') location.hash = '#/';
      toast(`Posted. Everyone in ${f.course.value} can see it now.`);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false;
  });

  // ---------- people search (only signed-up users) ----------
  function peopleSearch(input, results, onPick, exclude = () => []) {
    let timer, seq = 0;
    const close = () => { results.hidden = true; input.setAttribute('aria-expanded', 'false'); };
    const run = async () => {
      const my = ++seq, q = input.value.trim();
      try {
        const r = await api(`/api/users?q=${encodeURIComponent(q)}`);
        if (my !== seq) return;
        const skip = new Set(exclude());
        const list = r.users.filter((u) => !skip.has(u.id));
        results.innerHTML = list.length
          ? list.map((u) => `<button type="button" role="option" class="person" data-pick="${u.id}" data-name="${esc(u.name)}">${avatar(u.name)}<span><strong>${esc(u.name)}</strong><small>${esc(u.hint)}</small></span></button>`).join('')
          : `<p class="people-empty">${q ? `No one called “${esc(q)}” has signed up yet. Share the link with them!` : 'No classmates have signed up yet.'}</p>`;
        results.hidden = false; input.setAttribute('aria-expanded', 'true');
      } catch { close(); }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 180); });
    input.addEventListener('focus', run);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter') e.preventDefault(); if (e.key === 'ArrowDown') { const b = results.querySelector('.person'); if (b) { e.preventDefault(); b.focus(); } } });
    results.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]'); if (!b) return;
      onPick({ id: b.dataset.pick, name: b.dataset.name });
      input.value = ''; close(); input.focus();
    });
    results.addEventListener('mousedown', (e) => e.preventDefault());
    input.addEventListener('blur', () => setTimeout(() => { if (!results.contains(document.activeElement)) close(); }, 120));
  }

  let draftMembers = [];
  function renderDraftMembers() {
    const wrap = $('#member-chips'), input = $('#member-input');
    wrap.querySelectorAll('.member').forEach((n) => n.remove());
    draftMembers.forEach((m, i) => {
      const s = document.createElement('span'); s.className = 'member';
      s.innerHTML = `${avatar(m.name)}${esc(m.name)}<button type="button" aria-label="Remove ${esc(m.name)}" data-draft-del="${i}">✕</button>`;
      wrap.insertBefore(s, input);
    });
  }
  $('#member-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-draft-del]');
    if (b) { e.stopPropagation(); draftMembers.splice(+b.dataset.draftDel, 1); renderDraftMembers(); }
    else $('#member-input').focus();
  });
  peopleSearch($('#member-input'), $('#member-results'), (p) => { if (!draftMembers.some((m) => m.id === p.id)) draftMembers.push(p); renderDraftMembers(); }, () => draftMembers.map((m) => m.id));
  $('#member-input').addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !e.target.value && draftMembers.length) { draftMembers.pop(); renderDraftMembers(); }
  });
  function openProject() {
    if (!user) return askSignIn();
    const f = $('#form-project'); f.reset(); f.querySelector('.form-error').hidden = true;
    draftMembers = []; renderDraftMembers(); fillCourses();
    $('#dlg-project').showModal(); f.title.focus();
  }
  $('#form-project').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('[type=submit]'), err = f.querySelector('.form-error');
    btn.disabled = true; err.hidden = true;
    try {
      const p = await mutate('/api/projects', { method: 'POST', body: { title: f.title.value, course: f.course.value, description: f.description.value,
        due_at: f.due_at.value ? new Date(f.due_at.value).toISOString() : null, members: draftMembers.map((m) => m.id) } });
      await load();
      $('#dlg-project').close();
      location.hash = `#/projects/${p.id}`;
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false;
  });

  window.addEventListener('hashchange', () => { ui.suggestions = null; ui.suggestError = null; ui.addTaskOpen = false; render(); window.scrollTo(0, 0); });
  setInterval(() => { if (!document.querySelector('dialog[open]') && !(document.activeElement && document.activeElement.dataset.key)) render(); }, 60000);

  render();
  const whoAmI = api('/api/auth/me')
    .then((r) => { auth.problem = r.problem; catalog = r.catalog || []; auth.checked = true; if (r.user) setUser(r.user); else render(); return r.user; })
    .catch(() => { auth.checked = true; render(); return null; });
  Promise.all([load(), whoAmI]).then(() => connect());
})();
