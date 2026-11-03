// Due Desk — frontend (vanilla JS, no build step)
(() => {
  'use strict';

  const TZ = 'Asia/Karachi';
  const TYPES = ['Quiz', 'Assignment', 'Project', 'Exam'];
  const COURSE_COLORS = ['#0198CC', '#133197', '#019832', '#B42318', '#7A5C00', '#00729F', '#6B4BC2', '#C2410C'];
  const AVATAR_COLORS = ['#133197', '#00729F', '#007A29', '#B42318', '#7A5C00', '#5B3FB0'];

  const state = { deadlines: [], projects: [], members: [], tasks: [], ai: false, loaded: false, error: null };
  const ui = { filter: 'All', day: null, suggestions: null, suggestLoading: false, suggestError: null, offline: false, newIds: new Set() };
  let me = localStorage.getItem('qkh_name') || '';
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
    const abs = Math.abs(ms), m = Math.round(abs / 60000), h = Math.round(abs / 3600000), dd = Math.round(abs / 86400000);
    const t = m < 60 ? `${m} min` : h < 48 ? `${h} h` : `${dd} days`;
    return ms >= 0 ? `in ${t}` : `${t} ago`;
  }
  function urgency(dl) {
    if (done.has(dl.id)) return { key: 'done', label: 'Done', cls: 'b-done' };
    if (new Date(dl.due_at) < Date.now()) return { key: 'overdue', label: 'Overdue', cls: 'b-overdue' };
    const diff = dayDiff(dl.due_at);
    if (diff === 0) return { key: 'today', label: 'Today', cls: 'b-today' };
    if (diff === 1) return { key: 'tomorrow', label: 'Tomorrow', cls: 'b-tomorrow' };
    if (diff <= 6) return { key: 'week', label: 'This week', cls: 'b-week' };
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
  let version = -1, loading = null, polls = 0;

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const next = await api('/api/state');
        if (state.loaded) {
          const known = new Set(state.deadlines.map((d) => d.id));
          next.deadlines.filter((d) => !known.has(d.id)).forEach((d) => {
            ui.newIds.add(d.id); setTimeout(() => ui.newIds.delete(d.id), 1500);
            if (d.posted_by !== me) toast(`${d.posted_by} just posted: ${d.course} ${d.type.toLowerCase()}, “${d.title}”`);
          });
          const knownP = new Set(state.projects.map((p) => p.id));
          next.projects.filter((p) => !knownP.has(p.id) && p.created_by !== me).forEach((p) => toast(`${p.created_by} started a group project: “${p.title}”`));
        }
        version = next.version;
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
      if (r.version !== version) await load();
    } catch { $('#presence').classList.remove('on'); }
  }
  function connect() {
    poll();
    setInterval(() => { if (!document.hidden) poll(); }, 2500);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  }
  // after this device writes something, refresh right away instead of waiting for the next poll
  const mutate = async (path, opts) => { const r = await api(path, opts); load(); return r; };

  function toast(msg, err = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.innerHTML = `<span class="tdot"></span><span>${esc(msg)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  // ---------- rendering ----------
  function render() {
    // keep focus and typing intact when live updates re-render the view
    const a = document.activeElement;
    const focusKey = a && a.dataset && a.dataset.key;
    const sel = focusKey && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;

    const route = location.hash.replace(/^#/, '') || '/';
    document.querySelectorAll('.tabs a').forEach((t) => t.classList.toggle('active', (t.dataset.tab === 'projects') === route.startsWith('/projects')));
    $('#me-btn').textContent = me ? me : 'Set name';
    $('#fab').hidden = route.startsWith('/projects/');
    $('#fab-label').textContent = route.startsWith('/projects') ? 'New project' : 'Add deadline';

    const view = $('#view');
    if (state.error) view.innerHTML = `<div class="empty"><strong>Can't reach the board</strong>${esc(state.error)}</div>`;
    else if (!state.loaded) view.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    else if (route.startsWith('/projects/')) view.innerHTML = projectView(route.split('/')[2]);
    else if (route.startsWith('/projects')) view.innerHTML = projectsView();
    else view.innerHTML = homeView();

    if (focusKey) {
      const el = view.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch {} }
    }
  }

  function homeView() {
    const all = [...state.deadlines].sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
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
        <span class="dname">${esc(name)}</span><span class="dnum">${num}</span><span class="dcount ${open ? 'has' : ''}">${open}</span></button>`;
    }).join('');

    const todo = sel.items.length
      ? sel.items.map((x) => `<label class="todo-row ${done.has(x.id) ? 'done' : ''}">
          <input type="checkbox" class="check" data-done="${x.id}" ${done.has(x.id) ? 'checked' : ''} aria-label="Mark ${esc(x.title)} done">
          <span class="t"><strong>${esc(x.title)}</strong><span class="muted" style="font-size:13px">${esc(x.course)} · ${esc(x.type)} · ${fmtTime(x.due_at)}</span></span>
        </label>`).join('')
      : `<div class="todo-empty">Nothing due ${esc(selLabel)}. Free time, enjoy it.</div>`;

    // grouped list
    const filtered = all.filter((d) => ui.filter === 'All' || d.type === ui.filter);
    const groups = [['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'This week'], ['later', 'Later'], ['done', 'Done']];
    const byGroup = Object.fromEntries(groups.map(([k]) => [k, []]));
    filtered.forEach((d) => byGroup[urgency(d).key].push(d));
    const listHtml = filtered.length
      ? groups.filter(([k]) => byGroup[k].length).map(([k, label]) =>
          `<h2 class="section-title">${label} <span class="count">${byGroup[k].length}</span></h2><div class="list">${byGroup[k].map(card).join('')}</div>`).join('')
      : `<div class="empty" style="margin-top:16px"><strong>No deadlines yet</strong>Post the first one with “+ Add deadline”.</div>`;

    return `
      <section class="hero">
        <h1>What's due, ${esc(first)}?</h1>
        <p>${upcoming.length ? `${thisWeek} due this week · ${upcoming.length} upcoming in total` : 'Nothing upcoming. Post a deadline to start the board.'}</p>
      </section>
      <h2 class="section-title">Your to-do</h2>
      <div class="daystrip" role="group" aria-label="Pick a day">${strip}</div>
      <div class="todo">${todo}</div>
      <div class="chips" role="group" aria-label="Filter by type">
        ${['All', ...TYPES].map((t) => `<button type="button" class="chip" data-filter="${t}" aria-pressed="${ui.filter === t}">${t === 'All' ? 'All' : t + (t === 'Quiz' ? 'zes' : 's')}</button>`).join('')}
      </div>
      ${listHtml}`;
  }

  function card(d) {
    const u = urgency(d);
    const isDone = done.has(d.id);
    return `<article class="card ${ui.newIds.has(d.id) ? 'new' : ''} ${isDone ? 'is-done' : ''}">
      <input type="checkbox" class="check" data-done="${d.id}" ${isDone ? 'checked' : ''} aria-label="Mark ${esc(d.title)} done">
      <div class="body">
        <div class="meta"><span class="course-dot" style="background:${courseColor(d.course)}"></span>${esc(d.course)} · ${esc(d.type)}</div>
        <h3>${esc(d.title)}</h3>
        ${d.notes ? `<p class="notes">${esc(d.notes)}</p>` : ''}
        <div class="foot"><span><b>${fmtDue(d.due_at)}</b> · ${countdown(d.due_at)}</span><span>Posted by ${esc(d.posted_by)} · ${timeAgo(d.created_at)}</span></div>
      </div>
      <div class="side"><span class="badge ${u.cls}">${u.label}</span>
        ${d.posted_by === me ? `<button type="button" class="icon-btn" data-del-deadline="${d.id}" aria-label="Delete ${esc(d.title)}">✕</button>` : ''}
      </div>
    </article>`;
  }

  function projectStats(p) {
    const tasks = state.tasks.filter((t) => t.project_id === p.id);
    const doneCount = tasks.filter((t) => t.done).length;
    return { tasks, doneCount, pct: tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0 };
  }
  const avatar = (n) => `<span class="avatar" style="background:${avatarColor(n)}" title="${esc(n)}">${esc(initials(n))}</span>`;

  function projectsView() {
    const list = [...state.projects].sort((a, b) => new Date(a.due_at || 8.64e15) - new Date(b.due_at || 8.64e15));
    const cards = list.map((p) => {
      const { tasks, doneCount, pct } = projectStats(p);
      const members = state.members.filter((m) => m.project_id === p.id);
      return `<a class="pcard" href="#/projects/${p.id}">
        <div class="meta" style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-muted)">${esc(p.course || 'Group project')}${p.due_at ? ` · due ${esc(fmtDue(p.due_at))}` : ''}</div>
        <h3>${esc(p.title)}</h3>
        <div class="progress" aria-label="${pct}% done"><span style="width:${pct}%"></span></div>
        <div class="prow"><span>${doneCount} of ${tasks.length} tasks done</span><span class="avatars">${members.slice(0, 5).map((m) => avatar(m.name)).join('')}</span></div>
      </a>`;
    }).join('');
    return `<section class="hero"><h1>Group projects</h1><p>Split the work, see who's doing what, and stop chasing people on WhatsApp.</p></section>
      <div class="list" style="margin-top:16px">${cards || `<div class="empty"><strong>No group projects yet</strong>Start one with “+ New project”.</div>`}</div>`;
  }

  function projectView(pid) {
    const p = state.projects.find((x) => x.id === pid);
    if (!p) return `<a class="back" href="#/projects">← All projects</a><div class="empty"><strong>Project not found</strong>It may have been removed.</div>`;
    const members = state.members.filter((m) => m.project_id === p.id);
    const { tasks, doneCount, pct } = projectStats(p);
    const options = (sel) => `<option value="">Unassigned</option>` + members.map((m) => `<option value="${esc(m.name)}" ${sel === m.name ? 'selected' : ''}>${esc(m.name)}</option>`).join('');

    const taskRows = tasks.map((t) => `<div class="task ${t.done ? 'done' : ''}">
        <input type="checkbox" class="check" data-task-done="${t.id}" ${t.done ? 'checked' : ''} aria-label="Mark ${esc(t.title)} done">
        <div class="tt"><strong>${esc(t.title)}</strong><small>${t.estimate_hours ? `~${t.estimate_hours} h` : ''}${t.source === 'ai' ? `${t.estimate_hours ? ' · ' : ''}<span class="badge b-ai" style="padding:0 6px;font-size:11px">AI</span>` : ''}</small></div>
        <label class="sr-only" for="as-${t.id}">Assign ${esc(t.title)}</label>
        <select id="as-${t.id}" data-assign="${t.id}">${options(t.assignee)}</select>
        <button type="button" class="icon-btn" data-del-task="${t.id}" aria-label="Delete task ${esc(t.title)}">✕</button>
      </div>`).join('');

    let suggest = '';
    if (ui.suggestLoading && ui.suggestFor === p.id) {
      suggest = `<div class="suggest"><h3>Thinking about your project…</h3><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;
    } else if (ui.suggestions && ui.suggestFor === p.id) {
      suggest = `<div class="suggest"><h3>Suggested tasks</h3>
        <p>${ui.offline ? 'Offline suggestions: add an Anthropic API key on the server for real AI. ' : ''}Edit, remove or assign them, then add them to the project.</p>
        ${ui.suggestions.map((s, i) => `<div class="srow">
          <label class="sr-only" for="s-t-${i}">Task ${i + 1}</label><input id="s-t-${i}" name="title" data-key="s-t-${i}" data-s-title="${i}" value="${esc(s.title)}">
          <label class="sr-only" for="s-h-${i}">Hours</label><input id="s-h-${i}" name="hours" data-key="s-h-${i}" data-s-hours="${i}" type="number" min="0.5" step="0.5" value="${esc(s.estimate_hours)}">
          <label class="sr-only" for="s-a-${i}">Assign</label><select id="s-a-${i}" data-s-assign="${i}">${options(s.assignee)}</select>
          <button type="button" class="icon-btn" data-s-del="${i}" aria-label="Remove suggestion">✕</button></div>`).join('')}
        <div class="actions"><button type="button" class="btn small" data-s-discard>Discard</button><button type="button" class="btn small primary" data-s-accept>Add ${ui.suggestions.length} tasks</button></div></div>`;
    } else if (ui.suggestError && ui.suggestFor === p.id) {
      suggest = `<p class="form-error" style="margin-top:12px">${esc(ui.suggestError)}</p>`;
    }

    return `<a class="back" href="#/projects">← All projects</a>
      <section class="hero"><div class="muted" style="font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase">${esc(p.course || 'Group project')}${p.due_at ? ` · due ${esc(fmtDue(p.due_at))}` : ''}</div>
        <h1>${esc(p.title)}</h1>${p.description ? `<p>${esc(p.description)}</p>` : ''}</section>

      <div class="panel"><h2>Members</h2>
        <div class="members">${members.map((m) => `<span class="member">${avatar(m.name)}${esc(m.name)}<button type="button" data-del-member="${m.id}" aria-label="Remove ${esc(m.name)}">✕</button></span>`).join('') || '<span class="muted">No members yet.</span>'}</div>
        <form class="inline-form" data-add-member="${p.id}"><label class="sr-only" for="add-member">Add a member</label><input id="add-member" data-key="add-member" placeholder="Add a member by name" maxlength="40" required><button class="btn small" type="submit">Add</button></form>
      </div>

      <div class="panel"><h2>Tasks</h2>
        <div class="progress" aria-label="${pct}% done"><span style="width:${pct}%"></span></div>
        <div class="prow" style="margin-bottom:6px"><span>${doneCount} of ${tasks.length} done</span><span>${pct}%</span></div>
        <button type="button" class="btn ai" data-suggest="${p.id}" ${ui.suggestLoading ? 'disabled' : ''} style="width:100%;margin-top:6px">✨ Suggest tasks with AI</button>
        ${suggest}
        <div style="margin-top:8px">${taskRows || '<p class="muted" style="margin:12px 0 0">No tasks yet. Ask the AI for a breakdown or add your own below.</p>'}</div>
        <form class="inline-form" data-add-task="${p.id}"><label class="sr-only" for="add-task">New task</label><input id="add-task" data-key="add-task" placeholder="Add a task manually" maxlength="120" required><button class="btn small primary" type="submit">Add</button></form>
      </div>`;
  }

  // ---------- events ----------
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-day]');
    if (!t) return;
    try {
      if (t.dataset.day) { ui.day = t.dataset.day; return render(); }
      if (t.dataset.filter) { ui.filter = t.dataset.filter; return render(); }
      if (t.dataset.delDeadline) { await mutate(`/api/deadlines/${t.dataset.delDeadline}`, { method: 'DELETE' }); return; }
      if (t.dataset.delTask) { await mutate(`/api/tasks/${t.dataset.delTask}`, { method: 'DELETE' }); return; }
      if (t.dataset.delMember) { await mutate(`/api/members/${t.dataset.delMember}`, { method: 'DELETE' }); return; }
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
      if (t.id === 'me-btn') return askName(true);
      if (t.id === 'fab') return location.hash.startsWith('#/projects') ? openProject() : openDeadline();
      if (t.hasAttribute('data-close')) return t.closest('dialog').close();
    } catch (err) { toast(err.message, true); }
  });

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
    } catch (err) { toast(err.message, true); }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.sTitle !== undefined) ui.suggestions[+t.dataset.sTitle].title = t.value;
    if (t.dataset.sHours !== undefined) ui.suggestions[+t.dataset.sHours].estimate_hours = Number(t.value) || null;
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (f.dataset.addMember || f.dataset.addTask) {
      e.preventDefault();
      const input = f.querySelector('input');
      const value = input.value.trim();
      if (!value) return;
      try {
        if (f.dataset.addMember) await mutate(`/api/projects/${f.dataset.addMember}/members`, { method: 'POST', body: { name: value } });
        else await mutate('/api/tasks', { method: 'POST', body: { project_id: f.dataset.addTask, title: value, source: 'manual' } });
        const el = $(`#${input.id}`); if (el) { el.value = ''; el.focus(); }
      } catch (err) { toast(err.message, true); }
    }
  });

  // ---------- dialogs ----------
  function askName(force = false) {
    if (me && !force) return;
    const d = $('#dlg-name');
    d.querySelector('input').value = me;
    d.showModal();
  }
  $('#form-name').addEventListener('submit', (e) => {
    const v = e.target.name.value.trim();
    if (!v) { e.preventDefault(); return; }
    me = v.slice(0, 40); localStorage.setItem('qkh_name', me); render();
  });
  $('#dlg-name').addEventListener('cancel', (e) => { if (!me) e.preventDefault(); });

  function fillCourses() {
    const courses = [...new Set([...state.deadlines.map((d) => d.course), ...state.projects.map((p) => p.course)].filter(Boolean))].sort();
    $('#course-list').innerHTML = courses.map((c) => `<option value="${esc(c)}">`).join('');
  }
  function openDeadline() {
    if (!me) return askName();
    const f = $('#form-deadline'); f.reset(); f.querySelector('.form-error').hidden = true;
    const d = new Date(Date.now() + 86400000); d.setHours(23, 59, 0, 0);
    f.due_at.value = toLocalInput(d);
    fillCourses(); $('#dlg-deadline').showModal(); f.title.focus();
  }
  $('#form-deadline').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('[type=submit]'), err = f.querySelector('.form-error');
    btn.disabled = true; err.hidden = true;
    try {
      await mutate('/api/deadlines', { method: 'POST', body: { title: f.title.value, course: f.course.value, type: f.type.value,
        due_at: new Date(f.due_at.value).toISOString(), notes: f.notes.value, posted_by: me } });
      $('#dlg-deadline').close();
      if (location.hash && location.hash !== '#/') location.hash = '#/';
      toast('Posted. Everyone can see it now.');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false;
  });

  let draftMembers = [];
  function renderDraftMembers() {
    const wrap = $('#member-chips'), input = $('#member-input');
    wrap.querySelectorAll('.member').forEach((n) => n.remove());
    draftMembers.forEach((n, i) => {
      const s = document.createElement('span'); s.className = 'member';
      s.innerHTML = `${avatar(n)}${esc(n)}<button type="button" aria-label="Remove ${esc(n)}" data-draft-del="${i}">✕</button>`;
      wrap.insertBefore(s, input);
    });
  }
  $('#member-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-draft-del]');
    if (b) { e.stopPropagation(); draftMembers.splice(+b.dataset.draftDel, 1); renderDraftMembers(); }
    else $('#member-input').focus();
  });
  $('#member-input').addEventListener('keydown', (e) => {
    const v = e.target.value.trim().replace(/,$/, '');
    if ((e.key === 'Enter' || e.key === ',') && v) {
      e.preventDefault();
      if (!draftMembers.some((n) => n.toLowerCase() === v.toLowerCase()) && v.toLowerCase() !== me.toLowerCase()) draftMembers.push(v);
      e.target.value = ''; renderDraftMembers();
    } else if (e.key === 'Enter') e.preventDefault();
    else if (e.key === 'Backspace' && !e.target.value && draftMembers.length) { draftMembers.pop(); renderDraftMembers(); }
  });
  function openProject() {
    if (!me) return askName();
    const f = $('#form-project'); f.reset(); f.querySelector('.form-error').hidden = true;
    draftMembers = []; renderDraftMembers(); fillCourses();
    $('#dlg-project').showModal(); f.title.focus();
  }
  $('#form-project').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('[type=submit]'), err = f.querySelector('.form-error');
    const pending = $('#member-input').value.trim();
    if (pending) { draftMembers.push(pending); $('#member-input').value = ''; }
    btn.disabled = true; err.hidden = true;
    try {
      const p = await mutate('/api/projects', { method: 'POST', body: { title: f.title.value, course: f.course.value, description: f.description.value,
        due_at: f.due_at.value ? new Date(f.due_at.value).toISOString() : null, created_by: me, members: draftMembers } });
      await load();
      $('#dlg-project').close();
      location.hash = `#/projects/${p.id}`;
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false;
  });

  window.addEventListener('hashchange', () => { ui.suggestions = null; ui.suggestError = null; render(); window.scrollTo(0, 0); });
  setInterval(() => { if (!document.querySelector('dialog[open]') && !(document.activeElement && document.activeElement.dataset.key)) render(); }, 60000);

  render();
  load().then(() => { connect(); if (!me) askName(); });
})();
