# Commute Blocker

A Chrome extension that scans your Google Calendar for events with a location and
automatically adds a "Commute" block on your calendar before each one — sized to the
actual transit time (via the Google Routes API), with an optional early-departure
alternative and a weather forecast added a couple of days out. It also blocks the rest
of the evening after an in-person event, so your calendar reflects reality instead of
looking wide open right after you get home.

## How the two secrets are handled

There are two different credentials involved, and they're handled two different ways:

- **Google Calendar access (OAuth)** is tied 1:1 to your specific installed copy of the
  extension — Chrome assigns your install a unique extension ID, and Google's OAuth
  client has to be registered against that exact ID. There's no way around each person
  creating their own OAuth client for their own install; see setup below.
- **Maps API access (Routes, Geocoding, Weather)** goes through a small serverless
  proxy (`api/*.js`, meant for Vercel) instead of hitting Google directly from the
  browser. The Maps API key lives only as a server-side environment variable on
  whoever deployed the proxy — it's never in this repo, never shipped to the
  extension, and never visible to anyone using it. This is what makes it possible for
  people to use a shared deployment instead of each generating their own Maps key.

If you're just installing this to use someone else's already-deployed proxy, you can
skip the whole "Google Cloud project for Maps" step entirely — see below.

## Setup (using a shared proxy someone else deployed)

### 1. Load the extension

1. Clone or download this repo.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Note the **extension ID** Chrome assigns it (shown on the card) — you'll need it
   in step 2.

### 2. OAuth client (for calendar access — this part can't be shared)

1. Go to the [Google Cloud Console](https://console.cloud.google.com/), create a
   project (or reuse one).
2. **APIs & Services → OAuth consent screen**: fill in the basic app info. Keep it in
   **Testing** mode and add your own Google account under **Test users**.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Chrome Extension**.
   - Item ID: the extension ID from step 1.
4. Copy the generated **Client ID** and paste it into `manifest.json`, replacing
   `YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com` on the `oauth2.client_id` line.
5. Go back to `chrome://extensions` and click the reload icon on the extension card.

### 3. Proxy access

This repo is already wired to a live shared proxy
(`https://commute-blocker-proxy.vercel.app`, set as `PROXY_BASE_URL` in both
`background.js` and `options.js`, and in `manifest.json`'s `host_permissions`) — no
Maps API key setup needed, nothing to change here for the default case.

If you were given an access code for it, open Settings → **Shared proxy access** and
paste it in — otherwise leave that field blank. If you'd rather point at a different
proxy (your own, or someone else's), replace `PROXY_BASE_URL` in both files and the
matching entry in `manifest.json`'s `host_permissions`, then reload the extension.

### 4. Set your home location and connect

Settings has two ways to set where transit times are calculated from:

- **Use my current location** — uses your browser's built-in geolocation, free and
  with no key involved. Chrome prompts for permission the first time.
- **Type an address** — useful if you're configuring this from somewhere other than
  home. Typing here clears any detected location.

Then click the extension icon → **Connect Google Calendar** → grant access. Click
**Check now** to run an immediate scan, or just wait — it checks automatically every
15 minutes (configurable in Settings) and also re-checks whenever a Google Calendar
tab finishes loading.

## Deploying your own proxy instead

If you'd rather not depend on someone else's deployment (or you're the one setting
this up for others):

1. Enable **Routes API**, **Geocoding API**, and **Weather API** in a Google Cloud
   project, and create a Maps API key. It doesn't need any HTTP referrer restriction
   this time — it's only ever called from your server, never from a browser — but do
   restrict it to just those three APIs.
2. Push this repo to GitHub (already done if you're reading this from one), then
   import it in [Vercel](https://vercel.com) (New Project → import the repo).
3. In the Vercel project's **Environment Variables**, set:
   - `MAPS_API_KEY` — the key from step 1. Required.
   - `HOURLY_REQUEST_CAP` — optional, max requests per hour per person per endpoint.
     Defaults to 60.
   - `PROXY_ACCESS_CODE` — optional. If set, only requests carrying a matching
     `X-Access-Code` header are served. Share this value with people out-of-band
     (text, not GitHub) if you want to gate who can use your deployment; leave it
     unset to run it open.
4. Deploy. Vercel auto-detects the functions in `api/` — no build config needed.
5. Update `PROXY_BASE_URL` in `background.js` and `options.js`, and
   `host_permissions` in `manifest.json`, to your new `https://<project>.vercel.app`
   URL, then follow the setup steps above.

For local testing: `npm install`, copy `.env.example` to `.env` and fill in
`MAPS_API_KEY`, then `npm run dev` (runs `vercel dev`).

### Why the rate cap, and its limit

The cap is per-person (each install generates its own random client ID, stored
locally, sent as a header) so one misbehaving install can't eat the whole hour's
budget for everyone else on the same deployment. It's enforced in memory inside the
serverless function, which is good enough to catch a stuck retry loop or a bug — it
is **not** a hard guarantee against deliberate abuse, since a new serverless instance
(e.g. after a cold start) starts its own counter from zero. Combine it with an access
code if you're sharing the deployment with people you trust but still want a floor
against a leaked URL being hit directly.

## Settings reference

| Setting | What it does |
|---|---|
| Home location | Origin for every transit calculation — detected via geolocation or typed as an address. |
| Shared proxy access code | Only needed if the person who deployed the proxy gave you one. Local-only, never synced. |
| Extra buffer (min) | Padding added on top of the raw transit estimate. |
| Check every (min) | How often the background poll runs (minimum 5). |
| Block the evening until | After an in-person event, blocks your calendar until this hour so the evening doesn't look free. |
| Calendar to add blocks to | Which calendar receives the generated blocks — defaults to your primary one. |
| Transit types to allow | Broad category filter (bus/subway/train/light rail/rail) from the Routes API. |
| Avoid / prioritize transit lines | Free-text keyword matching against each route's line/agency name, for finer control than the category filter gives you. |
| "Earlier" option | Adds a second itinerary targeting an earlier arrival, shown alongside the on-time one. |
| Weather forecast | Adds a forecast for the event's location a configurable number of days out. |

## Project structure

```
manifest.json    Extension manifest (permissions, OAuth client, proxy host)
background.js    Service worker — polling, Calendar API, calls to the proxy
popup.html/js    Toolbar popup — connect, run now, status
options.html/js  Settings page — all configuration
api/routes.js    Proxies Routes API (transit ETAs)
api/geocode.js   Proxies Geocoding API (forward + reverse)
api/weather.js   Proxies Weather API (forecast)
api/_shared.js   Rate limiting + optional access-code check, shared by the above
```

## License

MIT — see [LICENSE](LICENSE).
