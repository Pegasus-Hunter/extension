// Pegasus Scanner — service worker (background).
//
// Responsibilità:
//   1) Riceve START dal popup → apre tab FB Ads Library con URL keyword/paese.
//   2) Aspetta che il content script si annunci READY.
//   3) Invia START al content script.
//   4) Inoltra i batch dal content script all'API server (wooshstoreai.com).
//   5) Propaga metrics/log al popup quando aperto.
//   6) Gestisce STOP / chiusura tab.
//
// Tutto è async + state machine semplice. Lo stato vive in chrome.storage.local
// così sopravvive a sleep/wake del service worker.

import { storage } from "../lib/storage.js";
import { api } from "../lib/api-client.js";

const FB_BASE = "https://www.facebook.com/ads/library/";

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
};

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
  await persistRuntime();
  broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });

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
    await persistRuntime();
    broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
  } catch (e) {
    RUNTIME.status = "error";
    RUNTIME.lastError = `Content script: ${e?.message ?? e}`;
    await persistRuntime();
    broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
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
  await persistRuntime();
  broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
}

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
            // Restituiamo totalStores al content script così l'overlay live
            // può mostrarlo aggiornato dalla fonte di verità (server).
            sendResponse({
              ok: true,
              scanId: RUNTIME.scanId,
              totalStores: RUNTIME.totalStores,
              autoTracked: res?.autoTracked,
            });
          } catch (e) {
            sendResponse({ ok: false, error: e?.message ?? String(e), status: e?.status });
          }
          break;
        }
        case "PEGASUS_DONE": {
          RUNTIME.totalAds = msg.totalFound ?? RUNTIME.totalAds;
          RUNTIME.status = "finalizing";
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
            chrome.notifications?.create?.({
              type: "basic",
              iconUrl: "icons/icon-128.png",
              title: "Pegasus — scansione completata",
              message: `${RUNTIME.totalAds} annunci trovati per "${RUNTIME.keyword}"`,
            });
          } catch (e) {
            RUNTIME.status = "error";
            RUNTIME.lastError = `Finalize: ${e?.message ?? e}`;
          }
          await persistRuntime();
          broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
          sendResponse({ ok: true });
          break;
        }
        case "PEGASUS_METRICS": {
          RUNTIME.totalAds = msg.totalFound ?? RUNTIME.totalAds;
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
    persistRuntime();
    broadcastToPopup({ type: "PEGASUS_STATE", state: { ...RUNTIME } });
  }
});

// All'install/update facciamo nulla — la chiave la inserisce l'utente
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Pegasus] Service worker installato");
});
