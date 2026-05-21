// Popup UI logic. Niente framework — vanilla JS + chrome.storage + sendMessage
// al service worker.
//
// i18n: globalThis.PegasusI18n.t(key, replacements) — caricato da lib/i18n.js
// PRIMA di questo modulo (vedi popup.html). Default locale: IT (mercato primario),
// EN per tutto il resto.

import { storage } from "../lib/storage.js";
import { COUNTRIES } from "../lib/countries.js";

const i18n = globalThis.PegasusI18n;
const t = (key, repl) => i18n.t(key, repl);

const els = {
  viewSetup: document.getElementById("viewSetup"),
  viewMain: document.getElementById("viewMain"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  serverSelect: document.getElementById("serverSelect"),
  btnSaveApiKey: document.getElementById("btnSaveApiKey"),
  setupError: document.getElementById("setupError"),
  openApiKeysLink: document.getElementById("openApiKeysLink"),

  keywordInput: document.getElementById("keywordInput"),
  countrySelect: document.getElementById("countrySelect"),
  limitSelect: document.getElementById("limitSelect"),
  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),

  scanStatus: document.getElementById("scanStatus"),
  metricAds: document.getElementById("metricAds"),
  metricStores: document.getElementById("metricStores"),
  metricSent: document.getElementById("metricSent"),
  scanLog: document.getElementById("scanLog"),

  statusDot: document.getElementById("statusDot"),
  statusLabel: document.getElementById("statusLabel"),

  openDashboard: document.getElementById("openDashboard"),
  resetApiKey: document.getElementById("resetApiKey"),
};

// === init ===
async function init() {
  // Bootstrap i18n: popola tutti i nodi [data-i18n] prima di mostrare la view.
  // Manifest V3-safe: applyToDom usa textContent, mai innerHTML.
  i18n.applyToDom(document);
  populateCountries();
  const apiKey = await storage.getApiKey();
  if (!apiKey) {
    showSetup();
  } else {
    await showMain();
  }
}

function populateCountries() {
  els.countrySelect.innerHTML = "";
  for (const c of COUNTRIES) {
    const opt = document.createElement("option");
    opt.value = c.code;
    opt.textContent = c.name;
    els.countrySelect.appendChild(opt);
  }
}

function showSetup() {
  els.viewSetup.hidden = false;
  els.viewMain.hidden = true;
}

async function showMain() {
  els.viewSetup.hidden = true;
  els.viewMain.hidden = false;
  const prefs = await storage.getPrefs();
  els.keywordInput.value = prefs.keyword || "";
  els.countrySelect.value = prefs.country || "IT";
  els.limitSelect.value = String(prefs.limit || 150);
  await refreshState();
}

function setStatus(dotClass, label) {
  els.statusDot.className = "status-dot " + (dotClass || "");
  els.statusLabel.textContent = label;
}

function pushLog(level, msg) {
  const line = document.createElement("div");
  line.className = "log-line " + (level === "err" ? "err" : level === "ok" ? "ok" : "");
  line.textContent = `· ${msg}`;
  els.scanLog.appendChild(line);
  els.scanLog.scrollTop = els.scanLog.scrollHeight;
  // tieni solo le ultime 100 righe
  while (els.scanLog.childElementCount > 100) {
    els.scanLog.removeChild(els.scanLog.firstChild);
  }
}

function renderState(state) {
  els.metricAds.textContent = state.totalAds ?? 0;
  els.metricStores.textContent = state.totalStores ?? 0;
  els.metricSent.textContent = state.sentItems ?? 0;

  const isRunning =
    state.status === "scanning" ||
    state.status === "waiting_cs" ||
    state.status === "opening_tab" ||
    state.status === "finalizing";

  els.btnStart.hidden = isRunning;
  els.btnStop.hidden = !isRunning;
  els.scanStatus.hidden = state.status === "idle";

  if (isRunning) {
    setStatus(
      "running",
      state.status === "scanning" ? t("popup.status.scanning") : t("popup.status.starting"),
    );
  } else if (state.status === "completed") {
    setStatus("ok", t("popup.status.completed"));
  } else if (state.status === "error") {
    setStatus("err", t("popup.status.error"));
    if (state.lastError) pushLog("err", state.lastError);
  } else {
    setStatus("", t("popup.status.idle"));
  }
}

async function refreshState() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "PEGASUS_POPUP_STATE" });
    if (res?.state) renderState(res.state);
  } catch (e) {
    // service worker freddo o non disponibile — ricarica al prossimo tick
  }
}

// === handlers ===
els.btnSaveApiKey.addEventListener("click", async () => {
  els.setupError.hidden = true;
  const raw = els.apiKeyInput.value.trim();
  const server = els.serverSelect.value;
  if (!raw || !raw.startsWith("wsk_")) {
    els.setupError.textContent = t("popup.err.keyInvalid");
    els.setupError.hidden = false;
    return;
  }
  try {
    await storage.setApiKey(raw);
    await storage.setServer(server);
    // Verifica chiave contro il server
    const pingRes = await chrome.runtime.sendMessage({ type: "PEGASUS_POPUP_PING_API" });
    if (!pingRes?.ok) {
      els.setupError.textContent = pingRes?.error || t("popup.err.serverUnreach");
      els.setupError.hidden = false;
      await storage.clearApiKey();
      return;
    }
    await showMain();
  } catch (e) {
    els.setupError.textContent = e?.message ?? String(e);
    els.setupError.hidden = false;
  }
});

// The user-facing dashboard lives at https://pegasushunter.com/app/...
// while the API server is at https://api.pegasushunter.com. Strip the
// `api.` prefix so opening the dashboard from the popup lands the user
// on the right host. For localhost (dev), point straight to the web app
// on port 3000.
function frontendBaseFor(server) {
  if (!server) return "https://pegasushunter.com";
  if (server.startsWith("http://localhost")) return "http://localhost:3000";
  return server.replace(/^https?:\/\/api\./, "https://").replace(/\/$/, "");
}

els.openApiKeysLink.addEventListener("click", async (e) => {
  e.preventDefault();
  const server = await storage.getServer();
  chrome.tabs.create({ url: `${frontendBaseFor(server)}/app/api-keys` });
});

els.openDashboard.addEventListener("click", async (e) => {
  e.preventDefault();
  const server = await storage.getServer();
  chrome.tabs.create({ url: `${frontendBaseFor(server)}/app/scanner` });
});

els.resetApiKey.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!confirm(t("popup.confirm.resetKey"))) return;
  await storage.clearApiKey();
  showSetup();
});

els.btnStart.addEventListener("click", async () => {
  const keyword = els.keywordInput.value.trim();
  const country = els.countrySelect.value;
  const limit = Number(els.limitSelect.value);

  if (!keyword) {
    pushLog("err", t("popup.err.keyMissing"));
    return;
  }
  await storage.setPrefs({ keyword, country, limit });
  els.scanLog.innerHTML = "";
  pushLog("", t("popup.log.startScan", { kw: keyword, country }));

  const res = await chrome.runtime.sendMessage({
    type: "PEGASUS_POPUP_START",
    payload: { keyword, country, limit },
  });
  if (!res?.ok) {
    pushLog("err", res?.error ?? t("popup.err.startFailed"));
  }
});

els.btnStop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "PEGASUS_POPUP_STOP" });
  pushLog("", t("popup.log.stopRequested"));
});

// Ascolta stati push dal service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "PEGASUS_STATE" && msg.state) {
    renderState(msg.state);
  } else if (msg?.type === "PEGASUS_LOG") {
    pushLog(msg.level, msg.msg);
  }
});

init();
