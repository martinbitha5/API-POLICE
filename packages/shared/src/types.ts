// Types partagés entre mobile, web et api.
// Source de vérité unique — ne jamais dupliquer ces types ailleurs.

// ─────────────────────────────────────────────────────────────
// Enums / unions
// ─────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'supervisor' | 'agent';

/** Compartiment soute de l'avion (avant / arrière). */
export type SoutePosition = 'avant' | 'arriere';

export const SOUTE_LABEL: Record<SoutePosition, string> = {
  avant: 'Soute avant',
  arriere: 'Soute arrière',
} as const;

export type FlightStatus = 'scheduled' | 'boarding' | 'closed' | 'cancelled';

/** Libellés français des statuts de vol (partagés web / public / mobile). */
export const FLIGHT_STATUS_LABEL: Record<FlightStatus, string> = {
  scheduled: 'Programmé',
  boarding: 'Embarquement',
  closed: 'Porte fermée',
  cancelled: 'Annulé',
} as const;

/** Statut d'un dossier de litige bagage. */
export type DisputeStatus = 'open' | 'investigating' | 'resolved';

export const DISPUTE_STATUS_LABEL: Record<DisputeStatus, string> = {
  open: 'Ouvert',
  investigating: 'En cours',
  resolved: 'Résolu',
} as const;

/** Raisons de rejet d'un bagage (règles anti-fraude 1 à 5). */
export const FRAUD_REASON = {
  PASSENGER_NOT_REGISTERED: 'Passager non enregistré',
  ZERO_DECLARED: '0 bagage déclaré sur boarding pass',
  QUOTA_EXCEEDED: 'Quota bagage dépassé',
  ALREADY_SCANNED: 'Bagage déjà enregistré',
  WRONG_FLIGHT: 'Bagage appartient à un autre vol',
} as const;

export type FraudReason = (typeof FRAUD_REASON)[keyof typeof FRAUD_REASON];

/** Catégories de réclamation passager (app tracking → litige). */
export type ClaimCategory = 'missing' | 'damaged' | 'contents' | 'delayed' | 'other';

/** Libellé français stocké en base (l'app litige est en français). */
export const CLAIM_CATEGORY_LABEL: Record<ClaimCategory, string> = {
  missing: 'Bagage manquant',
  damaged: 'Bagage endommagé',
  contents: 'Objet manquant dans le bagage',
  delayed: 'Bagage retardé',
  other: 'Autre problème',
} as const;

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
  airport_code: string | null;
  airline_code: string | null;
  created_at: string;
}

export interface Flight {
  id: string;
  flight_number: string;
  origin: string;
  destination: string;
  /** Escales intermédiaires en ordre de trajet (vols avec transit). Route complète = origin → stops → destination. */
  stops: string[] | null;
  /** Transporteur, dérivé du préfixe de flight_number. Colonne générée : sert au cloisonnement par compagnie. */
  airline_code: string | null;
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
  /** true = bagage chargé en soute pour la destination (fonction « Charger »). */
  in_hold: boolean;
  in_hold_at: string | null;
  in_hold_by: string | null;
  /** true = bagage restant marqué pour réacheminement sur le prochain vol. */
  rush: boolean;
  rush_at: string | null;
  rush_by: string | null;
  /** Compartiment soute où le bagage a été placé (null = pas encore scanné en soute). */
  soute: SoutePosition | null;
  soute_at: string | null;
  soute_by: string | null;
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

export interface BaggageDispute {
  id: string;
  baggage_id: string | null;
  flight_id: string | null;
  passenger_id: string | null;
  tag_number: string | null;
  status: DisputeStatus;
  reason: string | null;
  notes: string | null;
  /** true = ouvert via une réclamation passager (app tracking), pas par un superviseur. */
  from_passenger: boolean;
  created_by: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
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
// Actions soute : Charger (in_hold) / Rush (réacheminement)
// ─────────────────────────────────────────────────────────────

export interface BaggageActionAccepted {
  status: 'accepted';
  passengerName: string;
  tagNumber: string;
  /** Nombre de bagages de ce passager déjà dans cet état (chargés ou rush). */
  count: number;
  declaredCount: number;
  message: string;
}

export interface BaggageActionRejected {
  status: 'rejected';
  message: string;
}

export type BaggageActionResult = BaggageActionAccepted | BaggageActionRejected;

/**
 * Chargement groupé en soute (fonction « Charger ») : pas de scan, on pousse
 * d'un coup tous les bagages enregistrés non-rush du vol.
 */
export interface BaggageLoadAllAccepted {
  status: 'accepted';
  /** Bagages nouvellement chargés par cette action. */
  loaded: number;
  /** Bagages déjà chargés avant l'action. */
  alreadyLoaded: number;
  /** Bagages exclus car marqués rush (réacheminement). */
  rushed: number;
  /** Total des bagages enregistrés (confirmés) du vol. */
  confirmed: number;
  message: string;
}

export interface BaggageLoadAllRejected {
  status: 'rejected';
  message: string;
}

export type BaggageLoadAllResult = BaggageLoadAllAccepted | BaggageLoadAllRejected;

// ─────────────────────────────────────────────────────────────
// Dolly : contrôle rayon X avant chargement
// Seuls les bagages enregistrés (is_confirmed) sont admis sur le dolly.
// Le dolly « attend » le nombre exact de bagages enregistrés du vol.
// ─────────────────────────────────────────────────────────────

export interface DollyScanAccepted {
  status: 'accepted';
  passengerName: string;
  tagNumber: string;
  /** Bagages actuellement sur le dolly pour ce vol. */
  onDolly: number;
  /** Cible : total des bagages enregistrés (confirmés) du vol. */
  confirmed: number;
  /** true = ce bagage était déjà sur le dolly (re-scan). */
  alreadyOnDolly: boolean;
  /** true = tous les bagages enregistrés sont sur le dolly (onDolly ≥ confirmed). */
  complete: boolean;
  message: string;
}

export interface DollyScanRejected {
  status: 'rejected';
  message: string;
}

export type DollyScanResult = DollyScanAccepted | DollyScanRejected;

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

/**
 * État d'un bagage du point de vue passager (du plus avancé au moins avancé) :
 *  • rush       : restant, marqué pour réacheminement sur le prochain vol.
 *  • loaded     : chargé en soute pour la destination.
 *  • registered : étiquette scannée au tapis (enregistré, anti-fraude OK).
 *  • pending    : déclaré mais pas encore scanné.
 */
export type BaggageStatus = 'pending' | 'registered' | 'loaded' | 'rush';

export const BAGGAGE_STATUS_LABEL: Record<BaggageStatus, string> = {
  pending: 'En attente',
  registered: 'Enregistré',
  loaded: 'Chargé en soute',
  rush: 'Réacheminement',
} as const;

export interface TrackedBag {
  tagNumber: string;
  status: BaggageStatus;
  /** Date du dernier événement pertinent (chargement, enregistrement…). */
  scannedAt: string | null;
  /** Statut du litige/réclamation si le passager a signalé un problème, sinon null. */
  claimStatus: DisputeStatus | null;
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

// ─────────────────────────────────────────────────────────────
// Réclamation passager (app tracking → litige superviseur)
// ─────────────────────────────────────────────────────────────

export interface BaggageClaimAccepted {
  status: 'accepted';
  message: string;
}

export interface BaggageClaimRejected {
  status: 'rejected';
  message: string;
}

export type BaggageClaimResult = BaggageClaimAccepted | BaggageClaimRejected;
