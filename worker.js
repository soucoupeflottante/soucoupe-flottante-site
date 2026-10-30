// Tally: small, cookieless statistics. Counts are anonymous hourly totals kept in D1.
// Only /tally/* reaches this Worker; everything else is served as static files.

const NAME_OK = /^[a-z0-9:_.\-]{1,48}$/;
const APP_OK = /^[a-z0-9_\-]{1,24}$/;
const MAX_EVENTS = 80;
const MAX_N = 200;
const DAILY_REQUEST_CAP = 3000;
const RETENTION_MONTHS = 25;

let ready;
function setup(db) {
  if (!ready) {
    ready = db.batch([
      db.prepare(
        "CREATE TABLE IF NOT EXISTS events (app TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (app, day, hour, name))"
      ),
      db.prepare(
        "CREATE TABLE IF NOT EXISTS abuse (h TEXT NOT NULL, day TEXT NOT NULL, c INTEGER NOT NULL, PRIMARY KEY (h, day))"
      ),
    ]);
  }
  return ready;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Shortened hash of the network: last IPv4 octet / last 80 bits of IPv6 are dropped first.
async function networkHash(ip) {
  let part = ip || "none";
  if (part.includes(":")) part = part.split(":").slice(0, 3).join(":");
  else part = part.split(".").slice(0, 3).join(".");
  const data = new TextEncoder().encode("tally:" + part);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

async function hit(request, env, url) {
  if (!sameOrigin(request, url)) return new Response(null, { status: 403 });
  let body;
  try {
    const text = await request.text();
    if (text.length > 8000) return new Response(null, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const app = String(body.app || "");
  if (!APP_OK.test(app)) return new Response(null, { status: 400 });
  const raw = body.events && typeof body.events === "object" ? body.events : {};
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > MAX_EVENTS) return new Response(null, { status: 400 });

  const counts = new Map();
  for (const [name, value] of entries) {
    if (!NAME_OK.test(name)) continue;
    const n = Math.min(MAX_N, Math.max(1, Math.floor(Number(value) || 0)));
    if (!Number.isFinite(n) || n < 1) continue;
    counts.set(name, (counts.get(name) || 0) + n);
  }
  const opens = counts.get("open") || 0;
  const country = request.cf && request.cf.country;
  if (opens > 0 && country && /^[A-Z]{2}$/.test(country)) {
    counts.set("country:" + country.toLowerCase(), opens);
  }
  if (counts.size === 0) return new Response(null, { status: 400 });

  const db = env.DB;
  await setup(db);

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const hour = now.getUTCHours();

  // Daily limit per network (hash kept separately, deleted after two days).
  const h = await networkHash(request.headers.get("cf-connecting-ip"));
  const row = await db
    .prepare(
      "INSERT INTO abuse (h, day, c) VALUES (?, ?, 1) ON CONFLICT(h, day) DO UPDATE SET c = c + 1 RETURNING c"
    )
    .bind(h, day)
    .first();
  if (row && row.c > DAILY_REQUEST_CAP) return new Response(null, { status: 429 });

  const upsert = db.prepare(
    "INSERT INTO events (app, day, hour, name, n) VALUES (?, ?, ?, ?, ?) ON CONFLICT(app, day, hour, name) DO UPDATE SET n = n + excluded.n"
  );
  await db.batch([...counts].map(([name, n]) => upsert.bind(app, day, hour, name, n)));

  // Light housekeeping on a small share of requests.
  if (Math.random() < 0.02) {
    const twoDays = new Date(now.getTime() - 2 * 86400000).toISOString().slice(0, 10);
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
    await db.batch([
      db.prepare("DELETE FROM abuse WHERE day < ?").bind(twoDays),
      db.prepare("DELETE FROM events WHERE day < ?").bind(cutoff.toISOString().slice(0, 10)),
    ]);
  }
  return new Response(null, { status: 204 });
}

async function stats(request, env, url) {
  const key = url.searchParams.get("key") || "";
  if (!env.STATS_KEY || key.length !== env.STATS_KEY.length || key !== env.STATS_KEY) {
    return json({ error: "forbidden" }, 403);
  }
  await setup(env.DB);
  const q = url.searchParams;
  const where = [];
  const args = [];
  if (q.get("app")) { where.push("app = ?"); args.push(q.get("app")); }
  if (q.get("from")) { where.push("day >= ?"); args.push(q.get("from")); }
  if (q.get("to")) { where.push("day <= ?"); args.push(q.get("to")); }
  const sql =
    "SELECT app, day, hour AS hour_utc, name, n FROM events" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY day, hour, name LIMIT 50000";
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  if (q.get("format") === "json") return json(results);
  const lines = ["app,day,hour_utc,name,n", ...results.map((r) => [r.app, r.day, r.hour_utc, r.name, r.n].join(","))];
  return new Response(lines.join("\n") + "\n", {
    headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/tally/hit" && request.method === "POST") return hit(request, env, url);
    if (url.pathname === "/tally/stats" && request.method === "GET") return stats(request, env, url);
    return new Response("Not found", { status: 404 });
  },
};
