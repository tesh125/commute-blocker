// background.js — Commute Blocker service worker
//
// Flow:
//  1. Every POLL_ALARM fires (every pollMinutes, default 15), we look ahead
//     LOOKAHEAD_DAYS across every calendar on the account — owned, shared
//     with you, and subscribed — not just the primary one. This window
//     covers a full month, so newly added events anywhere in the next 30
//     days get picked up on the very next poll after they're created, not
//     just when they get close.
//  2. For each timed event that has a `location` and hasn't already been
//     processed, we ask the Routes API for a transit or driving ETA (per
//     the "Travel mode" setting) from the user's home address, arriving by
//     the event's start time — plus, for transit, a second Routes API call
//     targeting an earlier arrival, so the block's description can show
//     both an "earlier" and "on-time" itinerary. Driving doesn't support
//     targeting an arrival time, so only the on-time estimate applies.
//  3. We create a "Commute" event ending at the event's start time, tagged
//     with extendedProperties.private.sourceEventId so re-runs (including
//     re-scanning the same event on every poll) don't create duplicates.
//     Blocks are always created on a single TARGET calendar — your primary
//     one by default, or a specific calendar you pick from the dropdown in
//     Settings (stored as its calendar ID) — regardless of which calendar
//     the source event came from, since they represent your own
//     availability.
//  4. Once the event is within weatherLeadDays (default 2), we geocode its
//     location and fetch a forecast (Google Weather API), then patch it
//     onto the commute block's description exactly once, tagged with
//     extendedProperties.private.weatherAdded.

const ALARM_NAME = "commute-blocker-poll";
const DEFAULT_POLL_MINUTES = 15;
const LOOKAHEAD_DAYS = 30; // scan a full month ahead on every check
const DEFAULT_BUFFER_MINUTES = 5; // extra padding added to the commute block
const TAB_TRIGGER_DEBOUNCE_MS = 60 * 1000; // don't re-run more than once/min from tab activity
const DEFAULT_BLOCK_UNTIL_HOUR = 20; // 8pm — after an in-person event, block through this hour
const DEFAULT_EARLY_OPTION_MINUTES = 20; // how much earlier the "earlier option" itinerary targets
const DEFAULT_WEATHER_LEAD_DAYS = 2; // stamp the forecast onto the block this many days out

// Routes/Geocoding/Weather calls go through this proxy (see api/*.js)
// instead of hitting Google directly, so nobody running this extension
// needs their own Maps API key — the key lives server-side on whoever
// deployed the proxy. Running your own instead of a shared deployment?
// Replace this with your own Vercel URL (same value as in options.js).
const PROXY_BASE_URL = "https://commute-blocker.vercel.app";

let lastTabTriggerAt = 0;

// A stable per-install identifier so the proxy's hourly rate limit is
// per-person, not one shared bucket for everyone using the same deployment.
// Generated once and kept in local storage — never synced, unrelated to any
// Google account.
async function getProxyHeaders() {
  let { clientId } = await chrome.storage.local.get({ clientId: null });
  if (!clientId) {
    clientId = crypto.randomUUID();
    await chrome.storage.local.set({ clientId });
  }
  return { "X-Client-Id": clientId };
}

chrome.runtime.onInstalled.addListener(() => {
  setupAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runCheck().catch((err) => logStatus(`Error: ${err.message}`, true));
  }
});

// Second trigger: run a check whenever a Google Calendar tab finishes loading
// (opened fresh, or refreshed). This catches an event you just added in the
// browser almost immediately, instead of waiting for the next poll.
// Note: Calendar is a single-page app, so adding an event *without* reloading
// or navigating the tab won't fire this — the 15-min poll is the backstop
// for that case (and for events added from phone/other devices).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !tab.url.includes("calendar.google.com")) return;

  const now = Date.now();
  if (now - lastTabTriggerAt < TAB_TRIGGER_DEBOUNCE_MS) return;
  lastTabTriggerAt = now;

  runCheck().catch((err) => logStatus(`Error: ${err.message}`, true));
});

// Allow the popup to trigger a manual run and to (re)configure the alarm.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "RUN_NOW") {
    runCheck()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }
  if (msg?.type === "RESCHEDULE_ALARM") {
    setupAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function setupAlarm() {
  const { pollMinutes } = await chrome.storage.sync.get({
    pollMinutes: DEFAULT_POLL_MINUTES,
  });
  chrome.alarms.clear(ALARM_NAME, () => {
    chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: Math.max(5, Number(pollMinutes) || DEFAULT_POLL_MINUTES),
    });
  });
}

async function runCheck() {
  const settings = await chrome.storage.sync.get({
    homeAddress: "",
    homeLat: null,
    homeLng: null,
    bufferMinutes: DEFAULT_BUFFER_MINUTES,
    blockUntilHour: DEFAULT_BLOCK_UNTIL_HOUR,
    targetCalendarId: "primary", // chosen from the dropdown in Settings
    travelMode: DEFAULT_TRAVEL_MODE, // "TRANSIT" or "DRIVE" — Settings radio buttons
    allowedTravelModes: [...ALL_TRAVEL_MODES], // Settings mode checkboxes (transit only)
    avoidKeywords: DEFAULT_AVOID_KEYWORDS, // Settings "avoid" text field (transit only)
    priorityKeywords: "", // Settings "prioritize" text field (transit only)
    earlyOptionMinutes: DEFAULT_EARLY_OPTION_MINUTES, // Settings "earlier by" field (transit only)
    avoidTolls: false, // Settings driving checkbox
    avoidHighways: false, // Settings driving checkbox
    weatherEnabled: true,
    weatherLeadDays: DEFAULT_WEATHER_LEAD_DAYS,
  });
  const hasHomeLocation =
    !!settings.homeAddress || (settings.homeLat != null && settings.homeLng != null);
  if (!hasHomeLocation) {
    logStatus("Set your home location in Options first.", true);
    return;
  }
  // A detected location (set via the "Use my current location" button)
  // always takes precedence over a typed address — options.js keeps the two
  // mutually exclusive, but this order matters if that ever changes.
  const homeOrigin =
    settings.homeLat != null && settings.homeLng != null
      ? { location: { latLng: { latitude: settings.homeLat, longitude: settings.homeLng } } }
      : { address: settings.homeAddress };

  const token = await getAuthToken(false);
  const calendars = await listAllCalendars(token);

  const targetCalendarId = settings.targetCalendarId || "primary";
  // If a specific (non-primary) calendar was chosen but has since been
  // deleted/unshared, fail loudly instead of quietly erroring on insert.
  if (targetCalendarId !== "primary" && !calendars.some((c) => c.id === targetCalendarId)) {
    logStatus(
      "The calendar chosen in Settings for commute blocks no longer exists or isn't accessible — pick a new one in Settings.",
      true
    );
    return;
  }

  const events = await listUpcomingEvents(token, calendars);

  let created = 0;
  let transitFailures = 0; // events with a location where the Routes API call didn't return a route
  for (const event of events) {
    if (shouldSkip(event)) continue;

    // --- Pre-event commute block ---
    let beforeBlock = await findBlockEvent(token, targetCalendarId, event, "sourceEventId");
    if (!beforeBlock) {
      const eventStart = new Date(event.start.dateTime);
      const travelMode = settings.travelMode === "DRIVE" ? "DRIVE" : DEFAULT_TRAVEL_MODE;
      const onTimeTransit =
        travelMode === "DRIVE"
          ? await getDrivingInfo(homeOrigin, event.location, settings.avoidTolls, settings.avoidHighways)
          : await getTransitInfo(
              homeOrigin,
              event.location,
              event.start.dateTime,
              settings.allowedTravelModes,
              settings.avoidKeywords,
              settings.priorityKeywords
            );
      if (onTimeTransit == null) {
        transitFailures++;
      } else {
        const bufferSeconds = (Number(settings.bufferMinutes) || 0) * 60;
        const commuteStart = new Date(
          eventStart.getTime() - (onTimeTransit.durationSeconds + bufferSeconds) * 1000
        );

        // Second, earlier-target Routes API call so the description can
        // show a "leave earlier" alternative alongside the on-time one.
        // Driving doesn't support targeting an arrival time (only transit
        // does), so this is skipped entirely in DRIVE mode.
        let earlyTransit;
        let earlyArrivalDate;
        if (travelMode === "TRANSIT") {
          const earlyMinutes = Number(settings.earlyOptionMinutes) || DEFAULT_EARLY_OPTION_MINUTES;
          earlyArrivalDate = new Date(eventStart.getTime() - earlyMinutes * 60 * 1000);
          earlyTransit = await getTransitInfo(
            homeOrigin,
            event.location,
            earlyArrivalDate.toISOString(),
            settings.allowedTravelModes,
            settings.avoidKeywords,
            settings.priorityKeywords
          );
        }

        beforeBlock = await createCommuteEvent(
          token,
          targetCalendarId,
          event,
          commuteStart,
          eventStart,
          travelMode,
          onTimeTransit,
          earlyTransit,
          earlyArrivalDate
        );
        created++;
      }
    }

    // --- Weather forecast: stamped once, ~N days before the event, onto
    // the commute block created/found above (works whether it already
    // existed or was just created this run). ---
    if (settings.weatherEnabled && beforeBlock) {
      const alreadyStamped = beforeBlock.extendedProperties?.private?.weatherAdded === "true";
      if (!alreadyStamped) {
        const eventStart = new Date(event.start.dateTime);
        const daysUntil = (eventStart.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
        const leadDays = Number(settings.weatherLeadDays);
        const effectiveLeadDays = Number.isFinite(leadDays) ? leadDays : DEFAULT_WEATHER_LEAD_DAYS;
        if (daysUntil >= 0 && daysUntil <= effectiveLeadDays) {
          await addWeatherToBlock(token, targetCalendarId, beforeBlock, event, eventStart);
        }
      }
    }

    // --- Post-event evening block: keep the rest of the evening free ---
    if (event.end?.dateTime) {
      const afterBlock = await findBlockEvent(token, targetCalendarId, event, "afterEventId");
      if (!afterBlock) {
        const eventEnd = new Date(event.end.dateTime);
        const blockUntilHour = Number(settings.blockUntilHour);
        const blockUntil = new Date(eventEnd);
        blockUntil.setHours(
          Number.isFinite(blockUntilHour) ? blockUntilHour : DEFAULT_BLOCK_UNTIL_HOUR,
          0,
          0,
          0
        );

        if (blockUntil > eventEnd) {
          await createAfterEventBlock(
            token,
            targetCalendarId,
            event,
            eventEnd,
            blockUntil,
            settings.blockUntilHour
          );
          created++;
        }
      }
    }
  }

  const time = new Date().toLocaleTimeString();
  if (transitFailures > 0) {
    const createdPart = created > 0 ? `Created ${created} block(s), but transit` : "Transit";
    logStatus(
      `${createdPart} lookup failed for ${transitFailures} event(s) at ${time} — check your Maps API key and its restrictions (see the extension's service worker console for details).`,
      true
    );
  } else {
    logStatus(
      created > 0 ? `Created ${created} block(s) at ${time}` : `Checked at ${time} — nothing new`
    );
  }
}

// Matches video-call links/domains people commonly paste into the location
// field, so those don't get treated as an in-person, needs-a-commute event.
const VIRTUAL_LOCATION_PATTERN =
  /^https?:\/\/|zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com|whereby\.com|gotomeeting\.com|gotomeet\.me|skype\.com|meet\.jit\.si|chime\.aws|bluejeans\.com|ringcentral\.com/i;

function isVirtualLocation(event) {
  if (event.hangoutLink) return true; // Google Meet attached
  if (event.conferenceData) return true; // any video-conferencing attached
  if (event.location && VIRTUAL_LOCATION_PATTERN.test(event.location)) return true;
  return false;
}

function shouldSkip(event) {
  if (!event.location || !event.start?.dateTime) return true; // no location or all-day event
  if (isVirtualLocation(event)) return true; // Zoom/Meet/Teams/etc. — not an in-person event
  if (event.summary === "Commute") return true; // our own before-block
  if (event.summary && event.summary.startsWith("Blocked until")) return true; // our own after-block
  return false;
}

// Events can come from any calendar on the account now, and event IDs are
// only guaranteed unique *within* a calendar, so the idempotency tag we
// stamp on generated blocks includes the source calendar ID too.
function eventKey(event) {
  return `${event._calendarId || "primary"}::${event.id}`;
}

function formatHourLabel(hour) {
  const h24 = Number.isFinite(Number(hour)) ? Number(hour) : DEFAULT_BLOCK_UNTIL_HOUR;
  const period = h24 >= 12 ? "PM" : "AM";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}${period}`;
}

// --- Google auth ---------------------------------------------------------

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "No auth token"));
        return;
      }
      resolve(token);
    });
  });
}

// --- Calendar API ----------------------------------------------------------

// Every calendar visible on the account: calendars you own, ones shared with
// you, and ones you've subscribed to (e.g. a partner's or team calendar).
// Returns {id, summary} so callers can both scan by ID and resolve a
// Settings-provided calendar name to an ID.
async function listAllCalendars(token) {
  let calendars = [];
  let pageToken = undefined;

  for (let page = 0; page < 5; page++) {
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList"
    );
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Calendar list (calendarList) failed: ${res.status}`);
    const data = await res.json();

    for (const cal of data.items || []) {
      if (cal.deleted) continue;
      calendars.push({ id: cal.id, summary: cal.summary });
    }

    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return calendars;
}

async function listEventsForCalendar(token, calendarId, timeMin, timeMax) {
  let items = [];
  let pageToken = undefined;

  // A month of events can exceed a single page, so follow nextPageToken.
  // Capped at 10 pages (2500/page) as a sanity limit — plenty for a month.
  for (let page = 0; page < 10; page++) {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    );
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      // A single inaccessible/misbehaving calendar shouldn't kill the whole
      // check — skip it and keep going with the rest.
      console.warn(`Calendar events fetch failed for ${calendarId}: ${res.status}`);
      return items;
    }
    const data = await res.json();
    items = items.concat(data.items || []);

    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return items;
}

async function listUpcomingEvents(token, calendars) {
  const timeMin = new Date().toISOString();
  const timeMax = new Date(
    Date.now() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  let allEvents = [];
  for (const cal of calendars) {
    const events = await listEventsForCalendar(token, cal.id, timeMin, timeMax);
    for (const ev of events) {
      ev._calendarId = cal.id; // tag source calendar for the idempotency key
    }
    allEvents = allEvents.concat(events);
  }

  return allEvents;
}

// Search a 2-day window around the event for a block we already tagged with
// this event's ID under the given property key ("sourceEventId" for the
// pre-event commute block, "afterEventId" for the post-event evening block),
// so re-running the check is idempotent for each block type. Returns the
// actual event resource (so callers can patch it, e.g. to add weather) or
// null if none exists yet.
async function findBlockEvent(token, calendarId, sourceEvent, propertyKey) {
  const dayBefore = new Date(
    new Date(sourceEvent.start.dateTime).getTime() - 24 * 60 * 60 * 1000
  ).toISOString();
  const dayAfter = new Date(
    new Date(sourceEvent.start.dateTime).getTime() + 24 * 60 * 60 * 1000
  ).toISOString();

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  );
  url.searchParams.set("timeMin", dayBefore);
  url.searchParams.set("timeMax", dayAfter);
  url.searchParams.set("privateExtendedProperty", `${propertyKey}=${eventKey(sourceEvent)}`);
  url.searchParams.set("singleEvents", "true");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null; // fail open — worst case we retry later
  const data = await res.json();
  return (data.items || [])[0] || null;
}

function formatTimeLabel(date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Renders one itinerary option as a labeled block, ending with an explicit
// "Estimated arrival" line (the target time we asked the Routes API to hit,
// not a value parsed back out of the last step — simpler and just as
// accurate, since that target *is* what the route was computed against).
function formatItinerarySection(label, transit, arrivalDate) {
  const arrivalLabel = formatTimeLabel(arrivalDate);
  if (!transit) {
    return `${label}: not available`;
  }
  const body = transit.stepsSummary || "(no transit steps returned)";
  return `${label}:\n${body}\nEstimated arrival: ${arrivalLabel}`;
}

async function createCommuteEvent(
  token,
  calendarId,
  sourceEvent,
  start,
  end,
  travelMode,
  onTimeTransit,
  earlyTransit,
  earlyArrivalDate
) {
  const minutes = Math.round(onTimeTransit.durationSeconds / 60);
  const modeLabel = travelMode === "DRIVE" ? "Driving" : "Transit";
  const distanceDetail =
    travelMode === "DRIVE" && onTimeTransit.distanceMiles != null
      ? [`${onTimeTransit.distanceMiles} mi`, onTimeTransit.modifiersSummary].filter(Boolean).join(", ")
      : "";
  const distancePart = distanceDetail ? ` (${distanceDetail})` : "";
  const sections = [];
  if (earlyTransit !== undefined) {
    sections.push(formatItinerarySection("Earlier option", earlyTransit, earlyArrivalDate));
    sections.push(formatItinerarySection("On-time option", onTimeTransit, end));
  }
  const routeText = sections.length ? `\n\n${sections.join("\n\n")}` : "";

  const body = {
    summary: "Commute",
    description: `Auto-created by Commute Blocker.\n${modeLabel} time: ~${minutes} min${distancePart} to ${sourceEvent.location}${routeText}`,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: {
      private: { sourceEventId: eventKey(sourceEvent), createdBy: "commute-blocker" },
    },
    reminders: { useDefault: false },
    colorId: "8", // Graphite (grey) in Google Calendar's palette
  };

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Event insert failed: ${res.status} ${text}`);
  }
  return res.json(); // the created event resource, so callers have its id
}

async function createAfterEventBlock(token, calendarId, sourceEvent, start, end, blockUntilHour) {
  const label = formatHourLabel(blockUntilHour);
  const body = {
    summary: `Blocked until ${label} (after ${sourceEvent.summary || "event"})`,
    description: `Auto-created by Commute Blocker.\nKeeps the rest of the evening free after an in-person event.`,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: {
      private: { afterEventId: eventKey(sourceEvent), createdBy: "commute-blocker" },
    },
    reminders: { useDefault: false },
    colorId: "8", // Graphite (grey) — same as the pre-event commute block
  };

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Event insert failed: ${res.status} ${text}`);
  }
}

// --- Routes API (transit ETA + turn-by-turn steps) -------------------------
//
// We stick with the Routes API (computeRoutes) rather than the legacy
// Directions API: it's Google's actively-maintained replacement, it's the
// API you already enabled for this project, and — as long as the field
// mask asks for `routes.legs` — it returns the same step-by-step transit
// detail (which line, which stops, departure/arrival times) that Directions
// API used to be the only way to get.
//
// The API has two request-level levers, both configured from Settings:
//  - allowedTravelModes: a coarse filter on vehicle *category* (bus/subway/
//    train/rail/light rail) — not specific lines or operators.
//  - Everything finer (avoiding a specific line/operator, or preferring one
//    over another, e.g. GO Train over UP Express) has no API-level
//    equivalent, since both would just be "rail" to Google. So we ask for
//    alternative routes and score them ourselves in pickBestRoute(): filter
//    out any route matching the "avoid" keywords, then among what's left,
//    prefer the one that mentions a "prioritize" keyword earliest in your
//    ranked list, and use trip duration only as the final tiebreaker.
const ALL_TRAVEL_MODES = ["BUS", "SUBWAY", "TRAIN", "LIGHT_RAIL", "RAIL"];
const DEFAULT_AVOID_KEYWORDS = "UP Express, Union Pearson";
const DEFAULT_TRAVEL_MODE = "TRANSIT"; // Settings "Travel mode" radio — "TRANSIT" or "DRIVE"

async function getTransitInfo(
  origin,
  destinationAddress,
  arrivalTimeISO,
  allowedTravelModes,
  avoidKeywordsRaw,
  priorityKeywordsRaw
) {
  const transitPreferences = { routingPreference: "FEWER_TRANSFERS" };
  const modes = Array.isArray(allowedTravelModes) ? allowedTravelModes : ALL_TRAVEL_MODES;
  // Only send allowedTravelModes if it's an actual restriction — sending the
  // full set (or an empty set, which would mean "nothing allowed") is the
  // same as not restricting at all, so we just omit the field in both cases.
  if (modes.length > 0 && modes.length < ALL_TRAVEL_MODES.length) {
    transitPreferences.allowedTravelModes = modes;
  }

  const res = await fetch(`${PROXY_BASE_URL}/api/routes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await getProxyHeaders()),
    },
    body: JSON.stringify({
      origin,
      destination: { address: destinationAddress },
      travelMode: "TRANSIT",
      arrivalTime: arrivalTimeISO,
      computeAlternativeRoutes: true,
      transitPreferences,
    }),
  });

  if (!res.ok) {
    console.warn("Routes proxy error", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const routes = data.routes || [];
  if (routes.length === 0) return null;

  const avoidKeywords = parseKeywordList(avoidKeywordsRaw);
  const priorityKeywords = parseKeywordList(priorityKeywordsRaw);
  const route = pickBestRoute(routes, avoidKeywords, priorityKeywords);
  const durationStr = route?.duration; // e.g. "1834s"
  if (!durationStr) return null;

  return {
    durationSeconds: parseInt(durationStr.replace("s", ""), 10),
    stepsSummary: summarizeTransitSteps(route),
  };
}

// Driving equivalent of getTransitInfo(). The Routes API only supports
// targeting an *arrival* time for TRANSIT — DRIVE requests a departure time
// instead (defaulting to now), so this returns a live traffic-aware estimate
// of the drive rather than a prediction for the event's actual start time.
// That's a reasonable approximation for how long the drive takes; it just
// can't account for traffic patterns specific to that future time of day.
async function getDrivingInfo(origin, destinationAddress, avoidTolls, avoidHighways) {
  const routeModifiers = {};
  if (avoidTolls) routeModifiers.avoidTolls = true;
  if (avoidHighways) routeModifiers.avoidHighways = true;

  const body = {
    origin,
    destination: { address: destinationAddress },
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
  };
  if (Object.keys(routeModifiers).length > 0) body.routeModifiers = routeModifiers;

  const res = await fetch(`${PROXY_BASE_URL}/api/routes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await getProxyHeaders()),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.warn("Routes proxy error", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const route = (data.routes || [])[0];
  const durationStr = route?.duration; // e.g. "1834s"
  if (!durationStr) return null;

  return {
    durationSeconds: parseInt(durationStr.replace("s", ""), 10),
    stepsSummary: null, // turn-by-turn isn't shown for driving, just the summary line
    distanceMiles:
      typeof route.distanceMeters === "number"
        ? Math.round((route.distanceMeters / 1609.34) * 10) / 10
        : null,
    modifiersSummary: summarizeDrivingModifiers(avoidTolls, avoidHighways),
  };
}

// "avoiding tolls", "avoiding highways", "avoiding tolls and highways", or
// null if neither is set — folded into the commute block's summary line.
function summarizeDrivingModifiers(avoidTolls, avoidHighways) {
  const parts = [];
  if (avoidTolls) parts.push("tolls");
  if (avoidHighways) parts.push("highways");
  return parts.length ? `avoiding ${parts.join(" and ")}` : null;
}

// "UP Express, Union Pearson" -> ["UP Express", "Union Pearson"], order kept
// (order matters for priority keywords — first listed wins ties).
function parseKeywordList(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary wrapped so a short numeric route ("7") doesn't also match
// as a substring of a longer one ("107", "17", "70") — plain substring
// matching would otherwise make those indistinguishable.
function keywordPattern(keyword) {
  return `\\b${escapeRegExp(keyword)}\\b`;
}

function routeDurationSeconds(route) {
  return route.duration ? parseInt(route.duration.replace("s", ""), 10) : Infinity;
}

// All transit line/vehicle/agency names mentioned anywhere in a route —
// used both to check for avoided keywords and to score priority keywords.
function routeTransitNames(route) {
  const steps = (route.legs || []).flatMap((leg) => leg.steps || []);
  return steps.flatMap((step) => {
    const td = step.transitDetails;
    if (!td) return [];
    return [
      td.transitLine?.name,
      td.transitLine?.nameShort,
      ...(td.transitLine?.agencies || []).map((a) => a.name),
    ].filter(Boolean);
  });
}

function routeMatchesAnyKeyword(route, keywords) {
  if (keywords.length === 0) return false;
  const pattern = new RegExp(keywords.map(keywordPattern).join("|"), "i");
  return routeTransitNames(route).some((name) => pattern.test(name));
}

// Lower is better: index of the first (highest-ranked) priority keyword that
// appears anywhere in the route. Infinity if none of them match, so routes
// with no priority match sort after any route that has one.
function routePriorityScore(route, priorityKeywords) {
  if (priorityKeywords.length === 0) return 0; // no preference configured — all routes tie
  const names = routeTransitNames(route);
  let bestIndex = Infinity;
  priorityKeywords.forEach((keyword, index) => {
    if (index >= bestIndex) return;
    const pattern = new RegExp(keywordPattern(keyword), "i");
    if (names.some((name) => pattern.test(name))) bestIndex = index;
  });
  return bestIndex;
}

// Picks the best route: filters out anything matching an "avoid" keyword
// (falling back to the full set if every alternative is flagged), then among
// what's left, prefers earliest-ranked "prioritize" keyword match, then
// shortest duration as the final tiebreaker.
function pickBestRoute(routes, avoidKeywords, priorityKeywords) {
  const clean = routes.filter((r) => !routeMatchesAnyKeyword(r, avoidKeywords));
  const pool = clean.length > 0 ? clean : routes;

  return pool.reduce((best, r) => {
    const rScore = routePriorityScore(r, priorityKeywords);
    const bestScore = routePriorityScore(best, priorityKeywords);
    if (rScore !== bestScore) return rScore < bestScore ? r : best;
    return routeDurationSeconds(r) < routeDurationSeconds(best) ? r : best;
  });
}

// Turns a Routes API route into a readable, step-by-step itinerary, e.g.:
//   Walk ~4 min
//   5:12 PM Bus 42 -> Main St Station (5:34 PM)
//   Walk ~3 min
//
// Google's transit steps include every micro-segment of walking between
// platforms/exits (often rounding to 0 min each), which reads as noisy
// clutter if printed one-per-line. We merge consecutive walk/non-transit
// steps into a single combined "Walk ~X min" line, and drop the line
// entirely if the merged total still rounds to 0 min.
function summarizeTransitSteps(route) {
  const steps = (route?.legs || []).flatMap((leg) => leg.steps || []);
  if (steps.length === 0) return null;

  const lines = [];
  let walkAccumSeconds = 0;

  const flushWalk = () => {
    if (walkAccumSeconds > 0) {
      const mins = Math.round(walkAccumSeconds / 60);
      if (mins > 0) lines.push(`Walk ~${mins} min`);
    }
    walkAccumSeconds = 0;
  };

  for (const step of steps) {
    const stepSeconds = step.staticDuration
      ? parseInt(step.staticDuration.replace("s", ""), 10)
      : 0;

    if (step.travelMode === "TRANSIT" && step.transitDetails) {
      flushWalk();
      const td = step.transitDetails;
      const vehicle = td.transitLine?.vehicle?.name?.text || "Transit";
      const line = td.transitLine?.nameShort || td.transitLine?.name || "";
      const to = td.stopDetails?.arrivalStop?.name || "";
      const depTime = td.localizedValues?.departureTime?.time?.text;
      const arrTime = td.localizedValues?.arrivalTime?.time?.text;
      const depPrefix = depTime ? `${depTime} ` : "";
      const arrLabel = arrTime ? ` (${arrTime})` : "";
      // e.g. "4:05 PM Bus 11 -> Airport Rd South Of Derry Rd (4:20 PM)"
      lines.push(`${depPrefix}${vehicle} ${line} -> ${to}${arrLabel}`);
    } else {
      // WALK or any other non-transit connector step — accumulate instead
      // of printing each micro-segment separately.
      walkAccumSeconds += stepSeconds;
    }
  }
  flushWalk();

  return lines.length ? lines.join("\n") : null;
}

// --- Weather (Geocoding API + Weather API) ----------------------------------
//
// Fetches a forecast for the event's location and stamps it onto the
// already-created commute block's description via a PATCH, tagged with
// extendedProperties.private.weatherAdded so it only happens once per event
// (checked by the caller before calling this). Both calls go through the
// proxy: Geocoding turns the event's address into lat/lng, then Weather's
// forecast.days endpoint is queried for that location.
async function addWeatherToBlock(token, calendarId, block, sourceEvent, eventStart) {
  const geo = await geocodeAddress(sourceEvent.location);
  if (!geo) return;

  const forecastDays = await getDailyForecast(geo.lat, geo.lng);
  if (forecastDays.length === 0) return;

  // The API's array starts at "today" for the location and returns one
  // entry per day, so the day offset from now is a reasonable index —
  // exact enough for a lead time of a few days, without needing to convert
  // into the location's own timezone to match `displayDate` precisely.
  const daysAhead = Math.round((eventStart.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  const dayIndex = Math.max(0, Math.min(forecastDays.length - 1, daysAhead));
  const forecastDay = forecastDays[dayIndex];
  if (!forecastDay) return;

  const weatherLine = formatWeatherSummary(forecastDay);
  if (!weatherLine) return;

  const newDescription = `${block.description || ""}\n\nWeather:\n${weatherLine}`;
  const body = {
    description: newDescription,
    extendedProperties: {
      private: { ...(block.extendedProperties?.private || {}), weatherAdded: "true" },
    },
  };

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(block.id)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    console.warn(`Weather patch failed: ${res.status} ${await res.text()}`);
  }
}

async function geocodeAddress(address) {
  const url = new URL(`${PROXY_BASE_URL}/api/geocode`);
  url.searchParams.set("address", address);

  const res = await fetch(url, { headers: await getProxyHeaders() });
  if (!res.ok) {
    console.warn("Geocoding proxy error", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const loc = data.results?.[0]?.geometry?.location;
  if (!loc) return null;
  return { lat: loc.lat, lng: loc.lng };
}

async function getDailyForecast(lat, lng, days = 10) {
  const url = new URL(`${PROXY_BASE_URL}/api/weather`);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lng", String(lng));
  url.searchParams.set("days", String(days));

  const res = await fetch(url, { headers: await getProxyHeaders() });
  if (!res.ok) {
    console.warn("Weather proxy error", res.status, await res.text());
    return [];
  }
  const data = await res.json();
  return data.forecastDays || [];
}

// e.g. "Partly sunny, 2°C-13°C, 5% chance of rain"
function formatWeatherSummary(forecastDay) {
  const daytime = forecastDay.daytimeForecast;
  const condition = daytime?.weatherCondition?.description?.text;

  const maxT = forecastDay.maxTemperature?.degrees;
  const minT = forecastDay.minTemperature?.degrees;
  const unit = forecastDay.maxTemperature?.unit === "FAHRENHEIT" ? "°F" : "°C";
  const tempPart =
    minT != null && maxT != null ? `${Math.round(minT)}${unit}-${Math.round(maxT)}${unit}` : null;

  const precipPercent = daytime?.precipitation?.probability?.percent;
  const precipType = daytime?.precipitation?.probability?.type;
  const precipPart =
    precipPercent != null
      ? `${precipPercent}% chance of ${precipType ? precipType.toLowerCase() : "precipitation"}`
      : null;

  return [condition, tempPart, precipPart].filter(Boolean).join(", ") || null;
}

// --- status/logging for the popup -----------------------------------------

async function logStatus(message, isError = false) {
  await chrome.storage.local.set({
    lastStatus: message,
    lastStatusIsError: isError,
    lastRunAt: Date.now(),
  });
}
