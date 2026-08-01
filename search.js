// Vercel serverless function — looks up ANY club by name (not just the
// tracked list) and returns their real confirmed transfers.
//
// Two-step process per search: find the club's team ID, then fetch their
// transfers. That's 2 API calls per unique club searched, so results are
// cached per club-name for a while to avoid burning quota on repeat
// searches of the same club.

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_HOST = "https://v3.football.api-sports.io";
const CACHE_TTL_MS = (Number(process.env.SEARCH_CACHE_TTL_MINUTES) || 360) * 60 * 1000; // 6h default

// Persists only while this function instance stays warm between requests.
const searchCache = new Map(); // key: lowercased club name -> { data, fetchedAt }

async function findTeam(query) {
  const res = await fetch(`${API_HOST}/teams?search=${encodeURIComponent(query)}`, {
    headers: { "x-apisports-key": API_KEY },
  });
  if (!res.ok) throw new Error(`Team lookup failed (${res.status})`);
  const json = await res.json();
  const match = json.response?.[0]?.team;
  if (!match) return null;
  return { id: match.id, name: match.name, logo: match.logo };
}

async function fetchTransfers(teamId) {
  const res = await fetch(`${API_HOST}/transfers?team=${teamId}`, {
    headers: { "x-apisports-key": API_KEY },
  });
  if (!res.ok) throw new Error(`Transfers lookup failed (${res.status})`);
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
  // Newest first, cap to a reasonable number for display
  rows.sort((a, b) => new Date(b.date) - new Date(a.date));
  return rows.slice(0, 30);
}

export default async function handler(req, res) {
  if (!API_KEY) {
    res.status(500).json({ error: "Missing API_FOOTBALL_KEY environment variable." });
    return;
  }

  const query = (req.query.club || "").trim();
  if (!query) {
    res.status(400).json({ error: "Missing ?club= query parameter." });
    return;
  }

  const cacheKey = query.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    res.status(200).json({ ...cached.data, fromCache: true });
    return;
  }

  try {
    const team = await findTeam(query);
    if (!team) {
      res.status(404).json({ error: `No club found matching "${query}".` });
      return;
    }
    const transfers = await fetchTransfers(team.id);
    const payload = { club: team.name, transfers, fetchedAt: Date.now() };
    searchCache.set(cacheKey, { data: payload, fetchedAt: Date.now() });
    res.status(200).json({ ...payload, fromCache: false });
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch club data", detail: err.message });
  }
}
