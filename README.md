# Pegasus Hunter — Chrome Extension v0.7.0 (Steroids Edition)

Scansiona Facebook Ads Library con **overlay live** sulla pagina, estrae i link prodotto su Shopify/WooCommerce/BigCommerce/Wix/Squarespace/ClickFunnels e li manda alla dashboard Pegasus Hunter (`pegasushunter.com`).

## Cosa cambia in v0.7.0 — Steroids Edition

**Performance**

- IntersectionObserver real-time: niente più polling DOM, le card vengono processate appena entrano in viewport.
- Parallel flush: fino a 3 batch in volo contemporaneamente verso il backend.
- Adaptive scroll pacing: -30% se la resa è alta, +50% se cala. Il loop si calibra da solo.
- DOM micro-cache 500ms per `findAdCards()`.

**Data richness**

- Estrazione di 12+ campi per ad: `advertiser`, `advertiser_url`, `imageUrl`, `videoUrl`, `activeAds`, `adStartDate`, `libraryId`, `ctaText`, `headline`, `bodyText`, `displayDomain`, `platforms`, e detection automatica di `platform` (shopify/woocommerce/bigcommerce/wix/squarespace/clickfunnels).

**Robustness**

- Auto-resume da scan crashati (handshake CS↔SW via `chrome.storage.local` + `PEGASUS_RESUME`).
- Retry esponenziale 3× (1s, 3s, 9s con jitter ±30%) per ogni flush. Stop immediato su 401/403/422.
- Heartbeat alarm 30s SW→CS: se 2 miss consecutivi, re-inject del CS via `chrome.scripting`.
- Queue mode offline: 3 fail network → accumulo senza flush per 60s, poi retry.

**Anti-detection**

- Variabilità scroll: 80% bottom, 15% al 80%, 5% al 60%.
- Random idle micro-pauses di 6-12s ogni ~8 cicli (simula utente che legge).

**Background reliability**

- Multi-strategy keep-alive: AudioContext → WebRTC fallback → Wake Lock bonus. La extension testa in cascata e usa la prima strategy disponibile.

**UX**

- Riga "Speed: X ads/min" calcolata su sliding window 60s.
- Badge keep-alive (Audio/WebRTC/WakeLock/None).
- Banner "Network slow — buffering N items" in queue mode.

**Selectors resilience**

- Triplo fallback per `findAdCards()`: `[role="article"]` → `[role="main"]>div>div>div` con >=3 figli → brute-force pattern (img + l.php + testo "X ads"). Log della strategy "vincente".

**Telemetria interna**

- `STATE.metrics` raccoglie cycles, cardsPerCycle, flushAttempts/Successes/Failures, recoveryKicks, stagnationStreak, keepAliveStrategy. Inviato al SW al `PEGASUS_DONE` (logging locale, no upload backend).

## Versioni precedenti

- `v0.6.0` — Keep-alive audio + visibility recovery + state persistence.
- `v0.5.0` — Exponential backoff retry su ingest.
- `v0.4.0` — Live badge counter sull'icona estensione.
- `v0.3.0` — i18n IT/EN auto-detect.
- `v0.2.0` — Merge in Pegasus Hunter (backend FastAPI + overlay live).

## Installazione (sviluppo)

1. Apri `chrome://extensions`.
2. Abilita **Modalità sviluppatore** in alto a destra.
3. Click su **Carica estensione non pacchettizzata**.
4. Seleziona questa cartella (`extension/`).
5. L'icona Pegasus (P dorata su sfondo blu) appare nella barra estensioni.

## Configurazione

1. Vai su `https://pegasushunter.com/app/api-keys` (devi essere loggato).
2. Crea una nuova API key.
3. Copia la chiave `wsk_...`.
4. Click sull'icona Pegasus → incolla la chiave nel campo **API Key**.
5. Seleziona il server (Produzione di default).
6. **Salva e continua**.

## Uso

1. Click sull'icona → inserisci **keyword** (es. `smartwatch`).
2. Scegli il **paese** (default: Italia).
3. Scegli il **limite annunci** (50 = veloce / 150 = medio / 400 = lungo).
4. **Avvia scansione**.
5. Si apre una tab in modalità visibile su `facebook.com/ads/library`. L'overlay live mostra contatori in tempo reale.
6. Vedi i risultati su `https://pegasushunter.com/app/scanner`.

## Architettura

```
popup/                  ← UI (HTML + CSS + JS)
background/             ← service worker (orchestratore)
content-scripts/        ← scraping FB Ads + overlay live (Shadow DOM, isolato)
lib/                    ← api-client (Bearer wsk_), storage, countries
icons/                  ← logo P dorato 16/48/128
manifest.json           ← Manifest V3 — versione 0.2.0
```

### Flusso dati

```
popup (utente)
   ↓ chrome.runtime.sendMessage
service-worker
   ↓ chrome.tabs.create (visible)
tab facebook.com/ads/library
   ↓ content script (scrape + overlay live)
service-worker
   ↓ fetch Bearer wsk_…
api.pegasushunter.com/api/v1/scanner/ingest
   ↓ FastAPI
Postgres (pegasus_scanner_runs + _products + auto-track shared_trackers)
```

## Endpoint server consumati

| Endpoint | Metodo | Quando |
|----------|--------|--------|
| `/api/v1/scanner/ping` | GET | Setup: verifica chiave wsk_ valida |
| `/api/v1/scanner/ingest` | POST | Ogni batch (25 item) durante scansione + finalize |

## Overlay live (killer UX)

Durante lo scraping, l'estensione inietta un widget fisso top-right della pagina FB:

```
┌─────────────────────────────┐
│ 🦅 PEGASUS HUNTER  ●        │
│ Keyword: smartwatch · IT    │
│ ┌─────┬─────┬─────┐         │
│ │ 47  │ 38  │ 45  │         │
│ │Ads  │Shop │Sync │         │
│ └─────┴─────┴─────┘         │
│ [Stop]    [Dashboard]       │
│ Scansionando…               │
└─────────────────────────────┘
```

- Counters incrementati in tempo reale dal content script
- Dot animato giallo durante scansione, verde a completamento, rosso su errore
- Shadow DOM isolato per non collidere con CSS di Facebook
- z-index 2147483647 (sempre in cima)
- Si rimuove automaticamente 30s dopo il completamento

## Debug

- Popup: tasto destro sull'icona → **Ispeziona popup**.
- Service worker: `chrome://extensions` → click su **Service worker** sotto la card Pegasus.
- Content script + overlay: apri la tab `facebook.com/ads/library/...`, DevTools → tab **Console**.

## Versionamento

- `0.1.0` — MVP iniziale Pegasus-Store
- `0.1.1` — Scroll smart + multilingua detection
- `0.2.0` — Merge in Pegasus Hunter (nuovo backend FastAPI + overlay live)
- `0.3.0` — i18n IT/EN
- `0.4.0` — Badge live sull'icona
- `0.5.0` — Retry esponenziale ingest
- `0.6.0` — Keep-alive audio + visibility recovery
- `0.7.0` — Steroids Edition (IO observer + parallel flush + multi-keepalive + auto-resume + 12+ fields + multi-platform)
