// All API logic, shared by the local server (server.js) and the Vercel function (api/index.js).
import crypto from 'node:crypto';
import { clerkConfig, clerkProblem, verifyClerkToken, fetchClerkUser } from './clerk.js';

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
// New boards start empty: students only see what their batch actually posts.
export function seed() {
  return { deadlines: [], projects: [], members: [], tasks: [] };
}

// FAST NUCES courses offered in the sign-up course picker. Students can also add their own.
export const COURSE_CATALOG = [
  'Programming Fundamentals', 'Object Oriented Programming', 'Data Structures', 'Design and Analysis of Algorithms',
  'Discrete Structures', 'Digital Logic Design', 'Computer Organization and Assembly Language', 'Operating Systems',
  'Database Systems', 'Computer Networks', 'Software Engineering', 'Theory of Automata', 'Compiler Construction',
  'Artificial Intelligence', 'Machine Learning', 'Human Computer Interaction', 'Web Programming', 'Information Security',
  'Parallel and Distributed Computing', 'Calculus and Analytical Geometry', 'Linear Algebra', 'Probability and Statistics',
  'Differential Equations', 'Technical and Business Writing', 'Islamic Studies', 'Pakistan Studies',
];
const courseKey = (c) => String(c || '').trim().toLowerCase().replace(/\s+/g, ' ');
function cleanCourses(list) {
  const seen = new Set(), out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const v = str(c, 80).replace(/\s+/g, ' ');
    if (v && !seen.has(courseKey(v))) { seen.add(courseKey(v)); out.push(v); }
  }
  return out.slice(0, 20);
}

const normEmail = (v) => str(v, 254).toLowerCase();
const publicUser = (u) => ({ sub: u.id, name: u.name, email: u.email });
const userView = (u) => ({ ...publicUser(u), courses: u.courses || [] });
const maskEmail = (e) => { const [a, d] = String(e).split('@'); return d ? `${a.slice(0, 2)}•••@${d}` : ''; };

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

// ---------- accounts ----------
async function accountFor(store, ctx) {
  const m = /^Bearer\s+(.+)$/i.exec(ctx.authorization || '');
  if (!m || clerkProblem()) return null;
  const claims = await verifyClerkToken(m[1].trim(), { origin: ctx.origin });
  if (!claims) return null;
  let email = await store.getLink(claims.sub);
  if (email) { const rec = await store.getUser(email); if (rec) return rec; }
  // first time we see this Clerk user: fetch their email and name, then reuse or create the account
  const info = await fetchClerkUser(claims.sub);
  if (!info.email) return null;
  let rec = await store.getUser(info.email);
  if (!rec) rec = { id: id(), name: str(info.name, 40) || 'Student', email: info.email, courses: [], created_at: now() };
  rec.clerk_id = claims.sub;
  await store.putUser(rec);
  await store.setLink(claims.sub, info.email);
  return rec;
}

// ---------- router ----------
// route: path after /api/, e.g. "deadlines/abc". ctx: { cookie, secure }. Returns { status, body, headers? }.
export async function handle(store, method, route, query = {}, body = {}, ctx = {}) {
  const parts = route.split('/').filter(Boolean);
  const [r0, r1, r2] = parts;
  await store.seedIfEmpty(seed);
  // one-time: clear the old sample deadlines and projects so every board starts empty
  if (await store.once('empty-start-v2')) await store.reset(seed);
  // who is calling: a Clerk session token, mapped to our account by email (the version poll skips this)
  const record = r0 === 'version' ? null : await accountFor(store, ctx);
  const session = record ? { sub: record.id, name: record.name, email: record.email } : null;
  const user = record ? { ...session, courses: record.courses || [] } : null;

  // ---------- auth ----------
  if (r0 === 'auth' && r1 === 'me' && method === 'GET') return ok({ user, problem: clerkProblem(), catalog: COURSE_CATALOG, clerkPublishableKey: clerkConfig().publishableKey || null });
  if (r0 === 'auth' && r1 === 'me' && method === 'PATCH') {
    if (!record) return fail(401, 'Sign in first.');
    if ('courses' in body) record.courses = cleanCourses(body.courses);
    let renamed = false;
    if ('name' in body) {
      const name = str(body.name, 40);
      if (!name) return fail(400, 'Enter your name.');
      if (name !== record.name) {
        const old = record.name;
        record.name = name; renamed = true;
        // keep the new name everywhere it already appears
        const all = await store.getAll();
        const myProjects = new Set(all.members.filter((m) => m.user_id === record.id).map((m) => m.project_id));
        const members = all.members.filter((m) => m.user_id === record.id).map((m) => ({ ...m, name }));
        const tasks = all.tasks.filter((t) => myProjects.has(t.project_id) && t.assignee === old).map((t) => ({ ...t, assignee: name }));
        const deadlines = all.deadlines.filter((d) => d.posted_by_sub === record.id).map((d) => ({ ...d, posted_by: name }));
        const projects = all.projects.filter((x) => x.created_by_sub === record.id).map((x) => ({ ...x, created_by: name }));
        if (members.length) await store.put('members', ...members);
        if (tasks.length) await store.put('tasks', ...tasks);
        if (deadlines.length) await store.put('deadlines', ...deadlines);
        if (projects.length) await store.put('projects', ...projects);
      }
    }
    await store.putUser(record);
    // the name lives in the session cookie too, so refresh it after a rename
    return ok({ user: userView(record), renamed });
  }

  if (r0 === 'version' && method === 'GET') {
    const [version, online] = await Promise.all([store.getVersion(), query.client ? store.presence(str(query.client, 64)) : null]);
    return ok({ version, online });
  }
  if (r0 === 'state' && method === 'GET') {
    const all = await store.getAll();
    const stats = { deadlines: all.deadlines.length, projects: all.projects.length };
    if (!user) return ok({ deadlines: [], projects: [], members: [], tasks: [], version: all.version, stats, ai: !!process.env.ANTHROPIC_API_KEY });
    const mine = new Set(all.members.filter((m) => m.user_id === user.sub).map((m) => m.project_id));
    const myCourses = new Set(user.courses.map(courseKey));
    return ok({
      deadlines: all.deadlines.filter((d) => myCourses.has(courseKey(d.course)) || (d.project_id && mine.has(d.project_id))),
      projects: all.projects.filter((p) => mine.has(p.id)),
      members: all.members.filter((m) => mine.has(m.project_id)),
      tasks: all.tasks.filter((t) => mine.has(t.project_id)),
      version: all.version, stats, ai: !!process.env.ANTHROPIC_API_KEY,
    });
  }

  if (r0 === 'reset' && method === 'POST') {
    const keyNeeded = process.env.RESET_KEY;
    if (keyNeeded && query.key !== keyNeeded) return fail(403, 'Wrong reset key.');
    await store.reset(seed);
    return ok({ ok: true });
  }

  // everything below changes shared data, so it needs a signed-in user
  if (method !== 'GET' && !user) return fail(401, 'Sign in to make changes.');
  const isMember = async (projectId) => (await store.getAll()).members.some((m) => m.project_id === projectId && m.user_id === user.sub);

  // search people who have signed up, to add them to a group project
  if (r0 === 'users' && method === 'GET') {
    if (!user) return fail(401, 'Sign in to search classmates.');
    const q = courseKey(query.q);
    const people = (await store.listUsers())
      .filter((u) => u.id !== user.sub && !u.email.endsWith('.test'))
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().startsWith(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8)
      .map((u) => ({ id: u.id, name: u.name, hint: maskEmail(u.email) }));
    return ok({ users: people });
  }

  if (r0 === 'deadlines' && !r1 && method === 'POST') {
    const due_at = validDate(body.due_at);
    if (!str(body.title) || !str(body.course) || !due_at) return fail(400, 'Title, course and due date are required.');
    const project_id = str(body.project_id, 64) || null;
    if (project_id && !(await isMember(project_id))) return fail(403, "You can only post to group projects you're in.");
    const item = { id: id(), title: str(body.title, 120), course: str(body.course, 80), type: TYPES.includes(body.type) ? body.type : 'Assignment',
      due_at, notes: str(body.notes, 500), project_id, posted_by: user.name, posted_by_sub: user.sub, created_at: now() };
    await store.put('deadlines', item);
    return ok(item, 201);
  }
  if (r0 === 'deadlines' && r1 && method === 'DELETE') {
    const d = await store.get('deadlines', r1);
    if (d && d.posted_by_sub !== user.sub) return fail(403, 'Only the person who posted this can delete it.');
    await store.del('deadlines', r1);
    return ok({ ok: true });
  }

  if (r0 === 'projects' && !r1 && method === 'POST') {
    if (!str(body.title)) return fail(400, 'Project title is required.');
    const p = { id: id(), title: str(body.title, 120), course: str(body.course, 80), description: str(body.description, 1000),
      due_at: validDate(body.due_at), created_by: user.name, created_by_sub: user.sub, created_at: now() };
    const people = await store.listUsers();
    const ids = [...new Set((Array.isArray(body.members) ? body.members : []).map((x) => str(x, 64)))].filter((x) => x && x !== user.sub);
    const picked = ids.map((uid) => people.find((u) => u.id === uid)).filter(Boolean);
    await store.put('projects', p);
    await store.put('members', { id: id(), project_id: p.id, user_id: user.sub, name: user.name },
      ...picked.map((u) => ({ id: id(), project_id: p.id, user_id: u.id, name: u.name })));
    return ok(p, 201);
  }
  if (r0 === 'projects' && r1 && r2 === 'members' && method === 'POST') {
    if (!(await isMember(r1))) return fail(403, "Only group members can add people.");
    const person = (await store.listUsers()).find((u) => u.id === str(body.user_id, 64));
    if (!person) return fail(404, 'Pick someone who has signed up for Due Desk.');
    const { members } = await store.getAll();
    if (members.some((m) => m.project_id === r1 && m.user_id === person.id)) return fail(409, `${person.name} is already in this group.`);
    const m = { id: id(), project_id: r1, user_id: person.id, name: person.name };
    await store.put('members', m);
    return ok(m, 201);
  }
  if (r0 === 'members' && r1 && method === 'DELETE') {
    const m = await store.get('members', r1);
    if (m && !(await isMember(m.project_id))) return fail(403, 'Only group members can remove people.');
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
    if (!p || !(await isMember(p.id))) return fail(404, 'Project not found.');
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
    const { members } = await store.getAll();
    const mine = new Set(members.filter((m) => m.user_id === user.sub).map((m) => m.project_id));
    const created = list
      .filter((t) => str(t.title) && mine.has(t.project_id))
      .map((t) => ({ id: id(), project_id: t.project_id, title: str(t.title, 120), estimate_hours: Number(t.estimate_hours) || null,
        assignee: str(t.assignee, 40) || null, done: false, source: t.source === 'ai' ? 'ai' : 'manual', created_at: now() }));
    if (!created.length) return fail(400, 'Task title is required.');
    await store.put('tasks', ...created);
    return ok(created, 201);
  }
  if (r0 === 'tasks' && r1) {
    const t = await store.get('tasks', r1);
    if (!t || !(await isMember(t.project_id))) return fail(404, 'Task not found.');
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
