// Pegasus Hunter — custom i18n (IT/EN).
//
// Niente Chrome _locales/ ufficiale perché siamo distribuiti via .zip + GitHub
// Release, non via Web Store. Sistema custom semplice: oggetto MESSAGES con
// namespace `it` / `en`, funzione t(key, replacements) con fallback cross-locale.
//
// Questo file NON è un ES module: viene caricato come <script> nel popup.html
// (prima del popup.js modulare) e come content_script (prima di fb-ads-extract.js).
// Espone l'API su globalThis.PegasusI18n così entrambi i contesti la usano allo
// stesso modo, senza import.

(function () {
  "use strict";

  const MESSAGES = {
    it: {
      // ── popup header / status pill ─────────────────────────────────────
      "popup.title": "Pegasus Hunter",
      "popup.status.idle": "In attesa",
      "popup.status.starting": "Avviando…",
      "popup.status.scanning": "Scansionando",
      "popup.status.completed": "Completata",
      "popup.status.error": "Errore",

      // ── popup setup view ───────────────────────────────────────────────
      "popup.setupTitle": "Collega Pegasus Hunter",
      "popup.setupHelp": "Incolla la tua API key. La trovi in",
      "popup.setupHelpLink": "pegasushunter.com → API Keys",
      "popup.apiKeyLabel": "API Key",
      "popup.serverLabel": "Server (avanzato)",
      "popup.serverProd": "Produzione · api.pegasushunter.com",
      "popup.serverLocal": "Locale · localhost:8080 (dev)",
      "popup.saveContinue": "Salva e continua",

      // ── popup main view ────────────────────────────────────────────────
      "popup.keywordLabel": "Keyword",
      "popup.keywordPh": "es. smartwatch, perruque...",
      "popup.countryLabel": "Paese",
      "popup.limitLabel": "Limite annunci",
      "popup.limitFast": "50 (veloce)",
      "popup.limitMedium": "150 (medio)",
      "popup.limitLong": "400 (lungo)",
      "popup.limitUnlimited": "Tutti (sperimentale)",
      "popup.startScan": "Avvia scansione",
      "popup.stop": "Ferma",

      // ── popup metrics ──────────────────────────────────────────────────
      "popup.metricAds": "Annunci",
      "popup.metricStores": "Shop trovati",
      "popup.metricSent": "Sincronizzati",

      // ── popup footer links ─────────────────────────────────────────────
      "popup.openDashboard": "Apri dashboard",
      "popup.resetKey": "Reset API key",

      // ── popup errors / confirms ────────────────────────────────────────
      "popup.err.keyMissing": "Inserisci una keyword",
      "popup.err.keyInvalid": "API key non valida: deve iniziare con wsk_",
      "popup.err.serverUnreach": "Impossibile verificare la chiave col server",
      "popup.err.startFailed": "Avvio fallito",
      "popup.confirm.resetKey": "Vuoi davvero rimuovere la API key?",

      // ── popup logs ─────────────────────────────────────────────────────
      "popup.log.startScan": "Avvio scansione: \"{kw}\" — paese {country}",
      "popup.log.stopRequested": "Stop richiesto",
      "popup.log.batchSent": "Batch inviato: {n} item, totale {tot}",

      // ── content-script overlay ─────────────────────────────────────────
      "overlay.title": "PEGASUS HUNTER",
      "overlay.keywordLabel": "Keyword:",
      "overlay.countryLabel": "Paese:",
      "overlay.metricAds": "Annunci",
      "overlay.metricStores": "Shop",
      "overlay.metricSent": "Sync",
      "overlay.btnStop": "Stop",
      "overlay.btnDashboard": "Dashboard",
      "overlay.status.scanning": "Scansionando…",
      "overlay.status.stopRequested": "Stop richiesto…",
      "overlay.status.completed": "✓ Completata · {n} prodotti",
      "overlay.status.limit": "✓ Limite raggiunto · {n} prodotti",
      "overlay.status.stopped": "✓ Interrotto · {n} prodotti",
      "overlay.status.authError": "Errore: API key invalida o revocata",
      "overlay.status.stoppedReason": "Terminato ({reason})",

      // ── content-script logs ────────────────────────────────────────────
      "cs.log.scanStart": "Avvio scansione FB Ads Library",
      "cs.log.overlayFail": "Overlay injection failed: {err}",
      "cs.log.recoveryKick": "Recovery: scroll su+giù per svegliare il lazy-load",
      "cs.log.stagnation": "Stagnazione dopo {n} cicli — termino",
      "cs.log.scanDone": "Scansione terminata: {n} prodotti, motivo: {reason}",
      "cs.log.batchSent": "Batch inviato: {n} item, totale {tot}",
      "cs.log.ingestFail": "Ingest fallito: {err}. Reinserisco in coda.",
      "cs.err.scanInProgress": "Scansione già in corso",
    },

    en: {
      // ── popup header / status pill ─────────────────────────────────────
      "popup.title": "Pegasus Hunter",
      "popup.status.idle": "Idle",
      "popup.status.starting": "Starting…",
      "popup.status.scanning": "Scanning",
      "popup.status.completed": "Completed",
      "popup.status.error": "Error",

      // ── popup setup view ───────────────────────────────────────────────
      "popup.setupTitle": "Connect Pegasus Hunter",
      "popup.setupHelp": "Paste your API key. Get it from",
      "popup.setupHelpLink": "pegasushunter.com → API Keys",
      "popup.apiKeyLabel": "API Key",
      "popup.serverLabel": "Server (advanced)",
      "popup.serverProd": "Production · api.pegasushunter.com",
      "popup.serverLocal": "Local · localhost:8080 (dev)",
      "popup.saveContinue": "Save and continue",

      // ── popup main view ────────────────────────────────────────────────
      "popup.keywordLabel": "Keyword",
      "popup.keywordPh": "e.g. smartwatch, wig...",
      "popup.countryLabel": "Country",
      "popup.limitLabel": "Ads limit",
      "popup.limitFast": "50 (fast)",
      "popup.limitMedium": "150 (medium)",
      "popup.limitLong": "400 (long)",
      "popup.limitUnlimited": "All (experimental)",
      "popup.startScan": "Start scan",
      "popup.stop": "Stop",

      // ── popup metrics ──────────────────────────────────────────────────
      "popup.metricAds": "Ads",
      "popup.metricStores": "Stores",
      "popup.metricSent": "Synced",

      // ── popup footer links ─────────────────────────────────────────────
      "popup.openDashboard": "Open dashboard",
      "popup.resetKey": "Reset API key",

      // ── popup errors / confirms ────────────────────────────────────────
      "popup.err.keyMissing": "Enter a keyword",
      "popup.err.keyInvalid": "Invalid API key: must start with wsk_",
      "popup.err.serverUnreach": "Cannot verify the key with the server",
      "popup.err.startFailed": "Start failed",
      "popup.confirm.resetKey": "Really remove the API key?",

      // ── popup logs ─────────────────────────────────────────────────────
      "popup.log.startScan": "Starting scan: \"{kw}\" — country {country}",
      "popup.log.stopRequested": "Stop requested",
      "popup.log.batchSent": "Batch sent: {n} items, total {tot}",

      // ── content-script overlay ─────────────────────────────────────────
      "overlay.title": "PEGASUS HUNTER",
      "overlay.keywordLabel": "Keyword:",
      "overlay.countryLabel": "Country:",
      "overlay.metricAds": "Ads",
      "overlay.metricStores": "Stores",
      "overlay.metricSent": "Sync",
      "overlay.btnStop": "Stop",
      "overlay.btnDashboard": "Dashboard",
      "overlay.status.scanning": "Scanning…",
      "overlay.status.stopRequested": "Stop requested…",
      "overlay.status.completed": "✓ Completed · {n} products",
      "overlay.status.limit": "✓ Limit reached · {n} products",
      "overlay.status.stopped": "✓ Stopped · {n} products",
      "overlay.status.authError": "Error: invalid or revoked API key",
      "overlay.status.stoppedReason": "Ended ({reason})",

      // ── content-script logs ────────────────────────────────────────────
      "cs.log.scanStart": "Starting FB Ads Library scan",
      "cs.log.overlayFail": "Overlay injection failed: {err}",
      "cs.log.recoveryKick": "Recovery: scroll up+down to wake the lazy-load",
      "cs.log.stagnation": "Stagnation after {n} cycles — stopping",
      "cs.log.scanDone": "Scan ended: {n} products, reason: {reason}",
      "cs.log.batchSent": "Batch sent: {n} items, total {tot}",
      "cs.log.ingestFail": "Ingest failed: {err}. Requeuing.",
      "cs.err.scanInProgress": "Scan already running",
    },
  };

  // chrome.i18n.getUILanguage() restituisce es. "it-IT", "en-US", "fr-FR", etc.
  // Default IT se non riconosciuto (Italia first, EN come fallback richiesto dal
  // pitch europeo del prodotto — vedi STATO.md).
  function getLocale() {
    let ui = "";
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && chrome.i18n.getUILanguage) {
        ui = chrome.i18n.getUILanguage() || "";
      } else if (typeof navigator !== "undefined") {
        ui = navigator.language || "";
      }
    } catch {
      ui = "";
    }
    const lower = String(ui).toLowerCase();
    if (lower.startsWith("it")) return "it";
    if (lower.startsWith("en")) return "en";
    // Default: IT (mercato primario). Tutto il resto cade su EN sotto via
    // fallback nella t(), così l'utente non-italiano vede inglese.
    return "en";
  }

  // Sostituisce {placeholder} con i valori di replacements.
  // Non interpola HTML — solo testo. textContent-safe.
  function interpolate(template, replacements) {
    if (!template || !replacements) return template;
    return template.replace(/\{(\w+)\}/g, (match, key) => {
      if (Object.prototype.hasOwnProperty.call(replacements, key)) {
        return String(replacements[key]);
      }
      return match;
    });
  }

  // Cache del locale corrente. Lo si può forzare via setLocale (debug/test).
  let CURRENT = null;

  function setLocale(loc) {
    if (loc === "it" || loc === "en") CURRENT = loc;
  }

  function currentLocale() {
    if (CURRENT) return CURRENT;
    CURRENT = getLocale();
    return CURRENT;
  }

  /**
   * t(key, replacements?) → string
   * Lookup ordered: locale corrente → fallback all'altro locale → key letterale.
   * Mai null/undefined: se la key non esiste in nessun locale, ritorna la key
   * stessa (così è ovvio in dev cosa manca).
   */
  function t(key, replacements) {
    const loc = currentLocale();
    const other = loc === "it" ? "en" : "it";
    const raw =
      (MESSAGES[loc] && MESSAGES[loc][key]) ||
      (MESSAGES[other] && MESSAGES[other][key]) ||
      key;
    return interpolate(raw, replacements);
  }

  /**
   * Applica i18n a tutti i nodi con [data-i18n] in `root`. Sostituisce solo
   * textContent (Manifest V3-safe: niente innerHTML). Supporta inoltre:
   *   - data-i18n-attr="placeholder": setta l'attributo invece di textContent.
   *   - data-i18n-title: setta l'attributo title.
   */
  function applyToDom(root) {
    const scope = root || document;
    const nodes = scope.querySelectorAll("[data-i18n]");
    nodes.forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (!key) return;
      const attr = el.getAttribute("data-i18n-attr");
      const value = t(key);
      if (attr) {
        el.setAttribute(attr, value);
      } else {
        el.textContent = value;
      }
    });
    const titled = scope.querySelectorAll("[data-i18n-title]");
    titled.forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      if (!key) return;
      el.setAttribute("title", t(key));
    });
  }

  globalThis.PegasusI18n = {
    t,
    getLocale,
    setLocale,
    currentLocale,
    applyToDom,
    MESSAGES,
  };
})();
