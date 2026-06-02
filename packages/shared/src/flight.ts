import type { Flight } from './types.js';

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

/** Route complète d'un vol, escales comprises : "FIH → FKI → FBM". */
export function formatRoute(
  flight: Pick<Flight, 'origin' | 'destination' | 'stops'>,
  sep = ' → ',
): string {
  const stops = (flight.stops ?? []).filter((s) => s.trim().length > 0);
  return [flight.origin, ...stops, flight.destination].join(sep);
}
