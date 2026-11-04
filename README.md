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
   | `CLERK_PUBLISHABLE_KEY` | from dashboard.clerk.com → API keys (`pk_…`) |
   | `CLERK_SECRET_KEY` | from the same page (`sk_…`); keep it secret |

4. Open **Deployments**, click the three dots on the latest one and choose **Redeploy**. The app is live at `https://due-desk.vercel.app` (or the address Vercel shows).

## Sign-in with Clerk

Accounts are handled by [Clerk](https://clerk.com): email sign-up, Google, password resets and account settings all come from Clerk. Due Desk keeps its own record per person (name, courses, group memberships), matched to Clerk by email.

1. Create an application at **dashboard.clerk.com**. Turn on the sign-in options you want (for example **Email** and **Google**).
2. In **Configure → Domains** (or **Developers → Domains**) make sure `https://due-desk-nine.vercel.app` is allowed for the instance you use.
3. From **API keys**, copy the **Publishable key** (`pk_…`) and the **Secret key** (`sk_…`).
4. In Vercel → Settings → Environment Variables add `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`, then redeploy.

How it works: the browser gets a short-lived session token from Clerk and sends it with every API call (`Authorization: Bearer …`). The API checks the token's signature against Clerk's public keys and its expiry, issuer and origin, then looks the person up. No Clerk npm packages are needed.

New people are asked to pick their courses right after signing up. People who had a Due Desk account before Clerk keep their courses and groups when they sign up with the same email.

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

- **Accounts:** sign-up and sign-in through Clerk (email or Google). Everyone picks their courses; posts show the person's name, and only the poster can delete a deadline.
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
| `lib/clerk.js` | Checks Clerk session tokens and fetches a user's name and email |
| `lib/stores.js` | Upstash Redis storage (over its REST API) and a local in-memory store |
| `server.js` | Local development server |

Live updates: each phone checks a version number every 2.5 seconds and reloads the data only when it changes, which keeps database usage well inside Upstash's free plan. Times are shown in Pakistan time (Asia/Karachi).
