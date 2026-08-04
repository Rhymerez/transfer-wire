// Vercel serverless function — pulls real transfer headlines from trusted,
// publicly-syndicated RSS feeds (BBC Sport, The Guardian) and sorts them
// into "done" / "talks" / "rumour" buckets using simple keyword matching.
//
// IMPORTANT — what this can and can't do:
// - It shows real, current headlines with a link back to the original
//   article on the source's own site. It never copies full article text —
//   just the headline and the short teaser the RSS feed itself provides,
//   which is exactly what RSS is designed for.
// - It CANNOT reliably produce the rich hand-written detail (fee amounts,
//   "% likely" bars, "medical stage" status) you see in the hand-curated
//   cards — that structured detail isn't published anywhere as free,
//   machine-readable data. So this feed sits alongside the curated
//   sections rather than replacing them.
// - Keyword classification is a best guess, not perfect. A headline like
//   "Chelsea complete transfer of..." lands in Done; "closing in on..."
//   lands in Talks; anything vaguer lands in Rumours. Expect occasional
//   misfires — always check the linked source for the full picture.

const FEEDS = [
  { url: "https://feeds.bbci.co.uk/sport/football/rss.xml", source: "BBC Sport" },
  { url: "https://www.theguardian.com/football/rss", source: "The Guardian" },
];

const CACHE_TTL_MS = (Number(process.env.NEWS_CACHE_TTL_MINUTES) || 60) * 60 * 1000;

// Keep this loosely in sync with the tracked clubs in transfers.js — used
// only to filter general football news down to transfer-relevant, club-
// relevant stories.
const CLUB_NAMES = [
  "Manchester City", "Manchester United", "Liverpool", "Chelsea", "Arsenal",
  "Tottenham", "Newcastle", "West Ham", "Everton", "Aston Villa", "Brighton",
  "Wolves", "Real Madrid", "Barcelona", "Atletico Madrid", "Bayern Munich",
  "Dortmund", "Leverkusen", "Juventus", "Inter Milan", "Inter,", "AC Milan",
  "Napoli", "Paris Saint-Germain", "PSG", "Marseille",
];

const TRANSFER_WORDS = [
  "transfer", "sign", "signs", "signing", "signed", "joins", "join", "loan",
  "medical", "fee", "deal", "move to", "agrees", "agreed", "linked", "target",
  "targets", "rumour", "rumor", "swap", "here we go",
];

const DONE_WORDS = [
  "confirm", "confirms", "confirmed", "complete", "completes", "completed",
  "have signed", "signs for", "signs a", "signs on", "official:", "done deal",
  "unveiled", "announce", "announced",
];

const TALKS_WORDS = [
  "medical", "advanced talks", "agrees personal terms", "set to sign",
  "close to", "closing in", "here we go", "on the verge", "in talks",
  "set to complete", "edging closer", "expected to sign",
];

let cache = { data: null, fetchedAt: 0, lastError: null };

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  let content = match[1];
  content = content.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");
  return decodeEntities(stripTags(content)).trim();
}

function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const chunk = m[1];
    items.push({
      title: extractTag(chunk, "title"),
      link: extractTag(chunk, "link"),
      description: extractTag(chunk, "description"),
      pubDate: extractTag(chunk, "pubDate"),
    });
  }
  return items;
}

function classify(text) {
  const lower = text.toLowerCase();
  if (DONE_WORDS.some((w) => lower.includes(w))) return "done";
  if (TALKS_WORDS.some((w) => lower.includes(w))) return "talks";
  return "rumour";
}

function isRelevant(text) {
  const lower = text.toLowerCase();
  const hasClub = CLUB_NAMES.some((c) => lower.includes(c.toLowerCase()));
  const hasTransferWord = TRANSFER_WORDS.some((w) => lower.includes(w));
  return hasClub && hasTransferWord;
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, { headers: { "User-Agent": "TransferWireBot/1.0" } });
  if (!res.ok) throw new Error(`${feed.source} responded ${res.status}`);
  const xml = await res.text();
  return parseRss(xml).map((item) => ({ ...item, source: feed.source }));
}

async function refreshCache() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const merged = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") merged.push(...r.value);
    else errors.push(`${FEEDS[i].source}: ${r.reason.message}`);
  });

  const relevant = merged.filter((item) => isRelevant(`${item.title} ${item.description}`));

  const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 14; // last 14 days
  const recent = relevant.filter((item) => {
    const t = item.pubDate ? new Date(item.pubDate).getTime() : NaN;
    return !isNaN(t) && t >= cutoff;
  });

  const buckets = { done: [], talks: [], rumour: [] };
  recent.forEach((item) => {
    const bucket = classify(`${item.title} ${item.description}`);
    buckets[bucket].push({
      title: item.title,
      link: item.link,
      source: item.source,
      pubDate: item.pubDate,
      teaser: item.description.length > 250 ? item.description.slice(0, 247) + "…" : item.description,
    });
  });

  Object.keys(buckets).forEach((k) => {
    buckets[k].sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    buckets[k] = buckets[k].slice(0, 12);
  });

  cache = { data: buckets, fetchedAt: Date.now(), lastError: errors.length ? errors.join("; ") : null };
  return cache;
}

export default async function handler(req, res) {
  const isStale = !cache.data || Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  const forceRequested = req.query.force === "true";

  if (isStale || forceRequested) {
    try {
      await refreshCache();
    } catch (err) {
      if (!cache.data) {
        res.status(502).json({ error: "Failed to fetch news feeds", detail: err.message });
        return;
      }
    }
  }

  res.status(200).json({
    done: cache.data?.done || [],
    talks: cache.data?.talks || [],
    rumours: cache.data?.rumour || [],
    fetchedAt: cache.fetchedAt,
    stale: Date.now() - cache.fetchedAt > CACHE_TTL_MS,
    warning: cache.lastError,
  });
}
