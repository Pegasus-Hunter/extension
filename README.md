# Pegasus Hunter — Chrome Extension v0.2.0

Scansiona Facebook Ads Library con **overlay live** sulla pagina, estrae i link Shopify dei prodotti pubblicizzati e li manda alla dashboard Pegasus Hunter (`pegasushunter.com`).

## Cosa cambia in v0.2.0 rispetto alla v0.1.1

- **Backend nuovo**: parla con `api.pegasushunter.com/api/v1/*` (FastAPI central server), non più con `wooshstoreai.com`. Auth via Bearer `wsk_…`.
- **Overlay live UI**: durante lo scraping, in alto a destra della pagina FB Ads Library appare un widget fisso con contatori in tempo reale (annunci trovati, shop unici, batch sincronizzati). Bottoni Stop / Apri Dashboard. Killer UX feature.
- **Branding**: "Pegasus Scanner" → "Pegasus Hunter".

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
