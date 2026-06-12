// packages/api/src/server.ts
import Fastify from "fastify";

// packages/bcbp-parser/src/baggage.ts
var PHYSICAL_LENGTH = 10;
var BOARDING_LENGTH = 13;
function parseBaggageTag(tag) {
  if (!/^\d+$/.test(tag)) {
    throw new Error(`Invalid baggage tag: "${tag}" must contain only digits`);
  }
  if (tag.length !== PHYSICAL_LENGTH && tag.length !== BOARDING_LENGTH) {
    throw new Error(
      `Invalid baggage tag length: ${tag.length}, expected ${PHYSICAL_LENGTH} or ${BOARDING_LENGTH}`
    );
  }
  return {
    issuerCode: tag[0],
    airlineNumericCode: tag.slice(1, 4),
    serialNumber: tag.slice(4, 10),
    // 6 chiffres = clé de liaison passager ↔ bagage
    declaredBaggageCount: tag.length === BOARDING_LENGTH ? parseInt(tag.slice(10, 13), 10) : 0,
    rawTag: tag
  };
}

// packages/bcbp-parser/src/boarding.ts
import { decode } from "bcbp";
function parseBoardingPass(raw) {
  const parsed = decode(raw);
  const legs = parsed.data?.legs ?? [];
  const first = legs[0];
  if (!first) {
    throw new Error("Boarding pass invalide : aucun leg trouv\xE9");
  }
  return {
    fullName: formatName(parsed.data?.passengerName ?? ""),
    pnr: first.operatingCarrierPNR ?? "",
    flightNumber: normalizeFlightNumber(first),
    seat: first.seatNumber ?? "",
    class: first.compartmentCode ?? "",
    sequenceNumber: parseSequence(first.checkInSequenceNumber),
    declaredBaggageCount: countDeclaredBags(parsed),
    baggageTags: extractBaggageTags(parsed),
    legs: legs.map(mapLeg),
    rawBcbp: raw
  };
}
function mapLeg(leg, index) {
  return {
    origin: leg.departureAirport ?? "",
    destination: leg.arrivalAirport ?? "",
    flightNumber: normalizeFlightNumber(leg),
    order: index + 1
  };
}
function normalizeFlightNumber(leg) {
  const carrier = leg.operatingCarrierDesignator?.trim() ?? "";
  const number = leg.flightNumber?.trim() ?? "";
  return carrier ? `${carrier}${number}` : number;
}
function formatName(raw) {
  const [last = "", first = ""] = raw.trim().split("/");
  const lastName = last.trim();
  const firstName = first.trim();
  if (!firstName) return lastName;
  const formattedFirst = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
  return `${lastName} ${formattedFirst}`;
}
function parseSequence(raw) {
  const n = parseInt((raw ?? "").trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}
function countDeclaredBags(parsed) {
  const data = parsed.data;
  if (!data) return 0;
  const tags = [data.baggageTagNumber, data.firstBaggageTagNumber, data.secondBaggageTagNumber];
  let total = 0;
  for (const tag of tags) {
    const digits = (tag ?? "").replace(/\D/g, "");
    if (digits.length >= 13) {
      total += parseInt(digits.slice(-3), 10) || 0;
    }
  }
  return total;
}
function extractBaggageTags(parsed) {
  const data = parsed.data;
  if (!data) return [];
  return [data.baggageTagNumber, data.firstBaggageTagNumber, data.secondBaggageTagNumber].filter(
    (tag) => typeof tag === "string" && tag.trim().length > 0
  );
}

// packages/shared/src/types.ts
var FRAUD_REASON = {
  PASSENGER_NOT_REGISTERED: "Passager non enregistr\xE9",
  ZERO_DECLARED: "0 bagage d\xE9clar\xE9 sur boarding pass",
  QUOTA_EXCEEDED: "Quota bagage d\xE9pass\xE9",
  ALREADY_SCANNED: "Bagage d\xE9j\xE0 enregistr\xE9",
  WRONG_FLIGHT: "Bagage appartient \xE0 un autre vol"
};

// packages/shared/src/flight.ts
function splitFlightNumber(raw) {
  const cleaned = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = cleaned.match(/^([A-Z]*)(\d+)?$/);
  if (!m) return { carrier: cleaned, number: null };
  const digits = m[2];
  return { carrier: m[1] ?? "", number: digits !== void 0 ? parseInt(digits, 10) : null };
}
function flightNumbersMatch(a, b) {
  const fa = splitFlightNumber(a);
  const fb = splitFlightNumber(b);
  if (fa.number === null || fb.number === null) return false;
  if (fa.number !== fb.number) return false;
  if (fa.carrier && fb.carrier) return fa.carrier === fb.carrier;
  return true;
}

// packages/api/src/supabase.ts
import { createClient } from "@supabase/supabase-js";
var client = null;
function getSupabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis");
  }
  client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  return client;
}

// packages/api/src/fraud.ts
function reject(reason, message) {
  return { result: { status: "rejected", reason, fraudAlert: false, message }, fraudAlert: null, confirmBagId: null };
}
function rejectWithAlert(ctx, reason, message) {
  return {
    result: { status: "rejected", reason, fraudAlert: true, message },
    fraudAlert: {
      flight_id: ctx.flightId,
      pnr: ctx.passenger?.pnr ?? null,
      passenger_name: ctx.passenger?.fullName ?? null,
      tag_number: ctx.parsedTag.rawTag,
      declared_baggage_count: ctx.passenger?.declaredBaggageCount ?? null,
      gate: ctx.gate,
      reason
    },
    confirmBagId: null
  };
}
function evaluateBaggageScan(ctx) {
  const { registeredBag, passenger, parsedTag } = ctx;
  if (ctx.duplicateConfirmedTag) {
    return reject(FRAUD_REASON.ALREADY_SCANNED, "\u26A0\uFE0F Bagage d\xE9j\xE0 enregistr\xE9");
  }
  if (!registeredBag || !passenger) {
    return rejectWithAlert(
      ctx,
      FRAUD_REASON.PASSENGER_NOT_REGISTERED,
      "Bagage non autoris\xE9 \u2014 superviseur alert\xE9"
    );
  }
  if (passenger.flightId !== ctx.flightId) {
    return reject(FRAUD_REASON.WRONG_FLIGHT, "Bagage appartient \xE0 un autre vol");
  }
  if (registeredBag.isConfirmed) {
    return reject(FRAUD_REASON.ALREADY_SCANNED, "\u26A0\uFE0F Bagage d\xE9j\xE0 enregistr\xE9");
  }
  if (passenger.declaredBaggageCount === 0) {
    return rejectWithAlert(
      ctx,
      FRAUD_REASON.ZERO_DECLARED,
      "Bagage non autoris\xE9 \u2014 superviseur alert\xE9"
    );
  }
  if (ctx.confirmedCountForPassenger >= passenger.declaredBaggageCount) {
    return rejectWithAlert(
      ctx,
      FRAUD_REASON.QUOTA_EXCEEDED,
      "Bagage non autoris\xE9 \u2014 quota d\xE9pass\xE9, superviseur alert\xE9"
    );
  }
  return {
    result: {
      status: "accepted",
      passengerName: passenger.fullName,
      confirmedCount: ctx.confirmedCountForPassenger + 1,
      declaredCount: passenger.declaredBaggageCount
    },
    fraudAlert: null,
    confirmBagId: registeredBag.id
  };
}

// packages/api/src/routes/scan.ts
async function scanRoutes(app2) {
  app2.post("/scan/boarding", async (request, reply) => {
    const { raw, flightId, scannedBy } = request.body;
    if (!raw || !flightId) {
      return reply.code(400).send({ error: "raw et flightId sont requis" });
    }
    const parsed = parseBoardingPass(raw);
    const supabase = getSupabase();
    const { data: flight, error: flightErr } = await supabase.from("flights").select("flight_number").eq("id", flightId).single();
    if (flightErr || !flight) {
      return reply.code(404).send({ error: "Vol introuvable" });
    }
    if (!flightNumbersMatch(parsed.flightNumber, flight.flight_number)) {
      return reply.code(409).send({
        error: `\u26A0\uFE0F Boarding pass ${parsed.flightNumber || "\u2014"} \u2014 vol ${flight.flight_number}. Mauvais vol.`
      });
    }
    const { data: passenger, error } = await supabase.from("passengers").insert({
      flight_id: flightId,
      full_name: parsed.fullName,
      pnr: parsed.pnr,
      seat: parsed.seat,
      class: parsed.class,
      sequence_number: parsed.sequenceNumber,
      declared_baggage_count: parsed.declaredBaggageCount,
      raw_bcbp: parsed.rawBcbp,
      scanned_by: scannedBy ?? null
    }).select().single();
    if (error) {
      if (error.code === "23505") {
        return reply.code(409).send({ error: "\u26A0\uFE0F Passager d\xE9j\xE0 enregistr\xE9" });
      }
      request.log.error(error);
      return reply.code(500).send({ error: "\xC9chec de l'enregistrement du passager" });
    }
    if (parsed.legs.length > 0) {
      await supabase.from("passenger_legs").insert(
        parsed.legs.map((leg) => ({
          passenger_id: passenger.id,
          origin: leg.origin,
          destination: leg.destination,
          flight_number: leg.flightNumber,
          leg_order: leg.order
        }))
      );
    }
    const preRegistered = parsed.baggageTags.flatMap((rawTag) => {
      const digits = rawTag.replace(/\D/g, "");
      if (digits.length !== 13 && digits.length !== 10) return [];
      const pt = parseBaggageTag(digits);
      const count = digits.length === 13 ? pt.declaredBaggageCount : 1;
      if (count <= 0) return [];
      const baseSerial = parseInt(pt.serialNumber, 10);
      return Array.from({ length: count }, (_, i) => {
        const serial = String(baseSerial + i).padStart(6, "0");
        return {
          passenger_id: passenger.id,
          flight_id: flightId,
          tag_number: `${pt.issuerCode}${pt.airlineNumericCode}${serial}`,
          issuer_code: pt.issuerCode,
          airline_numeric_code: pt.airlineNumericCode,
          serial_number: serial,
          is_confirmed: false
        };
      });
    });
    if (preRegistered.length > 0) {
      await supabase.from("baggage").upsert(preRegistered, { onConflict: "flight_id,tag_number", ignoreDuplicates: true });
    }
    return reply.send({
      passenger: {
        fullName: parsed.fullName,
        pnr: parsed.pnr,
        seat: parsed.seat,
        class: parsed.class,
        declaredBaggageCount: parsed.declaredBaggageCount,
        legs: parsed.legs
      }
    });
  });
  app2.post("/scan/baggage", async (request, reply) => {
    const { tag, flightId, gate, scannedBy } = request.body;
    if (!tag || !flightId) {
      return reply.code(400).send({ error: "tag et flightId sont requis" });
    }
    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    const supabase = getSupabase();
    const { data: dupRow } = await supabase.from("baggage").select("id").eq("flight_id", flightId).eq("tag_number", tag).eq("is_confirmed", true).maybeSingle();
    const { data: bagRow } = await supabase.from("baggage").select("id, passenger_id, tag_number, is_confirmed").eq("flight_id", flightId).eq("serial_number", parsedTag.serialNumber).order("is_confirmed", { ascending: true }).limit(1).maybeSingle();
    let passenger = null;
    let confirmedCount = 0;
    if (bagRow) {
      const { data: pax } = await supabase.from("passengers").select("id, full_name, pnr, flight_id, declared_baggage_count").eq("id", bagRow.passenger_id).single();
      if (pax) {
        passenger = {
          id: pax.id,
          fullName: pax.full_name,
          pnr: pax.pnr,
          flightId: pax.flight_id,
          declaredBaggageCount: pax.declared_baggage_count
        };
        const { count } = await supabase.from("baggage").select("id", { count: "exact", head: true }).eq("passenger_id", pax.id).eq("is_confirmed", true);
        confirmedCount = count ?? 0;
      }
    }
    const decision = evaluateBaggageScan({
      parsedTag,
      flightId,
      gate: gate ?? null,
      registeredBag: bagRow ? { id: bagRow.id, passengerId: bagRow.passenger_id, tagNumber: bagRow.tag_number, isConfirmed: bagRow.is_confirmed } : null,
      passenger,
      confirmedCountForPassenger: confirmedCount,
      duplicateConfirmedTag: Boolean(dupRow)
    });
    if (decision.confirmBagId) {
      await supabase.from("baggage").update({ is_confirmed: true, tag_number: tag, scanned_by: scannedBy ?? null, scanned_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", decision.confirmBagId);
    }
    if (decision.fraudAlert) {
      const { data: existingAlert } = await supabase.from("fraud_alerts").select("id").eq("tag_number", decision.fraudAlert.tag_number).eq("flight_id", decision.fraudAlert.flight_id).maybeSingle();
      if (!existingAlert) {
        await supabase.from("fraud_alerts").insert(decision.fraudAlert);
      }
    }
    return reply.send(decision.result);
  });
  async function markBaggage(field, body) {
    const { tag, flightId, scannedBy } = body;
    if (!tag || !flightId) {
      return { code: 400, result: { status: "rejected", message: "tag et flightId sont requis" } };
    }
    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return { code: 400, result: { status: "rejected", message: e.message } };
    }
    const supabase = getSupabase();
    const { data: bagRow } = await supabase.from("baggage").select("id, passenger_id, is_confirmed").eq("flight_id", flightId).eq("serial_number", parsedTag.serialNumber).order("is_confirmed", { ascending: false }).limit(1).maybeSingle();
    if (!bagRow) {
      return { code: 200, result: { status: "rejected", message: "Bagage inconnu sur ce vol." } };
    }
    if (!bagRow.is_confirmed) {
      return {
        code: 200,
        result: { status: "rejected", message: "Bagage non enregistr\xE9 au tapis \u2014 confirmez-le d\u2019abord." }
      };
    }
    const stamp = (/* @__PURE__ */ new Date()).toISOString();
    const patch = field === "in_hold" ? { in_hold: true, in_hold_at: stamp, in_hold_by: scannedBy ?? null } : { rush: true, rush_at: stamp, rush_by: scannedBy ?? null };
    await supabase.from("baggage").update({ ...patch, tag_number: tag }).eq("id", bagRow.id);
    const { data: pax } = await supabase.from("passengers").select("full_name, declared_baggage_count").eq("id", bagRow.passenger_id).single();
    const { count } = await supabase.from("baggage").select("id", { count: "exact", head: true }).eq("passenger_id", bagRow.passenger_id).eq(field, true);
    const verb = field === "in_hold" ? "charg\xE9 en soute" : "marqu\xE9 pour r\xE9acheminement";
    return {
      code: 200,
      result: {
        status: "accepted",
        passengerName: pax?.full_name ?? "\u2014",
        tagNumber: tag,
        count: count ?? 0,
        declaredCount: pax?.declared_baggage_count ?? 0,
        message: `Bagage ${verb}.`
      }
    };
  }
  app2.post("/scan/rush", async (request, reply) => {
    const { code, result } = await markBaggage("rush", request.body);
    return reply.code(code).send(result);
  });
  app2.post("/scan/load-all", async (request, reply) => {
    const { flightId, scannedBy } = request.body;
    if (!flightId) {
      return reply.code(400).send({ status: "rejected", message: "flightId est requis" });
    }
    const supabase = getSupabase();
    const { data: rows } = await supabase.from("baggage").select("id, in_hold, rush").eq("flight_id", flightId).eq("is_confirmed", true);
    const bags = rows ?? [];
    const confirmed = bags.length;
    const rushed = bags.filter((b) => b.rush).length;
    const alreadyLoaded = bags.filter((b) => b.in_hold && !b.rush).length;
    const toLoad = bags.filter((b) => !b.in_hold && !b.rush).map((b) => b.id);
    if (toLoad.length > 0) {
      await supabase.from("baggage").update({ in_hold: true, in_hold_at: (/* @__PURE__ */ new Date()).toISOString(), in_hold_by: scannedBy ?? null }).in("id", toLoad);
    }
    const result = {
      status: "accepted",
      loaded: toLoad.length,
      alreadyLoaded,
      rushed,
      confirmed,
      message: toLoad.length > 0 ? `${toLoad.length} bagage(s) charg\xE9(s) en soute.` : confirmed === 0 ? "Aucun bagage enregistr\xE9 \xE0 charger." : "Tous les bagages \xE9ligibles sont d\xE9j\xE0 charg\xE9s."
    };
    return reply.send(result);
  });
  app2.post("/scan/soute", async (request, reply) => {
    const { tag, flightId, soute, scannedBy } = request.body;
    if (!tag || !flightId || !soute) {
      return reply.code(400).send({ status: "rejected", message: "tag, flightId et soute sont requis" });
    }
    if (soute !== "avant" && soute !== "arriere") {
      return reply.code(400).send({ status: "rejected", message: 'soute doit \xEAtre "avant" ou "arriere"' });
    }
    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ status: "rejected", message: e.message });
    }
    const supabase = getSupabase();
    const { data: bagRow } = await supabase.from("baggage").select("id, passenger_id, is_confirmed").eq("flight_id", flightId).eq("serial_number", parsedTag.serialNumber).order("is_confirmed", { ascending: false }).limit(1).maybeSingle();
    if (!bagRow) {
      return reply.send({ status: "rejected", message: "Bagage inconnu sur ce vol." });
    }
    if (!bagRow.is_confirmed) {
      return reply.send({ status: "rejected", message: "Bagage non enregistr\xE9 au tapis \u2014 confirmez-le d'abord." });
    }
    const stamp = (/* @__PURE__ */ new Date()).toISOString();
    await supabase.from("baggage").update({ soute, soute_at: stamp, soute_by: scannedBy ?? null, tag_number: tag }).eq("id", bagRow.id);
    const { data: pax } = await supabase.from("passengers").select("full_name, declared_baggage_count").eq("id", bagRow.passenger_id).single();
    const { count } = await supabase.from("baggage").select("id", { count: "exact", head: true }).eq("passenger_id", bagRow.passenger_id).eq("soute", soute);
    const souteLabel = soute === "avant" ? "soute avant" : "soute arri\xE8re";
    return reply.send({
      status: "accepted",
      passengerName: pax?.full_name ?? "\u2014",
      tagNumber: tag,
      count: count ?? 0,
      declaredCount: pax?.declared_baggage_count ?? 0,
      message: `Bagage plac\xE9 en ${souteLabel}.`
    });
  });
  app2.post("/scan/embarquement", async (request, reply) => {
    const { raw, flightId, scannedBy } = request.body;
    if (!raw || !flightId) {
      return reply.code(400).send({ error: "raw et flightId sont requis" });
    }
    const parsed = parseBoardingPass(raw);
    const supabase = getSupabase();
    const { data: flight, error: flightErr } = await supabase.from("flights").select("flight_number").eq("id", flightId).single();
    if (flightErr || !flight) {
      return reply.code(404).send({ error: "Vol introuvable" });
    }
    if (!flightNumbersMatch(parsed.flightNumber, flight.flight_number)) {
      const result2 = {
        status: "rejected",
        message: `\u26A0\uFE0F Boarding pass ${parsed.flightNumber || "\u2014"} \u2014 vol ${flight.flight_number}. Mauvais vol.`
      };
      return reply.send(result2);
    }
    const { data: passenger } = await supabase.from("passengers").select("id, full_name, seat, boarded").eq("flight_id", flightId).eq("pnr", parsed.pnr).eq("seat", parsed.seat).maybeSingle();
    if (!passenger) {
      const result2 = {
        status: "rejected",
        message: "\u26A0\uFE0F Passager non enregistr\xE9 \u2014 check-in requis avant embarquement."
      };
      return reply.send(result2);
    }
    const alreadyBoarded = passenger.boarded === true;
    if (!alreadyBoarded) {
      await supabase.from("passengers").update({ boarded: true, boarded_at: (/* @__PURE__ */ new Date()).toISOString(), boarded_by: scannedBy ?? null }).eq("id", passenger.id);
    }
    const [{ count: registered }, { count: boarded }] = await Promise.all([
      supabase.from("passengers").select("id", { count: "exact", head: true }).eq("flight_id", flightId),
      supabase.from("passengers").select("id", { count: "exact", head: true }).eq("flight_id", flightId).eq("boarded", true)
    ]);
    const reg = registered ?? 0;
    const brd = boarded ?? 0;
    const result = {
      status: "accepted",
      passengerName: passenger.full_name,
      seat: passenger.seat ?? "\u2014",
      alreadyBoarded,
      counts: { registered: reg, boarded: brd, remaining: Math.max(reg - brd, 0) }
    };
    return reply.send(result);
  });
}

// packages/api/src/server.ts
function buildServer() {
  const app2 = Fastify({ logger: true });
  app2.get("/health", async () => ({ status: "ok" }));
  app2.register(scanRoutes);
  return app2;
}

// packages/api/src/index.ts
var app = buildServer();
var port = Number(process.env.PORT ?? 3001);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
