// Pegasus Scanner — service worker (background).
//
// Responsabilità:
//   1) Riceve START dal popup → apre tab FB Ads Library con URL keyword/paese.
//   2) Aspetta che il content script si annunci READY.
//   3) Invia START al content script.
//   4) Inoltra i batch dal content script all'API server (pegasushunter.com).
//   5) Propaga metrics/log al popup quando aperto.
//   6) Gestisce STOP / chiusura tab.
//   7) (v0.4.0) Badge dell'icona dell'estensione con contatore live.
//   8) (v0.7.0) Heartbeat ogni 30s + re-inject del CS se morto.
//   9) (v0.7.0) RESUME handshake per scan crashati.
//
// Tutto è async + state machine semplice. Lo stato vive in chrome.storage.local
// così sopravvive a sleep/wake del service worker.

import { storage } from "../lib/storage.js";
import { api } from "../lib/api-client.js";

const FB_BASE = "https://www.facebook.com/ads/library/";

// ── Badge helper (v0.4.0) ────────────────────────────────────────────────
// Pegasus brand green for the active-scan badge, red for the error badge.
// `chrome.action.setBadge*` is a no-op on browsers where the action API is
// missing (older Chromium derivatives) — guarded with optional chaining.
const BADGE_GREEN = "#22c55e";
const BADGE_RED = "#ef4444";

function setBadge(text, color = BADGE_GREEN) {
  try {
    chrome.action?.setBadgeText?.({ text });
    if (text) {
      chrome.action?.setBadgeBackgroundColor?.({ color });
    }
  } catch {
    // chrome.action surface unavailable (e.g. very old Chromium fork) — silent.
  }
}

function clearBadge() {
  setBadge("");
}

// Format a number for the small (~4-char) badge: 0..999 raw, then "1.2k", "3.4k",
// "12k", "99k", "999k", "1M+". Avoids overflow that would silently truncate.
function fmtBadge(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 10_000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (v < 1_000_000) return Math.round(v / 1000) + "k";
  return "1M+";
}

// Stato runtime in memoria (best effort; per persistenza vera vedi storage)
const RUNTIME = {
  scanTabId: null,
  scanId: null,
  keyword: "",
  country: "",
  limit: 0,
  totalAds: 0,
  totalStores: 0,
  sentItems: 0,
  status: "idle", // idle|opening_tab|waiting_cs|scanning|finalizing|completed|error
  lastError: null,
  startedAt: null,
  // v0.7.0 — heartbeat health
  lastHeartbeatAt: null,
  missedHeartbeats: 0,
  // v0.7.0 — metrics ricevute dal CS al PEGASUS_DONE (telemetria locale)
  lastMetrics: null,
};

// ── v0.7.0 — Heartbeat constants ────────────────────────────────────────
// Ogni 30s pinghiamo il CS via chrome.alarms (più affidabile di setInterval:
// sopravvive a sleep del service worker MV3). Se manca 2 ping consecutivi,
// dichiariamo il CS morto e tentiamo re-inject via chrome.scripting.
const HEARTBEAT_ALARM = "pegasus_cs_heartbeat";
const HEARTBEAT_PERIOD_MIN = 0.5; // minutes — chrome.alarms minimum is 0.5min in MV3
const HEARTBEAT_MAX_MISSED = 2;

async function persistRuntime() {
  await storage.setCurrentScan({
    scanId: RUNTIME.scanId,
    keyword: RUNTIME.keyword,
    country: RUNTIME.country,
    status: RUNTIME.status,
    scanTabId: RUNTIME.scanTabId,
    totalAds: RUNTIME.totalAds,
    totalStores: RUNTIME.totalStores,
    sentItems: RUNTIME.sentItems,
    lastError: RUNTIME.lastError,
    startedAt: RUNTIME.startedAt,
  });
}

async function broadcastToPopup(payload) {
  // sendMessage senza tabs è broadcast ai listener interni (popup)
  try {
    await chrome.runtime.sendMessage(payload);
  } catch {
    // Popup chiuso → ignora
  }
}

function buildFbAdsUrl(keyword, country) {
  const q = encodeURIComponent(keyword);
  const c = (country || "ALL").toUpperCase();
  return `${FB_BASE}?active_status=active&ad_type=all&country=${c}&q=${q}&search_type=keyword_unordered&media_type=all`;
}

async function waitForTabComplete(tabId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function poll() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return reject(new Error("Tab persa"));
        if (tab.status === "complete") return resolve(tab);
        if (Date.now() - start > timeoutMs) return reject(new Error("Timeout caricamento tab"));
        setTimeout(poll, 400);
      });
    }
    poll();
  });
}

async function startScan({ keyword, country, limit }) {
  if (RUNTIME.status !== "idle" && RUNTIME.status !== "completed" && RUNTIME.status !== "error") {
    throw new Error("Scansione già in corso");
  }
  if (!keyword || !keyword.trim()) throw new Error("Keyword obbligatoria");

  RUNTIME.scanId = null;
  RUNTIME.keyword = keyword.trim();
  RUNTIME.country = country || "ALL";
  RUNTIME.limit = Number(limit) || 0;
  RUNTIME.totalAds = 0;
  RUNTIME.totalStores = 0;
  RUNTIME.sentItems = 0;
  RUNTIME.lastError = null;
  RUNTIME.startedAt = Date.now();
  RUNTIME.status = "opening_tab";
  RUNTIME.lastHeartbeatAt = null;
  RUNTIME.missedHeartbeats = 0;
  RUNTIME.lastMetrics = null;
  await persistRuntime();
  broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
  // Show "..." while the FB tab is loading (before the first batch lands).
  setBadge("...", BADGE_GREEN);

  const url = buildFbAdsUrl(RUNTIME.keyword, RUNTIME.country);
  const tab = await chrome.tabs.create({ url, active: false });
  RUNTIME.scanTabId = tab.id;
  RUNTIME.status = "waiting_cs";
  await persistRuntime();

  try {
    await waitForTabComplete(tab.id);
  } catch (e) {
    RUNTIME.status = "error";
    RUNTIME.lastError = e?.message ?? String(e);
    await persistRuntime();
    broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
    setBadge("!", BADGE_RED);
    return;
  }

  // Diamo qualche secondo al content script per montarsi (richiesto da FB lazy load)
  await new Promise((r) => setTimeout(r, 2500));

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "PEGASUS_START",
      scanId: RUNTIME.scanId,
      keyword: RUNTIME.keyword,
      country: RUNTIME.country,
      limit: RUNTIME.limit,
    });
    if (!resp?.ok) throw new Error(resp?.error ?? "Avvio content script fallito");
    RUNTIME.status = "scanning";
    RUNTIME.lastHeartbeatAt = Date.now();
    setBadge("0", BADGE_GREEN);
    await persistRuntime();
    broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
    // v0.7.0 — alarms-based heartbeat. Sopravvive al sleep del SW MV3 (al
    // contrario di setInterval) e ping al CS ogni 30s.
    startHeartbeatAlarm();
  } catch (e) {
    RUNTIME.status = "error";
    RUNTIME.lastError = `Content script: ${e?.message ?? e}`;
    await persistRuntime();
    broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
    setBadge("!", BADGE_RED);
  }
}

async function stopScan() {
  if (RUNTIME.scanTabId) {
    try {
      await chrome.tabs.sendMessage(RUNTIME.scanTabId, { type: "PEGASUS_STOP" });
    } catch {
      /* tab persa */
    }
  }
  RUNTIME.status = "idle";
  stopHeartbeatAlarm();
  await persistRuntime();
  broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
  clearBadge();
}

// ═══════════════════════════════════════════════════════════════════════════
// v0.7.0 — Heartbeat alarm: ping CS ogni 30s; se 2 mancati, re-inject.
// ═══════════════════════════════════════════════════════════════════════════
function startHeartbeatAlarm() {
  try {
    chrome.alarms?.create?.(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MIN });
  } catch {
    // chrome.alarms may be unavailable on some Chromium forks; silent.
  }
}

function stopHeartbeatAlarm() {
  try { chrome.alarms?.clear?.(HEARTBEAT_ALARM); } catch {}
  RUNTIME.missedHeartbeats = 0;
}

async function reinjectContentScript(tabId) {
  // Best-effort: usa chrome.scripting per re-iniettare i18n + content script.
  // Funziona solo se permessi `scripting` + host permissions sulla tab matchano
  // — abbiamo entrambi. Niente di rumoroso lato user: il CS si re-annuncia READY.
  try {
    await chrome.scripting?.executeScript?.({
      target: { tabId },
      files: ["lib/i18n.js", "content-scripts/fb-ads-extract.js"],
    });
    console.log("[Pegasus] CS re-injected after missed heartbeats");
  } catch (e) {
    console.warn("[Pegasus] CS re-inject failed:", e?.message ?? e);
  }
}

async function onHeartbeatTick() {
  if (RUNTIME.status !== "scanning" || !RUNTIME.scanTabId) return;
  try {
    const r = await chrome.tabs.sendMessage(RUNTIME.scanTabId, { type: "PEGASUS_HEARTBEAT" });
    if (r?.ok) {
      RUNTIME.lastHeartbeatAt = Date.now();
      RUNTIME.missedHeartbeats = 0;
    } else {
      RUNTIME.missedHeartbeats++;
    }
  } catch {
    // Il CS può essere morto (tab refresh, navigation, crash). Conta il miss.
    RUNTIME.missedHeartbeats++;
  }
  if (RUNTIME.missedHeartbeats >= HEARTBEAT_MAX_MISSED) {
    console.warn(`[Pegasus] CS missed ${RUNTIME.missedHeartbeats} heartbeats — re-injecting`);
    RUNTIME.missedHeartbeats = 0;
    if (RUNTIME.scanTabId) await reinjectContentScript(RUNTIME.scanTabId);
  }
}

chrome.alarms?.onAlarm?.addListener?.((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    onHeartbeatTick().catch(() => {});
  }
});

// === Handler dei messaggi dal content script (e dal popup) ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "PEGASUS_POPUP_START": {
          await startScan(msg.payload);
          sendResponse({ ok: true });
          break;
        }
        case "PEGASUS_POPUP_STOP": {
          await stopScan();
          sendResponse({ ok: true });
          break;
        }
        case "PEGASUS_POPUP_STATE": {
          sendResponse({ ok: true, state: { ...RUNTIME } });
          break;
        }
        case "PEGASUS_POPUP_PING_API": {
          try {
            const r = await api.ping();
            sendResponse({ ok: true, payload: r });
          } catch (e) {
            sendResponse({ ok: false, error: e?.message ?? String(e), status: e?.status });
          }
          break;
        }
        case "PEGASUS_CS_READY": {
          // content script si è montato — niente da fare, la pipe è già avviata
          sendResponse({ ok: true });
          break;
        }
        // v0.7.0 — handshake di resume. Il CS lo manda al boot se trova uno
        // scan stato persistito <5min. Confermiamo se il RUNTIME locale
        // ha ancora un scanId compatibile (stesso scan), altrimenti rigetto.
        case "PEGASUS_RESUME": {
          const sameKeyword = msg.keyword && RUNTIME.keyword && msg.keyword === RUNTIME.keyword;
          const stillScanning = RUNTIME.status === "scanning" || RUNTIME.status === "waiting_cs";
          if (stillScanning && sameKeyword) {
            sendResponse({ ok: true, scanId: RUNTIME.scanId });
          } else {
            sendResponse({ ok: false, reason: "no_active_scan_for_keyword" });
          }
          break;
        }
        case "PEGASUS_INGEST_BATCH": {
          try {
            const res = await api.ingest({
              scanId: RUNTIME.scanId ?? msg.scanId,
              keyword: RUNTIME.keyword || msg.keyword,
              country: RUNTIME.country || msg.country,
              items: msg.items,
              totalAds: msg.totalAds,
              status: "scanning",
            });
            if (res?.scanId && !RUNTIME.scanId) RUNTIME.scanId = res.scanId;
            RUNTIME.sentItems += msg.items?.length ?? 0;
            RUNTIME.totalAds = msg.totalAds ?? RUNTIME.totalAds;
            RUNTIME.totalStores = res?.totalStores ?? RUNTIME.totalStores;
            await persistRuntime();
            broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
            // v0.4.0: live badge counter — formatted to fit ~4 chars.
            setBadge(fmtBadge(RUNTIME.totalAds), BADGE_GREEN);
            // Restituiamo totalStores al content script così l'overlay live
            // può mostrarlo aggiornato dalla fonte di verità (server).
            sendResponse({
              ok: true,
              scanId: RUNTIME.scanId,
              totalStores: RUNTIME.totalStores,
              autoTracked: res?.autoTracked,
            });
          } catch (e) {
            // v0.7.0 — propaga status code al CS così può decidere se ritentare
            // (5xx/network) o abortire (401/403/422).
            sendResponse({ ok: false, error: e?.message ?? String(e), status: e?.status ?? 0 });
          }
          break;
        }
        case "PEGASUS_DONE": {
          RUNTIME.totalAds = msg.totalFound ?? RUNTIME.totalAds;
          RUNTIME.status = "finalizing";
          // v0.7.0 — salva metriche del CS per debug futuro (no upload server).
          if (msg.metrics) {
            RUNTIME.lastMetrics = msg.metrics;
            console.log("[Pegasus] CS metrics:", msg.metrics);
          }
          stopHeartbeatAlarm();
          await persistRuntime();
          try {
            if (RUNTIME.scanId) {
              await api.finalizeScan(RUNTIME.scanId, "completed", {
                totalAds: RUNTIME.totalAds,
                durationMs: msg.durationMs,
                reason: msg.reason,
              });
            }
            RUNTIME.status = "completed";
            // v0.4.0: keep the final ad count on the badge so the user sees
            // the result at-a-glance even after closing the popup.
            setBadge(fmtBadge(RUNTIME.totalAds), BADGE_GREEN);
            chrome.notifications?.create?.({
              type: "basic",
              iconUrl: "icons/icon-128.png",
              title: "Pegasus — scansione completata",
              message: `${RUNTIME.totalAds} annunci trovati per "${RUNTIME.keyword}"`,
            });
          } catch (e) {
            RUNTIME.status = "error";
            RUNTIME.lastError = `Finalize: ${e?.message ?? e}`;
            setBadge("!", BADGE_RED);
          }
          await persistRuntime();
          broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
          sendResponse({ ok: true });
          break;
        }
        case "PEGASUS_METRICS": {
          RUNTIME.totalAds = msg.totalFound ?? RUNTIME.totalAds;
          if (RUNTIME.status === "scanning") {
            setBadge(fmtBadge(RUNTIME.totalAds), BADGE_GREEN);
          }
          broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
          sendResponse({ ok: true });
          break;
        }
        case "PEGASUS_LOG": {
          broadcastToPopup({ type: "PEGASUS_LOG", level: msg.level, msg: msg.msg });
          sendResponse({ ok: true });
          break;
        }
        case "PEGASUS_OPEN_DASHBOARD": {
          // Bottone "Dashboard" nell'overlay live → apre la dashboard utente.
          const server = await storage.getServer();
          const dashUrl = server
            .replace(/^https?:\/\/api\./, "https://")
            .replace(/\/$/, "");
          chrome.tabs.create({ url: `${dashUrl}/app/scanner` });
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown type" });
      }
    } catch (e) {
      RUNTIME.lastError = e?.message ?? String(e);
      sendResponse({ ok: false, error: RUNTIME.lastError });
    }
  })();
  return true; // tieni il canale aperto per la response async
});

// Pulizia se la tab di scansione viene chiusa
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === RUNTIME.scanTabId && RUNTIME.status === "scanning") {
    RUNTIME.status = "error";
    RUNTIME.lastError = "Tab di scansione chiusa prima del termine";
    stopHeartbeatAlarm();
    persistRuntime();
    broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
    setBadge("!", BADGE_RED);
  }
});

// All'install/update facciamo nulla — la chiave la inserisce l'utente
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Pegasus] Service worker installato");
  // v0.4.0: belt-and-suspenders — clear any stale badge state from a
  // previous version after update.
  clearBadge();
  // v0.7.0: clean stale heartbeat alarm da install precedenti.
  stopHeartbeatAlarm();
});
