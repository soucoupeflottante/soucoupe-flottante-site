// Tally: small, cookieless statistics. Counts are anonymous hourly totals kept in D1.
// Only /tally/*, /subscribe, /subscribers, /scene and /scene-list reach this Worker; everything else is served as static files.

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
      db.prepare(
        "CREATE TABLE IF NOT EXISTS subscribers (email TEXT PRIMARY KEY, lang TEXT NOT NULL, created TEXT NOT NULL)"
      ),
      db.prepare(
        "CREATE TABLE IF NOT EXISTS artists (id INTEGER PRIMARY KEY AUTOINCREMENT, created TEXT NOT NULL, kind TEXT NOT NULL, whatsapp TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, link TEXT NOT NULL, style TEXT NOT NULL, format TEXT NOT NULL, people TEXT NOT NULL, about TEXT NOT NULL, needs TEXT NOT NULL, dates TEXT NOT NULL)"
      ),
    ]).then(async () => {
      // Added later: the page language, so replies go out in the right one. Fails quietly once it exists.
      try { await db.prepare("ALTER TABLE artists ADD COLUMN lang TEXT NOT NULL DEFAULT ''").run(); } catch {}
    });
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

// Password check for the statistics and the sign-up list. The key comes in the x-stats-key header
// (or ?key= for old links). Wrong guesses are counted per network and stop after a daily cap.
const KEY_FAIL_CAP = 30;
async function checkKey(request, env, url) {
  const db = env.DB;
  await setup(db);
  const day = new Date().toISOString().slice(0, 10);
  const h = "key:" + (await networkHash(request.headers.get("cf-connecting-ip")));
  const seen = await db.prepare("SELECT c FROM abuse WHERE h = ? AND day = ?").bind(h, day).first();
  if (seen && seen.c >= KEY_FAIL_CAP) return json({ error: "too many attempts" }, 429);
  const key = request.headers.get("x-stats-key") || url.searchParams.get("key") || "";
  if (env.STATS_KEY && key.length === env.STATS_KEY.length && key === env.STATS_KEY) return null;
  await db
    .prepare("INSERT INTO abuse (h, day, c) VALUES (?, ?, 1) ON CONFLICT(h, day) DO UPDATE SET c = c + 1")
    .bind(h, day)
    .run();
  return json({ error: "forbidden" }, 403);
}

async function stats(request, env, url) {
  const denied = await checkKey(request, env, url);
  if (denied) return denied;
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

// Programme sign-ups: an email address, the page language and the date. Nothing else is kept.
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SUBSCRIBE_DAILY_CAP = 20;

async function subscribe(request, env, url) {
  if (!sameOrigin(request, url)) return new Response(null, { status: 403 });
  let body;
  try {
    const text = await request.text();
    if (text.length > 2000) return new Response(null, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  // Hidden field that only bots fill in: pretend it worked.
  if (body.website) return new Response(null, { status: 204 });
  const email = String(body.email || "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_OK.test(email)) return new Response(null, { status: 400 });
  const lang = body.lang === "en" ? "en" : "fr";

  const db = env.DB;
  await setup(db);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const h = "sub:" + (await networkHash(request.headers.get("cf-connecting-ip")));
  const row = await db
    .prepare(
      "INSERT INTO abuse (h, day, c) VALUES (?, ?, 1) ON CONFLICT(h, day) DO UPDATE SET c = c + 1 RETURNING c"
    )
    .bind(h, day)
    .first();
  if (row && row.c > SUBSCRIBE_DAILY_CAP) return new Response(null, { status: 429 });

  await db
    .prepare("INSERT OR IGNORE INTO subscribers (email, lang, created) VALUES (?, ?, ?)")
    .bind(email, lang, now.toISOString())
    .run();
  return new Response(null, { status: 204 });
}

// The list, as a CSV, for whoever sends the programme. Same secret key as the statistics.
async function subscribers(request, env, url) {
  const denied = await checkKey(request, env, url);
  if (denied) return denied;
  if (url.searchParams.get("format") === "json") {
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers").first();
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const week = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE created >= ?").bind(weekAgo).first();
    return json({ count: total ? total.n : 0, week: week ? week.n : 0 });
  }
  const { results } = await env.DB.prepare("SELECT email, lang, created FROM subscribers ORDER BY created").all();
  const lines = ["email,lang,created", ...results.map((r) => [r.email, r.lang, r.created].join(","))];
  return new Response(lines.join("\n") + "\n", {
    headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" },
  });
}

// Proposals from the unlisted page /participer (open mic, expos, workshops, karaoke). Free text, so lengths are capped.
const SCENE_DAILY_CAP = 10;
const SCENE_FIELDS = { kind: 120, whatsapp: 3, name: 80, phone: 40, link: 200, style: 120, format: 40, people: 10, about: 1000, needs: 500, dates: 300 };

async function scene(request, env, url) {
  if (!sameOrigin(request, url)) return new Response(null, { status: 403 });
  let body;
  try {
    const text = await request.text();
    if (text.length > 8000) return new Response(null, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (body.website) return new Response(null, { status: 204 });
  const clean = (v, max) => String(v == null ? "" : v).replace(/\r\n/g, "\n").trim().slice(0, max);
  const f = {};
  for (const [k, max] of Object.entries(SCENE_FIELDS)) f[k] = clean(body[k], max);
  const email = clean(body.email, 254).toLowerCase();
  if (f.whatsapp !== "oui") f.whatsapp = "";
  const lang = body.lang === "en" ? "en" : "fr";
  // A name, and a way to answer: an e-mail or a phone. WhatsApp needs the phone.
  if (!f.name || (!email && !f.phone) || (email && !EMAIL_OK.test(email)) || (f.whatsapp && !f.phone)) {
    return new Response(null, { status: 400 });
  }

  const db = env.DB;
  await setup(db);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const h = "scene:" + (await networkHash(request.headers.get("cf-connecting-ip")));
  const row = await db
    .prepare(
      "INSERT INTO abuse (h, day, c) VALUES (?, ?, 1) ON CONFLICT(h, day) DO UPDATE SET c = c + 1 RETURNING c"
    )
    .bind(h, day)
    .first();
  if (row && row.c > SCENE_DAILY_CAP) return new Response(null, { status: 429 });

  await db
    .prepare(
      "INSERT INTO artists (created, kind, whatsapp, lang, name, email, phone, link, style, format, people, about, needs, dates) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(now.toISOString(), f.kind, f.whatsapp, lang, f.name, email, f.phone, f.link, f.style, f.format, f.people, f.about, f.needs, f.dates)
    .run();
  return new Response(null, { status: 204 });
}

// One CSV cell: quoted, and a leading = + - @ is defused so a spreadsheet never runs it as a formula.
function cell(v) {
  let t = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return '"' + t.replace(/"/g, '""') + '"';
}

// The proposals, as a CSV for the spreadsheet. Same secret key as the statistics.
async function artists(request, env, url) {
  const denied = await checkKey(request, env, url);
  if (denied) return denied;
  const { results } = await env.DB.prepare("SELECT * FROM artists ORDER BY created").all();
  const cols = ["created", "kind", "whatsapp", "lang", "name", "email", "phone", "link", "style", "format", "people", "about", "needs", "dates"];
  const lines = [cols.join(","), ...results.map((r) => cols.map((c) => cell(r[c])).join(","))];
  return new Response("\ufeff" + lines.join("\n") + "\n", {
    headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/tally/hit" && request.method === "POST") return hit(request, env, url);
    if (url.pathname === "/tally/stats" && request.method === "GET") return stats(request, env, url);
    if (url.pathname === "/subscribe" && request.method === "POST") return subscribe(request, env, url);
    if (url.pathname === "/subscribers" && request.method === "GET") return subscribers(request, env, url);
    if (url.pathname === "/scene" && request.method === "POST") return scene(request, env, url);
    if (url.pathname === "/scene-list" && request.method === "GET") return artists(request, env, url);
    return new Response("Not found", { status: 404 });
  },
};
