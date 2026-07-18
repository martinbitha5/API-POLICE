import type { FastifyInstance } from 'fastify';
import { parseBoardingPass, parseBaggageTag } from '@police/bcbp-parser';
import {
  flightNumbersMatch,
  type BoardingGateResult,
  type BaggageActionResult,
  type BaggageLoadAllResult,
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
      return reply.code(400).send({ error: '⚠️ Boarding pass illisible — rescannez.' });
    }
    const supabase = getSupabase();

    // Le boarding pass doit appartenir au vol sélectionné. On compare le n° de vol
    // du premier leg (le segment embarqué à cette porte) à celui du vol choisi.
    // Tolère le zéro-padding ("ET64" == "ET0064"). Rejet sinon — pas d'alerte
    // fraude : c'est une erreur de porte, pas une fraude bagage.
    const { data: flight, error: flightErr } = await supabase
      .from('flights')
      .select('flight_number')
      .eq('id', flightId)
      .single();

    if (flightErr || !flight) {
      return reply.code(404).send({ error: 'Vol introuvable' });
    }

    if (!flightNumbersMatch(parsed.flightNumber, flight.flight_number)) {
      return reply.code(409).send({
        error: `⚠️ Boarding pass ${parsed.flightNumber || '—'} — vol ${flight.flight_number}. Mauvais vol.`,
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
        return reply.code(409).send({ error: '⚠️ Passager déjà enregistré' });
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

    let passenger: BaggageScanContext['passenger'] = null;
    let confirmedCount = 0;
    if (bagRow) {
      const { data: pax } = await supabase
        .from('passengers')
        .select('id, full_name, pnr, flight_id, declared_baggage_count')
        .eq('id', bagRow.passenger_id)
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
      registeredBag: bagRow
        ? { id: bagRow.id, passengerId: bagRow.passenger_id, tagNumber: bagRow.tag_number, isConfirmed: bagRow.is_confirmed }
        : null,
      passenger,
      confirmedCountForPassenger: confirmedCount,
      duplicateConfirmedTag: Boolean(dupRow),
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
      return { code: 200, result: { status: 'rejected', message: 'Bagage inconnu sur ce vol.' } };
    }
    if (!bagRow.is_confirmed) {
      return {
        code: 200,
        result: { status: 'rejected', message: 'Bagage non enregistré au tapis — confirmez-le d’abord.' },
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
      return reply.send({ status: 'rejected', message: 'Bagage inconnu sur ce vol.' } satisfies BaggageActionResult);
    }
    if (!bagRow.is_confirmed) {
      return reply.send({ status: 'rejected', message: 'Bagage non enregistré au tapis — confirmez-le d\'abord.' } satisfies BaggageActionResult);
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
      return reply.code(400).send({ error: '⚠️ Boarding pass illisible — rescannez.' });
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
        message: `⚠️ Boarding pass ${parsed.flightNumber || '—'} — vol ${flight.flight_number}. Mauvais vol.`,
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
        message: '⚠️ Passager non enregistré — check-in requis avant embarquement.',
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
