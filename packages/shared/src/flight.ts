import type { Flight } from './types';
import { airportLabel } from './airports';

/** Décompose un numéro de vol en préfixe compagnie (lettres) + numéro (int). */
function splitFlightNumber(raw: string): { carrier: string; number: number | null } {
  const cleaned = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = cleaned.match(/^([A-Z]*)(\d+)?$/);
  if (!m) return { carrier: cleaned, number: null };
  const digits = m[2];
  return { carrier: m[1] ?? '', number: digits !== undefined ? parseInt(digits, 10) : null };
}

/**
 * Deux numéros de vol désignent-ils le même vol ?
 * Tolère le zéro-padding ("ET64" == "ET0064") et les espaces ("ET 64").
 * Si les deux portent un préfixe compagnie, il doit correspondre ; sinon on
 * compare uniquement la partie numérique.
 */
export function flightNumbersMatch(a: string, b: string): boolean {
  const fa = splitFlightNumber(a);
  const fb = splitFlightNumber(b);
  if (fa.number === null || fb.number === null) return false;
  if (fa.number !== fb.number) return false;
  if (fa.carrier && fb.carrier) return fa.carrier === fb.carrier;
  return true;
}

// ─────────────────────────────────────────────────────────────
// Rôle de l'aéroport de l'agent sur un vol.
//
// Ce qu'un agent a le droit de faire ne dépend pas de son aéroport, mais de la
// place de cet aéroport sur le vol qu'il ouvre : au départ on enregistre et on
// charge, à destination on réceptionne, à une escale on fait les deux. Kinshasa
// n'a aucun statut particulier. Le jour où un vol part de Lubumbashi, c'est
// l'agent de Lubumbashi qui en fait le départ, sans rien changer à son compte.
//
// La RLS garantit déjà qu'un agent ne voit que des vols touchant son aéroport.
// Ce module répond à la question d'après : quel rôle y joue-t-il ?
// ─────────────────────────────────────────────────────────────

/**
 * Place de l'aéroport de l'agent sur un vol.
 *
 * `unknown` couvre le compte sans aéroport et le vol hors périmètre. On n'y
 * restreint rien : immobiliser un PDA en pleine rotation à cause d'une fiche
 * de compte incomplète coûterait plus cher que l'écran de trop qu'il affiche.
 */
export type StationRole = 'origin' | 'destination' | 'stop' | 'unknown';

/** Opérations terrain d'un vol, une par écran du mobile. */
export type FlightOperation =
  | 'checkin'
  | 'baggage'
  | 'dolly'
  | 'soute'
  | 'charger'
  | 'rush'
  | 'expedition_rush'
  | 'embarquement'
  | 'arrivee';

function sameAirport(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = (a ?? '').trim().toUpperCase();
  return na.length > 0 && na === (b ?? '').trim().toUpperCase();
}

/** Place de `airportCode` sur ce vol. */
export function stationRole(
  flight: Pick<Flight, 'origin' | 'destination' | 'stops'>,
  airportCode: string | null | undefined,
): StationRole {
  if (!(airportCode ?? '').trim()) return 'unknown';

  const isOrigin = sameAirport(airportCode, flight.origin);
  const isDestination = sameAirport(airportCode, flight.destination);
  const isStop = (flight.stops ?? []).some((s) => sameAirport(airportCode, s));

  // Une escale débarque les passagers qui s'arrêtent là, puis recharge les
  // transits et les nouveaux : elle cumule les deux rôles. Un vol qui revient
  // à son point de départ relève du même cas.
  if (isStop || (isOrigin && isDestination)) return 'stop';
  if (isOrigin) return 'origin';
  if (isDestination) return 'destination';
  return 'unknown';
}

/** Cette opération a-t-elle un sens depuis cet aéroport ? */
export function operationAllowed(operation: FlightOperation, role: StationRole): boolean {
  switch (role) {
    case 'origin':
      // Tout le départ. La réception se fait à l'autre bout de la ligne.
      return operation !== 'arrivee';
    case 'destination':
      // Rien à préparer ici, l'avion arrive. Rush compris : un bagage resté au
      // sol est resté au départ, c'est là-bas qu'on le réachemine.
      return operation === 'arrivee';
    case 'stop':
      return true;
    case 'unknown':
      return true;
  }
}

/**
 * Refus à montrer à l'agent, ou null si l'opération est permise.
 * Le message dit où l'opération se fait, pas pourquoi le code refuse.
 */
export function operationDenial(
  operation: FlightOperation,
  flight: Pick<Flight, 'origin' | 'destination' | 'stops'>,
  airportCode: string | null | undefined,
): string | null {
  const role = stationRole(flight, airportCode);
  if (operationAllowed(operation, role)) return null;

  return operation === 'arrivee'
    ? `Ce vol part de ${airportLabel(flight.origin)}. Les bagages se réceptionnent à ${airportLabel(flight.destination)}, à l'arrivée.`
    : `Ce vol arrive à ${airportLabel(flight.destination)}. Les opérations de départ se font à ${airportLabel(flight.origin)}.`;
}

/** Une ligne qui dit à l'agent ce qu'il fait sur ce vol. Vide si indéterminé. */
export function stationRoleSummary(
  role: StationRole,
  flight: Pick<Flight, 'origin' | 'destination'>,
): string {
  switch (role) {
    case 'origin':
      return `Vol au départ vers ${airportLabel(flight.destination)}.`;
    case 'destination':
      return `Vol à l'arrivée de ${airportLabel(flight.origin)}.`;
    case 'stop':
      return 'Escale : débarquement, puis rechargement.';
    case 'unknown':
      return '';
  }
}

/** Route complète d'un vol, escales comprises : "FIH → FKI → FBM". */
export function formatRoute(
  flight: Pick<Flight, 'origin' | 'destination' | 'stops'>,
  sep = ' → ',
): string {
  const stops = (flight.stops ?? []).filter((s) => s.trim().length > 0);
  return [flight.origin, ...stops, flight.destination].join(sep);
}
