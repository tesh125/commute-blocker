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

function checkRateLimit(key) {
  const limit = Number(process.env.HOURLY_REQUEST_CAP) || DEFAULT_HOURLY_CAP;
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

// Optional extra gate: if PROXY_ACCESS_CODE is set in Vercel's env vars,
// only requests carrying a matching X-Access-Code header are allowed. Share
// that code with people out-of-band (text, not GitHub) — unlike the Maps
// API key, it's cheap to rotate if it ever leaks: just change the env var.
// Leave PROXY_ACCESS_CODE unset to skip this check entirely.
function checkAccessCode(req) {
  const required = process.env.PROXY_ACCESS_CODE;
  if (!required) return true;
  return req.headers["x-access-code"] === required;
}

// Applies the access-code gate and rate limit together, and writes the
// rate-limit headers either way. Returns true if the caller should proceed;
// on false it has already sent the (401 or 429) response.
function enforce(req, res, routeName) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!checkAccessCode(req)) {
    res.status(401).json({ error: "Missing or invalid access code." });
    return false;
  }

  const { allowed, limit, remaining, resetAt } = checkRateLimit(`${routeName}:${getClientId(req)}`);
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  if (!allowed) {
    res.status(429).json({ error: "Hourly request cap reached — try again later.", resetAt });
    return false;
  }

  return true;
}

module.exports = { enforce };
