import {
  FRAUD_REASON,
  type FraudReason,
  type ParsedBaggageTag,
  type BaggageScanResult,
} from '@police/shared';

// ─────────────────────────────────────────────────────────────
// Cœur anti-fraude — fonction PURE, sans I/O.
// Les 5 règles de rejet sont non négociables (cf. CLAUDE.md).
// La route Fastify assemble le contexte depuis Supabase puis appelle
// cette fonction ; toute la décision est testable sans base de données.
// ─────────────────────────────────────────────────────────────

/** Bagage déjà pré-enregistré (au scan du boarding pass) pour ce serial + vol. */
export interface RegisteredBag {
  id: string;
  passengerId: string;
  tagNumber: string;
  isConfirmed: boolean;
}

export interface ScanPassenger {
  id: string;
  fullName: string;
  pnr: string;
  flightId: string;
  declaredBaggageCount: number;
}

export interface BaggageScanContext {
  parsedTag: ParsedBaggageTag;
  flightId: string;
  gate: string | null;
  /**
   * Ligne baggage correspondant à serial_number, ou null si introuvable.
   * Peut venir d'un AUTRE vol du même jour : c'est ce qui rend la règle 5
   * atteignable. Tant que la recherche restait filtrée sur le vol courant,
   * `passenger.flightId` valait toujours `flightId` et le test « mauvais vol »
   * ne pouvait jamais être vrai.
   */
  registeredBag: RegisteredBag | null;
  /** Passager propriétaire du registeredBag, ou null. */
  passenger: ScanPassenger | null;
  /** Nombre de bagages déjà confirmés pour ce passager. */
  confirmedCountForPassenger: number;
  /** true si ce tag_number exact est déjà confirmé (doublon de scan). */
  duplicateConfirmedTag: boolean;
  /**
   * Diagnostic de liaison rédigé par la route (plage de séries du vol, vol
   * d'origine de l'étiquette…). Recopié dans l'alerte : une alerte règle 1 n'a
   * ni nom ni PNR, c'est la seule information exploitable par le superviseur.
   */
  tagNote?: string | null;
}

/** Brouillon d'alerte fraude à insérer (règles 1, 2, 3 uniquement). */
export interface FraudAlertDraft {
  flight_id: string;
  pnr: string | null;
  passenger_name: string | null;
  tag_number: string;
  declared_baggage_count: number | null;
  gate: string | null;
  reason: FraudReason;
  note: string | null;
}

export interface BaggageScanDecision {
  result: BaggageScanResult;
  /** Présent ⇒ insérer cette alerte fraude. */
  fraudAlert: FraudAlertDraft | null;
  /** Présent ⇒ passer cette ligne baggage à is_confirmed = true. */
  confirmBagId: string | null;
}

function reject(reason: FraudReason, message: string): BaggageScanDecision {
  return { result: { status: 'rejected', reason, fraudAlert: false, message }, fraudAlert: null, confirmBagId: null };
}

function rejectWithAlert(ctx: BaggageScanContext, reason: FraudReason, message: string): BaggageScanDecision {
  return {
    result: { status: 'rejected', reason, fraudAlert: true, message },
    fraudAlert: {
      flight_id: ctx.flightId,
      pnr: ctx.passenger?.pnr ?? null,
      passenger_name: ctx.passenger?.fullName ?? null,
      tag_number: ctx.parsedTag.rawTag,
      declared_baggage_count: ctx.passenger?.declaredBaggageCount ?? null,
      gate: ctx.gate,
      reason,
      note: ctx.tagNote ?? null,
    },
    confirmBagId: null,
  };
}

export function evaluateBaggageScan(ctx: BaggageScanContext): BaggageScanDecision {
  const { registeredBag, passenger, parsedTag } = ctx;

  // Règle 4 — étiquette déjà scannée (doublon). Pas d'alerte fraude.
  if (ctx.duplicateConfirmedTag) {
    return reject(FRAUD_REASON.ALREADY_SCANNED, 'Ce bagage a déjà été enregistré. Passez au suivant.');
  }

  // Règle 1 — ce n° de série n'est déclaré sur aucun boarding pass. On ne peut
  // nommer personne : l'étiquette est orpheline, c'est tout ce qu'on sait.
  if (!registeredBag || !passenger) {
    return rejectWithAlert(
      ctx,
      FRAUD_REASON.UNLINKED_TAG,
      "Bagage refusé. Aucun passager n'a déclaré cette étiquette. Mettez le bagage de côté, le superviseur arrive.",
    );
  }

  // Règle 5 — bagage rattaché à un autre vol. Pas d'alerte fraude.
  if (passenger.flightId !== ctx.flightId) {
    return reject(
      FRAUD_REASON.WRONG_FLIGHT,
      "Ce bagage n'est pas sur le bon tapis. Il appartient à un autre vol.",
    );
  }

  // Étiquette physique re-scannée sur une ligne déjà confirmée.
  if (registeredBag.isConfirmed) {
    return reject(FRAUD_REASON.ALREADY_SCANNED, 'Ce bagage a déjà été enregistré. Passez au suivant.');
  }

  // Règle 2 — 0 bagage déclaré sur le boarding pass.
  if (passenger.declaredBaggageCount === 0) {
    return rejectWithAlert(
      ctx,
      FRAUD_REASON.ZERO_DECLARED,
      `Bagage refusé. ${passenger.fullName} voyage sans bagage en soute. Mettez le bagage de côté, le superviseur arrive.`,
    );
  }

  // Règle 3 — quota de bagages dépassé.
  if (ctx.confirmedCountForPassenger >= passenger.declaredBaggageCount) {
    return rejectWithAlert(
      ctx,
      FRAUD_REASON.QUOTA_EXCEEDED,
      `Bagage refusé. ${passenger.fullName} a déjà ses ${passenger.declaredBaggageCount} bagage${passenger.declaredBaggageCount > 1 ? 's' : ''}. Mettez celui-ci de côté, le superviseur arrive.`,
    );
  }

  // ✅ Accepté — confirmer la ligne baggage.
  return {
    result: {
      status: 'accepted',
      passengerName: passenger.fullName,
      confirmedCount: ctx.confirmedCountForPassenger + 1,
      declaredCount: passenger.declaredBaggageCount,
    },
    fraudAlert: null,
    confirmBagId: registeredBag.id,
  };
}
