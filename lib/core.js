// All API logic, shared by the local server (server.js) and the Vercel function (api/index.js).
import crypto from 'node:crypto';

const TYPES = ['Quiz', 'Assignment', 'Project', 'Exam'];
const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function validDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const ok = (body, status = 200) => ({ status, body });
const fail = (status, error) => ({ status, body: { error } });

// ---------- seed data (dates relative to today, Pakistan time) ----------
export function seed() {
  const at = (days, hour, min = 0) => {
    // build the time in Asia/Karachi (UTC+5, no DST)
    const pk = new Date(Date.now() + 5 * 3600000);
    pk.setUTCDate(pk.getUTCDate() + days);
    pk.setUTCHours(hour, min, 0, 0);
    return new Date(pk.getTime() - 5 * 3600000).toISOString();
  };
  const dl = (title, course, type, due_at, notes, posted_by) => ({ id: id(), title, course, type, due_at, notes, posted_by, created_at: now() });
  const projectId = id();
  return {
    deadlines: [
      dl('Quiz 3: Trees and heaps', 'Data Structures', 'Quiz', at(0, 16), 'Chapters 4 to 6, in class.', 'Ali'),
      dl('Assignment 2: Inheritance', 'OOP', 'Assignment', at(1, 23, 59), 'Submit on Google Classroom.', 'Fatima'),
      dl('Lab 5 report', 'Digital Logic Design', 'Assignment', at(2, 12), 'Include truth tables and circuit screenshots.', 'Hamza'),
      dl('Project proposal', 'Software Engineering', 'Project', at(4, 17), 'Two pages, one per group.', 'Ayesha'),
      dl('Mid-term exam', 'Linear Algebra', 'Exam', at(6, 9), 'Syllabus: chapters 1 to 3.', 'CR'),
      dl('Quiz 2: SQL joins', 'Databases', 'Quiz', at(-1, 10), 'Already happened, kept to show "Overdue".', 'Usman'),
    ],
    projects: [{ id: projectId, title: 'Library management system', course: 'Software Engineering',
      description: 'Build requirements, UML diagrams and a working prototype for a university library system.',
      due_at: at(10, 17), created_by: 'Ayesha', created_at: now() }],
    members: ['Ayesha', 'Ali', 'Fatima'].map((name) => ({ id: id(), project_id: projectId, name })),
    tasks: [
      { id: id(), project_id: projectId, title: 'Write the requirements document', estimate_hours: 4, assignee: 'Ayesha', done: true, source: 'manual', created_at: now() },
      { id: id(), project_id: projectId, title: 'Draw use case and class diagrams', estimate_hours: 3, assignee: 'Ali', done: false, source: 'manual', created_at: now() },
    ],
  };
}

// ---------- AI breakdown ----------
function offlineBreakdown(title) {
  return [
    { title: `Agree on scope and goals for "${title}"`.slice(0, 120), estimate_hours: 1 },
    { title: 'Research and collect references', estimate_hours: 3 },
    { title: 'Draft the main deliverable', estimate_hours: 5 },
    { title: 'Build or prepare supporting material', estimate_hours: 4 },
    { title: 'Review together and fix issues', estimate_hours: 2 },
    { title: 'Prepare slides and rehearse the presentation', estimate_hours: 2 },
  ];
}
async function breakdown(p, memberCount) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { tasks: offlineBreakdown(p.title), offline: true };
  const today = new Date().toLocaleDateString('en-PK', { timeZone: 'Asia/Karachi', dateStyle: 'full' });
  const prompt = `You are helping a group of university students at FAST NUCES Lahore split a group project into tasks.

Project: ${p.title}
Course: ${p.course || 'not given'}
Description: ${p.description || 'not given'}
Due: ${p.due_at ? new Date(p.due_at).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' }) : 'not given'}
Today: ${today}
Group size: ${memberCount || 'unknown'}

Break this into 4 to 7 concrete, independent tasks that can each be owned by one student.
Order them in the sequence they should be done. Keep each title under 70 characters, starting with a verb.
Respond with ONLY a JSON array, no prose, in this exact shape:
[{"title": "string", "estimate_hours": number}]`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL(), max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`Claude API error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const text = (data.content || []).map((b) => b.text || '').join('');
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON array in response');
  const tasks = JSON.parse(match[0])
    .filter((t) => t && typeof t.title === 'string' && t.title.trim())
    .slice(0, 7)
    .map((t) => ({ title: t.title.trim().slice(0, 120), estimate_hours: Math.max(0.5, Math.min(40, Number(t.estimate_hours) || 2)) }));
  if (tasks.length < 2) throw new Error('Too few tasks returned');
  return { tasks, offline: false };
}

// ---------- router ----------
// route: path after /api/, e.g. "deadlines/abc". Returns { status, body }.
export async function handle(store, method, route, query = {}, body = {}) {
  const parts = route.split('/').filter(Boolean);
  const [r0, r1, r2] = parts;
  await store.seedIfEmpty(seed);

  if (r0 === 'version' && method === 'GET') {
    const [version, online] = await Promise.all([store.getVersion(), query.client ? store.presence(str(query.client, 64)) : null]);
    return ok({ version, online });
  }
  if (r0 === 'state' && method === 'GET') return ok({ ...(await store.getAll()), ai: !!process.env.ANTHROPIC_API_KEY });

  if (r0 === 'reset' && method === 'POST') {
    const keyNeeded = process.env.RESET_KEY;
    if (keyNeeded && query.key !== keyNeeded) return fail(403, 'Wrong reset key.');
    await store.reset(seed);
    return ok({ ok: true });
  }

  if (r0 === 'deadlines' && !r1 && method === 'POST') {
    const due_at = validDate(body.due_at);
    if (!str(body.title) || !str(body.course) || !due_at) return fail(400, 'Title, course and due date are required.');
    const item = { id: id(), title: str(body.title, 120), course: str(body.course, 80), type: TYPES.includes(body.type) ? body.type : 'Assignment',
      due_at, notes: str(body.notes, 500), posted_by: str(body.posted_by, 40) || 'Someone', created_at: now() };
    await store.put('deadlines', item);
    return ok(item, 201);
  }
  if (r0 === 'deadlines' && r1 && method === 'DELETE') { await store.del('deadlines', r1); return ok({ ok: true }); }

  if (r0 === 'projects' && !r1 && method === 'POST') {
    if (!str(body.title)) return fail(400, 'Project title is required.');
    const p = { id: id(), title: str(body.title, 120), course: str(body.course, 80), description: str(body.description, 1000),
      due_at: validDate(body.due_at), created_by: str(body.created_by, 40) || 'Someone', created_at: now() };
    const names = [...new Set([p.created_by, ...(Array.isArray(body.members) ? body.members : [])].map((n) => str(n, 40)).filter(Boolean))];
    await store.put('projects', p);
    await store.put('members', ...names.map((name) => ({ id: id(), project_id: p.id, name })));
    return ok(p, 201);
  }
  if (r0 === 'projects' && r1 && r2 === 'members' && method === 'POST') {
    const name = str(body.name, 40);
    if (!name) return fail(400, 'Name is required.');
    const { members } = await store.getAll();
    if (members.some((m) => m.project_id === r1 && m.name.toLowerCase() === name.toLowerCase())) return fail(409, `${name} is already in this group.`);
    const m = { id: id(), project_id: r1, name };
    await store.put('members', m);
    return ok(m, 201);
  }
  if (r0 === 'members' && r1 && method === 'DELETE') {
    const m = await store.get('members', r1);
    if (m) {
      const { tasks } = await store.getAll();
      const affected = tasks.filter((t) => t.project_id === m.project_id && t.assignee === m.name).map((t) => ({ ...t, assignee: null }));
      if (affected.length) await store.put('tasks', ...affected);
    }
    await store.del('members', r1);
    return ok({ ok: true });
  }
  if (r0 === 'projects' && r1 && r2 === 'breakdown' && method === 'POST') {
    const p = await store.get('projects', r1);
    if (!p) return fail(404, 'Project not found.');
    try {
      const { members } = await store.getAll();
      return ok(await breakdown(p, members.filter((m) => m.project_id === p.id).length));
    } catch (e) {
      console.error('Breakdown failed:', e.message);
      return fail(502, "Couldn't generate tasks. Try again.");
    }
  }

  if (r0 === 'tasks' && !r1 && method === 'POST') {
    const list = Array.isArray(body.tasks) ? body.tasks : [body];
    const { projects } = await store.getAll();
    const created = list
      .filter((t) => str(t.title) && projects.some((p) => p.id === t.project_id))
      .map((t) => ({ id: id(), project_id: t.project_id, title: str(t.title, 120), estimate_hours: Number(t.estimate_hours) || null,
        assignee: str(t.assignee, 40) || null, done: false, source: t.source === 'ai' ? 'ai' : 'manual', created_at: now() }));
    if (!created.length) return fail(400, 'Task title is required.');
    await store.put('tasks', ...created);
    return ok(created, 201);
  }
  if (r0 === 'tasks' && r1) {
    const t = await store.get('tasks', r1);
    if (!t) return fail(404, 'Task not found.');
    if (method === 'PATCH') {
      if ('title' in body && str(body.title)) t.title = str(body.title, 120);
      if ('assignee' in body) t.assignee = str(body.assignee, 40) || null;
      if ('done' in body) t.done = !!body.done;
      await store.put('tasks', t);
      return ok(t);
    }
    if (method === 'DELETE') { await store.del('tasks', r1); return ok({ ok: true }); }
  }
  return fail(404, 'Not found');
}
