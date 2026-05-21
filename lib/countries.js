// Country list — codice ISO 2-letter accettato da Facebook Ads Library.
// Ordinata per macro-area: TOP per dropshipping → UE → resto Europa → Nord
// America → Oceania → LATAM → ASIA → Medio Oriente → Africa. Cosi nella
// dropdown l'utente trova i paesi più usati in cima.

export const COUNTRIES = [
  // TOP — i più tracciati nel dropshipping
  { code: "ALL", name: "Tutti i paesi" },
  { code: "IT", name: "Italia" },
  { code: "US", name: "Stati Uniti" },
  { code: "GB", name: "Regno Unito" },
  { code: "DE", name: "Germania" },
  { code: "FR", name: "Francia" },
  { code: "ES", name: "Spagna" },
  { code: "NL", name: "Paesi Bassi" },

  // Europa occidentale
  { code: "BE", name: "Belgio" },
  { code: "CH", name: "Svizzera" },
  { code: "AT", name: "Austria" },
  { code: "PT", name: "Portogallo" },
  { code: "IE", name: "Irlanda" },
  { code: "LU", name: "Lussemburgo" },

  // Europa nordica
  { code: "DK", name: "Danimarca" },
  { code: "SE", name: "Svezia" },
  { code: "NO", name: "Norvegia" },
  { code: "FI", name: "Finlandia" },
  { code: "IS", name: "Islanda" },

  // Europa orientale
  { code: "PL", name: "Polonia" },
  { code: "CZ", name: "Repubblica Ceca" },
  { code: "SK", name: "Slovacchia" },
  { code: "HU", name: "Ungheria" },
  { code: "RO", name: "Romania" },
  { code: "BG", name: "Bulgaria" },
  { code: "HR", name: "Croazia" },
  { code: "SI", name: "Slovenia" },
  { code: "EE", name: "Estonia" },
  { code: "LV", name: "Lettonia" },
  { code: "LT", name: "Lituania" },
  { code: "GR", name: "Grecia" },
  { code: "CY", name: "Cipro" },
  { code: "MT", name: "Malta" },

  // Nord America
  { code: "CA", name: "Canada" },
  { code: "MX", name: "Messico" },

  // Oceania
  { code: "AU", name: "Australia" },
  { code: "NZ", name: "Nuova Zelanda" },

  // America Latina
  { code: "BR", name: "Brasile" },
  { code: "AR", name: "Argentina" },
  { code: "CL", name: "Cile" },
  { code: "CO", name: "Colombia" },
  { code: "PE", name: "Perù" },
  { code: "UY", name: "Uruguay" },

  // Asia / Pacifico
  { code: "JP", name: "Giappone" },
  { code: "KR", name: "Corea del Sud" },
  { code: "SG", name: "Singapore" },
  { code: "MY", name: "Malesia" },
  { code: "TH", name: "Thailandia" },
  { code: "PH", name: "Filippine" },
  { code: "ID", name: "Indonesia" },
  { code: "VN", name: "Vietnam" },
  { code: "IN", name: "India" },
  { code: "HK", name: "Hong Kong" },
  { code: "TW", name: "Taiwan" },

  // Medio Oriente
  { code: "AE", name: "Emirati Arabi Uniti" },
  { code: "SA", name: "Arabia Saudita" },
  { code: "IL", name: "Israele" },
  { code: "TR", name: "Turchia" },

  // Africa
  { code: "ZA", name: "Sudafrica" },
  { code: "EG", name: "Egitto" },
  { code: "MA", name: "Marocco" },
];
