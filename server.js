// Transfer Wire backend
// -----------------------------------------------------------------------
// Holds your API-Football key privately (never sent to the browser) and
// exposes GET /api/transfers, which the frontend calls when you click
// "Refresh". Requires Node 18+ (for built-in fetch).
// -----------------------------------------------------------------------

import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors()); // fine for local/dev use; lock this down if you deploy publicly

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_HOST = "https://v3.football.api-sports.io";

// How long to trust cached results before allowing a real re-fetch.
// Each refresh calls the API once per team below, so keep this high enough
// that you don't blow through the free tier's daily request cap.
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_MINUTES) || 240) * 60 * 1000; // default 4h

// A starter list of clubs to track. These IDs are API-Football's internal
// team IDs, recalled from general knowledge rather than verified live —
// double check each one against the API before relying on it:
//   GET https://v3.football.api-sports.io/teams?search=Arsenal
// (with your API key in the x-apisports-key header) and swap in the
// correct id if any of these are off.
const TRACKED_TEAMS = [
  { id: 50, name: "Manchester City" },
  { id: 33, name: "Manchester United" },
  { id: 40, name: "Liverpool" },
  { id: 49, name: "Chelsea" },
  { id: 42, name: "Arsenal" },
  { id: 47, name: "Tottenham" },
  { id: 34, name: "Newcastle United" },
  { id: 541, name: "Real Madrid" },
  { id: 529, name: "Barcelona" },
  { id: 157, name: "Bayern Munich" },
  { id: 85, name: "Paris Saint-Germain" },
];

let cache = {
  data: null,
  fetchedAt: 0,
  lastError: null,
};

async function fetchTransfersForTeam(team) {
  const res = await fetch(`${API_HOST}/transfers?team=${team.id}`, {
    headers: { "x-apisports-key": API_KEY },
  });
  if (!res.ok) {
    throw new Error(`API-Football responded ${res.status} for team ${team.name}`);
  }
  const json = await res.json();
  const players = json.response || [];

  const rows = [];
  for (const entry of players) {
    const playerName = entry.player?.name;
    for (const t of entry.transfers || []) {
      rows.push({
        name: playerName,
        date: t.date,
        from: t.teams?.out?.name,
        to: t.teams?.in?.name,
        fee: t.type && t.type !== "N/A" ? t.type : "Undisclosed",
      });
    }
  }
  return rows;
}

async function refreshCache() {
  const results = await Promise.allSettled(TRACKED_TEAMS.map(fetchTransfersForTeam));

  const merged = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") merged.push(...r.value);
    else errors.push(`${TRACKED_TEAMS[i].name}: ${r.reason.message}`);
  });

  // Keep only reasonably recent moves, newest first.
  const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 45; // last 45 days
  const recent = merged
    .filter((row) => row.date && new Date(row.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  // De-duplicate (same player/date can appear via both clubs' team queries)
  const seen = new Set();
  const deduped = recent.filter((row) => {
    const key = `${row.name}|${row.date}|${row.from}|${row.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  cache = {
    data: deduped,
    fetchedAt: Date.now(),
    lastError: errors.length ? errors.join("; ") : null,
  };
  return cache;
}

app.get("/api/transfers", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: "Missing API_FOOTBALL_KEY. Copy .env.example to .env and add your key.",
    });
  }

  const isStale = !cache.data || Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  const forceRequested = req.query.force === "true";

  if (isStale || forceRequested) {
    try {
      await refreshCache();
    } catch (err) {
      if (!cache.data) {
        return res.status(502).json({ error: "Failed to fetch transfer data", detail: err.message });
      }
      // fall through and serve stale cache if we have one
    }
  }

  res.json({
    transfers: cache.data || [],
    fetchedAt: cache.fetchedAt,
    stale: Date.now() - cache.fetchedAt > CACHE_TTL_MS,
    warning: cache.lastError,
  });
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Transfer Wire backend running at http://localhost:${PORT}`);
  console.log(`Frontend should call:  http://localhost:${PORT}/api/transfers`);
});
