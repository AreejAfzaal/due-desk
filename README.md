# Quiz Kab Hai?

A real-time shared deadline board for FAST NUCES Lahore students. Any student can post a quiz, assignment, project or exam, and it appears on everyone's screen within a few seconds. Group projects get members, AI-suggested task breakdowns and task assignments.

No npm packages and no build step: a static frontend in `public/`, one serverless API in `api/`, and Upstash Redis for shared data.

## Deploy to Vercel (one-time, about 5 minutes)

### 1. Put the code on GitHub

Open Terminal in this folder and run:

```bash
git init && git add . && git commit -m "Initial commit"
gh repo create quiz-kab-hai --private --source=. --push
```

(No `gh`? Install it with `brew install gh`, then run `gh auth login` once.)

### 2. Import it into Vercel

1. Go to **vercel.com/new** and sign in with GitHub.
2. Find **quiz-kab-hai** and click **Import**.
3. Leave every setting as it is and click **Deploy**. The page will say "Database not connected yet" until step 3 is done.

### 3. Add the free database

1. In your Vercel project, open the **Storage** tab.
2. Click **Create Database**, choose **Upstash for Redis** (free plan), and create it.
3. Connect it to the **quiz-kab-hai** project for all environments. Vercel adds the connection keys for you.

### 4. Turn on real AI (optional, recommended)

In **Settings → Environment Variables**, add:

| Name | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | your key from console.anthropic.com |
| `RESET_KEY` | any secret word, used to reset demo data |

Without `ANTHROPIC_API_KEY`, "Suggest tasks with AI" returns generic offline suggestions.

### 5. Redeploy

Open **Deployments**, click the three dots on the latest one, and choose **Redeploy**. Your app is live at `https://quiz-kab-hai.vercel.app` (or the address Vercel shows).

## Updating the app

Every push to GitHub redeploys automatically:

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

- **Name, no login:** students type their name once; it's saved on their phone.
- **Post a deadline:** title, course, type, due date and notes.
- **Live dashboard:** sorted by due date and grouped into Overdue / Today / Tomorrow / This week / Later / Done, with countdowns. New posts animate in on every screen with a toast ("Ali just posted…"). The header shows how many people are online.
- **Daily to-do:** a 7-day strip; tap a day to see what's due as a checklist. Ticking items off is personal.
- **Group projects:** create a project, add members, add tasks manually, assign them, tick them done, with a shared progress bar.
- **AI task breakdown:** Claude suggests 4 to 7 tasks from the project brief. Edit, remove or assign them before adding.

## How it works

| File | What it does |
| --- | --- |
| `public/` | The whole frontend: `index.html`, `app.js`, `styles.css` (FAST NUCES brand tokens, light and dark mode) and the logo |
| `api/index.js` | Vercel serverless function; `vercel.json` sends every `/api/*` request here |
| `lib/core.js` | All API logic, sample data and the Claude call |
| `lib/stores.js` | Upstash Redis storage (over its REST API) and a local in-memory store |
| `server.js` | Local development server |

Live updates: each phone checks a version number every 2.5 seconds and reloads the data only when it changes, which keeps database usage well inside Upstash's free plan. Times are shown in Pakistan time (Asia/Karachi).
