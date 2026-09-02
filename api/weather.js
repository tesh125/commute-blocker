// api/weather.js — Vercel serverless function
// Proxies the Weather API's forecast/days:lookup so MAPS_API_KEY never
// reaches the browser. background.js calls this with ?lat=&lng=&days=.
const { enforce } = require("./_shared");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!enforce(req, res, "weather")) return;

  if (!process.env.MAPS_API_KEY) {
    res.status(500).json({ error: "Server misconfigured: MAPS_API_KEY is not set." });
    return;
  }

  const { lat, lng, days } = req.query;
  if (!lat || !lng) {
    res.status(400).json({ error: 'Provide "lat" and "lng".' });
    return;
  }

  const url = new URL("https://weather.googleapis.com/v1/forecast/days:lookup");
  url.searchParams.set("location.latitude", lat);
  url.searchParams.set("location.longitude", lng);
  url.searchParams.set("days", days || "10");
  url.searchParams.set("key", process.env.MAPS_API_KEY);

  try {
    const upstream = await fetch(url);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
};
