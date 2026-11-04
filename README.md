# Due Desk

A real-time shared deadline board for FAST NUCES Lahore students. Any student can post a quiz, assignment, project or exam, and it appears on everyone's screen within a few seconds. Group projects get members, AI-suggested task breakdowns and task assignments.

No npm packages and no build step: a static frontend in `public/`, one serverless API in `api/`, and Upstash Redis for shared data.

## Deploy to Vercel (one-time)

1. Go to **vercel.com/new**, sign in with GitHub, find **due-desk** and click **Import**. Leave every setting as it is and click **Deploy**. The page will say "Database not connected yet" until step 2 is done.
2. In the project, open **Storage** → **Create Database** → **Upstash for Redis** (free plan), and connect it to the **due-desk** project for all environments. Vercel adds the connection keys for you.
3. In **Settings → Environment Variables**, add:

   | Name | Value |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | your key from console.anthropic.com (without it, AI suggestions are generic offline ones) |
   | `RESET_KEY` | any secret word, used to reset demo data |
   | `SESSION_SECRET` | a long random string; signs login cookies (`openssl rand -hex 32`) |

4. Open **Deployments**, click the three dots on the latest one and choose **Redeploy**. The app is live at `https://due-desk.vercel.app` (or the address Vercel shows).

## Demo account

The database is seeded with one account you can sign in with:

| Email | Password |
| --- | --- |
| `demo@duedesk.test` | `duedesk-demo` |

The repo is public, so anyone can read this password. Change or remove the account before sharing the live site widely.

## Updating the app

Every push to `main` redeploys automatically:

```bash
git add . && git commit -m "Describe the change" && git push
```

## Before the demo

Reset to the 6 sample deadlines and 1 sample project:

```bash
curl -X POST "https://YOUR-APP.vercel.app/api/reset?key=YOUR_RESET_KEY"
```

## Run it locally

```bash
node server.js          # http://localhost:3000, data saved to data.json
node server.js --reset  # start from the sample data
```

Locally it uses a file instead of Redis. Put `ANTHROPIC_API_KEY=...` in a `.env` file to use real AI locally.

## Features

- **Accounts:** anyone can browse; posting and editing need an account (email + password, hashed with scrypt). Posts show the account's name, and only the poster can delete a deadline. Sessions last 30 days in an HttpOnly cookie.
- **Post a deadline:** title, course, type, due date and notes.
- **Live dashboard:** sorted by due date and grouped into Overdue / Today / Tomorrow / This week / Later / Done, with countdowns. New posts animate in on every screen with a toast ("Ali just posted…"). The header shows how many people are online.
- **To-do tab:** a 7-day strip; tap a day to see what's due as a checklist. Ticking items off is personal.
- **Group projects:** create a project, add members, add tasks manually, assign them, tick them done, with a shared progress bar.
- **AI task breakdown:** Claude suggests 4 to 7 tasks from the project brief. Edit, remove or assign them before adding.

## How it works

| File | What it does |
| --- | --- |
| `public/` | The whole frontend: `index.html`, `app.js`, `styles.css` (FAST NUCES brand tokens, light theme only) and the logo |
| `api/index.js` | Vercel serverless function; `vercel.json` sends every `/api/*` request here |
| `lib/core.js` | All API logic, sample data and the Claude call |
| `lib/auth.js` | Password hashing and signed session cookies |
| `lib/stores.js` | Upstash Redis storage (over its REST API) and a local in-memory store |
| `server.js` | Local development server |

Live updates: each phone checks a version number every 2.5 seconds and reloads the data only when it changes, which keeps database usage well inside Upstash's free plan. Times are shown in Pakistan time (Asia/Karachi).
