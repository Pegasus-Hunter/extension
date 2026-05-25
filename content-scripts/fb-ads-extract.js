// Content script — gira dentro facebook.com/ads/library/* per scrappare i risultati.
// Comunica solo via chrome.runtime.onMessage con il service worker.
//
// Approccio:
//  1) Aspetta che la pagina sia idle e che la lista risultati sia montata.
//  2) Estrae tutti i link CTA degli ad (sono dietro lm.facebook.com/l.php redirect).
//  3) Decodifica i redirect → URL reale del prodotto.
//  4) Filtra per URL che hanno /products/ (Shopify pattern).
//  5) Scrolla la finestra per caricare il batch successivo, con jitter.
//  6) Manda batch al service worker ogni N nuovi item o ogni T secondi.
//  7) Si ferma quando: hit del limite, scroll non aggiunge più nuovi item per 3 cicli,
//     o ricevuto messaggio STOP.
//
// Robustness: Facebook obfusca aria-label / class names. Usiamo selettori
// strutturali (link `[href]` dentro card `[role="article"]` o pattern noti)
// + fallback su pattern URL (l.php, /l.php, /ads/library/?id=).

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
  };

  const BATCH_FLUSH_SIZE = 25;
  const BATCH_FLUSH_MS = 10_000;
  // Pacing tra cicli (con jitter ±30%). Più lento = meno rischio di flag FB
  // ma scansione più lunga. Aumentato per dare a FB tempo di rispondere.
  const SCROLL_CYCLE_MS = 4000;
  // Cicli consecutivi senza nuovi annunci PRIMA di dichiarare la scansione finita.
  // Con MAX_WAIT_NEW_CONTENT_MS=8s e SCROLL_CYCLE_MS=4s → ~20 cicli = ~4 min
  // di pazienza prima di mollare. FB Ads Library può avere pause di 30-60s
  // tra batch quando ne ha caricati molti.
  const STAGNATION_MAX_CYCLES = 25;
  // Dopo lo scroll-to-bottom, quanto aspettare per vedere nuove card prima
  // di considerare il ciclo "vuoto". Polling ogni 500ms.
  const MAX_WAIT_NEW_CONTENT_MS = 8000;
  // Recovery: ogni RECOVERY_EVERY_CYCLES cicli senza crescita, faccio
  // scroll-up + scroll-down per "svegliare" il lazy-load di Facebook.
  const RECOVERY_EVERY_CYCLES = 4;
  let flushTimer = null;

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
  //
  // Mostra in alto a destra della pagina FB Ads Library un widget fisso
  // con contatori che salgono in tempo reale durante lo scraping. L'utente
  // VEDE cosa sta facendo l'estensione, niente magia nascosta.
  //
  // Vantaggi: trust, educazione, demo marketing-ready, niente FB detection.
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

  function isShopifyProductUrl(url) {
    if (!url || typeof url !== "string") return false;
    if (!/^https?:\/\//i.test(url)) return false;
    if (!/\/products\//i.test(url)) return false;
    // Esclude domini noti non-Shopify finti positivi
    if (/(amazon|ebay|aliexpress|temu|walmart)\./i.test(url)) return false;
    return true;
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
  // FB Ads Library extraction (extension v0.9.0+)
  //
  // Tre famiglie di campi:
  //   1) Legacy v0.5.0: advertiser, imageUrl, activeAds — usati da scanner
  //      di base + dashboard /app/scanner. Devono restare working.
  //   2) NEW (v0.9.0) — identità ad: libraryId, pageId, pageUrl_fb. Servono
  //      a deduplicare e linkare gli ad allo stesso advertiser.
  //   3) NEW (v0.9.0) — timeline & distribution: startDate, platforms[],
  //      regions[]. Servono al backend per stimare la spesa con CPM × giorni.
  //
  // Best-effort: ogni try/catch isolato così se FB cambia un selettore solo
  // quel campo va a null, il resto resta funzionante. La compatibilità con
  // server v0.8.x è garantita perché tutti i nuovi campi sono opzionali nel
  // ScannerItem Pydantic (vedi server/app/routes_pegasus.py).
  // ═══════════════════════════════════════════════════════════════════════════

  // Estrai library_id dall'URL "Vedi i dettagli dell'annuncio" o dai link
  // interni "?id=NNN" della card. FB lo espone come parametro `id` nei link
  // verso il pannello dettagli — è il primo ancoraggio robusto disponibile.
  function extractLibraryId(card) {
    try {
      const links = card.querySelectorAll('a[href*="/ads/library/?id="], a[href*="?id="]');
      for (const a of links) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/[?&]id=(\d{6,20})/);
        if (m) return m[1];
      }
    } catch {}
    return null;
  }

  // Estrai page_id + page_url FB. La card ha sempre 1+ link al profilo FB
  // della pagina advertiser (es. `/MyShop` o `/profile.php?id=12345`).
  // Page_id può essere derivato da `?id=` o dallo slug stesso.
  function extractPageInfo(card) {
    let pageId = null;
    let pageName = null;
    let pageUrl = null;
    try {
      // Cerca link a profile FB della pagina. Esclusioni: /ads/library, /l.php,
      // ancore (#), link esterni.
      const links = card.querySelectorAll('a[role="link"][href^="/"]');
      for (const a of links) {
        const href = a.getAttribute("href") || "";
        if (!href || href.startsWith("/ads/") || href.startsWith("/l.php") || href.startsWith("#")) continue;
        const text = (a.textContent || "").trim();
        if (!text || text.length > 200) continue;
        // Match: /<slug>/  OR  /profile.php?id=NNN
        const slugMatch = href.match(/^\/([A-Za-z0-9._-]+)\/?$/);
        const profileMatch = href.match(/^\/profile\.php\?id=(\d+)/);
        if (slugMatch) {
          pageName = pageName || text;
          pageUrl = pageUrl || `https://www.facebook.com${href}`;
          // Page_id non si ricava dallo slug; lo proviamo dal data-* attributes.
          break;
        } else if (profileMatch) {
          pageName = pageName || text;
          pageId = pageId || profileMatch[1];
          pageUrl = pageUrl || `https://www.facebook.com${href}`;
          break;
        }
      }
      // Fallback page_id: cerca attributi data-*-id su elementi della card.
      if (!pageId) {
        const dataEl = card.querySelector('[data-ad-id], [data-page-id], [data-actor-id]');
        if (dataEl) {
          pageId = dataEl.getAttribute("data-page-id") ||
                   dataEl.getAttribute("data-actor-id") ||
                   null;
        }
      }
    } catch {}
    return { pageId, pageName, pageUrl };
  }

  // Estrai start_date dell'ad. FB lo mostra come "Avviato il 14 nov 2025"
  // (IT) o "Started running on Nov 14, 2025" (EN) ecc. Regex multilingua
  // → ISO date. Ritorna null se non trova un match riconoscibile.
  function extractStartDate(card) {
    try {
      const txt = (card.textContent || "");
      const patterns = [
        // IT: "Avviato il 14 nov 2025" / "Avviato il 14 novembre 2025"
        /Avviato\s+il\s+(\d{1,2})\s+([a-zà]{3,12})\s+(\d{4})/i,
        // EN: "Started running on Nov 14, 2025" / "Active since Nov 14, 2025"
        /(?:Started running on|Active since)\s+([A-Za-z]{3,12})\s+(\d{1,2}),\s+(\d{4})/i,
        // ES: "Empezó a publicarse el 14 nov 2025"
        /Empez[óo]\s+a\s+publicarse\s+el\s+(\d{1,2})\s+([a-záéíóú]{3,12})\s+(\d{4})/i,
        // FR: "Diffusion lancée le 14 nov 2025"
        /Diffusion\s+lanc[ée]e\s+le\s+(\d{1,2})\s+([a-zéûï]{3,12})\s+(\d{4})/i,
        // DE: "Geschaltet seit 14. Nov. 2025"
        /Geschaltet\s+seit\s+(\d{1,2})\.\s+([A-Za-zäöü]{3,12})\.?\s+(\d{4})/i,
        // NL: "Gestart op 14 nov 2025"
        /Gestart\s+op\s+(\d{1,2})\s+([a-z]{3,12})\s+(\d{4})/i,
      ];
      const MONTHS = {
        // IT (full + abbr)
        gen: 1, gennaio: 1, feb: 2, febbraio: 2, mar: 3, marzo: 3, apr: 4, aprile: 4,
        mag: 5, maggio: 5, giu: 6, giugno: 6, lug: 7, luglio: 7, ago: 8, agosto: 8,
        set: 9, settembre: 9, ott: 10, ottobre: 10, nov: 11, novembre: 11, dic: 12, dicembre: 12,
        // EN
        jan: 1, january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
        july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
        // FR / ES / DE / NL — common ones already overlap with IT/EN abbr.
        ene: 1, enero: 1, abr: 4, abril: 4, ago: 8, agosto: 8, sep: 9, sept: 9,
        oct: 10, dec: 12, dicembre: 12, dezember: 12, mär: 3, mai: 5,
        jui: 6, juin: 6, juil: 7, juillet: 7, ao: 8, oct: 10, octobre: 10,
        okt: 10, dez: 12,
      };
      for (const re of patterns) {
        const m = txt.match(re);
        if (!m) continue;
        // EN format puts month first: [_, month, day, year]; others put day first.
        let day, monthStr, year;
        if (/^(?:Started|Active)/i.test(m[0])) {
          monthStr = m[1].toLowerCase();
          day = parseInt(m[2], 10);
          year = parseInt(m[3], 10);
        } else {
          day = parseInt(m[1], 10);
          monthStr = m[2].toLowerCase().replace(/\.$/, "");
          year = parseInt(m[3], 10);
        }
        const month = MONTHS[monthStr] || MONTHS[monthStr.slice(0, 3)];
        if (!month || !day || !year || year < 2018 || year > 2099) continue;
        // Return ISO date "YYYY-MM-DD". Server parses with _parse_iso_date.
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    } catch {}
    return null;
  }

  // Quali piattaforme servono l'ad? FB mostra icone (FB / IG / Messenger /
  // Audience Network) sotto il header dell'ad. Le icone hanno aria-label
  // multilingua riconoscibili.
  function extractPlatforms(card) {
    const found = new Set();
    try {
      // Strategia 1: aria-label sulle icone piattaforma.
      const labelled = card.querySelectorAll('[aria-label]');
      for (const el of labelled) {
        const label = (el.getAttribute("aria-label") || "").toLowerCase();
        if (label.includes("facebook")) found.add("facebook");
        if (label.includes("instagram")) found.add("instagram");
        if (label.includes("messenger")) found.add("messenger");
        if (label.includes("audience network") || label.includes("rete pubblicità") ||
            label.includes("réseau") || label.includes("audience-netzwerk")) {
          found.add("audience_network");
        }
      }
      // Strategia 2: nomi noti nel testo della card (fallback).
      if (found.size === 0) {
        const txt = (card.textContent || "").toLowerCase();
        if (txt.includes("facebook")) found.add("facebook");
        if (txt.includes("instagram")) found.add("instagram");
        if (txt.includes("messenger")) found.add("messenger");
      }
    } catch {}
    return Array.from(found);
  }

  // Conteggio creative_count: 1 per image/video singolo, ≥2 per carousel.
  // Cerca thumbnail/dots indicators del carousel.
  function extractCreativeCount(card) {
    try {
      // FB segna i carousel con role="list" o data-pagelet contenenti più
      // figli che sono <img>/<video>. Approssimazione: contiamo <img> >=200px.
      const imgs = card.querySelectorAll("img");
      let bigImgs = 0;
      for (const img of imgs) {
        const w = img.naturalWidth || parseInt(img.width, 10) || 0;
        if (w >= 150) bigImgs++;
      }
      const videos = card.querySelectorAll("video").length;
      return Math.max(1, bigImgs + videos);
    } catch {}
    return 1;
  }

  function extractMediaType(card) {
    try {
      if (card.querySelector("video")) {
        // Carousel può contenere comunque un video — distinguiamo dopo.
        const count = extractCreativeCount(card);
        return count > 1 ? "carousel" : "video";
      }
      const count = extractCreativeCount(card);
      if (count > 1) return "carousel";
      if (card.querySelector("img")) return "image";
    } catch {}
    return null;
  }

  function extractVideoUrl(card) {
    try {
      const v = card.querySelector("video[src], video source[src]");
      if (v) return v.getAttribute("src") || (v.querySelector("source")?.getAttribute("src") ?? null);
    } catch {}
    return null;
  }

  // CTA button: testo del bottone "Acquista ora" / "Shop now" / "Ordina ora".
  function extractCta(card) {
    try {
      // Trova il bottone CTA: di solito è il `[role="button"]` o l'<a> che
      // contiene il link landing. Prendi il testo se è corto + verbo-azione.
      const candidates = card.querySelectorAll('[role="button"], a[href]');
      const ctaPatterns = /^(acquista|ordina|scopri|shop|buy|order|learn|sign|get|book|download|register|install|subscribe|contact|call|view|preorder|app|prenota|chiama)/i;
      for (const el of candidates) {
        const t = (el.textContent || "").trim();
        if (t.length >= 3 && t.length <= 30 && ctaPatterns.test(t)) {
          return t;
        }
      }
    } catch {}
    return null;
  }

  // Primary text + body text (i due blocchi principali dell'ad creative).
  function extractTexts(card) {
    let primary = null;
    let body = null;
    try {
      // Heuristic: i blocchi testuali "lunghi" dentro la card che non sono
      // il nome dell'advertiser né la CTA. Prendi i primi 2 più sostanziosi.
      const texts = card.querySelectorAll('div[dir="auto"], span[dir="auto"]');
      const blobs = [];
      for (const t of texts) {
        const s = (t.textContent || "").trim();
        if (s.length >= 20 && s.length <= 2000) blobs.push(s);
      }
      blobs.sort((a, b) => b.length - a.length);
      if (blobs[0]) primary = blobs[0].slice(0, 500);
      if (blobs[1]) body = blobs[1].slice(0, 1500);
    } catch {}
    return { primary, body };
  }

  // Regions: FB indica "Pubblicato in IT, FR" sui meta dell'ad. Multi-lingua.
  function extractRegions(card) {
    const out = new Set();
    try {
      const txt = card.textContent || "";
      // Pattern: country code di 2 lettere preceduto da virgola/spazio.
      // Più affidabile cercare i tag "Pubblicato in"/"Active in"/"Published in".
      const inPatterns = [
        /(?:Pubblicato\s+in|Active\s+in|Published\s+in|Diffus[ée]\s+(?:dans|en))\s+([A-Z]{2}(?:\s*,\s*[A-Z]{2})*)/i,
      ];
      for (const re of inPatterns) {
        const m = txt.match(re);
        if (m) {
          for (const cc of m[1].split(",")) {
            const c = cc.trim().toUpperCase();
            if (c.length === 2) out.add(c);
          }
        }
      }
    } catch {}
    return Array.from(out);
  }

  // Estrae info aggiuntive da una card ad. Wrapper retrocompatibile:
  // ritorna SEMPRE le 3 chiavi storiche (advertiser, imageUrl, activeAds)
  // + i nuovi campi v0.9.0. Tutto best-effort, ogni campo isolato in try.
  function extractCardInfo(card) {
    let advertiser = null;
    let imageUrl = null;
    let activeAds = null;

    try {
      const advLink = card.querySelector('a[role="link"][href^="/"]');
      if (advLink && advLink.textContent.trim()) {
        advertiser = advLink.textContent.trim().slice(0, 200);
      }
    } catch {}

    try {
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
      const txt = card.textContent || "";
      const patterns = [
        /(\d{1,4})\s+annunci?\s+(usano|attivi|in\s+esecuzione)/i,
        /(\d{1,4})\s+ads?\s+(use|active|running)/i,
        /(\d{1,4})\s+advertenties?\s+(gebruik|actief|wordt\s+uitgevoerd)/i,
        /(\d{1,4})\s+anzeigen?\s+(verwenden|aktiv)/i,
        /(\d{1,4})\s+annonces?\s+(utilisent|actives?)/i,
        /(\d{1,4})\s+anuncios?\s+(utilizan|activos?)/i,
      ];
      for (const p of patterns) {
        const m = txt.match(p);
        if (m) {
          activeAds = parseInt(m[1], 10);
          break;
        }
      }
    } catch {}

    // v0.9.0 extensions — additive, defensive, all-nullable.
    const libraryId = extractLibraryId(card);
    const pageInfo = extractPageInfo(card);
    const startDate = extractStartDate(card);
    const platforms = extractPlatforms(card);
    const regions = extractRegions(card);
    const mediaType = extractMediaType(card);
    const creativeCount = extractCreativeCount(card);
    const videoUrl = extractVideoUrl(card);
    const ctaText = extractCta(card);
    const texts = extractTexts(card);

    return {
      // legacy keys (do not rename — backend + dashboard consume these)
      advertiser,
      imageUrl,
      activeAds,
      // v0.9.0 — all keys match the ScannerItem Pydantic schema names
      libraryId,
      pageId: pageInfo.pageId,
      pageName: pageInfo.pageName || advertiser,
      pageUrl_fb: pageInfo.pageUrl,
      startDate,
      platforms,
      regions,
      mediaType,
      creativeImageUrl: imageUrl,
      creativeVideoUrl: videoUrl,
      creativeCount,
      ctaText,
      primaryText: texts.primary,
      bodyText: texts.body,
    };
  }

  function findAdCards() {
    // Strategia 1: role=article (pattern stabile)
    let cards = Array.from(document.querySelectorAll('[role="article"]'));
    if (cards.length > 0) return cards;
    // Strategia 2: fallback grezzo — div con link l.php dentro
    const containers = new Set();
    document.querySelectorAll('a[href*="l.php"], a[href*="lm.facebook.com"]').forEach((a) => {
      let p = a;
      for (let i = 0; i < 8 && p; i++) {
        p = p.parentElement;
        if (p && p.children.length >= 3) {
          containers.add(p);
          break;
        }
      }
    });
    return Array.from(containers);
  }

  function collectFromVisibleCards() {
    const cards = findAdCards();
    let added = 0;
    for (const card of cards) {
      const links = card.querySelectorAll('a[href*="l.php"], a[href*="lm.facebook.com"], a[href^="http"]');
      for (const a of links) {
        const unwrapped = unwrapFbRedirect(a.getAttribute("href") || a.href);
        if (!unwrapped) continue;
        if (!isShopifyProductUrl(unwrapped)) continue;
        const norm = normalizeProductUrl(unwrapped);
        if (STATE.seen.has(norm)) continue;
        STATE.seen.add(norm);
        const info = extractCardInfo(card);
        // Build the batch item: keep the legacy v0.5.0 keys (pageUrl,
        // advertiser, imageUrl, activeAds) at the top because the scanner
        // detail page reads them as-is, then spread the v0.9.0 ad-spend
        // tracking fields. Server tolerates absence of every v0.9.0 key —
        // they're optional in ScannerItem Pydantic. landingDomain derives
        // from the normalised pageUrl so the niche detector has something
        // robust to work with.
        let landingDomain = null;
        try {
          landingDomain = new URL(norm).hostname.replace(/^www\./, "");
        } catch {}
        STATE.batch.push({
          // legacy v0.5.0
          pageUrl: norm,
          advertiser: info.advertiser,
          imageUrl: info.imageUrl,
          activeAds: info.activeAds,
          // v0.9.0 — FB Ads spend tracking
          libraryId: info.libraryId,
          pageId: info.pageId,
          pageName: info.pageName,
          pageUrl_fb: info.pageUrl_fb,
          startDate: info.startDate,
          isActive: true, // keyword-scan only sees active ads
          platforms: info.platforms,
          regions: info.regions,
          mediaType: info.mediaType,
          creativeImageUrl: info.creativeImageUrl,
          creativeVideoUrl: info.creativeVideoUrl,
          creativeCount: info.creativeCount,
          primaryText: info.primaryText,
          bodyText: info.bodyText,
          ctaText: info.ctaText,
          ctaUrl: norm,
          landingDomain,
        });
        STATE.totalFound++;
        STATE.sinceLastBatch++;
        added++;
        if (STATE.limit > 0 && STATE.totalFound >= STATE.limit) {
          STATE.abortReason = "limit";
          break;
        }
      }
      if (STATE.abortReason) break;
    }
    return added;
  }

  async function flushBatch(force = false) {
    if (STATE.batch.length === 0) return;
    if (!force && STATE.batch.length < BATCH_FLUSH_SIZE) return;
    const items = STATE.batch.splice(0, STATE.batch.length);
    STATE.sinceLastBatch = 0;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "PEGASUS_INGEST_BATCH",
        scanId: STATE.scanId,
        keyword: STATE.keyword,
        country: STATE.country,
        items,
        totalAds: STATE.totalFound,
      });
      if (res?.scanId && !STATE.scanId) STATE.scanId = res.scanId;
      log(t("cs.log.batchSent", { n: items.length, tot: STATE.totalFound }));
      // Aggiorna overlay live col totalStores reale dal server (computato via
      // DISTINCT split_part lato Postgres — fonte di verità).
      updateOverlay({
        totalStores: res?.totalStores,
        sent: STATE.totalFound - STATE.batch.length,
      });
    } catch (e) {
      logErr(t("cs.log.ingestFail", { err: e?.message ?? e }));
      // Reinserisci a coda — meglio riprovare al prossimo flush.
      STATE.batch.unshift(...items);
      // Se la chiave è invalida, fermiamo.
      if (/401|403/.test(String(e?.status ?? "") + String(e?.message ?? ""))) {
        STATE.abortReason = "auth_error";
      }
    }
  }

  function startFlushTimer() {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = setInterval(() => flushBatch(true), BATCH_FLUSH_MS);
  }
  function stopFlushTimer() {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
  }

  function scrollToBottom() {
    const h = document.documentElement.scrollHeight;
    window.scrollTo({ top: h, behavior: "instant" });
    return h;
  }

  /**
   * Recovery: scroll su in cima, aspetta, poi scroll giù di nuovo.
   * Spesso "sveglia" il lazy-load di FB quando si è incantato.
   */
  async function recoveryKick() {
    log(t("cs.log.recoveryKick"));
    window.scrollTo({ top: 0, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 1500));
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 3000));
  }

  /**
   * Conta le card attualmente nel DOM. Usato per detect nuovi annunci dopo
   * uno scroll: se il count cresce → FB ha caricato altro.
   */
  function currentCardCount() {
    return findAdCards().length;
  }

  /**
   * Aspetta fino a MAX_WAIT_NEW_CONTENT_MS che appaiano nuove card o che
   * il page-height cresca. Ritorna true se qualcosa è cambiato, false se
   * timeout.
   */
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

  async function mainLoop() {
    log(t("cs.log.scanStart"));
    startFlushTimer();
    // Inject the live overlay UI on top-right of the page. Killer UX of v0.2.0.
    try {
      createOverlay(STATE.keyword, STATE.country);
    } catch (e) {
      logErr(t("cs.log.overlayFail", { err: e?.message ?? e }));
    }

    while (STATE.scanning && !STATE.abortReason) {
      STATE.cycles++;
      const before = STATE.totalFound;

      // 1) Raccogli quello che vediamo adesso
      collectFromVisibleCards();
      if (STATE.abortReason) break;

      // 2) Snapshot pre-scroll per detect crescita
      const prevCards = currentCardCount();
      const prevHeight = scrollToBottom();

      // 3) Aspetta che nuove card appaiano o il page-height cresca (max 8s)
      const grew = await waitForNewContent(prevCards, prevHeight);

      // 4) Re-raccolgi dopo l'attesa
      collectFromVisibleCards();
      const newItems = STATE.totalFound - before;

      // 5) Detect stagnazione: né crescita DOM né nuovi item nostri
      if (!grew && newItems === 0) {
        STATE.sinceLastScrollGrowth++;

        // Tenta recovery ogni RECOVERY_EVERY_CYCLES cicli stagnanti
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
      }

      // 6) Push metrics al popup + aggiorna overlay live
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

      // 7) Pausa con jitter prima del prossimo ciclo (pace anti-detection)
      await new Promise((r) => setTimeout(r, jitter(SCROLL_CYCLE_MS)));
    }

    stopFlushTimer();
    await flushBatch(true);

    chrome.runtime.sendMessage({
      type: "PEGASUS_DONE",
      scanId: STATE.scanId,
      totalFound: STATE.totalFound,
      reason: STATE.abortReason ?? "stopped",
      durationMs: Date.now() - STATE.startedAt,
    });

    // Final overlay update: green dot if completed naturally, red on error
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
    // Lascio l'overlay visibile per 30s così l'utente legge il risultato
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
      mainLoop();
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === "PEGASUS_STOP") {
      STATE.scanning = false;
      STATE.abortReason = "user_stop";
      sendResponse({ ok: true });
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
})();
