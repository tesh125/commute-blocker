// api/routes.js — Vercel serverless function
// Proxies the Routes API's computeRoutes so MAPS_API_KEY never reaches the
// browser. background.js posts the same body it used to send straight to
// Google — { origin, destination, travelMode, arrivalTime,
// computeAlternativeRoutes, transitPreferences } for transit, or
// { origin, destination, travelMode: "DRIVE", routingPreference } for
// driving — this just forwards it with the key attached server-side.
const { enforce } = require("./_shared");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!enforce(req, res, "routes")) return;

  if (!process.env.MAPS_API_KEY) {
    res.status(500).json({ error: "Server misconfigured: MAPS_API_KEY is not set." });
    return;
  }

  try {
    const upstream = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.MAPS_API_KEY,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.legs",
      },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
};
