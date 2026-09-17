// api/_shared.js — helpers shared by the proxy functions below.
// Filename starts with "_" so Vercel doesn't turn it into its own route.

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_HOURLY_CAP = 60;

// In-memory, per warm serverless instance — not a hard distributed
// guarantee (a cold start or a second concurrent instance gets its own
// counter). Good enough to catch a runaway loop or a misbehaving client at
// this project's scale; it isn't meant to police deliberate abuse from
// many different instances at once.
const buckets = new Map(); // key -> { count, windowStart }

function checkRateLimit(key, limit) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    buckets.set(key, bucket);
  }
  bucket.count++;
  return {
    allowed: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.windowStart + WINDOW_MS,
  };
}

// Identifies the caller for rate-limiting purposes: prefers the extension's
// self-generated per-install client ID (see getClientId() in background.js
// / options.js), falling back to the request's IP so even an old/stripped
// client still gets *some* limit applied.
function getClientId(req) {
  const header = req.headers["x-client-id"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return "unknown";
}

// Applies the per-client cap and (if configured) a combined-across-everyone
// global cap, writing rate-limit headers either way. Returns true if the
// caller should proceed; on false it has already sent the 429 response.
//
// The per-client cap (HOURLY_REQUEST_CAP, default 60/hr) stops one
// misbehaving install from eating the budget, but it doesn't cap total
// spend: with a public Chrome Web Store listing, every new install adds
// another 60/hr bucket, and the Maps API key's Google Cloud bill is on
// whoever deployed the proxy. GLOBAL_HOURLY_CAP is a second, unkeyed bucket
// shared by every caller of a given route, meant as a blunt ceiling on
// total requests/hour (and therefore roughly on cost) regardless of how
// many people are using the deployment. It's optional and unset by
// default — for a private/friends deployment the per-client cap alone is
// usually enough; set it once the proxy is behind a public listing. Same
// in-memory caveat as the per-client cap: pair it with a budget alert in
// Google Cloud Console (Billing -> Budgets & alerts) as the real backstop,
// since a cold start resets this counter to zero.
function enforce(req, res, routeName) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const perClientLimit = Number(process.env.HOURLY_REQUEST_CAP) || DEFAULT_HOURLY_CAP;
  const { allowed, limit, remaining, resetAt } = checkRateLimit(
    `${routeName}:${getClientId(req)}`,
    perClientLimit
  );
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  if (!allowed) {
    res.status(429).json({ error: "Hourly request cap reached — try again later.", resetAt });
    return false;
  }

  const globalLimit = Number(process.env.GLOBAL_HOURLY_CAP);
  if (globalLimit > 0) {
    const global = checkRateLimit(`global:${routeName}`, globalLimit);
    if (!global.allowed) {
      res
        .status(429)
        .json({ error: "This shared deployment has hit its overall hourly cap — try again later.", resetAt: global.resetAt });
      return false;
    }
  }

  return true;
}

module.exports = { enforce };
