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
    return request("POST", "/api/v1/scanner/ingest", {
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
    return request("POST", "/api/v1/scanner/ingest", {
      scanId,
      status,
      summary,
      finalize: true,
    });
  },
};
