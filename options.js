// Everything here lives in sync storage (fine to roam across your
// signed-in Chrome instances) except the per-install client ID, which is
// local-only (see getProxyHeaders() below) since it identifies this
// specific install to the proxy's rate limiter, not your Google account.
const SYNC_FIELDS = [
  "homeAddress",
  "bufferMinutes",
  "pollMinutes",
  "blockUntilHour",
  "targetCalendarId",
  "avoidKeywords",
  "priorityKeywords",
  "earlyOptionMinutes",
  "weatherLeadDays",
];
const CHECKBOX_FIELDS = ["weatherEnabled", "avoidTolls", "avoidHighways"]; // plain boolean checkboxes
const TRAVEL_MODES = ["BUS", "SUBWAY", "TRAIN", "LIGHT_RAIL", "RAIL"]; // transit vehicle-category checkboxes

// Same proxy background.js talks to — see PROXY_BASE_URL there for why, and
// keep the two in sync if you're pointing at your own deployment.
const PROXY_BASE_URL = "https://commute-blocker.vercel.app";

async function getProxyHeaders() {
  let { clientId } = await chrome.storage.local.get({ clientId: null });
  if (!clientId) {
    clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId });
  }
  return { "X-Client-Id": clientId };
}

// Shows/hides the transit-only vs. driving-only option groups based on
// which "Travel mode" radio is selected.
function updateTravelModeVisibility() {
  const isDrive = document.getElementById("travelMode_DRIVE").checked;
  document.getElementById("transitOptions").hidden = isDrive;
  document.getElementById("drivingOptions").hidden = !isDrive;
}
document.getElementById("travelMode_TRANSIT").addEventListener("change", updateTravelModeVisibility);
document.getElementById("travelMode_DRIVE").addEventListener("change", updateTravelModeVisibility);

// homeLat/homeLng aren't tied to a text input — they're set via the
// geolocation button below — so they're tracked separately from the visible
// address field, even though clicking the button fills that field too (with
// a reverse-geocoded label) for a human-readable confirmation of the result.
let homeLat = null;
let homeLng = null;

document.getElementById("useLocation").addEventListener("click", () => {
  const status = document.getElementById("locationStatus");
  const addressInput = document.getElementById("homeAddress");
  status.textContent = "Locating…";

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      homeLat = pos.coords.latitude;
      homeLng = pos.coords.longitude;

      // Reverse-geocode (through the proxy — see PROXY_BASE_URL above)
      // purely to fill the address field with something readable.
      // background.js still uses the coordinates directly for routing (see
      // homeOrigin in runCheck()) — this call doesn't affect accuracy, it's
      // just a label.
      try {
        const url = new URL(`${PROXY_BASE_URL}/api/geocode`);
        url.searchParams.set("latlng", `${homeLat},${homeLng}`);
        const res = await fetch(url, { headers: await getProxyHeaders() });
        const data = await res.json();
        const formatted = data.results?.[0]?.formatted_address;
        if (data.status === "OK" && formatted) {
          addressInput.value = formatted;
          status.textContent = "";
        } else {
          // The Geocoding API returns HTTP 200 even on failure, with the
          // real reason in data.status (e.g. REQUEST_DENIED, ZERO_RESULTS,
          // or OVER_QUERY_LIMIT if you've hit the proxy's hourly cap) — but
          // our own proxy also reports its own errors (e.g. a missing
          // MAPS_API_KEY on the server) as status "UNKNOWN_ERROR" with the
          // real reason in data.error, so surface that detail too instead
          // of just the status code.
          const detail = data.error_message || data.error;
          console.warn("Geocoding proxy error", data.status, detail);
          status.textContent = `Location detected, but couldn't resolve it to an address (${data.status || "unknown error"}${detail ? `: ${detail}` : ""}). It'll still be used for routing — or type an address below instead.`;
        }
      } catch {
        status.textContent = "Location detected, but the address lookup failed. It'll still be used for routing — or type an address below instead.";
      }
    },
    (err) => {
      // GeolocationPositionError codes: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT.
      // The raw err.message for code 2 ("Position update is unavailable") doesn't explain
      // *why* — usually OS-level Location Services being off, or no Wi-Fi radio for the
      // desktop location provider to use — so point at the fix instead of just echoing it.
      if (err.code === 2) {
        status.textContent =
          "Couldn't detect a location — check that Location Services is turned on for Chrome in your OS settings, or use the address field below instead.";
      } else if (err.code === 1) {
        status.textContent =
          "Location permission denied — allow it for this extension in Chrome, or use the address field below instead.";
      } else {
        status.textContent = `Couldn't get location: ${err.message}`;
      }
    },
    { enableHighAccuracy: false, timeout: 10000 }
  );
});

// Typing a manual address overrides a previously detected location, so the
// two never both apply at once — background.js only needs to check one.
// (Setting addressInput.value programmatically above doesn't fire this, so
// the coordinates survive the reverse-geocoded label being filled in.)
document.getElementById("homeAddress").addEventListener("input", () => {
  homeLat = null;
  homeLng = null;
});

function getAuthToken(interactive) {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive }, (t) => {
      resolve(chrome.runtime.lastError ? null : t);
    });
  });
}

// Reflects connection state on the Connect button + "Connected as ..." line.
// Shared by the initial (non-interactive) check and the Connect button's own
// (interactive) flow, so both paths keep the UI in sync the same way.
async function refreshConnectionUI(token) {
  const btn = document.getElementById("connectCalendar");
  const accountEl = document.getElementById("connectedAccount");

  if (!token) {
    btn.textContent = "Connect Google Calendar";
    accountEl.style.display = "none";
    accountEl.textContent = "";
    return;
  }

  btn.textContent = "Reconnect Google Calendar";
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const info = await res.json();
      accountEl.textContent = `Connected as ${info.email}`;
      accountEl.style.display = "inline";
    }
  } catch {
    // Non-fatal — the button label already reflects connection state.
  }
}

// Populates the "Calendar to add blocks to" dropdown with every calendar on
// the account (owned, shared, subscribed) — same call background.js makes —
// so you pick from a real list instead of having to type a name or ID.
async function loadCalendarOptions() {
  const hint = document.getElementById("calendarListHint");
  const select = document.getElementById("targetCalendarId");

  const token = await getAuthToken(false);
  await refreshConnectionUI(token);

  if (!token) {
    hint.textContent = "Connect above to see your calendars.";
    return;
  }

  try {
    let calendars = [];
    let pageToken;
    for (let page = 0; page < 5; page++) {
      const url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
      url.searchParams.set("maxResults", "250");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();

      for (const cal of data.items || []) {
        if (cal.deleted || cal.primary) continue; // primary already has its own option
        calendars.push(cal);
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }

    for (const cal of calendars) {
      const opt = document.createElement("option");
      opt.value = cal.id;
      opt.textContent = cal.summary;
      select.appendChild(opt);
    }
    hint.textContent = "Pick any calendar you own, one shared with you, or one you've subscribed to.";
  } catch (err) {
    hint.textContent = "Couldn't load your calendar list right now. You can still use \"Primary calendar\".";
  }
}

document.getElementById("connectCalendar").addEventListener("click", async () => {
  const hint = document.getElementById("calendarListHint");
  const select = document.getElementById("targetCalendarId");
  const previousSelection = select.value;

  hint.textContent = "Connecting…";
  const token = await getAuthToken(true);
  if (!token) {
    hint.textContent = "Connection failed — try again.";
    return;
  }

  // Reset to just the default option before repopulating, so reconnecting
  // doesn't duplicate entries an earlier connect already added.
  select.innerHTML = '<option value="primary">Primary calendar</option>';
  await loadCalendarOptions();
  if ([...select.options].some((o) => o.value === previousSelection)) {
    select.value = previousSelection;
  }
});

async function load() {
  // Populate the dropdown's options *before* setting its value from storage,
  // otherwise the saved selection has nothing to attach to yet.
  await loadCalendarOptions();

  const syncStored = await chrome.storage.sync.get({
    homeAddress: "",
    homeLat: null,
    homeLng: null,
    bufferMinutes: 5,
    pollMinutes: 15,
    blockUntilHour: 20,
    targetCalendarId: "primary",
    travelMode: "TRANSIT",
    avoidKeywords: "UP Express, Union Pearson",
    priorityKeywords: "",
    allowedTravelModes: [...TRAVEL_MODES], // all allowed by default
    earlyOptionMinutes: 20,
    weatherEnabled: true,
    weatherLeadDays: 2,
    avoidTolls: false,
    avoidHighways: false,
  });

  for (const key of SYNC_FIELDS) {
    document.getElementById(key).value = syncStored[key];
  }
  for (const key of CHECKBOX_FIELDS) {
    document.getElementById(key).checked = !!syncStored[key];
  }
  document.getElementById(
    syncStored.travelMode === "DRIVE" ? "travelMode_DRIVE" : "travelMode_TRANSIT"
  ).checked = true;
  updateTravelModeVisibility();
  for (const mode of TRAVEL_MODES) {
    document.getElementById(`mode_${mode}`).checked = syncStored.allowedTravelModes.includes(mode);
  }

  homeLat = syncStored.homeLat;
  homeLng = syncStored.homeLng;
}

async function save() {
  const syncValues = {};
  for (const key of SYNC_FIELDS) {
    const el = document.getElementById(key);
    syncValues[key] = el.type === "number" ? Number(el.value) : el.value.trim();
  }
  syncValues.homeLat = homeLat;
  syncValues.homeLng = homeLng;

  syncValues.travelMode = document.getElementById("travelMode_DRIVE").checked ? "DRIVE" : "TRANSIT";

  const checkedModes = TRAVEL_MODES.filter((mode) => document.getElementById(`mode_${mode}`).checked);
  // Treat "nothing checked" the same as "everything checked" — an empty
  // restriction isn't meaningful, and background.js already treats "all
  // modes selected" as "no restriction" too.
  syncValues.allowedTravelModes = checkedModes.length > 0 ? checkedModes : [...TRAVEL_MODES];

  for (const key of CHECKBOX_FIELDS) {
    syncValues[key] = document.getElementById(key).checked;
  }

  await chrome.storage.sync.set(syncValues);

  // Ask the background worker to reschedule the alarm in case pollMinutes changed.
  chrome.runtime.sendMessage({ type: "RESCHEDULE_ALARM" });

  const saved = document.getElementById("saved");
  saved.style.display = "block";
  setTimeout(() => (saved.style.display = "none"), 1500);
}

document.getElementById("save").addEventListener("click", save);

load();
