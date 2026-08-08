import type { FastifyInstance } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseBoardingPass, parseBaggageTag } from '@police/bcbp-parser';
import {
  flightNumbersMatch,
  type ParsedBaggageTag,
  type BoardingGateResult,
  type BaggageActionResult,
  type BaggageLoadAllResult,
  type DollyScanResult,
  type ArrivalScanResult,
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
      .like('tag_number', `${prefix}%`)
      .order('serial_number', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('baggage')
      .select('serial_number')
      .eq('flight_id', flightId)
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

    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    const supabase = getSupabase();

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
        .select('id, full_name, pnr, flight_id, declared_baggage_count')
        .eq('id', linkedBag.passenger_id)
        .single();
      if (pax) {
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
          .eq('is_confirmed', true);
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
      .select('id, passenger_id, is_confirmed')
      .eq('flight_id', flightId)
      .eq('serial_number', parsedTag.serialNumber)
      .order('is_confirmed', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!bagRow) {
      return { code: 200, result: { status: 'rejected', message: "Ce bagage n'appartient pas à ce vol." } };
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

  // ── POST /scan/rush ─── Marquer un bagage pour réacheminement ─
  app.post<{ Body: BaggageActionBody }>('/scan/rush', async (request, reply) => {
    const { code, result } = await markBaggage('rush', request.body, request.authUserId);
    return reply.code(code).send(result);
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
    const supabase = getSupabase();

    // État courant des bagages confirmés du vol.
    const { data: rows } = await supabase
      .from('baggage')
      .select('id, in_hold, rush')
      .eq('flight_id', flightId)
      .eq('is_confirmed', true);
    const bags = (rows as { id: string; in_hold: boolean; rush: boolean }[] | null) ?? [];

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

    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ status: 'rejected', message: (e as Error).message } satisfies BaggageActionResult);
    }

    const supabase = getSupabase();

    const { data: bagRow } = await supabase
      .from('baggage')
      .select('id, passenger_id, is_confirmed')
      .eq('flight_id', flightId)
      .eq('serial_number', parsedTag.serialNumber)
      .order('is_confirmed', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!bagRow) {
      return reply.send({ status: 'rejected', message: "Ce bagage n'appartient pas à ce vol." } satisfies BaggageActionResult);
    }
    if (!bagRow.is_confirmed) {
      return reply.send({ status: 'rejected', message: "Ce bagage n'est pas encore passé au tapis. Enregistrez-le d'abord." } satisfies BaggageActionResult);
    }

    const stamp = new Date().toISOString();
    await supabase
      .from('baggage')
      .update({ soute, soute_at: stamp, soute_by: scannedBy ?? null, tag_number: tag })
      .eq('id', bagRow.id);

    const { data: pax } = await supabase
      .from('passengers')
      .select('full_name, declared_baggage_count')
      .eq('id', bagRow.passenger_id)
      .single();

    const { count } = await supabase
      .from('baggage')
      .select('id', { count: 'exact', head: true })
      .eq('passenger_id', bagRow.passenger_id)
      .eq('soute', soute);

    const souteLabel = soute === 'avant' ? 'soute avant' : 'soute arrière';
    return reply.send({
      status: 'accepted',
      passengerName: pax?.full_name ?? '—',
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

    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ status: 'rejected', message: (e as Error).message } satisfies DollyScanResult);
    }

    const supabase = getSupabase();

    // Bagage de ce vol par n° de série (clé de liaison) ; on privilégie la ligne confirmée.
    const { data: bagRow } = await supabase
      .from('baggage')
      .select('id, passenger_id, is_confirmed, on_dolly')
      .eq('flight_id', flightId)
      .eq('serial_number', parsedTag.serialNumber)
      .order('is_confirmed', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Compteurs du vol : cible = bagages enregistrés (confirmés).
    async function progress(): Promise<{ onDolly: number; confirmed: number }> {
      const [{ count: onDolly }, { count: confirmed }] = await Promise.all([
        supabase.from('baggage').select('id', { count: 'exact', head: true }).eq('flight_id', flightId).eq('on_dolly', true),
        supabase.from('baggage').select('id', { count: 'exact', head: true }).eq('flight_id', flightId).eq('is_confirmed', true),
      ]);
      return { onDolly: onDolly ?? 0, confirmed: confirmed ?? 0 };
    }

    // Règle Dolly : refuser tout bagage non enregistré au tapis.
    if (!bagRow) {
      return reply.send({ status: 'rejected', message: "Ce bagage n'appartient pas à ce vol. Ne pas le charger." } satisfies DollyScanResult);
    }
    if (!bagRow.is_confirmed) {
      return reply.send({
        status: 'rejected',
        message: "Ce bagage n'est pas passé au tapis. Ne pas le charger.",
      } satisfies DollyScanResult);
    }

    // Contexte passager pour l'affichage.
    const { data: pax } = await supabase
      .from('passengers')
      .select('full_name')
      .eq('id', bagRow.passenger_id)
      .single();

    // Déjà sur le dolly → re-scan, pas de nouvelle écriture.
    if (bagRow.on_dolly) {
      const { onDolly, confirmed } = await progress();
      return reply.send({
        status: 'accepted',
        passengerName: pax?.full_name ?? '—',
        tagNumber: tag,
        onDolly,
        confirmed,
        alreadyOnDolly: true,
        complete: onDolly >= confirmed && confirmed > 0,
        message: 'Déjà sur le dolly.',
      } satisfies DollyScanResult);
    }

    await supabase
      .from('baggage')
      .update({ on_dolly: true, on_dolly_at: new Date().toISOString(), on_dolly_by: scannedBy, tag_number: tag })
      .eq('id', bagRow.id);

    const { onDolly, confirmed } = await progress();
    const complete = onDolly >= confirmed && confirmed > 0;
    return reply.send({
      status: 'accepted',
      passengerName: pax?.full_name ?? '—',
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

    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ status: 'rejected', message: (e as Error).message } satisfies ArrivalScanResult);
    }

    const supabase = getSupabase();

    const { data: bagRow } = await supabase
      .from('baggage')
      .select('id, passenger_id, is_confirmed, in_hold, rush, arrived')
      .eq('flight_id', flightId)
      .eq('serial_number', parsedTag.serialNumber)
      .order('is_confirmed', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Compteurs du vol : arrivés / partis en soute (hors rush).
    async function progress(): Promise<{ arrived: number; expected: number }> {
      const [{ count: arrived }, { count: expected }] = await Promise.all([
        supabase.from('baggage').select('id', { count: 'exact', head: true }).eq('flight_id', flightId).eq('arrived', true),
        supabase
          .from('baggage')
          .select('id', { count: 'exact', head: true })
          .eq('flight_id', flightId)
          .eq('in_hold', true)
          .eq('rush', false),
      ]);
      return { arrived: arrived ?? 0, expected: expected ?? 0 };
    }

    if (!bagRow) {
      return reply.send({ status: 'rejected', message: "Ce bagage n'appartient pas à ce vol." } satisfies ArrivalScanResult);
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

    const { data: pax } = await supabase
      .from('passengers')
      .select('full_name')
      .eq('id', bagRow.passenger_id)
      .single();

    // Déjà scanné à l'arrivée → re-scan, pas de nouvelle écriture.
    if (bagRow.arrived) {
      const { arrived, expected } = await progress();
      return reply.send({
        status: 'accepted',
        passengerName: pax?.full_name ?? '—',
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
      .update({ arrived: true, arrived_at: new Date().toISOString(), arrived_by: scannedBy, tag_number: tag })
      .eq('id', bagRow.id);

    const { arrived, expected } = await progress();
    const complete = arrived >= expected && expected > 0;
    return reply.send({
      status: 'accepted',
      passengerName: pax?.full_name ?? '—',
      tagNumber: tag,
      arrived,
      expected,
      alreadyArrived: false,
      complete,
      message: complete
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
      .select('id, full_name, seat, boarded')
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
