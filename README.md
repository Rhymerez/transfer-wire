# Transfer Wire — backend

A small proxy server so your API key never has to sit in browser JavaScript,
where anyone viewing the page could read and reuse it.

## What this does — and doesn't — cover

- **Does:** fetches real, confirmed transfer records (player, date, from/to
  club, fee type) for a tracked list of clubs, caches them, and serves them
  to the frontend's Refresh button.
- **Doesn't:** cover transfer *rumours* or "here we go" negotiation status —
  those are editorial judgment calls from journalists, not structured data
  any free API exposes. Keep those sections curated by hand, or ask Claude
  in chat to refresh them periodically.

## Setup

1. **Get a free API key**
   Sign up at https://dashboard.api-football.com — the free plan gives you
   100 requests/day, which is enough for a few refreshes since each refresh
   queries one request per tracked club.

2. **Install dependencies**
   ```bash
   cd transfer-server
   npm install
   ```

3. **Add your key**
   ```bash
   cp .env.example .env
   # then edit .env and paste your real key in
   ```

4. **Verify the team IDs**
   `server.js` has a `TRACKED_TEAMS` list with IDs recalled from general
   knowledge, not verified live — check each one before trusting the data:
   ```bash
   curl -H "x-apisports-key: YOUR_KEY" \
     "https://v3.football.api-sports.io/teams?search=Arsenal"
   ```
   Swap in the correct `id` for any club that's wrong or add more clubs.

5. **Run it**
   ```bash
   npm start
   ```
   You should see:
   ```
   Transfer Wire backend running at http://localhost:3000
   ```

6. **Point the frontend at it**
   Open `transfer-wire.html` — the Refresh button is already wired to call
   `http://localhost:3000/api/transfers`. Just make sure the server is
   running locally while you use the page.

## Rate-limit protection

Every refresh queries the API once per tracked club (11 clubs by default),
so the server caches results for 4 hours (`CACHE_TTL_MINUTES` in `.env`)
regardless of how often the button is clicked. Lower that value if you
add fewer clubs or upgrade your API plan; raise it if you're close to
your daily cap.

## Deploying beyond your own machine

This is written for local use. If you want the site to work from a phone
or for other people, deploy this folder to a free host with Node support
(Render, Railway, Fly.io, etc.), set `API_FOOTBALL_KEY` as an environment
variable in that host's dashboard (not committed to any repo), and update
the frontend's fetch URL from `localhost:3000` to your deployed URL.
