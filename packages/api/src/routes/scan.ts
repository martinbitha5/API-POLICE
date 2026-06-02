import type { FastifyInstance } from 'fastify';
import { parseBoardingPass, parseBaggageTag } from '@police/bcbp-parser';
import { flightNumbersMatch } from '@police/shared';
import { getSupabase } from '../supabase.js';
import { evaluateBaggageScan, type BaggageScanContext } from '../fraud.js';

interface BoardingBody {
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

export async function scanRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /scan/boarding ─────────────────────────────────────
  app.post<{ Body: BoardingBody }>('/scan/boarding', async (request, reply) => {
    const { raw, flightId, scannedBy } = request.body;
    if (!raw || !flightId) {
      return reply.code(400).send({ error: 'raw et flightId sont requis' });
    }

    const parsed = parseBoardingPass(raw);
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
    const { tag, flightId, gate, scannedBy } = request.body;
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
      await supabase.from('fraud_alerts').insert(decision.fraudAlert);
    }

    return reply.send(decision.result);
  });
}
