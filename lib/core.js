// All API logic, shared by the local server (server.js) and the Vercel function (api/index.js).
import crypto from 'node:crypto';
import { authProblem, hashPassword, checkPassword, DUMMY_HASH, sessionCookie, clearCookie, readSession } from './auth.js';

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

// Sample account so there's something to sign in with. Also listed in the README.
export const DEMO_USER = { name: 'Demo Student', email: 'demo@duedesk.test', password: 'duedesk-demo' };
export const seedUsers = async () => [{ id: id(), name: DEMO_USER.name, email: DEMO_USER.email,
  password_hash: await hashPassword(DEMO_USER.password), created_at: now() }];

const normEmail = (v) => str(v, 254).toLowerCase();
const publicUser = (u) => ({ sub: u.id, name: u.name, email: u.email });
const userView = (u) => ({ ...publicUser(u), courses: u.courses || [] });
const maskEmail = (e) => { const [a, d] = String(e).split('@'); return d ? `${a.slice(0, 2)}•••@${d}` : ''; };
const signedIn = (u, ctx, status = 200) => ({ status, body: { user: userView(u) }, headers: { 'Set-Cookie': sessionCookie(publicUser(u), ctx) } });

// ---------- Google ID token check (no SDK: Google's tokeninfo endpoint validates the signature) ----------
async function verifyGoogleToken(credential, clientId) {
  if (!credential) return null;
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const t = await r.json();
    const issuerOk = t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com';
    const fresh = Number(t.exp) * 1000 > Date.now();
    const verified = t.email_verified === true || t.email_verified === 'true';
    if (t.aud !== clientId || !issuerOk || !fresh || !verified || !t.email) return null;
    return t;
  } catch { return null; }
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
// route: path after /api/, e.g. "deadlines/abc". ctx: { cookie, secure }. Returns { status, body, headers? }.
export async function handle(store, method, route, query = {}, body = {}, ctx = {}) {
  const parts = route.split('/').filter(Boolean);
  const [r0, r1, r2] = parts;
  await store.seedIfEmpty(seed);
  await store.seedUsersIfEmpty(seedUsers);
  // one-time: clear the old sample deadlines and projects so every board starts empty
  if (await store.once('empty-start-v2')) await store.reset(seed);
  const session = readSession(ctx.cookie);
  const record = session ? await store.getUser(session.email) : null;
  const user = record ? { ...session, courses: record.courses || [] } : null;

  // ---------- auth ----------
  if (r0 === 'auth' && r1 === 'me' && method === 'GET') return ok({ user, problem: authProblem(), catalog: COURSE_CATALOG, googleClientId: process.env.GOOGLE_CLIENT_ID || null });
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
    return renamed ? signedIn(record, ctx) : ok({ user: userView(record) });
  }
  if (r0 === 'auth' && (r1 === 'signup' || r1 === 'login') && method === 'POST' && authProblem()) return fail(503, authProblem());
  if (r0 === 'auth' && r1 === 'signup' && method === 'POST') {
    const name = str(body.name, 40), email = normEmail(body.email), password = typeof body.password === 'string' ? body.password : '';
    if (!name) return fail(400, 'Enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'Enter a valid email address.');
    if (password.length < 8) return fail(400, 'Use a password of at least 8 characters.');
    if (password.length > 200) return fail(400, 'That password is too long.');
    if (await store.getUser(email)) return fail(409, 'An account with this email already exists. Sign in instead.');
    const u = { id: id(), name, email, courses: cleanCourses(body.courses), password_hash: await hashPassword(password), created_at: now() };
    await store.putUser(u);
    return signedIn(u, ctx, 201);
  }
  if (r0 === 'auth' && r1 === 'login' && method === 'POST') {
    const u = await store.getUser(normEmail(body.email));
    const good = await checkPassword(typeof body.password === 'string' ? body.password : '', u ? u.password_hash : DUMMY_HASH);
    if (u && !u.password_hash && u.google_sub) return fail(401, 'This account uses Google. Tap "Continue with Google" instead.');
    if (!u || !good) return fail(401, 'Wrong email or password.');
    return signedIn(u, ctx);
  }
  // Sign in with Google: the browser gets a Google ID token, we check it with Google and match it to an account by email
  if (r0 === 'auth' && r1 === 'google' && method === 'POST') {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return fail(503, 'Google sign-in is not set up yet. Add GOOGLE_CLIENT_ID to the environment.');
    const g = await verifyGoogleToken(str(body.credential, 4096), clientId);
    if (!g) return fail(401, "Couldn't verify your Google account. Try again.");
    let u = await store.getUser(normEmail(g.email)), isNew = false;
    if (!u) {
      u = { id: id(), name: str(g.name || g.given_name || g.email.split('@')[0], 40), email: normEmail(g.email), courses: [], google_sub: g.sub, created_at: now() };
      isNew = true;
    } else if (!u.google_sub) u.google_sub = g.sub;
    await store.putUser(u);
    const out = signedIn(u, ctx, isNew ? 201 : 200);
    out.body.isNew = isNew;
    return out;
  }
  if (r0 === 'auth' && r1 === 'logout' && method === 'POST') return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': clearCookie(ctx) } };

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
