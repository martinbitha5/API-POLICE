import type { FastifyInstance } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseBoardingPass, parseBaggageTag } from '@police/bcbp-parser';
import {
  flightNumbersMatch,
  operationDenial,
  FRAUD_REASON,
  type Flight,
  type FlightOperation,
  type ParsedBaggageTag,
  type BoardingGateResult,
  type BaggageActionResult,
  type BaggageLoadAllResult,
  type DollyScanResult,
  type ArrivalScanResult,
  type ExpeditionRushResult,
  type SoutePosition,
} from '@police/shared';
import { getSupabase } from '../supabase.js';
import { evaluateBaggageScan, type BaggageScanContext } from '../fraud.js';
import { authenticate } from '../auth.js';

interface BoardingBody {
  raw: string;
  flightId: string;
  scannedBy?: string;
}

interface EmbarquementBody {
  raw: string;
  flightId: string;
  scannedBy?: string;
}

interface BaggageBody {
  tag: string;
  flightId: string;
  gate?: string;
  scannedBy?: string;
}

interface BaggageActionBody {
  tag: string;
  flightId: string;
  scannedBy?: string;
}

interface SouteBody {
  tag: string;
  flightId: string;
  soute: SoutePosition;
  scannedBy?: string;
}

interface ExpeditionRushBody {
  /** Première étiquette scannée (originale ou RUSH, dans n'importe quel ordre). */
  tag: string;
  /** Deuxième étiquette. Absente = premier scan, on identifie seulement. */
  otherTag?: string;
  /**
   * true = le bagage ne porte qu'une seule étiquette (cas fréquent : Air Congo
   * colle une étiquette RUSH sur un colis venu d'ailleurs). Enregistre avec
   * cette étiquette seule au lieu d'attendre un deuxième scan.
   */
  soloTag?: boolean;
  flightId: string;
  scannedBy?: string;
}

/**
 * Filtre PostgREST « ce numéro de série, sur l'une OU l'autre étiquette ».
 *
 * Un bagage expédié porte deux étiquettes (l'originale et la RUSH) et l'agent
 * scanne celle qui lui tombe sous la main : tous les écrans aval cherchent donc
 * sur les deux colonnes. Les séries sortent de parseBaggageTag (chiffres
 * uniquement), le filtre est donc sûr à composer.
 */
function eitherSerial(serials: string[]): string {
  return serials.flatMap((s) => [`serial_number.eq.${s}`, `rush_serial_number.eq.${s}`]).join(',');
}

/** Ligne `baggage` réduite à ce dont la décision anti-fraude a besoin. */
interface LinkedBagRow {
  id: string;
  passenger_id: string;
  tag_number: string;
  is_confirmed: boolean;
}

/**
 * Cherche le même n° de série sur les AUTRES vols du jour.
 *
 * Sans cette recherche, la règle 5 était inatteignable : la requête de liaison
 * étant filtrée sur le vol courant, `passenger.flightId` valait toujours le vol
 * scanné et le test « bagage d'un autre vol » ne pouvait jamais être vrai. Un
 * bagage posé sur le mauvais tapis remontait donc au superviseur comme une
 * fraude, au même titre qu'un colis sans boarding pass.
 *
 * Bornée au même jour : le n° de série ne fait que 6 chiffres et se recycle
 * d'un jour sur l'autre. Chercher plus loin rattacherait un bagage à un vol de
 * la veille.
 */
async function findTagOnOtherFlights(
  supabase: SupabaseClient,
  flightId: string,
  parsedTag: ParsedBaggageTag,
): Promise<{ bag: LinkedBagRow; flightNumber: string } | null> {
  const { data: current } = await supabase.from('flights').select('date').eq('id', flightId).single();
  const date = (current as { date: string } | null)?.date;
  if (!date) return null;

  const { data: sameDay } = await supabase.from('flights').select('id, flight_number').eq('date', date);
  const others = ((sameDay as { id: string; flight_number: string }[] | null) ?? []).filter(
    (f) => f.id !== flightId,
  );
  if (others.length === 0) return null;

  const { data: row } = await supabase
    .from('baggage')
    .select('id, passenger_id, tag_number, is_confirmed, flight_id')
    .in(
      'flight_id',
      others.map((f) => f.id),
    )
    .eq('kind', 'passenger')
    .eq('cancelled', false)
    .eq('serial_number', parsedTag.serialNumber)
    .order('is_confirmed', { ascending: false })
    .limit(1)
    .maybeSingle();

  const bag = row as (LinkedBagRow & { flight_id: string }) | null;
  if (!bag) return null;
  return { bag, flightNumber: others.find((f) => f.id === bag.flight_id)?.flight_number ?? 'inconnu' };
}

/**
 * Étiquette orpheline : aucun boarding pass ne la déclare, donc aucun nom à
 * afficher. On dit alors ce qu'on sait, c'est-à-dire d'où sort l'étiquette.
 *
 * Les étiquettes d'un comptoir sont imprimées en série continue pour un vol.
 * Une série qui tombe dans la plage déjà vue sur ce vol désigne un colis
 * étiqueté ici, sur un dossier sans bagage déclaré : le scénario de fraude.
 * Hors de cette plage, il s'agit plutôt d'un bagage étranger au vol.
 *
 * Le texte renvoyé est lu par un superviseur en salle, pas par un développeur :
 * il dit quoi faire, pas comment le calcul a été fait. Les numéros de série ne
 * lui servent à rien, l'étiquette est déjà affichée au-dessus.
 *
 * C'est un indice de provenance, pas une identification : on ne devine jamais
 * un propriétaire par proximité de série, attribuer une fraude au mauvais
 * passager serait pire que de ne nommer personne.
 */
async function describeUnlinkedTag(
  supabase: SupabaseClient,
  flightId: string,
  parsedTag: ParsedBaggageTag,
): Promise<string> {
  const prefix = `${parsedTag.issuerCode}${parsedTag.airlineNumericCode}`;
  const [{ data: first }, { data: last }] = await Promise.all([
    supabase
      .from('baggage')
      .select('serial_number')
      .eq('flight_id', flightId)
      .eq('kind', 'passenger')
      .like('tag_number', `${prefix}%`)
      .order('serial_number', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('baggage')
      .select('serial_number')
      .eq('flight_id', flightId)
      .eq('kind', 'passenger')
      .like('tag_number', `${prefix}%`)
      .order('serial_number', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const serial = parsedTag.serialNumber;
  const lo = (first as { serial_number: string | null } | null)?.serial_number ?? null;
  const hi = (last as { serial_number: string | null } | null)?.serial_number ?? null;

  if (!lo || !hi) {
    return "Aucun bagage n'est encore enregistré sur ce vol. Vérifier que le comptoir a commencé à scanner les boarding pass.";
  }
  // Séries à 6 chiffres complétées à gauche par des zéros : l'ordre
  // lexicographique est l'ordre numérique.
  return serial >= lo && serial <= hi
    ? "Étiquette imprimée au comptoir pour ce vol, mais aucun passager ne l'a déclarée. Faire intercepter le colis avant le chargement."
    : "Cette étiquette ne vient pas du comptoir de ce vol. Bagage probablement égaré, à mettre de côté.";
}

/**
 * Refus de périmètre, ou null si l'agent est au bon bout de la ligne.
 *
 * La RLS garantit déjà qu'un agent ne voit que des vols touchant son aéroport ;
 * ce contrôle-ci porte sur le rôle qu'il y joue : on ne prépare pas un départ
 * depuis l'aéroport d'arrivée, et on ne réceptionne pas des bagages qui ne sont
 * pas encore partis.
 *
 * Le contrôle vit ici et pas seulement dans le mobile : l'API tourne en
 * service_role et contourne la RLS, donc masquer un bouton sur le PDA ne
 * protège rien. Un PDA d'une version antérieure affichera encore l'écran, et
 * c'est ce refus qui l'arrêtera.
 *
 * Vol introuvable, ou compte sans aéroport : on ne tranche pas. Les contrôles
 * propres à chaque route font le reste, et une fiche de compte incomplète ne
 * doit pas immobiliser un PDA en pleine rotation.
 */
async function stationDenial(
  flightId: string | undefined,
  airport: string | null,
  operation: FlightOperation,
): Promise<string | null> {
  if (!flightId) return null;

  const { data } = await getSupabase()
    .from('flights')
    .select('origin, destination, stops')
    .eq('id', flightId)
    .maybeSingle();

  const flight = data as Pick<Flight, 'origin' | 'destination' | 'stops'> | null;
  return flight ? operationDenial(operation, flight, airport) : null;
}

export async function scanRoutes(app: FastifyInstance): Promise<void> {
  // Toutes les routes de scan exigent un agent/superviseur/admin authentifié.
  // L'identité du scanneur est dérivée du JWT (request.authUserId), jamais du body.
  app.addHook('preHandler', authenticate);

  // ── POST /scan/boarding ─────────────────────────────────────
  app.post<{ Body: BoardingBody }>('/scan/boarding', async (request, reply) => {
    const { raw, flightId } = request.body;
    const scannedBy = request.authUserId;
    if (!raw || !flightId) {
      return reply.code(400).send({ error: 'raw et flightId sont requis' });
    }

    const denial = await stationDenial(flightId, request.authAirport, 'checkin');
    if (denial) {
      return reply.code(403).send({ error: denial });
    }

    let parsed;
    try {
      parsed = parseBoardingPass(raw);
    } catch {
      return reply.code(400).send({ error: 'Boarding pass illisible. Rescannez le billet.' });
    }
    const supabase = getSupabase();

    // Le boarding pass doit appartenir au vol sélectionné. On compare le n° de vol
    // du premier leg (le segment embarqué à cette porte) à celui du vol choisi.
    // Tolère le zéro-padding ("ET64" == "ET0064"). Rejet sinon — pas d'alerte
    // fraude : c'est une erreur de porte, pas une fraude bagage.
    const { data: flight, error: flightErr } = await supabase
      .from('flights')
      .select('flight_number, date')
      .eq('id', flightId)
      .single();

    if (flightErr || !flight) {
      return reply.code(404).send({ error: 'Vol introuvable' });
    }

    if (!flightNumbersMatch(parsed.flightNumber, flight.flight_number)) {
      return reply.code(409).send({
        error: `Ce billet est pour le vol ${parsed.flightNumber || 'inconnu'}, pas pour ${flight.flight_number}.`,
      });
    }

    const { data: passenger, error } = await supabase
      .from('passengers')
      .insert({
        flight_id: flightId,
        full_name: parsed.fullName,
        pnr: parsed.pnr,
        seat: parsed.seat,
        class: parsed.class,
        sequence_number: parsed.sequenceNumber,
        declared_baggage_count: parsed.declaredBaggageCount,
        raw_bcbp: parsed.rawBcbp,
        scanned_by: scannedBy ?? null,
      })
      .select()
      .single();

    if (error) {
      // 23505 = violation contrainte unique (flight_id, pnr, seat)
      // → ce passager précis (même siège) a déjà été scanné sur ce vol.
      if (error.code === '23505') {
        return reply.code(409).send({ error: 'Ce passager est déjà enregistré.' });
      }
      request.log.error(error);
      return reply.code(500).send({ error: "Échec de l'enregistrement du passager" });
    }

    if (parsed.legs.length > 0) {
      await supabase.from('passenger_legs').insert(
        parsed.legs.map((leg) => ({
          passenger_id: passenger.id,
          origin: leg.origin,
          destination: leg.destination,
          flight_number: leg.flightNumber,
          leg_order: leg.order,
        })),
      );
    }

    // Pré-enregistrement des bagages déclarés à partir des étiquettes du BCBP.
    // L'étiquette boarding (13 chiffres) porte le n° de série du PREMIER bagage
    // + le nombre de bagages consécutifs. On la déplie en N étiquettes physiques
    // (10 chiffres) de série serial, serial+1, … — exactement ce que l'agent
    // bagages scannera sur le tapis. La liaison se fait sur les 6 chiffres de série.
    const preRegistered = parsed.baggageTags.flatMap((rawTag) => {
      const digits = rawTag.replace(/\D/g, '');
      if (digits.length !== 13 && digits.length !== 10) return [];
      const pt = parseBaggageTag(digits);
      const count = digits.length === 13 ? pt.declaredBaggageCount : 1;
      if (count <= 0) return [];
      const baseSerial = parseInt(pt.serialNumber, 10);
      return Array.from({ length: count }, (_, i) => {
        const serial = String(baseSerial + i).padStart(6, '0');
        return {
          passenger_id: passenger.id,
          flight_id: flightId,
          tag_number: `${pt.issuerCode}${pt.airlineNumericCode}${serial}`,
          issuer_code: pt.issuerCode,
          airline_numeric_code: pt.airlineNumericCode,
          serial_number: serial,
          is_confirmed: false,
        };
      });
    });

    if (preRegistered.length > 0) {
      await supabase.from('baggage').upsert(preRegistered, { onConflict: 'flight_id,tag_number', ignoreDuplicates: true });

      // Course de scan : l'agent bagages passe parfois le tapis avant que le
      // check-in n'ait enregistré le passager. La ligne baggage n'existait pas
      // encore, la règle 1 s'est donc déclenchée à tort. Le boarding pass qu'on
      // vient de lire prouve le contraire — on referme ces alertes au lieu de
      // les laisser vivre comme des fraudes non résolues.
      //
      // Le rejet au tapis reste inchangé : le bagage a bien été écarté sur le
      // moment et devra être rescanné. Aucune règle n'est contournée, on ne
      // corrige que la trace laissée au superviseur.
      //
      // Balayage sur tous les vols du jour, pas seulement celui-ci : une
      // étiquette scannée sur le mauvais tapis lève une alerte sur le vol du
      // tapis, alors que le boarding pass qui la justifie arrive sur un autre
      // vol. Bornée au jour même, le n° de série se recyclant ensuite.
      const { data: dayFlights } = await supabase.from('flights').select('id').eq('date', flight.date);
      const dayIds = ((dayFlights as { id: string }[] | null) ?? []).map((f) => f.id);
      if (dayIds.length > 0) {
        await supabase
          .from('fraud_alerts')
          .update({
            resolved: true,
            resolved_at: new Date().toISOString(),
            resolved_by: scannedBy ?? null,
            note: `Fausse alerte. ${parsed.fullName} (PNR ${parsed.pnr}) s'est enregistré sur ${flight.flight_number} après le passage du bagage. L'étiquette est bien sur son billet, il n'y a pas de fraude. Le bagage peut être repassé au tapis.`,
          })
          .in('flight_id', dayIds)
          .eq('resolved', false)
          .in(
            'tag_number',
            preRegistered.map((b) => b.tag_number),
          );
      }
    }

    return reply.send({
      passenger: {
        fullName: parsed.fullName,
        pnr: parsed.pnr,
        seat: parsed.seat,
        class: parsed.class,
        declaredBaggageCount: parsed.declaredBaggageCount,
        legs: parsed.legs,
      },
    });
  });

  // ── POST /scan/baggage ──────────────────────────────────────
  app.post<{ Body: BaggageBody }>('/scan/baggage', async (request, reply) => {
    const { tag, flightId, gate } = request.body;
    const scannedBy = request.authUserId;
    if (!tag || !flightId) {
      return reply.code(400).send({ error: 'tag et flightId sont requis' });
    }

    const denial = await stationDenial(flightId, request.authAirport, 'baggage');
    if (denial) {
      return reply.code(403).send({ error: denial });
    }

    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    const supabase = getSupabase();

    // Bagage annulé par le superviseur (ou passager débarqué) : rejet net,
    // sans alerte fraude — la décision est déjà connue et tracée côté dashboard.
    const { data: cancelledRow } = await supabase
      .from('baggage')
      .select('id')
      .eq('flight_id', flightId)
      .eq('cancelled', true)
      .or(eitherSerial([parsedTag.serialNumber]))
      .limit(1)
      .maybeSingle();
    if (cancelledRow) {
      return reply.send({
        status: 'rejected',
        reason: FRAUD_REASON.CANCELLED,
        fraudAlert: false,
        message: 'Bagage annulé par le superviseur. Mettez-le de côté.',
      });
    }

    // Bagage expédition rush déjà enregistré sur ce vol : mauvais écran, pas
    // une fraude. Le tapis sert à la réconciliation avec un passager.
    const { data: fwdRow } = await supabase
      .from('baggage')
      .select('id')
      .eq('flight_id', flightId)
      .eq('kind', 'rush_forward')
      .or(eitherSerial([parsedTag.serialNumber]))
      .limit(1)
      .maybeSingle();
    if (fwdRow) {
      return reply.send({
        status: 'rejected',
        reason: FRAUD_REASON.RUSH_FORWARD,
        fraudAlert: false,
        message: "Bagage expédition rush, sans passager sur ce vol. Il ne passe pas au tapis.",
      });
    }

    // Doublon : ce tag exact est-il déjà confirmé SUR CE VOL ? (le même n° de
    // série peut légitimement appartenir à un autre vol/jour — on ne scope donc
    // jamais le doublon au-delà du vol courant.)
    const { data: dupRow } = await supabase
      .from('baggage')
      .select('id')
      .eq('flight_id', flightId)
      .eq('tag_number', tag)
      .eq('is_confirmed', true)
      .maybeSingle();

    // Bagage pré-enregistré pour ce serial sur ce vol.
    const { data: bagRow } = await supabase
      .from('baggage')
      .select('id, passenger_id, tag_number, is_confirmed')
      .eq('flight_id', flightId)
      .eq('kind', 'passenger')
      .eq('cancelled', false)
      .eq('serial_number', parsedTag.serialNumber)
      .order('is_confirmed', { ascending: true })
      .limit(1)
      .maybeSingle();

    // Rien sur ce vol : on regarde ailleurs avant de conclure. Une étiquette
    // trouvée sur un autre vol du jour est une erreur de tapis (règle 5, pas
    // d'alerte) ; introuvable partout, elle est orpheline (règle 1) et on
    // consigne d'où sort la série pour que le superviseur ait de quoi agir.
    let linkedBag = (bagRow as LinkedBagRow | null) ?? null;
    let tagNote: string | null = null;
    if (!linkedBag) {
      const elsewhere = await findTagOnOtherFlights(supabase, flightId, parsedTag);
      linkedBag = elsewhere?.bag ?? null;
      tagNote = elsewhere
        ? `Ce bagage est celui du vol ${elsewhere.flightNumber}. Il s'est trompé de tapis.`
        : await describeUnlinkedTag(supabase, flightId, parsedTag);
    }

    let passenger: BaggageScanContext['passenger'] = null;
    let confirmedCount = 0;
    if (linkedBag) {
      const { data: pax } = await supabase
        .from('passengers')
        .select('id, full_name, pnr, flight_id, declared_baggage_count, offloaded')
        .eq('id', linkedBag.passenger_id)
        .single();
      if (pax) {
        // Passager débarqué par le superviseur : ses bagages ont été annulés
        // (déjà rejetés plus haut), mais on couvre la course entre les deux
        // écritures. Rejet net, sans alerte — la décision est tracée.
        if (pax.offloaded) {
          return reply.send({
            status: 'rejected',
            reason: FRAUD_REASON.OFFLOADED,
            fraudAlert: false,
            message: `${pax.full_name} a été débarqué par le superviseur. Bagage non autorisé, mettez-le de côté.`,
          });
        }
        passenger = {
          id: pax.id,
          fullName: pax.full_name,
          pnr: pax.pnr,
          flightId: pax.flight_id,
          declaredBaggageCount: pax.declared_baggage_count,
        };
        const { count } = await supabase
          .from('baggage')
          .select('id', { count: 'exact', head: true })
          .eq('passenger_id', pax.id)
          .eq('is_confirmed', true)
          .eq('cancelled', false);
        confirmedCount = count ?? 0;
      }
    }

    const decision = evaluateBaggageScan({
      parsedTag,
      flightId,
      gate: gate ?? null,
      registeredBag: linkedBag
        ? {
            id: linkedBag.id,
            passengerId: linkedBag.passenger_id,
            tagNumber: linkedBag.tag_number,
            isConfirmed: linkedBag.is_confirmed,
          }
        : null,
      passenger,
      confirmedCountForPassenger: confirmedCount,
      duplicateConfirmedTag: Boolean(dupRow),
      tagNote,
    });

    if (decision.confirmBagId) {
      await supabase
        .from('baggage')
        .update({ is_confirmed: true, tag_number: tag, scanned_by: scannedBy ?? null, scanned_at: new Date().toISOString() })
        .eq('id', decision.confirmBagId);
    }

    if (decision.fraudAlert) {
      // Une seule alerte par (tag_number, flight_id) — pas de doublon si l'agent re-scanne
      const { data: existingAlert } = await supabase
        .from('fraud_alerts')
        .select('id')
        .eq('tag_number', decision.fraudAlert.tag_number)
        .eq('flight_id', decision.fraudAlert.flight_id)
        .maybeSingle();
      if (!existingAlert) {
        await supabase.from('fraud_alerts').insert(decision.fraudAlert);
      }
    }

    return reply.send(decision.result);
  });

  // ── Action soute partagée : Charger (in_hold) / Rush (rush) ──
  // Marque un bagage déjà enregistré (is_confirmed) au tapis :
  //  • in_hold = chargé en soute pour la destination.
  //  • rush    = restant, à réacheminer sur le prochain vol.
  async function markBaggage(
    field: 'in_hold' | 'rush',
    body: BaggageActionBody,
    scannedBy: string,
  ): Promise<{ code: number; result: BaggageActionResult }> {
    const { tag, flightId } = body;
    if (!tag || !flightId) {
      return { code: 400, result: { status: 'rejected', message: 'tag et flightId sont requis' } };
    }

    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return { code: 400, result: { status: 'rejected', message: (e as Error).message } };
    }

    const supabase = getSupabase();

    // Bagage de ce vol par n° de série (clé de liaison) ; on privilégie une ligne confirmée.
    const { data: bagRow } = await supabase
      .from('baggage')
      .select('id, passenger_id, is_confirmed, cancelled')
      .eq('flight_id', flightId)
      .eq('kind', 'passenger')
      .eq('serial_number', parsedTag.serialNumber)
      .order('is_confirmed', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!bagRow) {
      return { code: 200, result: { status: 'rejected', message: "Ce bagage n'appartient pas à ce vol." } };
    }
    if (bagRow.cancelled) {
      return {
        code: 200,
        result: { status: 'rejected', message: 'Bagage annulé par le superviseur. Mettez-le de côté.' },
      };
    }
    if (!bagRow.is_confirmed) {
      return {
        code: 200,
        result: { status: 'rejected', message: "Ce bagage n'est pas encore passé au tapis. Enregistrez-le d'abord." },
      };
    }

    const stamp = new Date().toISOString();
    const patch =
      field === 'in_hold'
        ? { in_hold: true, in_hold_at: stamp, in_hold_by: scannedBy ?? null }
        : { rush: true, rush_at: stamp, rush_by: scannedBy ?? null };
    await supabase.from('baggage').update({ ...patch, tag_number: tag }).eq('id', bagRow.id);

    // Contexte passager + compteurs.
    const { data: pax } = await supabase
      .from('passengers')
      .select('full_name, declared_baggage_count')
      .eq('id', bagRow.passenger_id)
      .single();
    const { count } = await supabase
      .from('baggage')
      .select('id', { count: 'exact', head: true })
      .eq('passenger_id', bagRow.passenger_id)
      .eq('cancelled', false)
      .eq(field, true);

    const verb = field === 'in_hold' ? 'chargé en soute' : 'marqué pour réacheminement';
    return {
      code: 200,
      result: {
        status: 'accepted',
        passengerName: pax?.full_name ?? '—',
        tagNumber: tag,
        count: count ?? 0,
        declaredCount: pax?.declared_baggage_count ?? 0,
        message: `Bagage ${verb}.`,
      },
    };
  }

  // ── POST /scan/rush ─── Marquer un bagage restant (Restants) ─
  app.post<{ Body: BaggageActionBody }>('/scan/rush', async (request, reply) => {
    const denial = await stationDenial(request.body.flightId, request.authAirport, 'rush');
    if (denial) {
      return reply.code(403).send({ error: denial });
    }
    const { code, result } = await markBaggage('rush', request.body, request.authUserId);
    return reply.code(code).send(result);
  });

  // ── POST /scan/expedition-rush ─── Bagage voyageant sans passager ─
  // Le bagage porte DEUX étiquettes : l'originale et l'étiquette RUSH imprimée
  // au réacheminement. L'agent scanne les deux, dans n'importe quel ordre :
  //  • 1er appel (tag seul)      → identification. Si l'étiquette correspond à
  //    un restant marqué chez nous (écran Restants), on nomme le propriétaire.
  //  • 2e appel (tag + otherTag) → enregistrement, les deux numéros liés.
  //
  // Verrou : restant connu → approved d'office (le lien avec son passager
  // d'origine est la preuve) ; bagage inconnu → pending, et le dolly refuse
  // tant qu'un superviseur n'a pas validé depuis le dashboard. Cet écran n'est
  // donc jamais un contournement du tapis : soit le bagage a un historique chez
  // nous, soit un humain responsable l'autorise nommément.
  app.post<{ Body: ExpeditionRushBody }>('/scan/expedition-rush', async (request, reply) => {
    const { tag, otherTag, soloTag, flightId } = request.body;
    const scannedBy = request.authUserId;
    if (!tag || !flightId) {
      return reply.code(400).send({ status: 'rejected', message: 'tag et flightId sont requis' } satisfies ExpeditionRushResult);
    }

    const denial = await stationDenial(flightId, request.authAirport, 'expedition_rush');
    if (denial) {
      return reply.code(403).send({ error: denial });
    }

    let t1: ParsedBaggageTag;
    let t2: ParsedBaggageTag | null = null;
    try {
      t1 = parseBaggageTag(tag);
      if (otherTag) t2 = parseBaggageTag(otherTag);
    } catch (e) {
      return reply.code(400).send({ status: 'rejected', message: (e as Error).message } satisfies ExpeditionRushResult);
    }

    if (t2 && t1.serialNumber === t2.serialNumber) {
      return reply.send({
        status: 'rejected',
        message: "Même étiquette scannée deux fois. Scannez l'AUTRE étiquette du bagage.",
      } satisfies ExpeditionRushResult);
    }

    const supabase = getSupabase();
    const { data: flight } = await supabase
      .from('flights')
      .select('flight_number, date, origin')
      .eq('id', flightId)
      .single();
    if (!flight) {
      return reply.code(404).send({ status: 'rejected', message: 'Vol introuvable' } satisfies ExpeditionRushResult);
    }

    const serials = t2 ? [t1.serialNumber, t2.serialNumber] : [t1.serialNumber];

    // Bagage ANNONCÉ par le superviseur : l'annonce vaut validation anticipée.
    // Un seul scan suffit, le colis est autorisé immédiatement, et l'écran
    // affiche les coordonnées saisies (provenance, propriétaire).
    const { data: announcedRow } = await supabase
      .from('baggage')
      .select('id, tag_number, serial_number, rush_tag_number, rush_serial_number, announced_by, rush_origin, rush_owner_name')
      .eq('flight_id', flightId)
      .eq('kind', 'rush_forward')
      .eq('rush_status', 'expected')
      .or(eitherSerial(serials))
      .limit(1)
      .maybeSingle();
    if (announcedRow) {
      const a = announcedRow as {
        id: string;
        tag_number: string;
        serial_number: string | null;
        rush_tag_number: string | null;
        rush_serial_number: string | null;
        announced_by: string | null;
        rush_origin: string | null;
        rush_owner_name: string | null;
      };
      const now = new Date().toISOString();
      const knownSerials = [a.serial_number, a.rush_serial_number].filter(Boolean);
      // Étiquette scannée que l'annonce ne connaissait pas encore (l'annonce ne
      // portait que la RUSH) : elle devient l'étiquette d'origine de la ligne.
      const fresh = [t1, ...(t2 ? [t2] : [])].find((p) => !knownSerials.includes(p.serialNumber));
      const linkPatch =
        fresh && a.tag_number === a.rush_tag_number
          ? {
              tag_number: fresh.rawTag,
              serial_number: fresh.serialNumber,
              issuer_code: fresh.issuerCode,
              airline_numeric_code: fresh.airlineNumericCode,
            }
          : {};
      await supabase
        .from('baggage')
        .update({
          rush_status: 'approved',
          rush_status_at: now,
          rush_status_by: a.announced_by ?? null,
          scanned_by: scannedBy ?? null,
          scanned_at: now,
          ...linkPatch,
        })
        .eq('id', a.id)
        .eq('rush_status', 'expected');
      const who = a.rush_owner_name ? ` ${a.rush_owner_name},` : '';
      const from = a.rush_origin ? ` ${a.rush_origin}.` : '';
      return reply.send({
        status: 'accepted',
        known: true,
        validation: 'approved',
        passengerName: a.rush_owner_name,
        originFlight: a.rush_origin,
        tagNumber: (linkPatch as { tag_number?: string }).tag_number ?? a.tag_number,
        rushTagNumber: a.rush_tag_number ?? a.tag_number,
        message: `Bagage annoncé par le superviseur :${who}${from} Autorisé.`,
      } satisfies ExpeditionRushResult);
    }

    // Déjà enregistré en expédition rush sur ce vol ? (les annonces en attente
    // viennent d'être traitées au-dessus, on ne regarde que le reste)
    const { data: existing } = await supabase
      .from('baggage')
      .select('id, rush_status')
      .eq('flight_id', flightId)
      .eq('kind', 'rush_forward')
      .neq('rush_status', 'expected')
      .or(eitherSerial(serials))
      .limit(1)
      .maybeSingle();
    if (existing) {
      const st = (existing as { rush_status: string | null }).rush_status;
      return reply.send({
        status: 'rejected',
        message:
          st === 'pending'
            ? 'Bagage déjà enregistré, en attente de validation du superviseur.'
            : st === 'denied'
              ? 'Bagage refusé par le superviseur. Ne pas embarquer.'
              : 'Bagage déjà enregistré et autorisé. Passez au suivant.',
      } satisfies ExpeditionRushResult);
    }

    // Bagage d'un passager de CE vol : la réconciliation se fait au tapis,
    // jamais ici. Impossible de sauter les règles anti-fraude par cet écran.
    const { data: ownBag } = await supabase
      .from('baggage')
      .select('id')
      .eq('flight_id', flightId)
      .eq('kind', 'passenger')
      .eq('cancelled', false)
      .in('serial_number', serials)
      .limit(1)
      .maybeSingle();
    if (ownBag) {
      return reply.send({
        status: 'rejected',
        message: "Ce bagage appartient à un passager de ce vol. Passez-le au tapis, écran Bagages.",
      } satisfies ExpeditionRushResult);
    }

    // Restant connu : bagage marqué Restants dans CET aéroport ces 7 derniers
    // jours (les n° de série se recyclent, on ne cherche pas plus loin ; on
    // prend le marquage le plus récent en cas de collision).
    const norm = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();
    const airport = norm(request.authAirport) || norm(flight.origin);
    const since = new Date(`${flight.date}T00:00:00Z`);
    since.setUTCDate(since.getUTCDate() - 7);
    const sinceStr = since.toISOString().slice(0, 10);

    const { data: recent } = await supabase
      .from('flights')
      .select('id, flight_number, date, origin, stops')
      .gte('date', sinceStr)
      .lte('date', flight.date);
    const candidates = (
      (recent as Pick<Flight, 'id' | 'flight_number' | 'date' | 'origin' | 'stops'>[] | null) ?? []
    ).filter(
      (f) => f.id !== flightId && (norm(f.origin) === airport || (f.stops ?? []).some((s) => norm(s) === airport)),
    );

    interface RestantRow {
      id: string;
      passenger_id: string;
      tag_number: string;
      serial_number: string | null;
      issuer_code: string | null;
      airline_numeric_code: string | null;
      flight_id: string;
    }
    let known: { bag: RestantRow; flightLabel: string; passengerName: string } | null = null;
    if (candidates.length > 0) {
      const { data: rest } = await supabase
        .from('baggage')
        .select('id, passenger_id, tag_number, serial_number, issuer_code, airline_numeric_code, flight_id')
        .in(
          'flight_id',
          candidates.map((f) => f.id),
        )
        .eq('kind', 'passenger')
        .eq('rush', true)
        .eq('cancelled', false)
        .in('serial_number', serials)
        .order('rush_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const bag = rest as RestantRow | null;
      if (bag) {
        // Un restant ne se réachemine qu'une fois : s'il a déjà sa ligne
        // d'expédition (non refusée), on ne le duplique pas sur un autre vol.
        const { data: fwd } = await supabase
          .from('baggage')
          .select('id')
          .eq('kind', 'rush_forward')
          .eq('origin_baggage_id', bag.id)
          .neq('rush_status', 'denied')
          .limit(1)
          .maybeSingle();
        if (fwd) {
          return reply.send({
            status: 'rejected',
            message: 'Ce restant a déjà été réacheminé sur un autre vol. Vérifiez avec le superviseur.',
          } satisfies ExpeditionRushResult);
        }

        const of = candidates.find((f) => f.id === bag.flight_id);
        const { data: pax } = await supabase
          .from('passengers')
          .select('full_name')
          .eq('id', bag.passenger_id)
          .single();
        known = {
          bag,
          flightLabel: of ? `${of.flight_number} du ${of.date}` : 'un vol précédent',
          passengerName: (pax as { full_name: string } | null)?.full_name ?? 'passager inconnu',
        };
      }
    }

    // Premier scan : on dit ce qu'on a reconnu, et on attend l'autre étiquette
    // (sauf si l'agent a indiqué que le bagage n'en porte qu'une).
    if (!t2 && !soloTag) {
      if (known) {
        return reply.send({
          status: 'lookup',
          known: true,
          passengerName: known.passengerName,
          originFlight: known.flightLabel,
          message: `Bagage de ${known.passengerName}, resté du vol ${known.flightLabel}. Scannez maintenant l'étiquette RUSH pour la lier.`,
        } satisfies ExpeditionRushResult);
      }
      return reply.send({
        status: 'lookup',
        known: false,
        passengerName: null,
        originFlight: null,
        message: "Étiquette non reconnue. Scannez l'autre étiquette du bagage.",
      } satisfies ExpeditionRushResult);
    }

    // Enregistrement. L'étiquette d'origine est celle qui correspond au restant
    // connu ; pour un bagage externe, l'ordre de scan fait foi (les écrans aval
    // cherchent de toute façon sur les deux numéros). Étiquette unique : le
    // même numéro sert des deux côtés.
    const original = known && t2 && known.bag.serial_number === t2.serialNumber ? t2 : t1;
    const rushTag = t2 ? (original === t1 ? t2 : t1) : t1;

    const { error: insErr } = await supabase.from('baggage').insert({
      flight_id: flightId,
      kind: 'rush_forward',
      passenger_id: known?.bag.passenger_id ?? null,
      tag_number: original.rawTag,
      issuer_code: original.issuerCode,
      airline_numeric_code: original.airlineNumericCode,
      serial_number: original.serialNumber,
      rush_tag_number: rushTag.rawTag,
      rush_serial_number: rushTag.serialNumber,
      origin_baggage_id: known?.bag.id ?? null,
      rush_status: known ? 'approved' : 'pending',
      rush_status_at: known ? new Date().toISOString() : null,
      is_confirmed: false,
      scanned_by: scannedBy ?? null,
    });
    if (insErr) {
      if (insErr.code === '23505') {
        return reply.send({
          status: 'rejected',
          message: 'Une ligne existe déjà pour cette étiquette sur ce vol. Vérifiez avec le superviseur.',
        } satisfies ExpeditionRushResult);
      }
      request.log.error(insErr);
      return reply.code(500).send({ status: 'rejected', message: "Échec de l'enregistrement du bagage" } satisfies ExpeditionRushResult);
    }

    if (known) {
      return reply.send({
        status: 'accepted',
        known: true,
        validation: 'approved',
        passengerName: known.passengerName,
        originFlight: known.flightLabel,
        tagNumber: original.rawTag,
        rushTagNumber: rushTag.rawTag,
        message: `Bagage de ${known.passengerName}, resté du vol ${known.flightLabel}. Rattaché à ce vol, étiquettes liées.`,
      } satisfies ExpeditionRushResult);
    }
    return reply.send({
      status: 'accepted',
      known: false,
      validation: 'pending',
      passengerName: null,
      originFlight: null,
      tagNumber: original.rawTag,
      rushTagNumber: rushTag.rawTag,
      message: 'Bagage inconnu enregistré. En attente de validation du superviseur avant chargement.',
    } satisfies ExpeditionRushResult);
  });

  // ── POST /scan/load-all ─── Charger en soute (groupé, sans scan) ─
  // Pousse en soute tous les bagages enregistrés (is_confirmed) et NON marqués
  // rush. Le flux : on scanne d'abord les bagages rush (restants), puis on
  // charge le reste d'un coup avec cette action.
  app.post<{ Body: { flightId: string; scannedBy?: string } }>('/scan/load-all', async (request, reply) => {
    const { flightId } = request.body;
    const scannedBy = request.authUserId;
    if (!flightId) {
      return reply.code(400).send({ status: 'rejected', message: 'flightId est requis' } satisfies BaggageLoadAllResult);
    }

    const denial = await stationDenial(flightId, request.authAirport, 'charger');
    if (denial) {
      return reply.code(403).send({ error: denial });
    }

    const supabase = getSupabase();

    // État courant des bagages embarquables du vol : confirmés au tapis, plus
    // les expéditions rush validées. Les annulés et les rush en attente ou
    // refusés ne partent jamais en soute par cette action.
    const { data: rows } = await supabase
      .from('baggage')
      .select('id, in_hold, rush, kind, rush_status, is_confirmed, cancelled')
      .eq('flight_id', flightId);
    const all =
      (rows as {
        id: string;
        in_hold: boolean;
        rush: boolean;
        kind: string;
        rush_status: string | null;
        is_confirmed: boolean;
        cancelled: boolean;
      }[] | null) ?? [];
    const bags = all.filter(
      (b) => !b.cancelled && (b.kind === 'rush_forward' ? b.rush_status === 'approved' : b.is_confirmed),
    );

    const confirmed = bags.length;
    const rushed = bags.filter((b) => b.rush).length;
    const alreadyLoaded = bags.filter((b) => b.in_hold && !b.rush).length;
    const toLoad = bags.filter((b) => !b.in_hold && !b.rush).map((b) => b.id);

    if (toLoad.length > 0) {
      await supabase
        .from('baggage')
        .update({ in_hold: true, in_hold_at: new Date().toISOString(), in_hold_by: scannedBy ?? null })
        .in('id', toLoad);
    }

    const result: BaggageLoadAllResult = {
      status: 'accepted',
      loaded: toLoad.length,
      alreadyLoaded,
      rushed,
      confirmed,
      message:
        toLoad.length > 0
          ? `${toLoad.length} bagage(s) chargé(s) en soute.`
          : confirmed === 0
            ? 'Aucun bagage enregistré à charger.'
            : 'Tous les bagages éligibles sont déjà chargés.',
    };
    return reply.send(result);
  });

  // ── POST /scan/soute ─── Identifier le compartiment soute ───
  app.post<{ Body: SouteBody }>('/scan/soute', async (request, reply) => {
    const { tag, flightId, soute } = request.body;
    const scannedBy = request.authUserId;
    if (!tag || !flightId || !soute) {
      return reply.code(400).send({ status: 'rejected', message: 'tag, flightId et soute sont requis' } satisfies BaggageActionResult);
    }
    if (soute !== 'avant' && soute !== 'arriere') {
      return reply.code(400).send({ status: 'rejected', message: 'soute doit être "avant" ou "arriere"' } satisfies BaggageActionResult);
    }

    const denial = await stationDenial(flightId, request.authAirport, 'soute');
    if (denial) {
      return reply.code(403).send({ error: denial });
    }

    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ status: 'rejected', message: (e as Error).message } satisfies BaggageActionResult);
    }

    const supabase = getSupabase();

    const { data: bagRow } = await supabase
      .from('baggage')
      .select('id, passenger_id, is_confirmed, kind, rush_status, cancelled, in_hold, pulled')
      .eq('flight_id', flightId)
      .or(eitherSerial([parsedTag.serialNumber]))
      .order('is_confirmed', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!bagRow) {
      return reply.send({ status: 'rejected', message: "Ce bagage n'appartient pas à ce vol." } satisfies BaggageActionResult);
    }
    if (bagRow.cancelled) {
      // Bagage annulé retrouvé en soute : ce scan CONFIRME le retrait physique.
      // C'est ce qui éteint le bandeau « à retirer de la soute » du dashboard.
      if (bagRow.in_hold && !bagRow.pulled) {
        await supabase
          .from('baggage')
          .update({ pulled: true, pulled_at: new Date().toISOString(), pulled_by: scannedBy ?? null })
          .eq('id', bagRow.id);
        return reply.send({
          status: 'accepted',
          passengerName: '—',
          tagNumber: tag,
          count: 0,
          declaredCount: 0,
          message: 'Bagage annulé retiré de la soute. Mettez-le de côté.',
        } satisfies BaggageActionResult);
      }
      return reply.send({
        status: 'rejected',
        message: 'Bagage annulé par le superviseur. Ne pas le charger.',
      } satisfies BaggageActionResult);
    }
    if (bagRow.kind === 'rush_forward') {
      if (bagRow.rush_status !== 'approved') {
        return reply.send({
          status: 'rejected',
          message:
            bagRow.rush_status === 'expected'
              ? "Bagage rush annoncé mais pas encore enregistré. Passez-le d'abord à l'écran Expédition rush."
              : bagRow.rush_status === 'pending'
                ? 'Bagage rush en attente de validation du superviseur. Ne pas le charger.'
                : 'Bagage rush refusé par le superviseur. Ne pas le charger.',
        } satisfies BaggageActionResult);
      }
    } else if (!bagRow.is_confirmed) {
      return reply.send({ status: 'rejected', message: "Ce bagage n'est pas encore passé au tapis. Enregistrez-le d'abord." } satisfies BaggageActionResult);
    }

    const stamp = new Date().toISOString();
    await supabase
      .from('baggage')
      .update({
        soute,
        soute_at: stamp,
        soute_by: scannedBy ?? null,
        ...(bagRow.kind === 'passenger' ? { tag_number: tag } : {}),
      })
      .eq('id', bagRow.id);

    const { data: pax } = bagRow.passenger_id
      ? await supabase
          .from('passengers')
          .select('full_name, declared_baggage_count')
          .eq('id', bagRow.passenger_id)
          .single()
      : { data: null };

    const { count } = bagRow.passenger_id
      ? await supabase
          .from('baggage')
          .select('id', { count: 'exact', head: true })
          .eq('passenger_id', bagRow.passenger_id)
          .eq('cancelled', false)
          .eq('soute', soute)
      : { count: 1 };

    const souteLabel = soute === 'avant' ? 'soute avant' : 'soute arrière';
    return reply.send({
      status: 'accepted',
      passengerName: pax?.full_name ?? (bagRow.kind === 'rush_forward' ? 'Bagage rush (sans passager)' : '—'),
      tagNumber: tag,
      count: count ?? 0,
      declaredCount: pax?.declared_baggage_count ?? 0,
      message: `Bagage placé en ${souteLabel}.`,
    } satisfies BaggageActionResult);
  });

  // ── POST /scan/dolly ─── Contrôle rayon X → dolly de chargement ─
  // L'agent scanne chaque bagage sortant du rayon X. Seuls les bagages DÉJÀ
  // enregistrés au tapis (is_confirmed, liés à un passager) sont admis sur le
  // dolly et tractés vers l'avion. Tout bagage non enregistré est refusé — on
  // ne charge que du bagage sûr. Renvoie la progression onDolly / confirmés.
  app.post<{ Body: BaggageActionBody }>('/scan/dolly', async (request, reply) => {
    const { tag, flightId } = request.body;
    const scannedBy = request.authUserId;
    if (!tag || !flightId) {
      return reply.code(400).send({ status: 'rejected', message: 'tag et flightId sont requis' } satisfies DollyScanResult);
    }

    const denial = await stationDenial(flightId, request.authAirport, 'dolly');
    if (denial) {
      return reply.code(403).send({ error: denial });
    }

    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ status: 'rejected', message: (e as Error).message } satisfies DollyScanResult);
    }

    const supabase = getSupabase();

    // Bagage de ce vol par n° de série, sur l'une OU l'autre étiquette (un
    // bagage expédié porte aussi son étiquette RUSH) ; on privilégie la ligne
    // confirmée.
    const { data: bagRow } = await supabase
      .from('baggage')
      .select('id, passenger_id, is_confirmed, on_dolly, kind, rush_status, cancelled')
      .eq('flight_id', flightId)
      .or(eitherSerial([parsedTag.serialNumber]))
      .order('is_confirmed', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Compteurs du vol : cible = bagages enregistrés au tapis + expéditions
    // rush validées, hors annulés.
    async function progress(): Promise<{ onDolly: number; confirmed: number }> {
      const [{ count: onDolly }, { count: paxBags }, { count: rushBags }] = await Promise.all([
        supabase
          .from('baggage')
          .select('id', { count: 'exact', head: true })
          .eq('flight_id', flightId)
          .eq('on_dolly', true)
          .eq('cancelled', false),
        supabase
          .from('baggage')
          .select('id', { count: 'exact', head: true })
          .eq('flight_id', flightId)
          .eq('kind', 'passenger')
          .eq('is_confirmed', true)
          .eq('cancelled', false),
        supabase
          .from('baggage')
          .select('id', { count: 'exact', head: true })
          .eq('flight_id', flightId)
          .eq('kind', 'rush_forward')
          .eq('rush_status', 'approved'),
      ]);
      return { onDolly: onDolly ?? 0, confirmed: (paxBags ?? 0) + (rushBags ?? 0) };
    }

    // Règle Dolly : refuser tout bagage non enregistré au tapis. La seule
    // exception est l'expédition rush VALIDÉE — jamais un rush en attente ou
    // refusé : le superviseur reste le seul à faire embarquer un colis sans
    // passager.
    if (!bagRow) {
      return reply.send({ status: 'rejected', message: "Ce bagage n'appartient pas à ce vol. Ne pas le charger." } satisfies DollyScanResult);
    }
    if (bagRow.cancelled) {
      return reply.send({
        status: 'rejected',
        message: 'Bagage annulé par le superviseur. Ne pas le charger.',
      } satisfies DollyScanResult);
    }
    if (bagRow.kind === 'rush_forward') {
      if (bagRow.rush_status === 'expected') {
        return reply.send({
          status: 'rejected',
          message: "Bagage rush annoncé mais pas encore enregistré. Passez-le d'abord à l'écran Expédition rush.",
        } satisfies DollyScanResult);
      }
      if (bagRow.rush_status === 'pending') {
        return reply.send({
          status: 'rejected',
          message: 'Bagage rush en attente de validation du superviseur. Ne pas le charger.',
        } satisfies DollyScanResult);
      }
      if (bagRow.rush_status !== 'approved') {
        return reply.send({
          status: 'rejected',
          message: 'Bagage rush refusé par le superviseur. Ne pas le charger.',
        } satisfies DollyScanResult);
      }
    } else if (!bagRow.is_confirmed) {
      return reply.send({
        status: 'rejected',
        message: "Ce bagage n'est pas passé au tapis. Ne pas le charger.",
      } satisfies DollyScanResult);
    }

    // Contexte passager pour l'affichage (un rush externe n'en a pas).
    const { data: pax } = bagRow.passenger_id
      ? await supabase.from('passengers').select('full_name').eq('id', bagRow.passenger_id).single()
      : { data: null };

    const displayName = pax?.full_name ?? (bagRow.kind === 'rush_forward' ? 'Bagage rush (sans passager)' : '—');

    // Déjà sur le dolly → re-scan, pas de nouvelle écriture.
    if (bagRow.on_dolly) {
      const { onDolly, confirmed } = await progress();
      return reply.send({
        status: 'accepted',
        passengerName: displayName,
        tagNumber: tag,
        onDolly,
        confirmed,
        alreadyOnDolly: true,
        complete: onDolly >= confirmed && confirmed > 0,
        message: 'Déjà sur le dolly.',
      } satisfies DollyScanResult);
    }

    // On ne réécrit jamais tag_number sur un bagage expédié : l'agent a pu
    // scanner l'étiquette RUSH, qui a sa propre colonne.
    await supabase
      .from('baggage')
      .update({
        on_dolly: true,
        on_dolly_at: new Date().toISOString(),
        on_dolly_by: scannedBy,
        ...(bagRow.kind === 'passenger' ? { tag_number: tag } : {}),
      })
      .eq('id', bagRow.id);

    const { onDolly, confirmed } = await progress();
    const complete = onDolly >= confirmed && confirmed > 0;
    return reply.send({
      status: 'accepted',
      passengerName: displayName,
      tagNumber: tag,
      onDolly,
      confirmed,
      alreadyOnDolly: false,
      complete,
      message: complete ? 'Dolly complet. Tous les bagages enregistrés sont chargés.' : 'Bagage vérifié, placé sur le dolly.',
    } satisfies DollyScanResult);
  });

  // ── POST /scan/arrivee ─── Réception à l'escale de destination ─
  // Dernière étape du parcours bagage. L'agent de l'aéroport d'arrivée scanne
  // chaque bagage sorti de la soute pour confirmer sa réception. La cible est
  // le nombre de bagages réellement partis (in_hold, hors rush) : 100 chargés
  // au départ = 100 à scanner à l'arrivée, et l'écart désigne les manquants.
  //
  // On n'accepte que des bagages effectivement chargés sur CE vol : un bagage
  // inconnu, resté au départ (rush) ou jamais chargé est refusé, sinon le
  // compteur d'arrivée ne voudrait plus rien dire.
  app.post<{ Body: BaggageActionBody }>('/scan/arrivee', async (request, reply) => {
    const { tag, flightId } = request.body;
    const scannedBy = request.authUserId;
    if (!tag || !flightId) {
      return reply.code(400).send({ status: 'rejected', message: 'tag et flightId sont requis' } satisfies ArrivalScanResult);
    }

    const denial = await stationDenial(flightId, request.authAirport, 'arrivee');
    if (denial) {
      return reply.code(403).send({ error: denial });
    }

    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ status: 'rejected', message: (e as Error).message } satisfies ArrivalScanResult);
    }

    const supabase = getSupabase();

    const { data: bagRow } = await supabase
      .from('baggage')
      .select('id, passenger_id, is_confirmed, in_hold, rush, arrived, kind, cancelled')
      .eq('flight_id', flightId)
      .or(eitherSerial([parsedTag.serialNumber]))
      .order('is_confirmed', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Compteurs du vol : arrivés / partis en soute (hors rush et annulés).
    async function progress(): Promise<{ arrived: number; expected: number }> {
      const [{ count: arrived }, { count: expected }] = await Promise.all([
        supabase
          .from('baggage')
          .select('id', { count: 'exact', head: true })
          .eq('flight_id', flightId)
          .eq('arrived', true)
          .eq('cancelled', false),
        supabase
          .from('baggage')
          .select('id', { count: 'exact', head: true })
          .eq('flight_id', flightId)
          .eq('in_hold', true)
          .eq('rush', false)
          .eq('cancelled', false),
      ]);
      return { arrived: arrived ?? 0, expected: expected ?? 0 };
    }

    if (!bagRow) {
      return reply.send({ status: 'rejected', message: "Ce bagage n'appartient pas à ce vol." } satisfies ArrivalScanResult);
    }
    if (bagRow.cancelled) {
      return reply.send({
        status: 'rejected',
        message: 'Ce bagage a été annulé au départ et aurait dû être retiré de la soute. Prévenez le superviseur.',
      } satisfies ArrivalScanResult);
    }
    if (bagRow.rush) {
      return reply.send({
        status: 'rejected',
        message: 'Ce bagage était marqué rush, il est resté au départ. Il arrivera sur un autre vol.',
      } satisfies ArrivalScanResult);
    }
    if (!bagRow.in_hold) {
      return reply.send({
        status: 'rejected',
        message: "Ce bagage n'a pas été chargé sur ce vol, il n'aurait pas dû voyager. Prévenez le superviseur.",
      } satisfies ArrivalScanResult);
    }

    const { data: pax } = bagRow.passenger_id
      ? await supabase.from('passengers').select('full_name').eq('id', bagRow.passenger_id).single()
      : { data: null };
    const displayName = pax?.full_name ?? (bagRow.kind === 'rush_forward' ? 'Bagage rush (sans passager)' : '—');

    // Déjà scanné à l'arrivée → re-scan, pas de nouvelle écriture.
    if (bagRow.arrived) {
      const { arrived, expected } = await progress();
      return reply.send({
        status: 'accepted',
        passengerName: displayName,
        tagNumber: tag,
        arrived,
        expected,
        alreadyArrived: true,
        complete: arrived >= expected && expected > 0,
        message: 'Bagage déjà réceptionné.',
      } satisfies ArrivalScanResult);
    }

    await supabase
      .from('baggage')
      .update({
        arrived: true,
        arrived_at: new Date().toISOString(),
        arrived_by: scannedBy,
        ...(bagRow.kind === 'passenger' ? { tag_number: tag } : {}),
      })
      .eq('id', bagRow.id);

    const { arrived, expected } = await progress();
    const complete = arrived >= expected && expected > 0;
    return reply.send({
      status: 'accepted',
      passengerName: displayName,
      tagNumber: tag,
      arrived,
      expected,
      alreadyArrived: false,
      complete,
      message:
        bagRow.kind === 'rush_forward'
          ? 'Bagage rush sans passager à bord. Remettez-le au service bagages pour restitution.'
          : complete
            ? 'Réception complète, tous les bagages chargés sont arrivés.'
            : 'Bagage réceptionné à destination.',
    } satisfies ArrivalScanResult);
  });

  // ── POST /scan/embarquement ─────────────────────────────────
  // Confirme qu'un passager DÉJÀ enregistré (check-in) monte à bord.
  // Pas de logique anti-fraude ici : on marque seulement boarded=true et on
  // renvoie le compteur "reste à embarquer". Un boarding pass d'un passager
  // non enregistré est refusé (le check-in doit précéder l'embarquement).
  app.post<{ Body: EmbarquementBody }>('/scan/embarquement', async (request, reply) => {
    const { raw, flightId } = request.body;
    const scannedBy = request.authUserId;
    if (!raw || !flightId) {
      return reply.code(400).send({ error: 'raw et flightId sont requis' });
    }

    const denial = await stationDenial(flightId, request.authAirport, 'embarquement');
    if (denial) {
      return reply.code(403).send({ error: denial });
    }

    let parsed;
    try {
      parsed = parseBoardingPass(raw);
    } catch {
      return reply.code(400).send({ error: 'Boarding pass illisible. Rescannez le billet.' });
    }
    const supabase = getSupabase();

    const { data: flight, error: flightErr } = await supabase
      .from('flights')
      .select('flight_number')
      .eq('id', flightId)
      .single();

    if (flightErr || !flight) {
      return reply.code(404).send({ error: 'Vol introuvable' });
    }

    if (!flightNumbersMatch(parsed.flightNumber, flight.flight_number)) {
      const result: BoardingGateResult = {
        status: 'rejected',
        message: `Ce billet est pour le vol ${parsed.flightNumber || 'inconnu'}, pas pour ${flight.flight_number}.`,
      };
      return reply.send(result);
    }

    // Identité passager dans un vol = PNR + siège (même clé qu'au check-in).
    const { data: passenger } = await supabase
      .from('passengers')
      .select('id, full_name, seat, boarded, offloaded')
      .eq('flight_id', flightId)
      .eq('pnr', parsed.pnr)
      .eq('seat', parsed.seat)
      .maybeSingle();

    if (!passenger) {
      const result: BoardingGateResult = {
        status: 'rejected',
        message: "Ce passager n'a pas encore fait son check-in. Envoyez-le au comptoir.",
      };
      return reply.send(result);
    }

    if (passenger.offloaded) {
      const result: BoardingGateResult = {
        status: 'rejected',
        message: `${passenger.full_name} a été débarqué par le superviseur. Ne pas embarquer.`,
      };
      return reply.send(result);
    }

    const alreadyBoarded = passenger.boarded === true;
    if (!alreadyBoarded) {
      await supabase
        .from('passengers')
        .update({ boarded: true, boarded_at: new Date().toISOString(), boarded_by: scannedBy ?? null })
        .eq('id', passenger.id);
    }

    // Compteurs du vol (après mise à jour).
    const [{ count: registered }, { count: boarded }] = await Promise.all([
      supabase.from('passengers').select('id', { count: 'exact', head: true }).eq('flight_id', flightId),
      supabase
        .from('passengers')
        .select('id', { count: 'exact', head: true })
        .eq('flight_id', flightId)
        .eq('boarded', true),
    ]);

    const reg = registered ?? 0;
    const brd = boarded ?? 0;
    const result: BoardingGateResult = {
      status: 'accepted',
      passengerName: passenger.full_name,
      seat: passenger.seat ?? '—',
      alreadyBoarded,
      counts: { registered: reg, boarded: brd, remaining: Math.max(reg - brd, 0) },
    };
    return reply.send(result);
  });
}
