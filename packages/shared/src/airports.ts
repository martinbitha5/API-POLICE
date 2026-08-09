// Aéroports desservis par Air Congo — référence partagée (portail vols, dashboard).
// Toutes les lignes partent de Kinshasa (FIH), qui est le hub du réseau.

import { todayInTimeZone } from './date';

export interface Airport {
  /** Code IATA (ex. "FBM"). */
  code: string;
  /** Ville desservie (ex. "Lubumbashi"). */
  city: string;
  /** Pays de l'aéroport. */
  country: string;
  /** true = ligne intérieure RDC, false = ligne internationale. */
  domestic: boolean;
  /**
   * Fuseau IANA de l'aéroport, qui définit sa journée d'exploitation.
   *
   * La RD Congo en compte DEUX : l'ouest (Kinshasa, Équateur, Ubangi) est à
   * UTC+1, le centre-est et le sud (Katanga, Kasaï, Kivu, Maniema, Tshopo,
   * Uele, Ituri) sont à UTC+2. Minuit tombe donc une heure plus tôt à
   * Lubumbashi qu'à Kinshasa : un fuseau unique pour tout le réseau serait faux
   * la moitié du temps.
   */
  timeZone: string;
}

/** Hub du réseau : toutes les lignes en partent ou y reviennent. */
export const HUB_CODE = 'FIH';

/** Fuseau de repli quand le code IATA est inconnu du référentiel. */
export const DEFAULT_TIME_ZONE = 'Africa/Kinshasa';

const KIN = 'Africa/Kinshasa'; // UTC+1 — ouest de la RDC
const LUB = 'Africa/Lubumbashi'; // UTC+2 — centre-est et sud de la RDC

export const AIRPORTS: readonly Airport[] = [
  // ── Lignes domestiques (RD Congo) ──────────────────────────
  { code: 'FIH', city: 'Kinshasa', country: 'RD Congo', domestic: true, timeZone: KIN },
  { code: 'MDK', city: 'Mbandaka', country: 'RD Congo', domestic: true, timeZone: KIN },
  { code: 'GMA', city: 'Gemena', country: 'RD Congo', domestic: true, timeZone: KIN },
  { code: 'BDT', city: 'Gbadolite', country: 'RD Congo', domestic: true, timeZone: KIN },
  { code: 'FBM', city: 'Lubumbashi', country: 'RD Congo', domestic: true, timeZone: LUB },
  { code: 'GOM', city: 'Goma', country: 'RD Congo', domestic: true, timeZone: LUB },
  { code: 'FKI', city: 'Kisangani', country: 'RD Congo', domestic: true, timeZone: LUB },
  { code: 'KND', city: 'Kindu', country: 'RD Congo', domestic: true, timeZone: LUB },
  { code: 'MJM', city: 'Mbuji-Mayi', country: 'RD Congo', domestic: true, timeZone: LUB },
  { code: 'KGA', city: 'Kananga', country: 'RD Congo', domestic: true, timeZone: LUB },
  { code: 'FMI', city: 'Kalemie', country: 'RD Congo', domestic: true, timeZone: LUB },
  { code: 'BUX', city: 'Bunia', country: 'RD Congo', domestic: true, timeZone: LUB },
  { code: 'BNC', city: 'Beni', country: 'RD Congo', domestic: true, timeZone: LUB },
  { code: 'IRP', city: 'Isiro', country: 'RD Congo', domestic: true, timeZone: LUB },

  // ── Lignes internationales ─────────────────────────────────
  { code: 'JNB', city: 'Johannesburg', country: 'Afrique du Sud', domestic: false, timeZone: 'Africa/Johannesburg' },
  { code: 'EBB', city: 'Entebbe', country: 'Ouganda', domestic: false, timeZone: 'Africa/Kampala' },
  { code: 'DLA', city: 'Douala', country: 'Cameroun', domestic: false, timeZone: 'Africa/Douala' },
  { code: 'COO', city: 'Cotonou', country: 'Bénin', domestic: false, timeZone: 'Africa/Porto-Novo' },
  { code: 'DAR', city: 'Dar es Salaam', country: 'Tanzanie', domestic: false, timeZone: 'Africa/Dar_es_Salaam' },
  { code: 'BRU', city: 'Bruxelles', country: 'Belgique', domestic: false, timeZone: 'Europe/Brussels' },
] as const;

const BY_CODE: Record<string, Airport> = Object.fromEntries(AIRPORTS.map((a) => [a.code, a]));

/** Aéroport correspondant au code IATA, ou undefined si inconnu. */
export function findAirport(code: string): Airport | undefined {
  return BY_CODE[code.trim().toUpperCase()];
}

/** Ville d'un code IATA — repli sur le code lui-même si l'aéroport est inconnu. */
export function airportCity(code: string): string {
  return findAirport(code)?.city ?? code;
}

/** Libellé complet : "Lubumbashi (FBM)" — repli sur le code seul si inconnu. */
export function airportLabel(code: string): string {
  const a = findAirport(code);
  return a ? `${a.city} (${a.code})` : code;
}

/**
 * Fuseau IANA d'un aéroport, qui définit sa journée d'exploitation.
 * Repli sur Kinshasa, hub du réseau, si le code est absent du référentiel.
 */
export function airportTimeZone(code: string | null | undefined): string {
  return findAirport(code ?? '')?.timeZone ?? DEFAULT_TIME_ZONE;
}

/**
 * Journée d'exploitation en cours à un aéroport, au format AAAA-MM-JJ.
 *
 * C'est la seule bonne réponse à « quels sont les vols du jour ? ». Elle bascule
 * à minuit sur place, pas à minuit UTC ni à minuit chez l'hébergeur.
 */
export function todayAtAirport(code: string | null | undefined): string {
  return todayInTimeZone(airportTimeZone(code));
}
