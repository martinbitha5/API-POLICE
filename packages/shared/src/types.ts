// Types partagés entre mobile, web et api.
// Source de vérité unique — ne jamais dupliquer ces types ailleurs.

// ─────────────────────────────────────────────────────────────
// Enums / unions
// ─────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'supervisor' | 'agent';

export type FlightStatus = 'scheduled' | 'boarding' | 'closed';

/** Raisons de rejet d'un bagage (règles anti-fraude 1 à 5). */
export const FRAUD_REASON = {
  PASSENGER_NOT_REGISTERED: 'Passager non enregistré',
  ZERO_DECLARED: '0 bagage déclaré sur boarding pass',
  QUOTA_EXCEEDED: 'Quota bagage dépassé',
  ALREADY_SCANNED: 'Bagage déjà enregistré',
  WRONG_FLIGHT: 'Bagage appartient à un autre vol',
} as const;

export type FraudReason = (typeof FRAUD_REASON)[keyof typeof FRAUD_REASON];

// ─────────────────────────────────────────────────────────────
// Résultats de parsing
// ─────────────────────────────────────────────────────────────

export interface ParsedBoardingPassLeg {
  origin: string;
  destination: string;
  flightNumber: string;
  order: number;
}

export interface ParsedBoardingPass {
  fullName: string;
  pnr: string;
  flightNumber: string;
  seat: string;
  class: string;
  sequenceNumber: number;
  declaredBaggageCount: number;
  baggageTags: string[];
  legs: ParsedBoardingPassLeg[];
  rawBcbp: string;
}

export interface ParsedBaggageTag {
  issuerCode: string;
  airlineNumericCode: string;
  serialNumber: string;
  declaredBaggageCount: number;
  rawTag: string;
}

// ─────────────────────────────────────────────────────────────
// Lignes de base de données (Supabase)
// ─────────────────────────────────────────────────────────────

export interface Profile {
  id: string;
  full_name: string;
  role: UserRole;
  gate: string | null;
  created_at: string;
}

export interface Flight {
  id: string;
  flight_number: string;
  origin: string;
  destination: string;
  /** Escales intermédiaires en ordre de trajet (vols avec transit). Route complète = origin → stops → destination. */
  stops: string[] | null;
  departure_time: string | null;
  arrival_time: string | null;
  status: FlightStatus;
  date: string;
  created_at: string;
}

export interface Passenger {
  id: string;
  flight_id: string;
  full_name: string;
  pnr: string;
  seat: string | null;
  class: string | null;
  sequence_number: number | null;
  declared_baggage_count: number;
  raw_bcbp: string | null;
  scanned_at: string;
  scanned_by: string | null;
  /** true = passager physiquement embarqué (boarding pass scanné à la porte). */
  boarded: boolean;
  boarded_at: string | null;
  boarded_by: string | null;
}

export interface PassengerLeg {
  id: string;
  passenger_id: string;
  origin: string;
  destination: string;
  flight_number: string | null;
  leg_order: number;
}

export interface Baggage {
  id: string;
  passenger_id: string;
  flight_id: string;
  tag_number: string;
  issuer_code: string | null;
  airline_numeric_code: string | null;
  serial_number: string | null;
  is_confirmed: boolean;
  scanned_at: string;
  scanned_by: string | null;
}

export interface FraudAlert {
  id: string;
  flight_id: string;
  pnr: string | null;
  passenger_name: string | null;
  tag_number: string | null;
  declared_baggage_count: number | null;
  gate: string | null;
  reason: string;
  resolved: boolean;
  created_at: string;
}

export interface AirlineCode {
  numeric_code: string;
  iata_code: string | null;
  name: string | null;
}

// ─────────────────────────────────────────────────────────────
// Résultats d'opérations de scan (api → clients)
// ─────────────────────────────────────────────────────────────

export interface BaggageScanAccepted {
  status: 'accepted';
  passengerName: string;
  confirmedCount: number;
  declaredCount: number;
}

export interface BaggageScanRejected {
  status: 'rejected';
  reason: FraudReason;
  /** true = une alerte fraude a été créée (règles 1, 2, 3). */
  fraudAlert: boolean;
  message: string;
}

export type BaggageScanResult = BaggageScanAccepted | BaggageScanRejected;

// ─────────────────────────────────────────────────────────────
// Embarquement à la porte (boarding pass scanné au gate)
// ─────────────────────────────────────────────────────────────

/** Compteurs d'embarquement d'un vol. reste = registered − boarded. */
export interface BoardingCounts {
  /** Passagers enregistrés au check-in. */
  registered: number;
  /** Passagers physiquement embarqués. */
  boarded: number;
  /** Reste à embarquer (registered − boarded). */
  remaining: number;
}

export interface BoardingGateAccepted {
  status: 'accepted';
  passengerName: string;
  seat: string;
  /** true = ce passager était déjà marqué embarqué (re-scan). */
  alreadyBoarded: boolean;
  counts: BoardingCounts;
}

export interface BoardingGateRejected {
  status: 'rejected';
  message: string;
}

export type BoardingGateResult = BoardingGateAccepted | BoardingGateRejected;

// ─────────────────────────────────────────────────────────────
// Suivi bagage côté passager (app tracking, public)
// ─────────────────────────────────────────────────────────────

/** État d'un bagage du point de vue passager. */
export type BaggageStatus = 'loaded' | 'pending';

export interface TrackedBag {
  tagNumber: string;
  /** true = étiquette physique scannée au tapis (bagage chargé). */
  status: BaggageStatus;
  scannedAt: string | null;
}

export interface TrackedPassenger {
  passengerName: string;
  pnr: string;
  flightNumber: string;
  /** Route complète, escales comprises : "FIH → FKI → FBM". */
  route: string;
  flightDate: string;
  flightStatus: FlightStatus;
  departureTime: string | null;
  declaredBaggageCount: number;
  confirmedBaggageCount: number;
  bags: TrackedBag[];
}

export interface BaggageTrackingFound {
  status: 'found';
  passengers: TrackedPassenger[];
}

export interface BaggageTrackingNotFound {
  status: 'not_found';
  message: string;
}

export type BaggageTrackingResult = BaggageTrackingFound | BaggageTrackingNotFound;
