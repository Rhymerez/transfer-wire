// Vercel serverless function — same logic as server.js, adapted to run
// on-demand instead of as an always-running server.
//
// Note: the cache here lives only as long as this function instance stays
// "warm." On a quiet site, Vercel may spin up a fresh instance for each
// visit, which resets the cache and re-queries the API. Fine for light,
// personal use; something to watch if traffic grows.

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_HOST = "https://v3.football.api-sports.io";
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_MINUTES) || 30) * 60 * 1000;

// NOTE: team IDs below were recalled from general knowledge, not verified
// live against your API key — double-check any that look wrong via:
//   https://v3.football.api-sports.io/teams?search=ClubName
// (with your key in the x-apisports-key header). To add a club not listed
// here (e.g. a Nigerian NPFL side), look up its id the same way and add a
// line in the same { id: ..., name: "..." } format.
const TRACKED_TEAMS = [
  // Premier League
  { id: 50, name: "Manchester City" },
  { id: 33, name: "Manchester United" },
  { id: 40, name: "Liverpool" },
  { id: 49, name: "Chelsea" },
  { id: 42, name: "Arsenal" },
  { id: 47, name: "Tottenham" },
  { id: 34, name: "Newcastle United" },
  { id: 48, name: "West Ham United" },
  { id: 45, name: "Everton" },
  { id: 66, name: "Aston Villa" },
  { id: 51, name: "Brighton" },
  { id: 39, name: "Wolves" },
  // La Liga
  { id: 541, name: "Real Madrid" },
  { id: 529, name: "Barcelona" },
  { id: 530, name: "Atletico Madrid" },
  // Bundesliga
  { id: 157, name: "Bayern Munich" },
  { id: 165, name: "Borussia Dortmund" },
  { id: 168, name: "Bayer Leverkusen" },
  // Serie A
  { id: 496, name: "Juventus" },
  { id: 505, name: "Inter Milan" },
  { id: 489, name: "AC Milan" },
  { id: 492, name: "Napoli" },
  // Ligue 1
  { id: 85, name: "Paris Saint-Germain" },
  { id: 81, name: "Marseille" },
];


// Persists only while this function instance stays warm between requests.
let cache = { data: null, fetchedAt: 0, lastError: null };

async function fetchTransfersForTeam(team) {
  const res = await fetch(`${API_HOST}/transfers?team=${team.id}`, {
    headers: { "x-apisports-key": API_KEY },
  });
  if (!res.ok) throw new Error(`API-Football responded ${res.status} for team ${team.name}`);
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

  const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 45;
  const recent = merged
    .filter((row) => row.date && new Date(row.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const seen = new Set();
  const deduped = recent.filter((row) => {
    const key = `${row.name}|${row.date}|${row.from}|${row.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  cache = { data: deduped, fetchedAt: Date.now(), lastError: errors.length ? errors.join("; ") : null };
  return cache;
}

export default async function handler(req, res) {
  if (!API_KEY) {
    res.status(500).json({ error: "Missing API_FOOTBALL_KEY environment variable." });
    return;
  }

  const isStale = !cache.data || Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  const forceRequested = req.query.force === "true";

  if (isStale || forceRequested) {
    try {
      await refreshCache();
    } catch (err) {
      if (!cache.data) {
        res.status(502).json({ error: "Failed to fetch transfer data", detail: err.message });
        return;
      }
    }
  }

  res.status(200).json({
    transfers: cache.data || [],
    fetchedAt: cache.fetchedAt,
    stale: Date.now() - cache.fetchedAt > CACHE_TTL_MS,
    warning: cache.lastError,
  });
}
