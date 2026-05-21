// Client HTTP per parlare con il central server Pegasus Hunter (FastAPI).
// Tutte le richieste usano Bearer wsk_... salvato in chrome.storage.local.
// Nessun cookie, nessuna sessione browser — l'estensione è un client
// headless puro che parla solo a /api/v1/scanner/*.
//
// Endpoint path:
//   - PROD: https://api.pegasushunter.com/api/v1/scanner/{ping,ingest}
//   - DEV : http://localhost:8080/api/v1/scanner/{ping,ingest}

import { storage } from "./storage.js";

const DEFAULT_TIMEOUT_MS = 15_000;

async function request(method, path, body) {
  const apiKey = await storage.getApiKey();
  if (!apiKey) throw new Error("Nessuna API key configurata");
  const base = await storage.getServer();

  const url = `${base.replace(/\/$/, "")}${path}`;
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(to);
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }

  if (!res.ok) {
    // Central server style: {detail: "..."}. Pegasus-Store legacy: {error: "..."}.
    // Manteniamo backward-compat per il dev locale.
    const msg = json?.detail ?? json?.error ?? json?.message ?? `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

// ── v0.5.0 — Retry wrapper for transient ingest failures ────────────────────
//
// Wraps `request()` with exponential backoff. Retry policy:
//   - status < 0 (treated as network error: AbortError, TypeError fetch
//     failure) → retry
//   - 5xx server errors → retry (the server is at fault, not the request)
//   - 408 / 429 → retry (rate-limited or timeout)
//   - 4xx other → do NOT retry (bad API key, plan limit, validation —
//     retrying won't help and would only burn the user's quota)
//
// Max 3 attempts with delays 1s, 3s, 9s (~13s total worst case). This keeps
// ingest fault-tolerant during the FB Ads Library scrape, when the user's
// home wifi may flake for a few seconds without taking the whole scan down.
const RETRY_DELAYS_MS = [1000, 3000, 9000];

function shouldRetry(err) {
  if (!err) return false;
  if (typeof err.status !== "number") return true; // network / abort
  if (err.status >= 500) return true;
  if (err.status === 408 || err.status === 429) return true;
  return false;
}

async function requestWithRetry(method, path, body) {
  let lastErr;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      return await request(method, path, body);
    } catch (e) {
      lastErr = e;
      if (!shouldRetry(e) || attempt === RETRY_DELAYS_MS.length) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}

export const api = {
  /**
   * Verifica chiave: chiama /api/v1/scanner/ping.
   * Risposta 200: { ok: true, user_id, scopes }. 401: chiave invalida/revocata.
   */
  async ping() {
    return request("GET", "/api/v1/scanner/ping");
  },

  /**
   * Ingest batch di prodotti scrappati. Idempotente per (scanId, pageUrl) lato
   * server. Il primo batch di una scan può omettere scanId — il server lo
   * crea e lo restituisce. Risposta include `autoTracked` (nuove subscription
   * create) e `totalStores` (DISTINCT su /products/).
   */
  async ingest({ scanId, keyword, country, items, status, totalAds }) {
    // v0.5.0 — retry on transient failures (5xx, timeout, network flake).
    // Ingest is idempotent server-side on (scanId, pageUrl), so retrying
    // a "did it actually save?" case is safe.
    return requestWithRetry("POST", "/api/v1/scanner/ingest", {
      scanId,
      keyword,
      country,
      items,
      status,
      totalAds,
    });
  },

  /**
   * Segnala fine scansione lato server (status: completed | failed).
   * Sul finalize, il server fa auto-track di tutti i prodotti unici scrappati.
   */
  async finalizeScan(scanId, status, summary) {
    // Same retry treatment — re-finalizing the same scan is a no-op server-side.
    return requestWithRetry("POST", "/api/v1/scanner/ingest", {
      scanId,
      status,
      summary,
      finalize: true,
    });
  },
};
