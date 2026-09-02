// api/geocode.js — Vercel serverless function
// Proxies the Geocoding API for both directions: ?address=... (forward,
// used by background.js to geocode an event's location for weather) and
// ?latlng=lat,lng (reverse, used by options.js to turn a detected location
// into a readable address). MAPS_API_KEY never reaches the browser.
const { enforce } = require("./_shared");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!enforce(req, res, "geocode")) return;

  if (!process.env.MAPS_API_KEY) {
    res.status(500).json({ error: "Server misconfigured: MAPS_API_KEY is not set.", status: "UNKNOWN_ERROR" });
    return;
  }

  const { address, latlng } = req.query;
  if (!address && !latlng) {
    res.status(400).json({ error: 'Provide either "address" or "latlng".' });
    return;
  }

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  if (address) url.searchParams.set("address", address);
  if (latlng) url.searchParams.set("latlng", latlng);
  url.searchParams.set("key", process.env.MAPS_API_KEY);

  try {
    const upstream = await fetch(url);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (error) {
    res.status(502).json({ error: error.message, status: "UNKNOWN_ERROR" });
  }
};
