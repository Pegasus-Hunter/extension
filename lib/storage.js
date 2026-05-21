// Wrapper su chrome.storage.local — async/await, namespaced, type-safe per quanto
// possibile in JS puro. Tutta la persistenza dell'estensione passa da qui.

const KEYS = {
  apiKey: "pegasus.apiKey",
  serverBaseUrl: "pegasus.serverBaseUrl",
  lastKeyword: "pegasus.lastKeyword",
  lastCountry: "pegasus.lastCountry",
  lastLimit: "pegasus.lastLimit",
  currentScan: "pegasus.currentScan",
};

// Pegasus Hunter — central server API base.
// In production, points to api.pegasushunter.com. Override via popup
// "Server (avanzato)" for dev (localhost:8080 = Pegasus-Hunter app/server).
const DEFAULT_SERVER = "https://api.pegasushunter.com";

async function get(key) {
  const obj = await chrome.storage.local.get(key);
  return obj?.[key];
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function remove(key) {
  await chrome.storage.local.remove(key);
}

export const storage = {
  async getApiKey() {
    return (await get(KEYS.apiKey)) ?? null;
  },
  async setApiKey(value) {
    if (!value || !value.startsWith("wsk_")) {
      throw new Error("API key non valida (deve iniziare con wsk_)");
    }
    await set(KEYS.apiKey, value);
  },
  async clearApiKey() {
    await remove(KEYS.apiKey);
  },

  async getServer() {
    return (await get(KEYS.serverBaseUrl)) ?? DEFAULT_SERVER;
  },
  async setServer(value) {
    await set(KEYS.serverBaseUrl, value || DEFAULT_SERVER);
  },

  async getPrefs() {
    return {
      keyword: (await get(KEYS.lastKeyword)) ?? "",
      country: (await get(KEYS.lastCountry)) ?? "IT",
      limit: (await get(KEYS.lastLimit)) ?? 150,
    };
  },
  async setPrefs({ keyword, country, limit }) {
    if (keyword !== undefined) await set(KEYS.lastKeyword, keyword);
    if (country !== undefined) await set(KEYS.lastCountry, country);
    if (limit !== undefined) await set(KEYS.lastLimit, limit);
  },

  async getCurrentScan() {
    return (await get(KEYS.currentScan)) ?? null;
  },
  async setCurrentScan(value) {
    await set(KEYS.currentScan, value);
  },
  async clearCurrentScan() {
    await remove(KEYS.currentScan);
  },
};

export const STORAGE_KEYS = KEYS;
