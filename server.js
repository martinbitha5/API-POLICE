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
  /**
   * Règle 1 — l'étiquette ne correspond à aucun bagage déclaré sur un boarding
   * pass de ce vol. On ne sait pas à qui elle appartient : le libellé décrit ce
   * qu'on constate (une étiquette orpheline), pas une conclusion sur le passager.
   */
  UNLINKED_TAG: "\xC9tiquette non rattach\xE9e \xE0 un passager",
  /**
   * @deprecated Ancien libellé de la règle 1, conservé pour les alertes
   * historiques déjà en base. Ne plus émettre : voir UNLINKED_TAG.
   */
  PASSENGER_NOT_REGISTERED: "Passager non enregistr\xE9",
  ZERO_DECLARED: "0 bagage d\xE9clar\xE9 sur boarding pass",
  QUOTA_EXCEEDED: "Quota bagage d\xE9pass\xE9",
  ALREADY_SCANNED: "Bagage d\xE9j\xE0 enregistr\xE9",
  WRONG_FLIGHT: "Bagage appartient \xE0 un autre vol",
  /** Rejets sans alerte fraude : décisions superviseur ou mauvais écran. */
  CANCELLED: "Bagage annul\xE9 par le superviseur",
  OFFLOADED: "Passager d\xE9barqu\xE9",
  RUSH_FORWARD: "Bagage exp\xE9dition rush"
};

// packages/shared/src/date.ts
function isoDate(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function todayLocal() {
  return isoDate(/* @__PURE__ */ new Date());
}
function todayInTimeZone(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(/* @__PURE__ */ new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
    const y = get("year");
    const m = get("month");
    const d = get("day");
    if (y.length === 4 && m.length === 2 && d.length === 2) return `${y}-${m}-${d}`;
  } catch {
  }
  return todayLocal();
}

// packages/shared/src/airports.ts
var DEFAULT_TIME_ZONE = "Africa/Kinshasa";
var KIN = "Africa/Kinshasa";
var LUB = "Africa/Lubumbashi";
var AIRPORTS = [
  // ── Lignes domestiques (RD Congo) ──────────────────────────
  { code: "FIH", city: "Kinshasa", country: "RD Congo", domestic: true, timeZone: KIN },
  { code: "MDK", city: "Mbandaka", country: "RD Congo", domestic: true, timeZone: KIN },
  { code: "GMA", city: "Gemena", country: "RD Congo", domestic: true, timeZone: KIN },
  { code: "BDT", city: "Gbadolite", country: "RD Congo", domestic: true, timeZone: KIN },
  { code: "FBM", city: "Lubumbashi", country: "RD Congo", domestic: true, timeZone: LUB },
  { code: "GOM", city: "Goma", country: "RD Congo", domestic: true, timeZone: LUB },
  { code: "FKI", city: "Kisangani", country: "RD Congo", domestic: true, timeZone: LUB },
  { code: "KND", city: "Kindu", country: "RD Congo", domestic: true, timeZone: LUB },
  { code: "MJM", city: "Mbuji-Mayi", country: "RD Congo", domestic: true, timeZone: LUB },
  { code: "KGA", city: "Kananga", country: "RD Congo", domestic: true, timeZone: LUB },
  { code: "FMI", city: "Kalemie", country: "RD Congo", domestic: true, timeZone: LUB },
  { code: "BUX", city: "Bunia", country: "RD Congo", domestic: true, timeZone: LUB },
  { code: "BNC", city: "Beni", country: "RD Congo", domestic: true, timeZone: LUB },
  { code: "IRP", city: "Isiro", country: "RD Congo", domestic: true, timeZone: LUB },
  // ── Lignes internationales ─────────────────────────────────
  { code: "JNB", city: "Johannesburg", country: "Afrique du Sud", domestic: false, timeZone: "Africa/Johannesburg" },
  { code: "EBB", city: "Entebbe", country: "Ouganda", domestic: false, timeZone: "Africa/Kampala" },
  { code: "DLA", city: "Douala", country: "Cameroun", domestic: false, timeZone: "Africa/Douala" },
  { code: "COO", city: "Cotonou", country: "B\xE9nin", domestic: false, timeZone: "Africa/Porto-Novo" },
  { code: "DAR", city: "Dar es Salaam", country: "Tanzanie", domestic: false, timeZone: "Africa/Dar_es_Salaam" },
  { code: "BRU", city: "Bruxelles", country: "Belgique", domestic: false, timeZone: "Europe/Brussels" }
];
var BY_CODE = Object.fromEntries(AIRPORTS.map((a) => [a.code, a]));
function findAirport(code) {
  return BY_CODE[code.trim().toUpperCase()];
}
function airportLabel(code) {
  const a = findAirport(code);
  return a ? `${a.city} (${a.code})` : code;
}
function airportTimeZone(code) {
  return findAirport(code ?? "")?.timeZone ?? DEFAULT_TIME_ZONE;
}
function todayAtAirport(code) {
  return todayInTimeZone(airportTimeZone(code));
}

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
function sameAirport(a, b) {
  const na = (a ?? "").trim().toUpperCase();
  return na.length > 0 && na === (b ?? "").trim().toUpperCase();
}
function stationRole(flight, airportCode) {
  if (!(airportCode ?? "").trim()) return "unknown";
  const isOrigin = sameAirport(airportCode, flight.origin);
  const isDestination = sameAirport(airportCode, flight.destination);
  const isStop = (flight.stops ?? []).some((s) => sameAirport(airportCode, s));
  if (isStop || isOrigin && isDestination) return "stop";
  if (isOrigin) return "origin";
  if (isDestination) return "destination";
  return "unknown";
}
function operationAllowed(operation, role) {
  switch (role) {
    case "origin":
      return operation !== "arrivee";
    case "destination":
      return operation === "arrivee";
    case "stop":
      return true;
    case "unknown":
      return true;
  }
}
function operationDenial(operation, flight, airportCode) {
  const role = stationRole(flight, airportCode);
  if (operationAllowed(operation, role)) return null;
  return operation === "arrivee" ? `Ce vol part de ${airportLabel(flight.origin)}. Les bagages se r\xE9ceptionnent \xE0 ${airportLabel(flight.destination)}, \xE0 l'arriv\xE9e.` : `Ce vol arrive \xE0 ${airportLabel(flight.destination)}. Les op\xE9rations de d\xE9part se font \xE0 ${airportLabel(flight.origin)}.`;
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
      reason,
      note: ctx.tagNote ?? null
    },
    confirmBagId: null
  };
}
function evaluateBaggageScan(ctx) {
  const { registeredBag, passenger, parsedTag } = ctx;
  if (ctx.duplicateConfirmedTag) {
    return reject(FRAUD_REASON.ALREADY_SCANNED, "Ce bagage a d\xE9j\xE0 \xE9t\xE9 enregistr\xE9. Passez au suivant.");
  }
  if (!registeredBag || !passenger) {
    return rejectWithAlert(
      ctx,
      FRAUD_REASON.UNLINKED_TAG,
      "Bagage refus\xE9. Aucun passager n'a d\xE9clar\xE9 cette \xE9tiquette. Mettez le bagage de c\xF4t\xE9, le superviseur arrive."
    );
  }
  if (passenger.flightId !== ctx.flightId) {
    return reject(
      FRAUD_REASON.WRONG_FLIGHT,
      "Ce bagage n'est pas sur le bon tapis. Il appartient \xE0 un autre vol."
    );
  }
  if (registeredBag.isConfirmed) {
    return reject(FRAUD_REASON.ALREADY_SCANNED, "Ce bagage a d\xE9j\xE0 \xE9t\xE9 enregistr\xE9. Passez au suivant.");
  }
  if (passenger.declaredBaggageCount === 0) {
    return rejectWithAlert(
      ctx,
      FRAUD_REASON.ZERO_DECLARED,
      `Bagage refus\xE9. ${passenger.fullName} voyage sans bagage en soute. Mettez le bagage de c\xF4t\xE9, le superviseur arrive.`
    );
  }
  if (ctx.confirmedCountForPassenger >= passenger.declaredBaggageCount) {
    return rejectWithAlert(
      ctx,
      FRAUD_REASON.QUOTA_EXCEEDED,
      `Bagage refus\xE9. ${passenger.fullName} a d\xE9j\xE0 ses ${passenger.declaredBaggageCount} bagage${passenger.declaredBaggageCount > 1 ? "s" : ""}. Mettez celui-ci de c\xF4t\xE9, le superviseur arrive.`
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

// packages/api/src/auth.ts
var ALLOWED_ROLES = ["agent", "supervisor", "admin"];
function bearerToken(request) {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}
async function authenticate(request, reply) {
  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: "Authentification requise" });
    return;
  }
  const supabase = getSupabase();
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData.user) {
    await reply.code(401).send({ error: "Session invalide ou expir\xE9e" });
    return;
  }
  const { data: profile, error: profErr } = await supabase.from("profiles").select("role, airport_code").eq("id", userData.user.id).single();
  if (profErr || !profile) {
    await reply.code(403).send({ error: "Profil introuvable" });
    return;
  }
  if (!ALLOWED_ROLES.includes(profile.role)) {
    await reply.code(403).send({ error: "R\xF4le non autoris\xE9" });
    return;
  }
  request.authUserId = userData.user.id;
  request.authRole = profile.role;
  request.authAirport = profile.airport_code;
}

// packages/api/src/routes/scan.ts
function eitherSerial(serials) {
  return serials.flatMap((s) => [`serial_number.eq.${s}`, `rush_serial_number.eq.${s}`]).join(",");
}
async function findTagOnOtherFlights(supabase, flightId, parsedTag) {
  const { data: current } = await supabase.from("flights").select("date").eq("id", flightId).single();
  const date = current?.date;
  if (!date) return null;
  const { data: sameDay } = await supabase.from("flights").select("id, flight_number").eq("date", date);
  const others = (sameDay ?? []).filter(
    (f) => f.id !== flightId
  );
  if (others.length === 0) return null;
  const { data: row } = await supabase.from("baggage").select("id, passenger_id, tag_number, is_confirmed, flight_id").in(
    "flight_id",
    others.map((f) => f.id)
  ).eq("kind", "passenger").eq("cancelled", false).eq("serial_number", parsedTag.serialNumber).order("is_confirmed", { ascending: false }).limit(1).maybeSingle();
  const bag = row;
  if (!bag) return null;
  return { bag, flightNumber: others.find((f) => f.id === bag.flight_id)?.flight_number ?? "inconnu" };
}
async function describeUnlinkedTag(supabase, flightId, parsedTag) {
  const prefix = `${parsedTag.issuerCode}${parsedTag.airlineNumericCode}`;
  const [{ data: first }, { data: last }] = await Promise.all([
    supabase.from("baggage").select("serial_number").eq("flight_id", flightId).eq("kind", "passenger").like("tag_number", `${prefix}%`).order("serial_number", { ascending: true }).limit(1).maybeSingle(),
    supabase.from("baggage").select("serial_number").eq("flight_id", flightId).eq("kind", "passenger").like("tag_number", `${prefix}%`).order("serial_number", { ascending: false }).limit(1).maybeSingle()
  ]);
  const serial = parsedTag.serialNumber;
  const lo = first?.serial_number ?? null;
  const hi = last?.serial_number ?? null;
  if (!lo || !hi) {
    return "Aucun bagage n'est encore enregistr\xE9 sur ce vol. V\xE9rifier que le comptoir a commenc\xE9 \xE0 scanner les boarding pass.";
  }
  return serial >= lo && serial <= hi ? "\xC9tiquette imprim\xE9e au comptoir pour ce vol, mais aucun passager ne l'a d\xE9clar\xE9e. Faire intercepter le colis avant le chargement." : "Cette \xE9tiquette ne vient pas du comptoir de ce vol. Bagage probablement \xE9gar\xE9, \xE0 mettre de c\xF4t\xE9.";
}
async function stationDenial(flightId, airport, operation) {
  if (!flightId) return null;
  const { data } = await getSupabase().from("flights").select("origin, destination, stops").eq("id", flightId).maybeSingle();
  const flight = data;
  return flight ? operationDenial(operation, flight, airport) : null;
}
async function scanRoutes(app2) {
  app2.addHook("preHandler", authenticate);
  app2.post("/scan/boarding", async (request, reply) => {
    const { raw, flightId } = request.body;
    const scannedBy = request.authUserId;
    if (!raw || !flightId) {
      return reply.code(400).send({ error: "raw et flightId sont requis" });
    }
    const denial = await stationDenial(flightId, request.authAirport, "checkin");
    if (denial) {
      return reply.code(403).send({ error: denial });
    }
    let parsed;
    try {
      parsed = parseBoardingPass(raw);
    } catch {
      return reply.code(400).send({ error: "Boarding pass illisible. Rescannez le billet." });
    }
    const supabase = getSupabase();
    const { data: flight, error: flightErr } = await supabase.from("flights").select("flight_number, date").eq("id", flightId).single();
    if (flightErr || !flight) {
      return reply.code(404).send({ error: "Vol introuvable" });
    }
    if (!flightNumbersMatch(parsed.flightNumber, flight.flight_number)) {
      return reply.code(409).send({
        error: `Ce billet est pour le vol ${parsed.flightNumber || "inconnu"}, pas pour ${flight.flight_number}.`
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
        return reply.code(409).send({ error: "Ce passager est d\xE9j\xE0 enregistr\xE9." });
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
      const { data: dayFlights } = await supabase.from("flights").select("id").eq("date", flight.date);
      const dayIds = (dayFlights ?? []).map((f) => f.id);
      if (dayIds.length > 0) {
        await supabase.from("fraud_alerts").update({
          resolved: true,
          resolved_at: (/* @__PURE__ */ new Date()).toISOString(),
          resolved_by: scannedBy ?? null,
          note: `Fausse alerte. ${parsed.fullName} (PNR ${parsed.pnr}) s'est enregistr\xE9 sur ${flight.flight_number} apr\xE8s le passage du bagage. L'\xE9tiquette est bien sur son billet, il n'y a pas de fraude. Le bagage peut \xEAtre repass\xE9 au tapis.`
        }).in("flight_id", dayIds).eq("resolved", false).in(
          "tag_number",
          preRegistered.map((b) => b.tag_number)
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
        legs: parsed.legs
      }
    });
  });
  app2.post("/scan/baggage", async (request, reply) => {
    const { tag, flightId, gate } = request.body;
    const scannedBy = request.authUserId;
    if (!tag || !flightId) {
      return reply.code(400).send({ error: "tag et flightId sont requis" });
    }
    const denial = await stationDenial(flightId, request.authAirport, "baggage");
    if (denial) {
      return reply.code(403).send({ error: denial });
    }
    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    const supabase = getSupabase();
    const { data: cancelledRow } = await supabase.from("baggage").select("id").eq("flight_id", flightId).eq("cancelled", true).or(eitherSerial([parsedTag.serialNumber])).limit(1).maybeSingle();
    if (cancelledRow) {
      return reply.send({
        status: "rejected",
        reason: FRAUD_REASON.CANCELLED,
        fraudAlert: false,
        message: "Bagage annul\xE9 par le superviseur. Mettez-le de c\xF4t\xE9."
      });
    }
    const { data: fwdRow } = await supabase.from("baggage").select("id").eq("flight_id", flightId).eq("kind", "rush_forward").or(eitherSerial([parsedTag.serialNumber])).limit(1).maybeSingle();
    if (fwdRow) {
      return reply.send({
        status: "rejected",
        reason: FRAUD_REASON.RUSH_FORWARD,
        fraudAlert: false,
        message: "Bagage exp\xE9dition rush, sans passager sur ce vol. Il ne passe pas au tapis."
      });
    }
    const { data: dupRow } = await supabase.from("baggage").select("id").eq("flight_id", flightId).eq("tag_number", tag).eq("is_confirmed", true).maybeSingle();
    const { data: bagRow } = await supabase.from("baggage").select("id, passenger_id, tag_number, is_confirmed").eq("flight_id", flightId).eq("kind", "passenger").eq("cancelled", false).eq("serial_number", parsedTag.serialNumber).order("is_confirmed", { ascending: true }).limit(1).maybeSingle();
    let linkedBag = bagRow ?? null;
    let tagNote = null;
    if (!linkedBag) {
      const elsewhere = await findTagOnOtherFlights(supabase, flightId, parsedTag);
      linkedBag = elsewhere?.bag ?? null;
      tagNote = elsewhere ? `Ce bagage est celui du vol ${elsewhere.flightNumber}. Il s'est tromp\xE9 de tapis.` : await describeUnlinkedTag(supabase, flightId, parsedTag);
    }
    let passenger = null;
    let confirmedCount = 0;
    if (linkedBag) {
      const { data: pax } = await supabase.from("passengers").select("id, full_name, pnr, flight_id, declared_baggage_count, offloaded").eq("id", linkedBag.passenger_id).single();
      if (pax) {
        if (pax.offloaded) {
          return reply.send({
            status: "rejected",
            reason: FRAUD_REASON.OFFLOADED,
            fraudAlert: false,
            message: `${pax.full_name} a \xE9t\xE9 d\xE9barqu\xE9 par le superviseur. Bagage non autoris\xE9, mettez-le de c\xF4t\xE9.`
          });
        }
        passenger = {
          id: pax.id,
          fullName: pax.full_name,
          pnr: pax.pnr,
          flightId: pax.flight_id,
          declaredBaggageCount: pax.declared_baggage_count
        };
        const { count } = await supabase.from("baggage").select("id", { count: "exact", head: true }).eq("passenger_id", pax.id).eq("is_confirmed", true).eq("cancelled", false);
        confirmedCount = count ?? 0;
      }
    }
    const decision = evaluateBaggageScan({
      parsedTag,
      flightId,
      gate: gate ?? null,
      registeredBag: linkedBag ? {
        id: linkedBag.id,
        passengerId: linkedBag.passenger_id,
        tagNumber: linkedBag.tag_number,
        isConfirmed: linkedBag.is_confirmed
      } : null,
      passenger,
      confirmedCountForPassenger: confirmedCount,
      duplicateConfirmedTag: Boolean(dupRow),
      tagNote
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
  async function markBaggage(field, body, scannedBy) {
    const { tag, flightId } = body;
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
    const { data: bagRow } = await supabase.from("baggage").select("id, passenger_id, is_confirmed, cancelled").eq("flight_id", flightId).eq("kind", "passenger").eq("serial_number", parsedTag.serialNumber).order("is_confirmed", { ascending: false }).limit(1).maybeSingle();
    if (!bagRow) {
      return { code: 200, result: { status: "rejected", message: "Ce bagage n'appartient pas \xE0 ce vol." } };
    }
    if (bagRow.cancelled) {
      return {
        code: 200,
        result: { status: "rejected", message: "Bagage annul\xE9 par le superviseur. Mettez-le de c\xF4t\xE9." }
      };
    }
    if (!bagRow.is_confirmed) {
      return {
        code: 200,
        result: { status: "rejected", message: "Ce bagage n'est pas encore pass\xE9 au tapis. Enregistrez-le d'abord." }
      };
    }
    const stamp = (/* @__PURE__ */ new Date()).toISOString();
    const patch = field === "in_hold" ? { in_hold: true, in_hold_at: stamp, in_hold_by: scannedBy ?? null } : { rush: true, rush_at: stamp, rush_by: scannedBy ?? null };
    await supabase.from("baggage").update({ ...patch, tag_number: tag }).eq("id", bagRow.id);
    const { data: pax } = await supabase.from("passengers").select("full_name, declared_baggage_count").eq("id", bagRow.passenger_id).single();
    const { count } = await supabase.from("baggage").select("id", { count: "exact", head: true }).eq("passenger_id", bagRow.passenger_id).eq("cancelled", false).eq(field, true);
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
    const denial = await stationDenial(request.body.flightId, request.authAirport, "rush");
    if (denial) {
      return reply.code(403).send({ error: denial });
    }
    const { code, result } = await markBaggage("rush", request.body, request.authUserId);
    return reply.code(code).send(result);
  });
  app2.post("/scan/expedition-rush", async (request, reply) => {
    const { tag, otherTag, soloTag, flightId } = request.body;
    const scannedBy = request.authUserId;
    if (!tag || !flightId) {
      return reply.code(400).send({ status: "rejected", message: "tag et flightId sont requis" });
    }
    const denial = await stationDenial(flightId, request.authAirport, "expedition_rush");
    if (denial) {
      return reply.code(403).send({ error: denial });
    }
    let t1;
    let t2 = null;
    try {
      t1 = parseBaggageTag(tag);
      if (otherTag) t2 = parseBaggageTag(otherTag);
    } catch (e) {
      return reply.code(400).send({ status: "rejected", message: e.message });
    }
    if (t2 && t1.serialNumber === t2.serialNumber) {
      return reply.send({
        status: "rejected",
        message: "M\xEAme \xE9tiquette scann\xE9e deux fois. Scannez l'AUTRE \xE9tiquette du bagage."
      });
    }
    const supabase = getSupabase();
    const { data: flight } = await supabase.from("flights").select("flight_number, date, origin").eq("id", flightId).single();
    if (!flight) {
      return reply.code(404).send({ status: "rejected", message: "Vol introuvable" });
    }
    const serials = t2 ? [t1.serialNumber, t2.serialNumber] : [t1.serialNumber];
    const { data: announcedRow } = await supabase.from("baggage").select("id, tag_number, serial_number, rush_tag_number, rush_serial_number, announced_by, rush_origin, rush_owner_name").eq("flight_id", flightId).eq("kind", "rush_forward").eq("rush_status", "expected").or(eitherSerial(serials)).limit(1).maybeSingle();
    if (announcedRow) {
      const a = announcedRow;
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const knownSerials = [a.serial_number, a.rush_serial_number].filter(Boolean);
      const fresh = [t1, ...t2 ? [t2] : []].find((p) => !knownSerials.includes(p.serialNumber));
      const linkPatch = fresh && a.tag_number === a.rush_tag_number ? {
        tag_number: fresh.rawTag,
        serial_number: fresh.serialNumber,
        issuer_code: fresh.issuerCode,
        airline_numeric_code: fresh.airlineNumericCode
      } : {};
      await supabase.from("baggage").update({
        rush_status: "approved",
        rush_status_at: now,
        rush_status_by: a.announced_by ?? null,
        scanned_by: scannedBy ?? null,
        scanned_at: now,
        ...linkPatch
      }).eq("id", a.id).eq("rush_status", "expected");
      const who = a.rush_owner_name ? ` ${a.rush_owner_name},` : "";
      const from = a.rush_origin ? ` ${a.rush_origin}.` : "";
      return reply.send({
        status: "accepted",
        known: true,
        validation: "approved",
        passengerName: a.rush_owner_name,
        originFlight: a.rush_origin,
        tagNumber: linkPatch.tag_number ?? a.tag_number,
        rushTagNumber: a.rush_tag_number ?? a.tag_number,
        message: `Bagage annonc\xE9 par le superviseur :${who}${from} Autoris\xE9.`
      });
    }
    const { data: existing } = await supabase.from("baggage").select("id, rush_status").eq("flight_id", flightId).eq("kind", "rush_forward").neq("rush_status", "expected").or(eitherSerial(serials)).limit(1).maybeSingle();
    if (existing) {
      const st = existing.rush_status;
      return reply.send({
        status: "rejected",
        message: st === "pending" ? "Bagage d\xE9j\xE0 enregistr\xE9, en attente de validation du superviseur." : st === "denied" ? "Bagage refus\xE9 par le superviseur. Ne pas embarquer." : "Bagage d\xE9j\xE0 enregistr\xE9 et autoris\xE9. Passez au suivant."
      });
    }
    const { data: ownBag } = await supabase.from("baggage").select("id").eq("flight_id", flightId).eq("kind", "passenger").eq("cancelled", false).in("serial_number", serials).limit(1).maybeSingle();
    if (ownBag) {
      return reply.send({
        status: "rejected",
        message: "Ce bagage appartient \xE0 un passager de ce vol. Passez-le au tapis, \xE9cran Bagages."
      });
    }
    const norm = (v) => (v ?? "").trim().toUpperCase();
    const airport = norm(request.authAirport) || norm(flight.origin);
    const since = /* @__PURE__ */ new Date(`${flight.date}T00:00:00Z`);
    since.setUTCDate(since.getUTCDate() - 7);
    const sinceStr = since.toISOString().slice(0, 10);
    const { data: recent } = await supabase.from("flights").select("id, flight_number, date, origin, stops").gte("date", sinceStr).lte("date", flight.date);
    const candidates = (recent ?? []).filter(
      (f) => f.id !== flightId && (norm(f.origin) === airport || (f.stops ?? []).some((s) => norm(s) === airport))
    );
    let known = null;
    if (candidates.length > 0) {
      const { data: rest } = await supabase.from("baggage").select("id, passenger_id, tag_number, serial_number, issuer_code, airline_numeric_code, flight_id").in(
        "flight_id",
        candidates.map((f) => f.id)
      ).eq("kind", "passenger").eq("rush", true).eq("cancelled", false).in("serial_number", serials).order("rush_at", { ascending: false }).limit(1).maybeSingle();
      const bag = rest;
      if (bag) {
        const { data: fwd } = await supabase.from("baggage").select("id").eq("kind", "rush_forward").eq("origin_baggage_id", bag.id).neq("rush_status", "denied").limit(1).maybeSingle();
        if (fwd) {
          return reply.send({
            status: "rejected",
            message: "Ce restant a d\xE9j\xE0 \xE9t\xE9 r\xE9achemin\xE9 sur un autre vol. V\xE9rifiez avec le superviseur."
          });
        }
        const of = candidates.find((f) => f.id === bag.flight_id);
        const { data: pax } = await supabase.from("passengers").select("full_name").eq("id", bag.passenger_id).single();
        known = {
          bag,
          flightLabel: of ? `${of.flight_number} du ${of.date}` : "un vol pr\xE9c\xE9dent",
          passengerName: pax?.full_name ?? "passager inconnu"
        };
      }
    }
    if (!t2 && !soloTag) {
      if (known) {
        return reply.send({
          status: "lookup",
          known: true,
          passengerName: known.passengerName,
          originFlight: known.flightLabel,
          message: `Bagage de ${known.passengerName}, rest\xE9 du vol ${known.flightLabel}. Scannez maintenant l'\xE9tiquette RUSH pour la lier.`
        });
      }
      return reply.send({
        status: "lookup",
        known: false,
        passengerName: null,
        originFlight: null,
        message: "\xC9tiquette non reconnue. Scannez l'autre \xE9tiquette du bagage."
      });
    }
    const original = known && t2 && known.bag.serial_number === t2.serialNumber ? t2 : t1;
    const rushTag = t2 ? original === t1 ? t2 : t1 : t1;
    const { error: insErr } = await supabase.from("baggage").insert({
      flight_id: flightId,
      kind: "rush_forward",
      passenger_id: known?.bag.passenger_id ?? null,
      tag_number: original.rawTag,
      issuer_code: original.issuerCode,
      airline_numeric_code: original.airlineNumericCode,
      serial_number: original.serialNumber,
      rush_tag_number: rushTag.rawTag,
      rush_serial_number: rushTag.serialNumber,
      origin_baggage_id: known?.bag.id ?? null,
      rush_status: known ? "approved" : "pending",
      rush_status_at: known ? (/* @__PURE__ */ new Date()).toISOString() : null,
      is_confirmed: false,
      scanned_by: scannedBy ?? null
    });
    if (insErr) {
      if (insErr.code === "23505") {
        return reply.send({
          status: "rejected",
          message: "Une ligne existe d\xE9j\xE0 pour cette \xE9tiquette sur ce vol. V\xE9rifiez avec le superviseur."
        });
      }
      request.log.error(insErr);
      return reply.code(500).send({ status: "rejected", message: "\xC9chec de l'enregistrement du bagage" });
    }
    if (known) {
      return reply.send({
        status: "accepted",
        known: true,
        validation: "approved",
        passengerName: known.passengerName,
        originFlight: known.flightLabel,
        tagNumber: original.rawTag,
        rushTagNumber: rushTag.rawTag,
        message: `Bagage de ${known.passengerName}, rest\xE9 du vol ${known.flightLabel}. Rattach\xE9 \xE0 ce vol, \xE9tiquettes li\xE9es.`
      });
    }
    return reply.send({
      status: "accepted",
      known: false,
      validation: "pending",
      passengerName: null,
      originFlight: null,
      tagNumber: original.rawTag,
      rushTagNumber: rushTag.rawTag,
      message: "Bagage inconnu enregistr\xE9. En attente de validation du superviseur avant chargement."
    });
  });
  app2.post("/scan/load-all", async (request, reply) => {
    const { flightId } = request.body;
    const scannedBy = request.authUserId;
    if (!flightId) {
      return reply.code(400).send({ status: "rejected", message: "flightId est requis" });
    }
    const denial = await stationDenial(flightId, request.authAirport, "charger");
    if (denial) {
      return reply.code(403).send({ error: denial });
    }
    const supabase = getSupabase();
    const { data: rows } = await supabase.from("baggage").select("id, in_hold, rush, kind, rush_status, is_confirmed, cancelled").eq("flight_id", flightId);
    const all = rows ?? [];
    const bags = all.filter(
      (b) => !b.cancelled && (b.kind === "rush_forward" ? b.rush_status === "approved" : b.is_confirmed)
    );
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
    const { tag, flightId, soute } = request.body;
    const scannedBy = request.authUserId;
    if (!tag || !flightId || !soute) {
      return reply.code(400).send({ status: "rejected", message: "tag, flightId et soute sont requis" });
    }
    if (soute !== "avant" && soute !== "arriere") {
      return reply.code(400).send({ status: "rejected", message: 'soute doit \xEAtre "avant" ou "arriere"' });
    }
    const denial = await stationDenial(flightId, request.authAirport, "soute");
    if (denial) {
      return reply.code(403).send({ error: denial });
    }
    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ status: "rejected", message: e.message });
    }
    const supabase = getSupabase();
    const { data: bagRow } = await supabase.from("baggage").select("id, passenger_id, is_confirmed, kind, rush_status, cancelled, in_hold, pulled").eq("flight_id", flightId).or(eitherSerial([parsedTag.serialNumber])).order("is_confirmed", { ascending: false }).limit(1).maybeSingle();
    if (!bagRow) {
      return reply.send({ status: "rejected", message: "Ce bagage n'appartient pas \xE0 ce vol." });
    }
    if (bagRow.cancelled) {
      if (bagRow.in_hold && !bagRow.pulled) {
        await supabase.from("baggage").update({ pulled: true, pulled_at: (/* @__PURE__ */ new Date()).toISOString(), pulled_by: scannedBy ?? null }).eq("id", bagRow.id);
        return reply.send({
          status: "accepted",
          passengerName: "\u2014",
          tagNumber: tag,
          count: 0,
          declaredCount: 0,
          message: "Bagage annul\xE9 retir\xE9 de la soute. Mettez-le de c\xF4t\xE9."
        });
      }
      return reply.send({
        status: "rejected",
        message: "Bagage annul\xE9 par le superviseur. Ne pas le charger."
      });
    }
    if (bagRow.kind === "rush_forward") {
      if (bagRow.rush_status !== "approved") {
        return reply.send({
          status: "rejected",
          message: bagRow.rush_status === "expected" ? "Bagage rush annonc\xE9 mais pas encore enregistr\xE9. Passez-le d'abord \xE0 l'\xE9cran Exp\xE9dition rush." : bagRow.rush_status === "pending" ? "Bagage rush en attente de validation du superviseur. Ne pas le charger." : "Bagage rush refus\xE9 par le superviseur. Ne pas le charger."
        });
      }
    } else if (!bagRow.is_confirmed) {
      return reply.send({ status: "rejected", message: "Ce bagage n'est pas encore pass\xE9 au tapis. Enregistrez-le d'abord." });
    }
    const stamp = (/* @__PURE__ */ new Date()).toISOString();
    await supabase.from("baggage").update({
      soute,
      soute_at: stamp,
      soute_by: scannedBy ?? null,
      ...bagRow.kind === "passenger" ? { tag_number: tag } : {}
    }).eq("id", bagRow.id);
    const { data: pax } = bagRow.passenger_id ? await supabase.from("passengers").select("full_name, declared_baggage_count").eq("id", bagRow.passenger_id).single() : { data: null };
    const { count } = bagRow.passenger_id ? await supabase.from("baggage").select("id", { count: "exact", head: true }).eq("passenger_id", bagRow.passenger_id).eq("cancelled", false).eq("soute", soute) : { count: 1 };
    const souteLabel = soute === "avant" ? "soute avant" : "soute arri\xE8re";
    return reply.send({
      status: "accepted",
      passengerName: pax?.full_name ?? (bagRow.kind === "rush_forward" ? "Bagage rush (sans passager)" : "\u2014"),
      tagNumber: tag,
      count: count ?? 0,
      declaredCount: pax?.declared_baggage_count ?? 0,
      message: `Bagage plac\xE9 en ${souteLabel}.`
    });
  });
  app2.post("/scan/dolly", async (request, reply) => {
    const { tag, flightId } = request.body;
    const scannedBy = request.authUserId;
    if (!tag || !flightId) {
      return reply.code(400).send({ status: "rejected", message: "tag et flightId sont requis" });
    }
    const denial = await stationDenial(flightId, request.authAirport, "dolly");
    if (denial) {
      return reply.code(403).send({ error: denial });
    }
    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ status: "rejected", message: e.message });
    }
    const supabase = getSupabase();
    const { data: bagRow } = await supabase.from("baggage").select("id, passenger_id, is_confirmed, on_dolly, kind, rush_status, cancelled").eq("flight_id", flightId).or(eitherSerial([parsedTag.serialNumber])).order("is_confirmed", { ascending: false }).limit(1).maybeSingle();
    async function progress() {
      const [{ count: onDolly2 }, { count: paxBags }, { count: rushBags }] = await Promise.all([
        supabase.from("baggage").select("id", { count: "exact", head: true }).eq("flight_id", flightId).eq("on_dolly", true).eq("cancelled", false),
        supabase.from("baggage").select("id", { count: "exact", head: true }).eq("flight_id", flightId).eq("kind", "passenger").eq("is_confirmed", true).eq("cancelled", false),
        supabase.from("baggage").select("id", { count: "exact", head: true }).eq("flight_id", flightId).eq("kind", "rush_forward").eq("rush_status", "approved")
      ]);
      return { onDolly: onDolly2 ?? 0, confirmed: (paxBags ?? 0) + (rushBags ?? 0) };
    }
    if (!bagRow) {
      return reply.send({ status: "rejected", message: "Ce bagage n'appartient pas \xE0 ce vol. Ne pas le charger." });
    }
    if (bagRow.cancelled) {
      return reply.send({
        status: "rejected",
        message: "Bagage annul\xE9 par le superviseur. Ne pas le charger."
      });
    }
    if (bagRow.kind === "rush_forward") {
      if (bagRow.rush_status === "expected") {
        return reply.send({
          status: "rejected",
          message: "Bagage rush annonc\xE9 mais pas encore enregistr\xE9. Passez-le d'abord \xE0 l'\xE9cran Exp\xE9dition rush."
        });
      }
      if (bagRow.rush_status === "pending") {
        return reply.send({
          status: "rejected",
          message: "Bagage rush en attente de validation du superviseur. Ne pas le charger."
        });
      }
      if (bagRow.rush_status !== "approved") {
        return reply.send({
          status: "rejected",
          message: "Bagage rush refus\xE9 par le superviseur. Ne pas le charger."
        });
      }
    } else if (!bagRow.is_confirmed) {
      return reply.send({
        status: "rejected",
        message: "Ce bagage n'est pas pass\xE9 au tapis. Ne pas le charger."
      });
    }
    const { data: pax } = bagRow.passenger_id ? await supabase.from("passengers").select("full_name").eq("id", bagRow.passenger_id).single() : { data: null };
    const displayName = pax?.full_name ?? (bagRow.kind === "rush_forward" ? "Bagage rush (sans passager)" : "\u2014");
    if (bagRow.on_dolly) {
      const { onDolly: onDolly2, confirmed: confirmed2 } = await progress();
      return reply.send({
        status: "accepted",
        passengerName: displayName,
        tagNumber: tag,
        onDolly: onDolly2,
        confirmed: confirmed2,
        alreadyOnDolly: true,
        complete: onDolly2 >= confirmed2 && confirmed2 > 0,
        message: "D\xE9j\xE0 sur le dolly."
      });
    }
    await supabase.from("baggage").update({
      on_dolly: true,
      on_dolly_at: (/* @__PURE__ */ new Date()).toISOString(),
      on_dolly_by: scannedBy,
      ...bagRow.kind === "passenger" ? { tag_number: tag } : {}
    }).eq("id", bagRow.id);
    const { onDolly, confirmed } = await progress();
    const complete = onDolly >= confirmed && confirmed > 0;
    return reply.send({
      status: "accepted",
      passengerName: displayName,
      tagNumber: tag,
      onDolly,
      confirmed,
      alreadyOnDolly: false,
      complete,
      message: complete ? "Dolly complet. Tous les bagages enregistr\xE9s sont charg\xE9s." : "Bagage v\xE9rifi\xE9, plac\xE9 sur le dolly."
    });
  });
  app2.post("/scan/arrivee", async (request, reply) => {
    const { tag, flightId } = request.body;
    const scannedBy = request.authUserId;
    if (!tag || !flightId) {
      return reply.code(400).send({ status: "rejected", message: "tag et flightId sont requis" });
    }
    const denial = await stationDenial(flightId, request.authAirport, "arrivee");
    if (denial) {
      return reply.code(403).send({ error: denial });
    }
    let parsedTag;
    try {
      parsedTag = parseBaggageTag(tag);
    } catch (e) {
      return reply.code(400).send({ status: "rejected", message: e.message });
    }
    const supabase = getSupabase();
    const { data: bagRow } = await supabase.from("baggage").select("id, passenger_id, is_confirmed, in_hold, rush, arrived, kind, cancelled").eq("flight_id", flightId).or(eitherSerial([parsedTag.serialNumber])).order("is_confirmed", { ascending: false }).limit(1).maybeSingle();
    async function progress() {
      const [{ count: arrived2 }, { count: expected2 }] = await Promise.all([
        supabase.from("baggage").select("id", { count: "exact", head: true }).eq("flight_id", flightId).eq("arrived", true).eq("cancelled", false),
        supabase.from("baggage").select("id", { count: "exact", head: true }).eq("flight_id", flightId).eq("in_hold", true).eq("rush", false).eq("cancelled", false)
      ]);
      return { arrived: arrived2 ?? 0, expected: expected2 ?? 0 };
    }
    if (!bagRow) {
      return reply.send({ status: "rejected", message: "Ce bagage n'appartient pas \xE0 ce vol." });
    }
    if (bagRow.cancelled) {
      return reply.send({
        status: "rejected",
        message: "Ce bagage a \xE9t\xE9 annul\xE9 au d\xE9part et aurait d\xFB \xEAtre retir\xE9 de la soute. Pr\xE9venez le superviseur."
      });
    }
    if (bagRow.rush) {
      return reply.send({
        status: "rejected",
        message: "Ce bagage \xE9tait marqu\xE9 rush, il est rest\xE9 au d\xE9part. Il arrivera sur un autre vol."
      });
    }
    if (!bagRow.in_hold) {
      return reply.send({
        status: "rejected",
        message: "Ce bagage n'a pas \xE9t\xE9 charg\xE9 sur ce vol, il n'aurait pas d\xFB voyager. Pr\xE9venez le superviseur."
      });
    }
    const { data: pax } = bagRow.passenger_id ? await supabase.from("passengers").select("full_name").eq("id", bagRow.passenger_id).single() : { data: null };
    const displayName = pax?.full_name ?? (bagRow.kind === "rush_forward" ? "Bagage rush (sans passager)" : "\u2014");
    if (bagRow.arrived) {
      const { arrived: arrived2, expected: expected2 } = await progress();
      return reply.send({
        status: "accepted",
        passengerName: displayName,
        tagNumber: tag,
        arrived: arrived2,
        expected: expected2,
        alreadyArrived: true,
        complete: arrived2 >= expected2 && expected2 > 0,
        message: "Bagage d\xE9j\xE0 r\xE9ceptionn\xE9."
      });
    }
    await supabase.from("baggage").update({
      arrived: true,
      arrived_at: (/* @__PURE__ */ new Date()).toISOString(),
      arrived_by: scannedBy,
      ...bagRow.kind === "passenger" ? { tag_number: tag } : {}
    }).eq("id", bagRow.id);
    const { arrived, expected } = await progress();
    const complete = arrived >= expected && expected > 0;
    return reply.send({
      status: "accepted",
      passengerName: displayName,
      tagNumber: tag,
      arrived,
      expected,
      alreadyArrived: false,
      complete,
      message: bagRow.kind === "rush_forward" ? "Bagage rush sans passager \xE0 bord. Remettez-le au service bagages pour restitution." : complete ? "R\xE9ception compl\xE8te, tous les bagages charg\xE9s sont arriv\xE9s." : "Bagage r\xE9ceptionn\xE9 \xE0 destination."
    });
  });
  app2.post("/scan/embarquement", async (request, reply) => {
    const { raw, flightId } = request.body;
    const scannedBy = request.authUserId;
    if (!raw || !flightId) {
      return reply.code(400).send({ error: "raw et flightId sont requis" });
    }
    const denial = await stationDenial(flightId, request.authAirport, "embarquement");
    if (denial) {
      return reply.code(403).send({ error: denial });
    }
    let parsed;
    try {
      parsed = parseBoardingPass(raw);
    } catch {
      return reply.code(400).send({ error: "Boarding pass illisible. Rescannez le billet." });
    }
    const supabase = getSupabase();
    const { data: flight, error: flightErr } = await supabase.from("flights").select("flight_number").eq("id", flightId).single();
    if (flightErr || !flight) {
      return reply.code(404).send({ error: "Vol introuvable" });
    }
    if (!flightNumbersMatch(parsed.flightNumber, flight.flight_number)) {
      const result2 = {
        status: "rejected",
        message: `Ce billet est pour le vol ${parsed.flightNumber || "inconnu"}, pas pour ${flight.flight_number}.`
      };
      return reply.send(result2);
    }
    const { data: passenger } = await supabase.from("passengers").select("id, full_name, seat, boarded, offloaded").eq("flight_id", flightId).eq("pnr", parsed.pnr).eq("seat", parsed.seat).maybeSingle();
    if (!passenger) {
      const result2 = {
        status: "rejected",
        message: "Ce passager n'a pas encore fait son check-in. Envoyez-le au comptoir."
      };
      return reply.send(result2);
    }
    if (passenger.offloaded) {
      const result2 = {
        status: "rejected",
        message: `${passenger.full_name} a \xE9t\xE9 d\xE9barqu\xE9 par le superviseur. Ne pas embarquer.`
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

// packages/api/src/routes/day.ts
async function dayRoutes(app2) {
  app2.addHook("preHandler", authenticate);
  app2.get("/operating-day", async (request) => ({
    airport: request.authAirport,
    day: todayAtAirport(request.authAirport),
    serverTime: (/* @__PURE__ */ new Date()).toISOString()
  }));
}

// packages/api/src/server.ts
function buildServer() {
  const app2 = Fastify({ logger: true });
  app2.get("/health", async () => ({ status: "ok" }));
  app2.register(scanRoutes);
  app2.register(dayRoutes);
  return app2;
}

// packages/api/src/index.ts
var app = buildServer();
var port = Number(process.env.PORT ?? 3001);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
