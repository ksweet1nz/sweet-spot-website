/* =============================================================
   SURVEY ACCESS LOG (Cloudflare Worker)
   Runs on surveys.sweetspotadvisory.com.au/_api/* in front of the
   survey bucket.

     POST /_api/view            { token }  viewer opened a survey link
     GET  /_api/dl/<token>/downloads/<file>  logs, then serves the file
     GET  /_api/log?token=      events, newest first   (admin key)
     GET  /_api/summary         totals per survey      (admin key)

   No raw IP addresses are stored: visitors are a short hash of IP +
   browser, salted per survey, so repeat visits group together.
   ============================================================= */

const TOKEN_RE = /^[A-Za-z0-9_-]{6,128}$/;
const SITE_ORIGIN = "https://sweetspotadvisory.com.au";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/_api\//, "");

    try {
      if (path === "view") return await view(request, env, ctx);
      if (path.startsWith("dl/")) return await download(request, env, ctx, path.slice(3));
      if (path === "log" || path === "summary") {
        if (!authorised(request, env)) return json({ error: "Not allowed" }, 403);
        return path === "log" ? await log(url, env) : await summary(env);
      }
    } catch (err) {
      console.error(err);
      return json({ error: "Server error" }, 500);
    }
    return json({ error: "Not found" }, 404);
  }
};

// ---------- Public endpoints ----------

async function view(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  let token = "";
  try { token = JSON.parse(await request.text()).token || ""; } catch (e) {}
  // Only log links that exist, so random requests can't fill the table.
  if (TOKEN_RE.test(token) && await env.SURVEYS.head(token + "/project.json")) {
    ctx.waitUntil(record(env, request, token, "view", null));
  }
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": SITE_ORIGIN } });
}

async function download(request, env, ctx, rest) {
  const slash = rest.indexOf("/");
  const token = rest.slice(0, slash);
  const file = rest.slice(slash + 1);
  if (slash < 0 || !TOKEN_RE.test(token) || !/^downloads\/[^/]+$/.test(file)) {
    return json({ error: "Not found" }, 404);
  }

  const object = await env.SURVEYS.get(token + "/" + file, { range: request.headers, onlyIf: request.headers });
  if (!object) return json({ error: "Not found" }, 404);

  // A resumed download asks for a later range; only count the first request.
  const range = object.range;
  if (!range || !range.offset) ctx.waitUntil(record(env, request, token, "download", file));

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Disposition", 'attachment; filename="' + await downloadName(env, token, file) + '"');
  if (!object.body) return new Response(null, { status: 304, headers });

  // R2 reports a range even for whole-file reads; only answer 206 when one was asked for.
  if (range && request.headers.has("Range")) {
    const start = range.offset || 0;
    const end = range.length != null ? start + range.length - 1 : object.size - 1;
    headers.set("Content-Range", "bytes " + start + "-" + end + "/" + object.size);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { headers });
}

// "PTW survey - orthomosaic.jpg" rather than a bare "orthomosaic.jpg".
async function downloadName(env, token, file) {
  const base = file.split("/").pop();
  try {
    const p = await (await env.SURVEYS.get(token + "/project.json")).json();
    const title = (p.title || "").replace(/[^\w .()-]+/g, " ").replace(/\s+/g, " ").trim();
    return title ? title + " - " + base : base;
  } catch (e) {
    return base;
  }
}

// ---------- Admin endpoints ----------

function authorised(request, env) {
  const given = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const want = env.ADMIN_KEY || "";
  if (!want || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

async function log(url, env) {
  const token = url.searchParams.get("token") || "";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 500, 2000);
  const stmt = TOKEN_RE.test(token)
    ? env.DB.prepare("SELECT * FROM events WHERE token = ? ORDER BY id DESC LIMIT ?").bind(token, limit)
    : env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").bind(limit);
  return json({ events: (await stmt.all()).results });
}

async function summary(env) {
  const rows = (await env.DB.prepare(
    "SELECT token, SUM(event = 'view') AS views, SUM(event = 'download') AS downloads, " +
    "COUNT(DISTINCT visitor) AS visitors, MAX(ts) AS last FROM events GROUP BY token"
  ).all()).results;
  return json({ surveys: rows });
}

// ---------- Helpers ----------

async function record(env, request, token, event, file) {
  const cf = request.cf || {};
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";
  await env.DB.prepare(
    "INSERT INTO events (ts, token, event, file, visitor, country, region, city, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(new Date().toISOString(), token, event, file, await visitorId(token, ip, ua),
         cf.country || null, cf.region || null, cf.city || null, device(ua)).run();
}

async function visitorId(token, ip, ua) {
  const data = new TextEncoder().encode(token + "|" + ip + "|" + ua);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(hash.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
}

function device(ua) {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Other";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari" : /curl|wget|python|bot|spider/i.test(ua) ? "Script or bot" : "Other";
  return os + " · " + browser;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
