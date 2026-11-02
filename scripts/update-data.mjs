// Fetches the account's favorited games + live stats from Roblox's
// first-party APIs and writes public/data.json for the site to read.
// Runs on a schedule in GitHub Actions (see .github/workflows/update-data.yml)
// and works locally too: node scripts/update-data.mjs  (Node 18+)
import { readFileSync, writeFileSync } from "node:fs";

const USER_ID = 5521424624;
const OUT = new URL("../public/data.json", import.meta.url);

// Snapshots for games Roblox's details API won't return (moderated /
// temporarily unavailable). Live data wins again the moment it's back.
const PINNED = {
  9759341824: {
    placeId: "76469560314137", name: "Dodgeball!",
    visits: 7933656, playing: 0, favorites: 22300, likeRatio: 80.6,
    thumbnail: "https://tr.rbxcdn.com/180DAY-5e0fbaf8d33767f63e065bf870e4562c/768/432/Image/Png/noFilter",
  },
};

async function jget(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1200 * i));
    try {
      const r = await fetch(url, { headers: { "User-Agent": "portfolio-data" } });
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return await r.json();
    } catch (e) { err = e; }
  }
  throw err;
}

let prev = null;
try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch { /* first run */ }

// favorited games, paged
const favs = [];
let cursor = "";
for (let page = 0; page < 4; page++) {
  const j = await jget(
    `https://games.roblox.com/v2/users/${USER_ID}/favorite/games?limit=50` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")
  );
  for (const g of j.data || []) {
    if (g.id && g.rootPlace && g.rootPlace.id) {
      favs.push({ universeId: g.id, placeId: String(g.rootPlace.id) });
    }
  }
  cursor = j.nextPageCursor;
  if (!cursor) break;
}
if (!favs.length) throw new Error("no favorites returned — aborting so the old data.json survives");

const ids = favs.map((g) => g.universeId).join(",");
const details = await jget(`https://games.roblox.com/v1/games?universeIds=${ids}`);
const votes = await jget(`https://games.roblox.com/v1/games/votes?universeIds=${ids}`).catch(() => ({ data: [] }));
const thumbs = await jget(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${ids}&countPerUniverse=1&defaults=true&size=768x432&format=Png&isCircular=false`).catch(() => ({ data: [] }));

const dMap = new Map((details.data || []).filter((d) => d.id).map((d) => [d.id, d]));
const vMap = new Map((votes.data || []).map((v) => [v.id, v]));
const tMap = new Map((thumbs.data || []).map((t) => [t.universeId, (t.thumbnails && t.thumbnails[0] && t.thumbnails[0].imageUrl) || null]));
const prevLikes = new Map(((prev && prev.games) || []).map((g) => [g.universeId, g.likeRatio]));

const games = favs.map(({ universeId, placeId }) => {
  const d = dMap.get(universeId);
  if (!d) {
    const pin = PINNED[universeId];
    if (!pin) return null; // moderated and not pinned — drop it
    return { universeId, placeId, url: `https://www.roblox.com/games/${placeId}/`, ...pin, thumbnail: tMap.get(universeId) || pin.thumbnail };
  }
  const v = vMap.get(universeId);
  const total = v ? v.upVotes + v.downVotes : 0;
  const likeRatio = total > 0
    ? Math.round((v.upVotes / total) * 1000) / 10
    : prevLikes.get(universeId) || 0; // votes hiccup — keep last known ratio
  return {
    universeId, placeId, name: d.name, playing: d.playing || 0, visits: d.visits || 0,
    favorites: d.favoritedCount || 0, likeRatio,
    thumbnail: tMap.get(universeId) || null,
    url: `https://www.roblox.com/games/${placeId}/`,
  };
}).filter(Boolean).sort((a, b) => b.visits - a.visits);

// the avatar render URL rides along so the site never proxies for it either
let avatarUrl = (prev && prev.avatarUrl) || null;
try {
  const a = await jget(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${USER_ID}&size=720x720&format=Png&isCircular=false`);
  avatarUrl = (a.data && a.data[0] && a.data[0].imageUrl) || avatarUrl;
} catch { /* keep previous */ }

const totals = {
  visits: games.reduce((s, g) => s + g.visits, 0),
  playing: games.reduce((s, g) => s + g.playing, 0),
  count: games.length,
};
writeFileSync(OUT, JSON.stringify({ generatedAt: Date.now(), avatarUrl, games, totals }, null, 1));
console.log(`data.json written: ${games.length} games, ${totals.visits.toLocaleString()} visits, ${totals.playing} playing`);
