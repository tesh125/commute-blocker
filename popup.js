// popup.js — Commute Blocker popup UI

const statusEl = document.getElementById("status");
const connectedEl = document.getElementById("connectedAccount");
const connectBtn = document.getElementById("connect");
const runNowBtn = document.getElementById("runNow");
const openOptionsBtn = document.getElementById("openOptions");

function renderStatus({ lastStatus, lastStatusIsError }) {
  if (!lastStatus) {
    statusEl.textContent = "No checks run yet.";
    statusEl.classList.remove("error");
    return;
  }
  statusEl.textContent = lastStatus;
  statusEl.classList.toggle("error", !!lastStatusIsError);
}

async function refreshStatus() {
  const stored = await chrome.storage.local.get({
    lastStatus: "",
    lastStatusIsError: false,
  });
  renderStatus(stored);
}

// Checks for an existing (non-interactive) auth token to reflect connection
// state, and — if connected — fetches the account email just to display it.
async function refreshConnection() {
  const token = await new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (t) => {
      resolve(chrome.runtime.lastError ? null : t);
    });
  });

  if (!token) {
    connectBtn.textContent = "Connect Google Calendar";
    connectedEl.style.display = "none";
    return;
  }

  connectBtn.textContent = "Reconnect Google Calendar";
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const info = await res.json();
      connectedEl.textContent = `Connected as ${info.email}`;
      connectedEl.style.display = "block";
    }
  } catch {
    // Non-fatal — the connect button label already reflects connection state.
  }
}

connectBtn.addEventListener("click", () => {
  chrome.identity.getAuthToken({ interactive: true }, (token) => {
    if (chrome.runtime.lastError || !token) {
      statusEl.textContent = `Connection failed: ${chrome.runtime.lastError?.message || "unknown error"}`;
      statusEl.classList.add("error");
      return;
    }
    refreshConnection();
    statusEl.textContent = 'Connected. Click "Check now" to run a scan.';
    statusEl.classList.remove("error");
  });
});

runNowBtn.addEventListener("click", () => {
  statusEl.textContent = "Checking…";
  statusEl.classList.remove("error");
  chrome.runtime.sendMessage({ type: "RUN_NOW" }, (res) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = `Error: ${chrome.runtime.lastError.message}`;
      statusEl.classList.add("error");
      return;
    }
    if (res && !res.ok) {
      statusEl.textContent = `Error: ${res.error}`;
      statusEl.classList.add("error");
      return;
    }
    refreshStatus();
  });
});

openOptionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refreshConnection();
refreshStatus();
