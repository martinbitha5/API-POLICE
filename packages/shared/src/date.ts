// Journée d'exploitation — référence partagée mobile / web / portails.
//
// La colonne `flights.date` est une DATE, pas un instant : c'est le jour
// d'exploitation du vol, tel qu'il est vécu à l'aéroport. Tout ce qui répond à
// « quels sont les vols du jour ? » doit donc raisonner dans le fuseau de
// l'aéroport, jamais en UTC ni dans le fuseau d'un serveur.
//
// Le piège classique est `new Date().toISOString().slice(0, 10)` : il renvoie
// la date UTC. À Kinshasa (UTC+1), entre 00h00 et 01h00 locales, il renvoie
// encore la veille — les écrans affichent les vols d'hier et l'agent risque de
// scanner sur le mauvais vol.

/** Date d'un objet Date au format AAAA-MM-JJ, dans le fuseau de l'appareil. */
export function isoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Date du jour dans le fuseau de l'appareil. */
export function todayLocal(): string {
  return isoDate(new Date());
}

/**
 * Date du jour dans un fuseau explicite (ex. « Africa/Kinshasa »).
 *
 * À utiliser dès que le code ne tourne pas sur un appareil posé à l'aéroport :
 * une route serveur déployée est en UTC, et un écran public peut être consulté
 * depuis n'importe où alors que la journée affichée reste celle de l'aéroport.
 *
 * On assemble les morceaux via formatToParts plutôt que de se fier au format
 * d'une locale : un moteur sans les données de la locale demandée renverrait
 * « 9/8/2026 ». Si le moteur ne connaît pas les fuseaux du tout (Hermes compilé
 * sans ICU), on retombe sur l'heure de l'appareil, qui est réglée à l'heure
 * locale sur les PDA de terrain.
 */
export function todayInTimeZone(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    const y = get('year');
    const m = get('month');
    const d = get('day');
    if (y.length === 4 && m.length === 2 && d.length === 2) return `${y}-${m}-${d}`;
  } catch {
    // Moteur sans support des fuseaux : repli ci-dessous.
  }
  return todayLocal();
}
