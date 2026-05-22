// Content script — gira dentro facebook.com/ads/library/* per scrappare i risultati.
// Comunica solo via chrome.runtime.onMessage con il service worker.
//
// v0.7.0 "Steroids Edition" — riscrittura del main loop per:
//   - IntersectionObserver-based card detection (no DOM polling)
//   - Adaptive scroll pacing in funzione del rendimento
//   - Multi-strategy keep-alive (audio → WebRTC → WakeLock)
//   - Auto-resume da scan crashati (chrome.storage.local + handshake con SW)
//   - Parallel batch flush (semaforo 3) con retry esponenziale
//   - Queue mode quando la rete è down (accumulo, no flush)
//   - Anti-detection scroll variability + random idle micro-pauses
//   - Triplo fallback selector per `findAdCards`
//   - Telemetria interna (metrics) inviata al SW al `PEGASUS_DONE`
//   - Extract 12+ campi per card (video, CTA, headline, libraryId, platforms…)
//   - Filtro URL esteso a Shopify/Woo/BigCommerce/Wix/Squarespace/ClickFunnels
//
// Robustness: Facebook obfusca aria-label / class names. Usiamo selettori
// strutturali a fallback in cascata + pattern URL (l.php, /ads/library/?id=).

(function () {
  "use strict";

  // i18n: lib/i18n.js viene caricato come content_script PRIMA di questo file
  // (vedi manifest.json content_scripts.js array). Espone PegasusI18n su globalThis.
  // Fallback: identità sulla key — così il file resta funzionante anche se i18n.js
  // non si è caricato per qualche motivo.
  const i18n = globalThis.PegasusI18n || {
    t: (k) => k,
    getLocale: () => "it",
  };
  const t = (key, repl) => i18n.t(key, repl);

  const STATE = {
    scanning: false,
    scanId: null,
    keyword: "",
    country: "",
    limit: 0, // 0 = nessun limite
    seen: new Set(), // dedupe per pageUrl
    batch: [], // accumulator del prossimo invio
    totalFound: 0,
    sinceLastBatch: 0,
    sinceLastScrollGrowth: 0, // cicli scroll senza nuove card
    abortReason: null,
    cycles: 0,
    startedAt: Date.now(),
    // v0.7.0 — sliding window per Speed (ads/min)
    foundTimestamps: [], // ms epoch di ogni ad trovato (max 500)
    // v0.7.0 — queue mode (network-down): accumula senza flushare
    queueMode: false,
    consecutiveNetworkFails: 0,
    // v0.7.0 — pacing adattivo
    adsPerCycleWindow: [], // ultimi 3 cicli (nuovi ad trovati)
    currentCycleMs: 4000, // valore corrente di SCROLL_CYCLE_MS (mutable)
    // v0.7.0 — telemetria interna
    metrics: {
      cycles: 0,
      cardsPerCycle: [],
      flushAttempts: 0,
      flushSuccesses: 0,
      flushFailures: 0,
      recoveryKicks: 0,
      stagnationStreak: 0,
      keepAliveStrategy: "none",
      startedAt: Date.now(),
      endedAt: null,
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // CONSTANTS — TUNED IN v0.7.0
  // ═══════════════════════════════════════════════════════════════════════════
  const BATCH_FLUSH_SIZE = 25;
  const BATCH_FLUSH_MS = 10_000;
  // Pacing tra cicli (con jitter ±30%). Più lento = meno rischio di flag FB
  // ma scansione più lunga. v0.7.0: BASE 4s, modulato in adaptive pacing.
  const SCROLL_CYCLE_MS_BASE = 4000;
  const SCROLL_CYCLE_MS_MIN = 1500;
  const SCROLL_CYCLE_MS_MAX = 12_000;
  // Cicli consecutivi senza nuovi annunci PRIMA di dichiarare la scansione finita.
  const STAGNATION_MAX_CYCLES = 25;
  // Dopo lo scroll-to-bottom, quanto aspettare per vedere nuove card prima
  // di considerare il ciclo "vuoto". Polling ogni 500ms.
  const MAX_WAIT_NEW_CONTENT_MS = 8000;
  // Recovery: ogni RECOVERY_EVERY_CYCLES cicli senza crescita, faccio
  // scroll-up + scroll-down per "svegliare" il lazy-load di Facebook.
  const RECOVERY_EVERY_CYCLES = 4;

  // v0.7.0 — parallel flush. Massimo 3 batch in volo verso il backend
  // contemporaneamente. Promise.all + semaforo manuale (niente lib esterne).
  const MAX_PARALLEL_FLUSHES = 3;
  let inFlightFlushes = 0;

  // v0.7.0 — DOM micro-cache: ricicla findAdCards() per N ms se chiamato
  // ravvicinato (es. due volte nello stesso tick per observer + manuale).
  const CARDS_CACHE_TTL_MS = 500;
  let cardsCache = { ts: 0, value: [] };

  // v0.7.0 — retry esponenziale per il flush. 3 tentativi: 1s, 3s, 9s con
  // jitter ±30%. NON ritenta su 401/403/422.
  const FLUSH_RETRY_DELAYS_MS = [1000, 3000, 9000];

  // v0.7.0 — auto-resume: uno scan persistito è considerato "fresh" entro
  // 5 minuti dal suo ultimo timestamp.
  const RESUME_MAX_AGE_MS = 5 * 60 * 1000;

  // v0.7.0 — speed window: 60s rolling per "ads/min".
  const SPEED_WINDOW_MS = 60_000;

  // v0.7.0 — network-down threshold: 3 fallimenti consecutivi network →
  // queue mode (accumula senza flushare per 60s).
  const NETWORK_FAIL_THRESHOLD = 3;
  const QUEUE_MODE_RETRY_MS = 60_000;

  let flushTimer = null;
  let queueModeTimer = null;
  let cardObserver = null;       // v0.7.0 — IntersectionObserver
  let observedCards = new WeakSet(); // dedupe card già osservate
  let keepAliveHandle = null;    // legacy (audio); ora dentro keepAlive.audio
  const keepAlive = {            // v0.7.0 — multi-strategy holder
    audio: null,
    webrtc: null,
    wakeLock: null,
    strategy: "none",
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // KEEP-ALIVE (v0.6.0 → v0.7.0 multi-strategy)
  //
  // Chrome aggressively throttles setTimeout/setInterval/RAF on non-visible
  // tabs. Bypassiamo con: audio → WebRTC → WakeLock, in cascata. Il primo
  // che riesce diventa la `keepAlive.strategy` attiva (log + overlay badge).
  // ═══════════════════════════════════════════════════════════════════════════

  // [1] AudioContext con OscillatorNode a gain ≈ -80 dB. Chrome marca la tab
  //     come "media-playing" e la esclude dal throttling. Funziona quasi sempre
  //     se la pagina ha avuto un user gesture (il click START sul popup conta).
  function tryAudioKeepAlive() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error("AudioContext unavailable");
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.frequency.value = 440;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      keepAlive.audio = { ctx, osc };
      keepAliveHandle = keepAlive.audio; // back-compat ref usato da visibility handler
      keepAlive.strategy = "audio";
      STATE.metrics.keepAliveStrategy = "audio";
      log(t("cs.log.keepAliveOn"));
      return true;
    } catch (e) {
      logErr(t("cs.log.keepAliveFail", { err: e?.message ?? e }));
      return false;
    }
  }

  // [2] WebRTC fallback. Una RTCPeerConnection con un data channel aperto
  //     mantiene attiva la tab in alcuni Chromium fork che bloccano
  //     AudioContext senza user gesture (es. Brave/Vivaldi con privacy preset).
  //     Niente connessione esterna: il PC resta in "new" perché non facciamo
  //     setLocalDescription contro un peer, ma il channel open basta a Chrome.
  function tryWebRTCKeepAlive() {
    try {
      if (typeof RTCPeerConnection === "undefined") {
        throw new Error("RTCPeerConnection unavailable");
      }
      const pc = new RTCPeerConnection();
      const dc = pc.createDataChannel("pegasus-keepalive");
      // Forziamo offer/answer locale per attivare il channel internamente:
      // anche senza peer remoto, Chrome conta la connessione come "in uso"
      // e riduce il throttling.
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => {});
      keepAlive.webrtc = { pc, dc };
      keepAlive.strategy = "webrtc";
      STATE.metrics.keepAliveStrategy = "webrtc";
      log(t("cs.log.keepAliveWebRTC"));
      return true;
    } catch (e) {
      logErr(t("cs.log.keepAliveFail", { err: `WebRTC: ${e?.message ?? e}` }));
      return false;
    }
  }

  // [3] Wake Lock API. Richiede HTTPS + document visibile per ottenerlo.
  //     Non sempre disponibile (Firefox no, Safari no, alcuni Chromium fork
  //     no). Quando c'è, è il sistema più "pulito" — niente media indicator
  //     sulla tab — ma funziona SOLO con tab visibile. Bonus, non sostituto.
  async function tryWakeLockKeepAlive() {
    try {
      if (!navigator.wakeLock) throw new Error("WakeLock API missing");
      const wl = await navigator.wakeLock.request("screen");
      keepAlive.wakeLock = wl;
      // Se non abbiamo niente di meglio, segnalo come strategy attiva.
      // Altrimenti audio/webrtc tengono il primato (funzionano anche minimizzati).
      if (keepAlive.strategy === "none") {
        keepAlive.strategy = "wakelock";
        STATE.metrics.keepAliveStrategy = "wakelock";
      }
      log(t("cs.log.keepAliveWakeLock"));
      return true;
    } catch (e) {
      // Silent: WakeLock è bonus, non blocking.
      return false;
    }
  }

  async function startKeepAlive() {
    // Tentativi in cascata: il primo che riesce diventa primary strategy.
    // Wake Lock è sempre bonus se disponibile, non sostituisce audio/webrtc.
    const audioOk = tryAudioKeepAlive();
    if (!audioOk) tryWebRTCKeepAlive();
    // Wake lock parallelo, best-effort, async.
    tryWakeLockKeepAlive().catch(() => {});
  }

  function stopKeepAlive() {
    if (keepAlive.audio) {
      try { keepAlive.audio.osc.stop(); } catch {}
      try { keepAlive.audio.ctx.close(); } catch {}
      keepAlive.audio = null;
    }
    if (keepAlive.webrtc) {
      try { keepAlive.webrtc.dc.close(); } catch {}
      try { keepAlive.webrtc.pc.close(); } catch {}
      keepAlive.webrtc = null;
    }
    if (keepAlive.wakeLock) {
      try { keepAlive.wakeLock.release(); } catch {}
      keepAlive.wakeLock = null;
    }
    keepAliveHandle = null;
    keepAlive.strategy = "none";
  }

  function log(...args) {
    chrome.runtime.sendMessage({
      type: "PEGASUS_LOG",
      level: "info",
      msg: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
    });
  }

  function logErr(msg) {
    chrome.runtime.sendMessage({ type: "PEGASUS_LOG", level: "err", msg });
  }

  function jitter(base) {
    const j = (Math.random() - 0.5) * 0.8; // ±40%
    return Math.max(200, Math.round(base * (1 + j)));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OVERLAY LIVE — la killer UX feature di Pegasus Hunter v0.2.0.
  // v0.7.0 — aggiunte: speed, keepalive badge, queue mode banner, resume btn.
  // ═══════════════════════════════════════════════════════════════════════════

  let overlayEl = null;

  function createOverlay(keyword, country) {
    if (overlayEl) removeOverlay();
    const host = document.createElement("div");
    host.id = "pegasus-overlay-host";
    // Use shadow DOM to isolate styles from FB's CSS
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; }
        .ph-overlay {
          position: fixed;
          top: 16px;
          right: 16px;
          z-index: 2147483647;
          width: 280px;
          padding: 14px 14px 12px;
          background: linear-gradient(135deg, rgba(15,23,42,0.97) 0%, rgba(30,41,59,0.97) 100%);
          color: #f1f5f9;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px;
          border-radius: 12px;
          box-shadow: 0 10px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(245,158,11,0.3);
          backdrop-filter: blur(6px);
          user-select: none;
        }
        .ph-header {
          display: flex; align-items: center; gap: 8px;
          font-weight: 700; font-size: 13px; letter-spacing: 0.3px;
          padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        .ph-logo {
          width: 20px; height: 20px; border-radius: 5px;
          background: linear-gradient(135deg, #1e3a8a, #f59e0b);
          display: grid; place-items: center;
          color: white; font-weight: 800; font-size: 12px;
        }
        .ph-title { flex: 1; }
        .ph-dot {
          width: 8px; height: 8px; border-radius: 50%; background: #f59e0b;
          animation: ph-pulse 1.4s infinite ease-in-out;
        }
        .ph-dot.ok { background: #10b981; animation: none; }
        .ph-dot.err { background: #ef4444; animation: none; }
        @keyframes ph-pulse { 0%,100%{opacity:1;} 50%{opacity:0.35;} }
        .ph-meta {
          padding: 10px 0 8px;
          font-size: 11px; color: #94a3b8;
        }
        .ph-meta strong { color: #f1f5f9; font-weight: 600; }
        .ph-metrics {
          display: grid; grid-template-columns: 1fr 1fr 1fr;
          gap: 6px; margin: 6px 0 10px;
        }
        .ph-cell {
          background: rgba(255,255,255,0.04);
          border-radius: 6px; padding: 8px 4px; text-align: center;
        }
        .ph-num {
          font-size: 17px; font-weight: 700; color: #f1f5f9;
          font-variant-numeric: tabular-nums;
        }
        .ph-lbl {
          font-size: 9px; color: #64748b;
          text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px;
        }
        .ph-speed-row {
          display: flex; align-items: center; justify-content: space-between;
          padding: 4px 2px 8px; font-size: 11px; color: #94a3b8;
        }
        .ph-speed-row strong {
          color: #f59e0b; font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .ph-ka-badge {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 2px 6px; border-radius: 4px;
          font-size: 10px; background: rgba(34,197,94,0.15);
          color: #4ade80; border: 1px solid rgba(34,197,94,0.3);
        }
        .ph-ka-badge.none {
          background: rgba(100,116,139,0.15);
          color: #94a3b8; border-color: rgba(100,116,139,0.3);
        }
        .ph-queue-banner {
          margin: 4px 0 8px; padding: 6px 8px;
          background: rgba(245,158,11,0.12);
          border: 1px solid rgba(245,158,11,0.35);
          border-radius: 6px;
          color: #fbbf24; font-size: 11px;
        }
        .ph-queue-banner[hidden] { display: none; }
        .ph-actions { display: flex; gap: 6px; }
        .ph-btn {
          flex: 1; padding: 7px 10px; border-radius: 6px;
          font-size: 11px; font-weight: 600; cursor: pointer;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.06); color: #f1f5f9;
          transition: background 0.15s, border-color 0.15s;
          font-family: inherit;
        }
        .ph-btn:hover { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.2); }
        .ph-btn.primary {
          background: linear-gradient(135deg, #1e3a8a, #3b82f6);
          border-color: #3b82f6;
        }
        .ph-btn.primary:hover { background: linear-gradient(135deg, #1e40af, #2563eb); }
        .ph-btn.danger { color: #fecaca; }
        .ph-btn.danger:hover { background: rgba(239,68,68,0.15); border-color: rgba(239,68,68,0.4); }
        .ph-status { font-size: 10px; color: #94a3b8; padding: 6px 0 0; }
        .ph-status.done { color: #10b981; }
      </style>
      <div class="ph-overlay" role="status" aria-live="polite">
        <div class="ph-header">
          <div class="ph-logo">P</div>
          <div class="ph-title">${t("overlay.title")}</div>
          <div class="ph-dot" id="ph-dot"></div>
        </div>
        <div class="ph-meta">
          ${t("overlay.keywordLabel")} <strong id="ph-kw"></strong> &middot; ${t("overlay.countryLabel")} <strong id="ph-country"></strong>
        </div>
        <div class="ph-metrics">
          <div class="ph-cell"><div class="ph-num" id="ph-ads">0</div><div class="ph-lbl">${t("overlay.metricAds")}</div></div>
          <div class="ph-cell"><div class="ph-num" id="ph-stores">0</div><div class="ph-lbl">${t("overlay.metricStores")}</div></div>
          <div class="ph-cell"><div class="ph-num" id="ph-sent">0</div><div class="ph-lbl">${t("overlay.metricSent")}</div></div>
        </div>
        <div class="ph-speed-row">
          <span>${t("overlay.speedLabel")}: <strong id="ph-speed">0</strong> ${t("overlay.speedUnit")}</span>
          <span class="ph-ka-badge none" id="ph-ka">${t("overlay.keepAliveNone")}</span>
        </div>
        <div class="ph-queue-banner" id="ph-queue" hidden></div>
        <div class="ph-actions">
          <button class="ph-btn danger" id="ph-stop">${t("overlay.btnStop")}</button>
          <button class="ph-btn primary" id="ph-open">${t("overlay.btnDashboard")}</button>
        </div>
        <div class="ph-status" id="ph-status">${t("overlay.status.scanning")}</div>
      </div>
    `;
    document.documentElement.appendChild(host);

    shadow.getElementById("ph-kw").textContent = keyword || "—";
    shadow.getElementById("ph-country").textContent = country || "ALL";

    shadow.getElementById("ph-stop").addEventListener("click", () => {
      STATE.scanning = false;
      STATE.abortReason = "user_stop";
      updateOverlayStatus(t("overlay.status.stopRequested"));
    });
    shadow.getElementById("ph-open").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "PEGASUS_OPEN_DASHBOARD" });
    });

    overlayEl = { host, shadow };
    return overlayEl;
  }

  function updateOverlay({ totalFound, totalStores, sent }) {
    if (!overlayEl) return;
    const s = overlayEl.shadow;
    if (typeof totalFound === "number") s.getElementById("ph-ads").textContent = String(totalFound);
    if (typeof totalStores === "number") s.getElementById("ph-stores").textContent = String(totalStores);
    if (typeof sent === "number") s.getElementById("ph-sent").textContent = String(sent);
  }

  function updateOverlaySpeed() {
    if (!overlayEl) return;
    const speed = computeSpeed();
    overlayEl.shadow.getElementById("ph-speed").textContent = String(speed);
  }

  function updateOverlayKeepAlive() {
    if (!overlayEl) return;
    const el = overlayEl.shadow.getElementById("ph-ka");
    if (!el) return;
    const s = keepAlive.strategy;
    let label = t("overlay.keepAliveNone");
    let cls = "ph-ka-badge none";
    if (s === "audio") { label = t("overlay.keepAliveAudio"); cls = "ph-ka-badge"; }
    else if (s === "webrtc") { label = t("overlay.keepAliveWebRTC"); cls = "ph-ka-badge"; }
    else if (s === "wakelock") { label = t("overlay.keepAliveWakeLock"); cls = "ph-ka-badge"; }
    el.textContent = label;
    el.className = cls;
  }

  function updateOverlayQueueMode() {
    if (!overlayEl) return;
    const banner = overlayEl.shadow.getElementById("ph-queue");
    if (!banner) return;
    if (STATE.queueMode) {
      banner.textContent = t("overlay.queueMode", { n: STATE.batch.length });
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  function updateOverlayStatus(text, variant) {
    if (!overlayEl) return;
    const s = overlayEl.shadow;
    const statusEl = s.getElementById("ph-status");
    const dotEl = s.getElementById("ph-dot");
    statusEl.textContent = text;
    statusEl.classList.toggle("done", variant === "ok");
    dotEl.classList.remove("ok", "err");
    if (variant === "ok") dotEl.classList.add("ok");
    if (variant === "err") dotEl.classList.add("err");
  }

  function removeOverlay() {
    if (overlayEl?.host && overlayEl.host.parentNode) {
      overlayEl.host.parentNode.removeChild(overlayEl.host);
    }
    overlayEl = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // URL handling — unwrap FB redirects, normalize, platform detection.
  // ═══════════════════════════════════════════════════════════════════════════

  // Decodifica i redirect di Facebook: lm.facebook.com/l.php?u=ENCODED_URL&...
  // oppure /l.php?u=ENCODED_URL&... in href relativi.
  function unwrapFbRedirect(href) {
    if (!href) return null;
    try {
      let u;
      if (href.startsWith("/")) {
        u = new URL(href, location.origin);
      } else {
        u = new URL(href);
      }
      if (
        u.pathname.endsWith("/l.php") ||
        u.hostname.endsWith("facebook.com") && u.pathname === "/l.php"
      ) {
        const target = u.searchParams.get("u");
        if (target) {
          try {
            return decodeURIComponent(target);
          } catch {
            return target;
          }
        }
      }
      return href;
    } catch {
      return null;
    }
  }

  // v0.7.0 — platform detection. Ritorna lo "slug" piattaforma del prodotto:
  // shopify | woocommerce | bigcommerce | wix | squarespace | clickfunnels |
  // unknown. Usato sia per il filtro che inviato al backend per analytics.
  function detectPlatform(url) {
    if (!url) return "unknown";
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      const path = u.pathname;

      // Hostname-based first (più affidabile quando esplicito).
      if (host.endsWith(".myshopify.com")) return "shopify";
      if (host.endsWith(".bigcommerce.com")) return "bigcommerce";
      if (host.endsWith(".wixsite.com") || host.endsWith(".wix.com")) return "wix";
      if (host.endsWith(".squarespace.com")) return "squarespace";
      if (host.endsWith(".clickfunnels.com") || host.endsWith(".myclickfunnels.com")) return "clickfunnels";

      // Path-based fallback: il dominio è custom (e.g. brand.com) ma il path
      // tradisce la piattaforma. Ordine matters: pattern più specifici prima.
      if (/^\/product-page\/[^/]+/i.test(path)) return "wix";
      if (/^\/products\/[^/]+/i.test(path)) return "shopify"; // Shopify default path
      if (/^\/product\/[^/]+\/?$/i.test(path)) return "woocommerce";
      if (/^\/(shop|store)\/[^/]+/i.test(path)) return "squarespace";
      if (/^\/(checkout|offer|order)\/[^/]+/i.test(path)) return "clickfunnels";

      return "unknown";
    } catch {
      return "unknown";
    }
  }

  // v0.7.0 — espansione di isShopifyProductUrl. Match qualsiasi URL "trackable"
  // su una delle piattaforme supportate. Niente falsi positivi su marketplace
  // (amazon/ebay/etc.).
  function isTrackableProductUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (!/^https?:\/\//i.test(url)) return false;

    // Esclude marketplace e affiliate finti positivi.
    if (/(amazon|ebay|aliexpress|temu|walmart|etsy|alibaba|wish\.com)\./i.test(url)) {
      return false;
    }

    const platform = detectPlatform(url);
    if (platform !== "unknown") return true;

    // Generic patterns: qualsiasi URL con `/buy/` `/order/` `/checkout/`
    // a path, anche su domini custom che non rientrano nei pattern noti.
    try {
      const path = new URL(url).pathname;
      if (/\/(buy|order|checkout)\/[^/]+/i.test(path)) return true;
    } catch {}

    return false;
  }

  function normalizeProductUrl(url) {
    try {
      const u = new URL(url);
      // Rimuovi tracking + fragment
      u.hash = "";
      const dropParams = [
        "fbclid",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
        "_fb",
        "_ga",
        "gclid",
        "ad_id",
        "adset_id",
        "campaign_id",
      ];
      for (const p of dropParams) u.searchParams.delete(p);
      // Spesso le URL hanno trailing slash inconsistente; normalizziamo.
      let str = u.toString();
      // se non ha querystring, togli trailing slash
      if (!u.search && str.endsWith("/")) str = str.slice(0, -1);
      return str;
    } catch {
      return url;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXTRACT CARD INFO — v0.7.0 expanded to 12+ fields
  //
  // Best-effort extraction: ogni campo è nullable. Facebook cambia DOM ogni
  // 2-3 mesi quindi NON ci basiamo su class names. Pattern stabili usati:
  //   - aria-label per Library ID
  //   - testo regex multilingua per "started running" + "X ads"
  //   - <video>/<img> per media
  //   - <a href> per advertiser_url
  //   - heuristic CTA: <span>/<div> con testo corto inside <a target=_blank>
  // ═══════════════════════════════════════════════════════════════════════════

  // Mappa multilingua "started running on …" → estrae la data come testo grezzo.
  // FB localizza il prefisso ma la data è sempre alfa+num quindi ce la teniamo
  // così com'è e la mandiamo al backend (parsing lato server più robusto).
  const START_DATE_PATTERNS = [
    /Avviato il\s+([0-9]{1,2}\s+\w+\s+\d{4})/i,           // IT
    /Avviato\s+il\s+([^·\n]+?)(?=$|·|\n)/i,                // IT relaxed
    /Started running on\s+([^·\n]+?)(?=$|·|\n)/i,          // EN
    /Sponsorisé(?:[esn]?)\s+depuis le\s+([^·\n]+?)(?=$|·|\n)/i, // FR
    /En cours d'exécution depuis le\s+([^·\n]+?)(?=$|·|\n)/i,  // FR alt
    /En ejecución desde el\s+([^·\n]+?)(?=$|·|\n)/i,       // ES
    /Em exibição desde\s+([^·\n]+?)(?=$|·|\n)/i,           // PT
    /In Auslieferung seit dem\s+([^·\n]+?)(?=$|·|\n)/i,    // DE
    /Loopt sinds\s+([^·\n]+?)(?=$|·|\n)/i,                 // NL
  ];

  // CTA testi più comuni multilingua — usati per validare che un elemento
  // testuale corto adiacente al link sia effettivamente la CTA, non rumore.
  const CTA_HINTS = new Set([
    // EN
    "shop now", "buy now", "order now", "learn more", "sign up", "get offer",
    "subscribe", "download", "get quote", "contact us", "apply now", "book now",
    // IT
    "acquista", "acquista ora", "scopri di più", "iscriviti", "ordina ora",
    "ricevi offerta", "compra adesso", "scopri", "registrati",
    // ES/PT
    "comprar ahora", "más información", "regístrate", "comprar agora",
    // FR
    "acheter", "en savoir plus", "s'inscrire",
    // DE
    "jetzt kaufen", "mehr ansehen", "registrieren",
    // NL
    "nu winkelen", "meer informatie",
  ]);

  function isCtaText(s) {
    if (!s) return false;
    const norm = s.trim().toLowerCase();
    if (norm.length === 0 || norm.length > 35) return false;
    return CTA_HINTS.has(norm) || /^(shop|buy|order|learn|acquista|compra|comprar|acheter)/i.test(norm);
  }

  // Plataforme icons (Facebook/Instagram/etc.) sono SVG con aria-label
  // localizzato. Cerchiamo la presenza del nome piattaforma nel testo della
  // card / aria-label per popolare l'array.
  const PLATFORM_KEYWORDS = {
    facebook: ["facebook"],
    instagram: ["instagram"],
    messenger: ["messenger"],
    audience_network: ["audience network", "audience"],
  };

  function detectAdPlatforms(card) {
    const out = new Set();
    try {
      // Cerca tutti gli <svg> con title o aria-label dentro la card; sono le
      // icone "Piattaforme: FB+IG+…" che FB mostra sotto "Avviato il …".
      const labeled = card.querySelectorAll('[aria-label]');
      for (const el of labeled) {
        const lbl = (el.getAttribute("aria-label") || "").toLowerCase();
        for (const [plat, kws] of Object.entries(PLATFORM_KEYWORDS)) {
          if (kws.some((k) => lbl.includes(k))) out.add(plat);
        }
      }
    } catch {}
    return Array.from(out);
  }

  function extractCardInfo(card) {
    let advertiser = null;
    let advertiser_url = null;
    let imageUrl = null;
    let videoUrl = null;
    let activeAds = null;
    let adStartDate = null;
    let libraryId = null;
    let ctaText = null;
    let headline = null;
    let bodyText = null;
    let displayDomain = null;
    let platforms = [];

    try {
      // Advertiser link: primo <a href="/PageName"> con testo non vuoto.
      // Spesso ha role="link" ma alcuni varianti FB lo droppano — fallback al
      // primo <a href^="/"> "pulito" (no /ads/, no /l.php, no /watch).
      const advLink =
        card.querySelector('a[role="link"][href^="/"]') ||
        Array.from(card.querySelectorAll('a[href^="/"]')).find((a) => {
          const h = a.getAttribute("href") || "";
          return !/^\/(ads|l\.php|watch|reel|story|stories|policies|help)/i.test(h)
            && a.textContent.trim().length > 0;
        });
      if (advLink && advLink.textContent.trim()) {
        advertiser = advLink.textContent.trim().slice(0, 200);
        const href = advLink.getAttribute("href") || advLink.href;
        if (href) {
          try {
            advertiser_url = new URL(href, location.origin).toString();
          } catch {
            advertiser_url = href;
          }
        }
      }
    } catch {}

    try {
      // Image: primo <img> abbastanza grande da essere una creative (non avatar).
      const imgs = card.querySelectorAll("img");
      for (const img of imgs) {
        const w = img.naturalWidth || parseInt(img.width, 10) || 0;
        if (w >= 200 && img.src) {
          imageUrl = img.src;
          break;
        }
      }
    } catch {}

    try {
      // Video: <video> con src diretto o <source>. FB usa blob URL che spesso
      // sono inutili lato server; preferiamo poster/src "https://" se presente.
      const video = card.querySelector("video");
      if (video) {
        const src = video.getAttribute("src") || video.src || null;
        if (src && /^https?:/.test(src)) videoUrl = src;
        else if (video.poster) videoUrl = video.poster; // fallback al poster
      }
    } catch {}

    try {
      // Active ads: pattern multilingua per "X annunci/ads/advertenties/Anzeigen/anuncios/publicités"
      const txt = card.textContent || "";
      const patterns = [
        /(\d{1,4})\s+annunci?\s+(usano|attivi|in\s+esecuzione)/i,        // IT
        /(\d{1,4})\s+ads?\s+(use|active|running)/i,                       // EN
        /(\d{1,4})\s+advertenties?\s+(gebruik|actief|wordt\s+uitgevoerd)/i, // NL
        /(\d{1,4})\s+anzeigen?\s+(verwenden|aktiv)/i,                     // DE
        /(\d{1,4})\s+annonces?\s+(utilisent|actives?)/i,                  // FR
        /(\d{1,4})\s+anuncios?\s+(utilizan|activos?)/i,                   // ES/PT
      ];
      for (const p of patterns) {
        const m = txt.match(p);
        if (m) {
          activeAds = parseInt(m[1], 10);
          break;
        }
      }
    } catch {}

    try {
      // Start date: scanniamo il textContent della card cercando un prefisso noto.
      const txt = card.textContent || "";
      for (const p of START_DATE_PATTERNS) {
        const m = txt.match(p);
        if (m && m[1]) {
          adStartDate = m[1].trim().slice(0, 100);
          break;
        }
      }
    } catch {}

    try {
      // Library ID: link a /ads/library/?id=NNNN o aria-label "Library ID: NNN".
      // Pattern stabile da anni, FB non l'ha mai cambiato.
      const libLink = card.querySelector('a[href*="/ads/library/?id="]');
      if (libLink) {
        const href = libLink.getAttribute("href") || libLink.href || "";
        const m = href.match(/[?&]id=(\d+)/);
        if (m) libraryId = m[1];
      }
      if (!libraryId) {
        const txt = card.textContent || "";
        const m = txt.match(/(?:Library ID|ID libreria|ID|Identifiant)[:\s]+(\d{10,})/i);
        if (m) libraryId = m[1];
      }
    } catch {}

    try {
      // CTA text: cerchiamo dentro <a target="_blank"> (link CTA esterno) un
      // <div>/<span> con testo corto. FB renderizza il bottone come stack di div.
      const ctaLinks = card.querySelectorAll('a[target="_blank"]');
      for (const a of ctaLinks) {
        // Stack di div con un testo corto come ultimo nodo testuale.
        const candidate = Array.from(a.querySelectorAll('div, span'))
          .map((el) => el.textContent.trim())
          .find((s) => isCtaText(s));
        if (candidate) {
          ctaText = candidate.slice(0, 50);
          break;
        }
      }
    } catch {}

    try {
      // Display domain: sotto la CTA c'è quasi sempre un link visible con il
      // dominio del prodotto (es. "techweise.com"). Pattern: piccolo, in
      // <a target=_blank> o testo subito sopra/sotto la CTA.
      const ctaLinks = card.querySelectorAll('a[target="_blank"]');
      for (const a of ctaLinks) {
        const span = a.querySelector('span, div');
        if (!span) continue;
        // Visited each direct text descendant; if it's a domain-like token, use it.
        const candidates = Array.from(a.querySelectorAll('div, span'))
          .map((el) => el.textContent.trim().toLowerCase())
          .filter((s) => /^[a-z0-9-]+(\.[a-z0-9-]+){1,}$/i.test(s) && !s.endsWith(".com.")); // bare-domain pattern
        if (candidates.length > 0) {
          displayDomain = candidates[0];
          break;
        }
      }
    } catch {}

    try {
      // Headline & bodyText: i div che contengono testo ad-copy sono spesso il
      // primo blocco di testo "lungo" sopra il media. Heuristica: prendi i due
      // <span>/<div> con dir="auto" più "informativi" (almeno 20 caratteri).
      const textNodes = Array.from(card.querySelectorAll('[dir="auto"]'))
        .map((el) => el.textContent.trim())
        .filter((s) => s.length >= 20 && s.length <= 400);
      // De-duplicate consecutive equal strings
      const dedup = [];
      for (const s of textNodes) {
        if (dedup[dedup.length - 1] !== s) dedup.push(s);
      }
      if (dedup.length >= 1) bodyText = dedup[0].slice(0, 400);
      if (dedup.length >= 2) headline = dedup[1].slice(0, 200);
    } catch {}

    try {
      platforms = detectAdPlatforms(card);
    } catch {}

    return {
      advertiser,
      advertiser_url,
      imageUrl,
      videoUrl,
      activeAds,
      adStartDate,
      libraryId,
      ctaText,
      headline,
      bodyText,
      displayDomain,
      platforms,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CARD FINDING — v0.7.0 triple-fallback + 500ms micro-cache
  //
  // FB cambia il DOM ogni qualche mese. Strategia con 3 fallback in cascata:
  //   1) [role="article"] — il pattern più stabile e desiderato.
  //   2) [role="main"] > div > div > div con >=3 figli — struttura grid.
  //   3) <div> contenenti <a href*="l.php"> + <img> + testo "X ads".
  // Logghiamo quale strategia ha trovato al primo successo del ciclo.
  // ═══════════════════════════════════════════════════════════════════════════

  let lastWinningStrategy = null;

  function findAdCards() {
    // Micro-cache: due chiamate ravvicinate nello stesso tick non rilanciano
    // querySelectorAll (200ms+ di parse su pagine grandi). Sliding window 500ms.
    const now = Date.now();
    if (now - cardsCache.ts < CARDS_CACHE_TTL_MS && cardsCache.value.length > 0) {
      return cardsCache.value;
    }

    // Strategia 1: role=article (pattern stabile)
    let cards = Array.from(document.querySelectorAll('[role="article"]'));
    let strategy = "role=article";

    // Strategia 2: layout grid sotto [role="main"]. Pattern stabile da ~2 anni
    // perché è il container del feed virtualizzato.
    if (cards.length === 0) {
      const main = document.querySelector('[role="main"]');
      if (main) {
        const candidates = Array.from(main.querySelectorAll(":scope > div > div > div"))
          .filter((d) => d.children.length >= 3);
        if (candidates.length > 0) {
          cards = candidates;
          strategy = "main-grid";
        }
      }
    }

    // Strategia 3: brute-force pattern. Cerca div che contengono link l.php +
    // img + testo "X ads/annunci/…". Lento ma quasi indistruttibile.
    if (cards.length === 0) {
      const containers = new Set();
      document.querySelectorAll('a[href*="l.php"], a[href*="lm.facebook.com"]').forEach((a) => {
        let p = a;
        for (let i = 0; i < 8 && p; i++) {
          p = p.parentElement;
          if (!p) break;
          if (p.children.length >= 3 && p.querySelector("img")) {
            const txt = p.textContent || "";
            if (/\d+\s+(ads?|annunci|annonces|anuncios|anzeigen|advertenties|anúncios)/i.test(txt)) {
              containers.add(p);
              break;
            }
          }
        }
      });
      if (containers.size > 0) {
        cards = Array.from(containers);
        strategy = "brute-force";
      }
    }

    // Logga solo quando la strategia "vincente" cambia: evita rumore in console.
    if (cards.length > 0 && strategy !== lastWinningStrategy) {
      log(t("cs.log.selectorWin", { strategy, n: cards.length }));
      lastWinningStrategy = strategy;
    }

    cardsCache = { ts: now, value: cards };
    return cards;
  }

  // v0.7.0 — extract from a single card (used by IntersectionObserver path).
  // Ritorna 1 se nuovo ad aggiunto, 0 se duplicate/non valido.
  function processCard(card) {
    if (!card || observedCards.has(card)) return 0;
    observedCards.add(card);

    const links = card.querySelectorAll('a[href*="l.php"], a[href*="lm.facebook.com"], a[href^="http"]');
    let added = 0;
    for (const a of links) {
      const unwrapped = unwrapFbRedirect(a.getAttribute("href") || a.href);
      if (!unwrapped) continue;
      if (!isTrackableProductUrl(unwrapped)) continue;
      const norm = normalizeProductUrl(unwrapped);
      if (STATE.seen.has(norm)) continue;
      STATE.seen.add(norm);
      const info = extractCardInfo(card);
      STATE.batch.push({
        pageUrl: norm,
        platform: detectPlatform(norm),
        advertiser: info.advertiser,
        advertiser_url: info.advertiser_url,
        imageUrl: info.imageUrl,
        videoUrl: info.videoUrl,
        activeAds: info.activeAds,
        adStartDate: info.adStartDate,
        libraryId: info.libraryId,
        ctaText: info.ctaText,
        headline: info.headline,
        bodyText: info.bodyText,
        displayDomain: info.displayDomain,
        platforms: info.platforms,
      });
      STATE.totalFound++;
      STATE.sinceLastBatch++;
      STATE.foundTimestamps.push(Date.now());
      // Cap the sliding window array — sono solo timestamp, 500 entries ~ 4KB.
      if (STATE.foundTimestamps.length > 500) STATE.foundTimestamps.shift();
      added++;
      if (STATE.limit > 0 && STATE.totalFound >= STATE.limit) {
        STATE.abortReason = "limit";
        break;
      }
    }
    return added;
  }

  function collectFromVisibleCards() {
    const cards = findAdCards();
    let added = 0;
    for (const card of cards) {
      added += processCard(card);
      if (STATE.abortReason) break;
    }
    return added;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERSECTION OBSERVER — v0.7.0 real-time card detection
  //
  // Polling con findAdCards() ogni ciclo è O(N*M) dove N è il numero di card
  // nel DOM (può salire a 1000+). IntersectionObserver è O(N) totale +
  // notifiche immediate quando una card entra in viewport — il modo nativo
  // di Chrome per dire "qualcosa è apparso".
  //
  // Strategia: appena la card entra in viewport, la processiamo. Pollin
  // collectFromVisibleCards() resta come fallback al primo ciclo (per le
  // card già presenti) + nei recovery kick.
  // ═══════════════════════════════════════════════════════════════════════════

  function setupCardObserver() {
    if (typeof IntersectionObserver === "undefined") {
      logErr(t("cs.log.observerFail", { err: "IntersectionObserver not available" }));
      return false;
    }
    if (cardObserver) return true; // già attivo

    try {
      cardObserver = new IntersectionObserver(
        (entries) => {
          if (!STATE.scanning) return;
          for (const e of entries) {
            if (e.isIntersecting) {
              processCard(e.target);
            }
          }
        },
        // rootMargin "0px 0px 200px 0px" → trigghera anche quando la card è 200px
        // sotto il viewport (FB la rende mentre stai per arrivarci).
        { root: null, rootMargin: "0px 0px 200px 0px", threshold: 0.1 }
      );
      log(t("cs.log.observerOn"));
      return true;
    } catch (e) {
      logErr(t("cs.log.observerFail", { err: e?.message ?? e }));
      cardObserver = null;
      return false;
    }
  }

  // Attacca l'observer alle card attualmente nel DOM. Da chiamare dopo ogni
  // scroll: le card nuove non sono nel WeakSet observedCards, l'observer le
  // emette al primo intersection. Le card già processate (observedCards) le
  // skippiamo silently — observe() su un nodo già osservato è no-op.
  function attachObserverToNewCards() {
    if (!cardObserver) return;
    const cards = findAdCards();
    for (const c of cards) {
      try { cardObserver.observe(c); } catch {}
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FLUSH BATCH — v0.7.0 parallel + retry esponenziale + queue mode
  //
  // - Max MAX_PARALLEL_FLUSHES batch in volo (semaforo manuale `inFlightFlushes`).
  // - Retry 3 tentativi: 1s, 3s, 9s con jitter ±30%.
  // - 401/403/422 → abort scan (auth_error o validation).
  // - 3 fail consecutivi network → queueMode ON: niente flush per 60s.
  // ═══════════════════════════════════════════════════════════════════════════

  function isAuthError(e) {
    const s = Number(e?.status ?? NaN);
    if (s === 401 || s === 403) return true;
    return /401|403/.test(String(e?.message ?? ""));
  }

  function isValidationError(e) {
    return Number(e?.status ?? NaN) === 422;
  }

  function isNetworkError(e) {
    if (!e) return false;
    if (typeof e.status !== "number") return true; // fetch failure
    return e.status === 0;
  }

  async function sendBatchWithRetry(items) {
    let lastErr = null;
    STATE.metrics.flushAttempts++;
    for (let attempt = 0; attempt <= FLUSH_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const res = await chrome.runtime.sendMessage({
          type: "PEGASUS_INGEST_BATCH",
          scanId: STATE.scanId,
          keyword: STATE.keyword,
          country: STATE.country,
          items,
          totalAds: STATE.totalFound,
        });
        if (res?.ok === false) {
          // SW returned a structured error (auth/validation/transient).
          const err = new Error(res.error || "ingest failed");
          err.status = res.status;
          throw err;
        }
        // Successo
        if (res?.scanId && !STATE.scanId) STATE.scanId = res.scanId;
        STATE.metrics.flushSuccesses++;
        return res;
      } catch (e) {
        lastErr = e;
        // Auth/validation: STOP — non ha senso ritentare.
        if (isAuthError(e)) {
          STATE.abortReason = "auth_error";
          log(t("cs.log.flushAuthAbort", { status: e?.status ?? "?" }));
          throw e;
        }
        if (isValidationError(e)) {
          STATE.abortReason = "validation_error";
          throw e;
        }
        // Ultimo tentativo: lascia esplodere.
        if (attempt === FLUSH_RETRY_DELAYS_MS.length) break;
        const baseDelay = FLUSH_RETRY_DELAYS_MS[attempt];
        const delayMs = jitter(baseDelay);
        log(t("cs.log.flushRetry", { n: attempt + 1, ms: delayMs, err: e?.message ?? e }));
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    STATE.metrics.flushFailures++;
    throw lastErr || new Error("flush failed");
  }

  async function flushBatch(force = false) {
    if (STATE.batch.length === 0) return;
    if (!force && STATE.batch.length < BATCH_FLUSH_SIZE) return;

    // Queue mode: non flushare, accumula. Il timer di recovery proverà ogni 60s.
    if (STATE.queueMode) {
      updateOverlayQueueMode();
      return;
    }

    // Semaforo: max 3 batch in volo. Se siamo già al limite, esci silently;
    // il prossimo tick proverà di nuovo.
    if (inFlightFlushes >= MAX_PARALLEL_FLUSHES) {
      return;
    }

    // Stacca il batch ATOMICAMENTE per evitare race con altri flush concorrenti.
    const items = STATE.batch.splice(0, BATCH_FLUSH_SIZE);
    if (items.length === 0) return;
    STATE.sinceLastBatch = Math.max(0, STATE.sinceLastBatch - items.length);

    inFlightFlushes++;
    if (inFlightFlushes > 1) {
      log(t("cs.log.parallelFlush", { n: inFlightFlushes }));
    }

    try {
      const res = await sendBatchWithRetry(items);
      log(t("cs.log.batchSent", { n: items.length, tot: STATE.totalFound }));
      updateOverlay({
        totalStores: res?.totalStores,
        sent: STATE.totalFound - STATE.batch.length,
      });
      // Reset network fail counter on success.
      STATE.consecutiveNetworkFails = 0;
      // If we were in queue mode, exit it and let the queue drain.
      if (STATE.queueMode) {
        STATE.queueMode = false;
        log(t("cs.log.queueModeOff", { n: STATE.batch.length }));
        updateOverlayQueueMode();
      }
    } catch (e) {
      logErr(t("cs.log.ingestFail", { err: e?.message ?? e }));
      // Re-queue items at the front so we retry them later.
      STATE.batch.unshift(...items);

      if (isNetworkError(e)) {
        STATE.consecutiveNetworkFails++;
        if (STATE.consecutiveNetworkFails >= NETWORK_FAIL_THRESHOLD && !STATE.queueMode) {
          STATE.queueMode = true;
          log(t("cs.log.queueModeOn", { n: STATE.batch.length }));
          updateOverlayQueueMode();
          // Retry every 60s — wake up the queue when network is back.
          if (queueModeTimer) clearTimeout(queueModeTimer);
          queueModeTimer = setTimeout(async () => {
            STATE.queueMode = false;
            await flushBatch(true);
          }, QUEUE_MODE_RETRY_MS);
        }
      }
    } finally {
      inFlightFlushes--;
    }

    // Se ci sono ancora item in coda e siamo sotto il semaforo, prova un altro
    // flush parallelo subito — sfrutta la capacità libera.
    if (STATE.batch.length >= BATCH_FLUSH_SIZE && inFlightFlushes < MAX_PARALLEL_FLUSHES && !STATE.queueMode) {
      // Fire-and-forget: non aspettare, prossimo flush in parallelo.
      flushBatch(false).catch(() => {});
    }
  }

  function startFlushTimer() {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = setInterval(() => flushBatch(true), BATCH_FLUSH_MS);
  }
  function stopFlushTimer() {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
    if (queueModeTimer) clearTimeout(queueModeTimer);
    queueModeTimer = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCROLL — v0.7.0 variability anti-detection
  //
  // Vecchio comportamento: sempre scroll-to-bottom. Detection risk: pattern
  // troppo regolare. Nuovo: 80% bottom, 15% al 80%, 5% al 60%. Simula utente
  // che scrolla "esplorando" invece di vacuum-cleaner.
  // ═══════════════════════════════════════════════════════════════════════════

  function scrollVariable() {
    const h = document.documentElement.scrollHeight;
    const r = Math.random();
    let targetRatio = 1.0;
    if (r < 0.05) targetRatio = 0.60;
    else if (r < 0.20) targetRatio = 0.80;
    // else default 1.0 (80%)
    const top = Math.round(h * targetRatio);
    window.scrollTo({ top, behavior: "instant" });

    // Always re-pin to bottom on the next tick if we're at 1.0, so FB's
    // IntersectionObserver triggers on the last card.
    if (targetRatio === 1.0) {
      try {
        const cards = findAdCards();
        const last = cards[cards.length - 1];
        if (last && typeof last.scrollIntoView === "function") {
          last.scrollIntoView({ behavior: "instant", block: "end" });
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
        }
      } catch {}
    }
    return h;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // "VEDI ALTRO" / "SEE MORE" CLICK — v0.7.1
  //
  // FB Ads Library sometimes paginates with an explicit "Vedi altro" /
  // "See more" / "Load more" button instead of pure infinite scroll. The
  // virtualized list above the button is exhausted; without a click on it,
  // the scraper plateaus at ~16 cards and never advances. Reported via
  // screenshot on 2026-05-22 (klarna / SE → 0 ads after 4 cycles, button
  // "Vedi altro" visible right under the ad grid).
  //
  // We sweep every <div role="button">, <a role="button">, <button> on the
  // page and click the first one whose visible text matches the multilingual
  // "see more" pattern AND is in (or near) the viewport. Dispatching click
  // via .click() works on FB's React handlers — they re-attach listeners on
  // every render, but a plain click event is honored.
  // ═══════════════════════════════════════════════════════════════════════════

  // One regex per supported locale — case-insensitive. We match permissive
  // variants like "vedi altro" / "vedi di più" / "mostra altri risultati"
  // because FB rotates the exact wording across A/B tests.
  const SEE_MORE_PATTERNS = [
    /^\s*vedi\s+(altro|di\s+pi[uù]|altri)/i,         // IT
    /^\s*mostra\s+(altro|di\s+pi[uù]|altri)/i,       // IT alt
    /^\s*see\s+more/i,                                // EN
    /^\s*show\s+more/i,                               // EN alt
    /^\s*load\s+more/i,                               // EN alt
    /^\s*ver\s+m[aá]s/i,                              // ES
    /^\s*mostrar\s+m[aá]s/i,                          // ES alt
    /^\s*voir\s+plus/i,                               // FR
    /^\s*afficher\s+plus/i,                           // FR alt
    /^\s*mehr\s+anzeigen/i,                           // DE
    /^\s*mehr\s+laden/i,                              // DE alt
    /^\s*meer\s+(bekijken|laden|weergeven)/i,         // NL
    /^\s*ver\s+mais/i,                                // PT
  ];

  // Track the last click so we don't hammer the button if FB ignores us.
  let lastSeeMoreClickAt = 0;
  const SEE_MORE_CLICK_COOLDOWN_MS = 3000;

  function matchesSeeMore(text) {
    if (!text || text.length > 60) return false; // long blobs are never the button
    return SEE_MORE_PATTERNS.some((re) => re.test(text));
  }

  function isInOrNearViewport(el) {
    try {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      // Within 1.5 viewport-heights of current scroll position (above or below).
      return r.top < vh * 1.5 && r.bottom > -vh * 0.5 && r.width > 0 && r.height > 0;
    } catch {
      return false;
    }
  }

  /**
   * Find and click a "Vedi altro" / "See more" pagination button if visible.
   * Returns true if a click happened, false otherwise.
   * Throttled at SEE_MORE_CLICK_COOLDOWN_MS to avoid double-firing.
   */
  function clickSeeMoreIfPresent() {
    if (Date.now() - lastSeeMoreClickAt < SEE_MORE_CLICK_COOLDOWN_MS) return false;

    // Cast a wide net: any clickable element with short visible text.
    const candidates = document.querySelectorAll(
      'div[role="button"], a[role="button"], button, [aria-label]'
    );
    for (const el of candidates) {
      // Prefer the directly visible text, fall back to aria-label.
      const txt =
        (el.textContent || "").trim() ||
        el.getAttribute("aria-label") ||
        "";
      if (!matchesSeeMore(txt)) continue;
      if (!isInOrNearViewport(el)) continue;
      // Skip the overlay's own buttons just in case (shadow DOM isolates
      // them but belt-and-suspenders).
      if (el.closest("#pegasus-overlay-host")) continue;

      try {
        el.scrollIntoView({ behavior: "instant", block: "center" });
        el.click();
        lastSeeMoreClickAt = Date.now();
        log(t("cs.log.seeMoreClicked", { text: txt.slice(0, 40) }));
        return true;
      } catch {
        // Click can throw if FB removes the element mid-interaction — silent.
        return false;
      }
    }
    return false;
  }

  /**
   * Recovery: scroll su in cima, aspetta, poi scroll giù di nuovo.
   * Spesso "sveglia" il lazy-load di FB quando si è incantato.
   */
  async function recoveryKick() {
    log(t("cs.log.recoveryKick"));
    STATE.metrics.recoveryKicks++;
    window.scrollTo({ top: 0, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 1500));
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
    // After the kick is the moment FB is most likely to expose a "Vedi
    // altro" button (the virtualized list has unloaded everything above
    // and re-rendered the end-of-results CTA). Reset the cooldown so we
    // can click it immediately if present.
    lastSeeMoreClickAt = 0;
    await new Promise((r) => setTimeout(r, 1000));
    clickSeeMoreIfPresent();
    await new Promise((r) => setTimeout(r, 2000));
  }

  function currentCardCount() {
    return findAdCards().length;
  }

  async function waitForNewContent(prevCards, prevHeight) {
    const start = Date.now();
    while (Date.now() - start < MAX_WAIT_NEW_CONTENT_MS) {
      await new Promise((r) => setTimeout(r, 500));
      const cards = currentCardCount();
      const h = document.documentElement.scrollHeight;
      if (cards > prevCards || h > prevHeight) return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SPEED COMPUTATION — sliding window 60s
  // Ritorna ads/min calcolato sugli ultimi 60s di foundTimestamps.
  // ═══════════════════════════════════════════════════════════════════════════
  function computeSpeed() {
    const now = Date.now();
    const cutoff = now - SPEED_WINDOW_MS;
    let count = 0;
    // Walk backward (più nuovi in coda) finché non sono fuori window.
    for (let i = STATE.foundTimestamps.length - 1; i >= 0; i--) {
      if (STATE.foundTimestamps[i] < cutoff) break;
      count++;
    }
    // Normalizza a per-minute. Se la scan è iniziata <60s fa, scala in proporzione
    // così non sottostimiamo all'inizio.
    const windowActiveMs = Math.min(SPEED_WINDOW_MS, now - STATE.startedAt);
    if (windowActiveMs < 1000) return 0;
    return Math.round((count / windowActiveMs) * 60_000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADAPTIVE PACING
  //
  // Sliding window di 3 cicli: se in media >10 nuovi ad/ciclo → -30% pace.
  // Se 0 → +50% (lascia respirare prima di dichiarare stagnazione).
  // ═══════════════════════════════════════════════════════════════════════════
  function adjustPace(newAdsThisCycle) {
    STATE.adsPerCycleWindow.push(newAdsThisCycle);
    if (STATE.adsPerCycleWindow.length > 3) STATE.adsPerCycleWindow.shift();

    if (STATE.adsPerCycleWindow.length < 3) return; // Aspetta che il window sia pieno.

    const avg = STATE.adsPerCycleWindow.reduce((a, b) => a + b, 0) / 3;
    if (avg > 10) {
      const next = Math.max(SCROLL_CYCLE_MS_MIN, Math.round(STATE.currentCycleMs * 0.7));
      if (next !== STATE.currentCycleMs) {
        log(t("cs.log.paceFaster", { n: Math.round(avg) }));
        STATE.currentCycleMs = next;
      }
    } else if (avg === 0) {
      const next = Math.min(SCROLL_CYCLE_MS_MAX, Math.round(STATE.currentCycleMs * 1.5));
      if (next !== STATE.currentCycleMs) {
        log(t("cs.log.paceSlower"));
        STATE.currentCycleMs = next;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PERSIST PROGRESS — v0.6.0 (storage write per ciclo) + v0.7.0 enrichments
  // ═══════════════════════════════════════════════════════════════════════════
  async function persistProgress() {
    try {
      await chrome.storage.local.set({
        pegasus_scrape_state: {
          scanning: STATE.scanning,
          scanId: STATE.scanId,
          keyword: STATE.keyword,
          country: STATE.country,
          limit: STATE.limit,
          totalFound: STATE.totalFound,
          cycles: STATE.cycles,
          // Storing the seen-set lets a future "resume" skip dedup-by-URL.
          // Cap at ~5000 entries to avoid blowing storage quota (5MB local).
          seen: Array.from(STATE.seen).slice(-5000),
          startedAt: STATE.startedAt,
          timestamp: Date.now(),
        },
      });
    } catch {
      // Storage quota / disconnected context — non-fatal.
    }
  }

  // v0.6.0 — visibilitychange handler.
  function setupVisibilityHandler() {
    document.addEventListener("visibilitychange", () => {
      if (!STATE.scanning) return;
      if (document.visibilityState === "hidden") {
        log(t("cs.log.visibilityHidden"));
      } else if (document.visibilityState === "visible") {
        log(t("cs.log.visibilityVisible"));
        if (keepAlive.audio?.ctx?.state === "suspended") {
          keepAlive.audio.ctx.resume().catch(() => {});
        }
        // Re-acquire wake lock if it was dropped while hidden.
        if (!keepAlive.wakeLock && navigator.wakeLock) {
          tryWakeLockKeepAlive().catch(() => {});
        }
        (async () => {
          await recoveryKick();
          collectFromVisibleCards();
        })().catch(() => {});
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESUME FROM STALE STATE — v0.7.0
  //
  // Al boot, se troviamo pegasus_scrape_state recente (<5min), chiediamo al SW
  // se vuole che riprendiamo. Il SW conferma se ha ancora un RUNTIME.scanId.
  // ═══════════════════════════════════════════════════════════════════════════
  async function maybeResume() {
    try {
      const obj = await chrome.storage.local.get("pegasus_scrape_state");
      const stale = obj?.pegasus_scrape_state;
      if (!stale || !stale.scanning) return;
      const ageMs = Date.now() - (stale.timestamp || 0);
      if (ageMs > RESUME_MAX_AGE_MS) return;
      const ageSec = Math.round(ageMs / 1000);
      log(t("cs.log.resumeFound", { n: stale.totalFound || 0, age: ageSec }));

      // Handshake col SW: vuole davvero che riprendiamo?
      const resp = await chrome.runtime.sendMessage({
        type: "PEGASUS_RESUME",
        scanId: stale.scanId,
        keyword: stale.keyword,
        country: stale.country,
        totalFound: stale.totalFound,
      });
      if (!resp?.ok) {
        log(t("cs.log.resumeRejected"));
        return;
      }
      // Ripopola STATE e riparti.
      STATE.scanId = stale.scanId;
      STATE.keyword = stale.keyword;
      STATE.country = stale.country;
      STATE.limit = stale.limit || 0;
      STATE.totalFound = stale.totalFound || 0;
      STATE.seen = new Set(Array.isArray(stale.seen) ? stale.seen : []);
      STATE.startedAt = stale.startedAt || Date.now();
      STATE.scanning = true;
      STATE.abortReason = null;
      STATE.cycles = stale.cycles || 0;
      mainLoop().catch((e) => logErr("Resume loop failed: " + (e?.message ?? e)));
    } catch {
      // Storage error or SW down — ignore, manual start funzionerà.
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN LOOP — v0.7.0 with adaptive pacing + observer + idle micro-pauses
  // ═══════════════════════════════════════════════════════════════════════════
  async function mainLoop() {
    log(t("cs.log.scanStart"));
    STATE.startedAt = STATE.startedAt || Date.now();
    STATE.metrics.startedAt = STATE.startedAt;
    STATE.currentCycleMs = SCROLL_CYCLE_MS_BASE;
    startFlushTimer();

    // Multi-strategy keep-alive (audio → webrtc → wakelock).
    startKeepAlive();
    setupVisibilityHandler();

    // Live overlay UI.
    try {
      createOverlay(STATE.keyword, STATE.country);
      updateOverlayKeepAlive();
    } catch (e) {
      logErr(t("cs.log.overlayFail", { err: e?.message ?? e }));
    }

    // IntersectionObserver setup. Fallback to polling if unavailable.
    const observerOk = setupCardObserver();

    // First pass: process whatever's already in the DOM (the observer only
    // fires on FUTURE intersections; existing cards need a manual sweep).
    collectFromVisibleCards();
    if (observerOk) attachObserverToNewCards();

    let pausedForIdleCycles = 0;

    while (STATE.scanning && !STATE.abortReason) {
      STATE.cycles++;
      STATE.metrics.cycles = STATE.cycles;
      const before = STATE.totalFound;

      // 1) Raccolta esplicita (se observer disponibile, è quasi sempre no-op:
      //    le card già le abbiamo prese in real-time).
      collectFromVisibleCards();
      if (STATE.abortReason) break;

      // 2) Snapshot pre-scroll per detect crescita
      const prevCards = currentCardCount();
      const prevHeight = scrollVariable();

      // 2.5) v0.7.1 — click "Vedi altro" se FB ha smesso di paginare in
      //      automatico e mostra il bottone. Throttled internamente al
      //      cooldown, quindi safe da chiamare ogni ciclo.
      clickSeeMoreIfPresent();

      // 3) Aspetta che nuove card appaiano o il page-height cresca (max 8s)
      const grew = await waitForNewContent(prevCards, prevHeight);

      // 4) Re-attach observer alle (eventuali) nuove card + re-raccogli
      if (observerOk) attachObserverToNewCards();
      collectFromVisibleCards();
      const newItems = STATE.totalFound - before;
      STATE.metrics.cardsPerCycle.push(newItems);
      // Cap il log array per non far esplodere la memoria su run lunghi.
      if (STATE.metrics.cardsPerCycle.length > 1000) STATE.metrics.cardsPerCycle.shift();

      // 5) Adaptive pacing — modula currentCycleMs in base alla resa.
      adjustPace(newItems);

      // 6) Stagnazione detect
      if (!grew && newItems === 0) {
        STATE.sinceLastScrollGrowth++;
        STATE.metrics.stagnationStreak = STATE.sinceLastScrollGrowth;

        if (
          STATE.sinceLastScrollGrowth > 0 &&
          STATE.sinceLastScrollGrowth % RECOVERY_EVERY_CYCLES === 0
        ) {
          await recoveryKick();
          collectFromVisibleCards();
        }

        if (STATE.sinceLastScrollGrowth >= STAGNATION_MAX_CYCLES) {
          log(t("cs.log.stagnation", { n: STATE.sinceLastScrollGrowth }));
          STATE.abortReason = "stagnant";
          break;
        }
      } else {
        STATE.sinceLastScrollGrowth = 0;
        STATE.metrics.stagnationStreak = 0;
      }

      // 7) Push metrics al popup + aggiorna overlay live
      const sentCount = STATE.totalFound - STATE.batch.length;
      chrome.runtime.sendMessage({
        type: "PEGASUS_METRICS",
        totalFound: STATE.totalFound,
        cycles: STATE.cycles,
      });
      updateOverlay({
        totalFound: STATE.totalFound,
        sent: Math.max(0, sentCount),
      });
      updateOverlaySpeed();
      updateOverlayKeepAlive();
      updateOverlayQueueMode();

      // 8) Persist progress every cycle so a tab crash doesn't lose state.
      persistProgress();

      // 9) Random idle micro-pause: 1 ogni ~8 cicli, 6-12s extra. Simula
      //    utente che si ferma a leggere un ad — pattern anti-detection.
      pausedForIdleCycles++;
      if (pausedForIdleCycles >= 8 && Math.random() < 0.2) {
        const pauseSec = 6 + Math.floor(Math.random() * 7); // 6..12
        log(t("cs.log.idleMicroPause", { s: pauseSec }));
        await new Promise((r) => setTimeout(r, pauseSec * 1000));
        pausedForIdleCycles = 0;
      }

      // 10) Pausa con jitter prima del prossimo ciclo (pace adattivo).
      await new Promise((r) => setTimeout(r, jitter(STATE.currentCycleMs)));
    }

    stopFlushTimer();
    stopKeepAlive();
    // Disconnetti l'observer (la WeakSet è già garbage-collectable).
    if (cardObserver) {
      try { cardObserver.disconnect(); } catch {}
      cardObserver = null;
    }
    // Drain residuo: flush forzato di tutto quello che resta in coda.
    while (STATE.batch.length > 0) {
      try {
        await flushBatch(true);
      } catch {
        break; // se fallisce, lasciamo cadere — il finalize() lato server tracking
      }
      if (STATE.batch.length === 0) break;
      // Se siamo bloccati in queue mode al termine, esci comunque.
      if (STATE.queueMode) break;
    }
    // Clear persisted state on natural completion.
    try { await chrome.storage.local.remove("pegasus_scrape_state"); } catch {}

    STATE.metrics.endedAt = Date.now();
    chrome.runtime.sendMessage({
      type: "PEGASUS_DONE",
      scanId: STATE.scanId,
      totalFound: STATE.totalFound,
      reason: STATE.abortReason ?? "stopped",
      durationMs: Date.now() - STATE.startedAt,
      metrics: STATE.metrics,
    });

    // Final overlay
    const ok =
      STATE.abortReason === "limit" ||
      STATE.abortReason === "stagnant" ||
      STATE.abortReason === "user_stop";
    updateOverlay({ totalFound: STATE.totalFound, sent: STATE.totalFound });
    if (STATE.abortReason === "auth_error") {
      updateOverlayStatus(t("overlay.status.authError"), "err");
    } else if (ok) {
      const statusKey =
        STATE.abortReason === "limit"
          ? "overlay.status.limit"
          : STATE.abortReason === "user_stop"
          ? "overlay.status.stopped"
          : "overlay.status.completed";
      updateOverlayStatus(t(statusKey, { n: STATE.totalFound }), "ok");
    } else {
      updateOverlayStatus(
        t("overlay.status.stoppedReason", { reason: STATE.abortReason || "stopped" }),
      );
    }
    setTimeout(() => removeOverlay(), 30_000);

    log(t("cs.log.scanDone", { n: STATE.totalFound, reason: STATE.abortReason }));
  }

  // === Message handler ===
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "PEGASUS_START") {
      if (STATE.scanning) {
        sendResponse({ ok: false, error: t("cs.err.scanInProgress") });
        return false;
      }
      STATE.scanning = true;
      STATE.scanId = msg.scanId ?? null;
      STATE.keyword = msg.keyword ?? "";
      STATE.country = msg.country ?? "ALL";
      STATE.limit = Number(msg.limit ?? 0) || 0;
      STATE.seen.clear();
      STATE.batch = [];
      STATE.totalFound = 0;
      STATE.sinceLastBatch = 0;
      STATE.sinceLastScrollGrowth = 0;
      STATE.abortReason = null;
      STATE.cycles = 0;
      STATE.startedAt = Date.now();
      STATE.foundTimestamps = [];
      STATE.queueMode = false;
      STATE.consecutiveNetworkFails = 0;
      STATE.adsPerCycleWindow = [];
      STATE.currentCycleMs = SCROLL_CYCLE_MS_BASE;
      STATE.metrics = {
        cycles: 0,
        cardsPerCycle: [],
        flushAttempts: 0,
        flushSuccesses: 0,
        flushFailures: 0,
        recoveryKicks: 0,
        stagnationStreak: 0,
        keepAliveStrategy: "none",
        startedAt: Date.now(),
        endedAt: null,
      };
      observedCards = new WeakSet();
      mainLoop().catch((e) => logErr("Main loop crashed: " + (e?.message ?? e)));
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === "PEGASUS_STOP") {
      STATE.scanning = false;
      STATE.abortReason = "user_stop";
      sendResponse({ ok: true });
      return false;
    }

    // v0.7.0 — heartbeat ping. SW invia ogni 30s; se non rispondiamo per 2 ping
    // di fila, SW dichiara CS morto e tenta re-inject via chrome.scripting.
    if (msg?.type === "PEGASUS_HEARTBEAT") {
      sendResponse({
        ok: true,
        scanning: STATE.scanning,
        totalFound: STATE.totalFound,
        cycles: STATE.cycles,
      });
      return false;
    }

    if (msg?.type === "PEGASUS_PING_CS") {
      sendResponse({
        ok: true,
        scanning: STATE.scanning,
        totalFound: STATE.totalFound,
      });
      return false;
    }
  });

  // Annuncia al service worker che il content script è pronto
  chrome.runtime.sendMessage({ type: "PEGASUS_CS_READY", href: location.href }).catch(() => {});

  // v0.7.0 — al boot, check se c'è uno scan stale da riprendere.
  // Fire-and-forget — il manuale "Start" funziona comunque.
  maybeResume().catch(() => {});
})();
