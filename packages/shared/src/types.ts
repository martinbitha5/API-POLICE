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

/**
 * Cycle de vie d'un vol.
 *
 *   scheduled → boarding → closed → departed → arrived
 *
 * `closed` signifie seulement que l'embarquement est terminé (porte fermée) :
 * l'avion peut rester au sol. `departed` et `arrived` disent la suite.
 * `delayed` et `cancelled` sont des écarts posés par le superviseur.
 */
export type FlightStatus =
  | 'scheduled'
  | 'delayed'
  | 'boarding'
  | 'closed'
  | 'departed'
  | 'arrived'
  | 'cancelled';

/** Ordre d'affichage des statuts dans un sélecteur : le parcours, puis les écarts. */
export const FLIGHT_STATUS_ORDER: readonly FlightStatus[] = [
  'scheduled',
  'boarding',
  'closed',
  'departed',
  'arrived',
  'delayed',
  'cancelled',
] as const;

/** Libellés français des statuts de vol (partagés web / public / mobile). */
export const FLIGHT_STATUS_LABEL: Record<FlightStatus, string> = {
  scheduled: 'Programmé',
  delayed: 'Retardé',
  boarding: 'Embarquement',
  closed: 'Embarquement terminé',
  departed: 'Décollé',
  arrived: 'Arrivé',
  cancelled: 'Annulé',
} as const;

/**
 * Les scans de check-in et d'embarquement sont-ils fermés pour ce statut ?
 * Dès la porte fermée, et pour tout ce qui suit ou annule le vol.
 */
export function isFlightLocked(status: FlightStatus): boolean {
  return status === 'closed' || status === 'departed' || status === 'arrived' || status === 'cancelled';
}

/** L'avion a quitté le sol (ou est déjà arrivé). */
export function hasFlightDeparted(status: FlightStatus): boolean {
  return status === 'departed' || status === 'arrived';
}

/** Raison affichée à l'agent quand un vol est verrouillé, par statut. */
export const FLIGHT_LOCK_REASON: Partial<Record<FlightStatus, string>> = {
  closed: 'Embarquement terminé',
  departed: 'Vol décollé',
  arrived: 'Vol arrivé',
  cancelled: 'Vol annulé',
} as const;

/**
 * Famille d'une ligne baggage :
 *  • passenger    : bagage d'un passager du vol (réconciliation tapis, règles anti-fraude).
 *  • rush_forward : bagage expédié SANS passager sur ce vol (écran Expédition rush).
 */
export type BaggageKind = 'passenger' | 'rush_forward';

/**
 * Validation d'un bagage expédié (rush_forward uniquement) :
 *  • expected : annoncé par le superviseur, pas encore arrivé au scan.
 *    L'annonce vaut validation anticipée : le scan le passera à approved.
 *  • approved : peut embarquer — annoncé, restant connu chez nous, ou décision
 *    du superviseur pour un bagage externe arrivé sans annonce.
 *  • pending  : bagage externe en attente de décision — le dolly le refuse.
 *  • denied   : refusé par le superviseur (ou annonce annulée).
 */
export type RushValidationStatus = 'expected' | 'pending' | 'approved' | 'denied';

export const RUSH_VALIDATION_LABEL: Record<RushValidationStatus, string> = {
  expected: "Annoncé, en attente d'arrivée",
  pending: 'En attente de validation',
  approved: 'Autorisé',
  denied: 'Refusé',
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
  /**
   * Règle 1 — l'étiquette ne correspond à aucun bagage déclaré sur un boarding
   * pass de ce vol. On ne sait pas à qui elle appartient : le libellé décrit ce
   * qu'on constate (une étiquette orpheline), pas une conclusion sur le passager.
   */
  UNLINKED_TAG: 'Étiquette non rattachée à un passager',
  /**
   * @deprecated Ancien libellé de la règle 1, conservé pour les alertes
   * historiques déjà en base. Ne plus émettre : voir UNLINKED_TAG.
   */
  PASSENGER_NOT_REGISTERED: 'Passager non enregistré',
  ZERO_DECLARED: '0 bagage déclaré sur boarding pass',
  QUOTA_EXCEEDED: 'Quota bagage dépassé',
  ALREADY_SCANNED: 'Bagage déjà enregistré',
  WRONG_FLIGHT: 'Bagage appartient à un autre vol',
  /** Rejets sans alerte fraude : décisions superviseur ou mauvais écran. */
  CANCELLED: 'Bagage annulé par le superviseur',
  OFFLOADED: 'Passager débarqué',
  RUSH_FORWARD: 'Bagage expédition rush',
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
  /** true = passager débarqué par le superviseur. Ses bagages sont annulés. */
  offloaded: boolean;
  offloaded_at: string | null;
  offloaded_by: string | null;
  offload_reason: string | null;
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
  /**
   * Passager du vol pour un bagage `passenger`. Pour un `rush_forward` : le
   * passager du vol D'ORIGINE si le bagage vient d'un restant connu, sinon null.
   */
  passenger_id: string | null;
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
  /** true = bagage contrôlé au rayon X et placé sur le dolly (avant chargement). */
  on_dolly: boolean;
  on_dolly_at: string | null;
  on_dolly_by: string | null;
  /** true = bagage restant marqué pour réacheminement sur le prochain vol. */
  rush: boolean;
  rush_at: string | null;
  rush_by: string | null;
  /** Compartiment soute où le bagage a été placé (null = pas encore scanné en soute). */
  soute: SoutePosition | null;
  soute_at: string | null;
  soute_by: string | null;
  /** true = bagage scanné à l'arrivée par l'escale de destination. */
  arrived: boolean;
  arrived_at: string | null;
  arrived_by: string | null;
  scanned_at: string;
  scanned_by: string | null;
  /** Famille de la ligne : bagage passager ou expédition rush (sans passager). */
  kind: BaggageKind;
  /** Deuxième étiquette physique (RUSH) d'un bagage expédié, sinon null. */
  rush_tag_number: string | null;
  rush_serial_number: string | null;
  /** Ligne d'origine (le restant) quand le bagage expédié est connu chez nous. */
  origin_baggage_id: string | null;
  /** Validation d'un bagage expédié. null pour un bagage passager. */
  rush_status: RushValidationStatus | null;
  rush_status_at: string | null;
  rush_status_by: string | null;
  /** Annonce superviseur (rush_forward) : saisie avant l'arrivée du colis. */
  announced_at: string | null;
  announced_by: string | null;
  /** Provenance saisie par le superviseur ("Air Congo, arrivé de GMA"). */
  rush_origin: string | null;
  /** Propriétaire saisi par le superviseur (bagage externe, hors base). */
  rush_owner_name: string | null;
  rush_note: string | null;
  /** true = bagage annulé par le superviseur (ou passager débarqué). */
  cancelled: boolean;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  /** true = bagage annulé retiré de la soute, confirmé par scan. */
  pulled: boolean;
  pulled_at: string | null;
  pulled_by: string | null;
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
  /**
   * Diagnostic de liaison au moment du rejet (d'où vient l'étiquette, ce qu'on
   * a cherché), ou explication de la résolution. Sans ça, une alerte règle 1
   * n'affiche ni nom ni PNR et le superviseur n'a rien pour agir.
   */
  note: string | null;
  resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
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

// ─────────────────────────────────────────────────────────────
// Expédition rush : bagage voyageant sans passager sur le vol.
// Flux à deux scans : le bagage porte son étiquette d'origine ET l'étiquette
// RUSH imprimée au réacheminement. L'agent scanne les deux, dans n'importe
// quel ordre ; le premier appel (sans otherTag) identifie, le second enregistre.
// ─────────────────────────────────────────────────────────────

/** Réponse au premier scan : le système dit ce qu'il a reconnu et attend l'autre étiquette. */
export interface ExpeditionRushLookup {
  status: 'lookup';
  /** true = l'étiquette correspond à un restant connu chez nous. */
  known: boolean;
  passengerName: string | null;
  /** Vol d'origine du restant connu (ex: "ET0062 du 2026-08-21"). */
  originFlight: string | null;
  message: string;
}

export interface ExpeditionRushAccepted {
  status: 'accepted';
  known: boolean;
  /** approved = peut embarquer ; pending = attente de validation superviseur. */
  validation: RushValidationStatus;
  passengerName: string | null;
  originFlight: string | null;
  tagNumber: string;
  rushTagNumber: string;
  message: string;
}

export interface ExpeditionRushRejected {
  status: 'rejected';
  message: string;
}

export type ExpeditionRushResult = ExpeditionRushLookup | ExpeditionRushAccepted | ExpeditionRushRejected;

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
// Arrivée : réception des bagages à l'escale de destination
// La cible est le nombre de bagages réellement partis en soute (hors rush) :
// 100 chargés au départ = 100 à scanner à l'arrivée. L'écart = manquants.
// ─────────────────────────────────────────────────────────────

export interface ArrivalScanAccepted {
  status: 'accepted';
  passengerName: string;
  tagNumber: string;
  /** Bagages déjà scannés à l'arrivée pour ce vol. */
  arrived: number;
  /** Cible : bagages partis en soute sur ce vol (in_hold, hors rush). */
  expected: number;
  /** true = ce bagage était déjà scanné à l'arrivée (re-scan). */
  alreadyArrived: boolean;
  /** true = tous les bagages partis sont arrivés (arrived ≥ expected). */
  complete: boolean;
  message: string;
}

export interface ArrivalScanRejected {
  status: 'rejected';
  message: string;
}

export type ArrivalScanResult = ArrivalScanAccepted | ArrivalScanRejected;

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
 *  • arrived    : scanné à l'arrivée par l'escale de destination.
 *  • in_transit : chargé en soute, part avec l'appareil.
 *  • registered : étiquette scannée au tapis (enregistré, anti-fraude OK).
 *  • pending    : déclaré mais pas encore scanné.
 */
export type BaggageStatus = 'pending' | 'registered' | 'in_transit' | 'arrived' | 'rush';

export const BAGGAGE_STATUS_LABEL: Record<BaggageStatus, string> = {
  pending: 'En attente',
  registered: 'Enregistré',
  in_transit: 'En route',
  arrived: 'Arrivé à destination',
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

// ─────────────────────────────────────────────────────────────
// Journal d'audit (vue `movement_log`, réservée aux admins)
// ─────────────────────────────────────────────────────────────

/** Nature d'un mouvement enregistré par le système. */
export type MovementKind =
  | 'passenger_checkin'
  | 'passenger_boarded'
  | 'passenger_offloaded'
  | 'baggage_declared'
  | 'baggage_belt'
  | 'rush_announced'
  | 'baggage_rush_in'
  | 'rush_approved'
  | 'rush_denied'
  | 'baggage_cancelled'
  | 'baggage_pulled'
  | 'baggage_dolly'
  | 'baggage_soute'
  | 'baggage_hold'
  | 'baggage_rush'
  | 'baggage_arrived'
  | 'fraud_opened'
  | 'fraud_resolved'
  | 'dispute_opened'
  | 'dispute_resolved';

/** Ordre d'affichage dans le filtre : le parcours réel, du check-in à l'arrivée. */
export const MOVEMENT_ORDER: MovementKind[] = [
  'passenger_checkin',
  'passenger_boarded',
  'passenger_offloaded',
  'baggage_declared',
  'baggage_belt',
  'rush_announced',
  'baggage_rush_in',
  'rush_approved',
  'rush_denied',
  'baggage_cancelled',
  'baggage_pulled',
  'baggage_dolly',
  'baggage_soute',
  'baggage_hold',
  'baggage_rush',
  'baggage_arrived',
  'fraud_opened',
  'fraud_resolved',
  'dispute_opened',
  'dispute_resolved',
];

export const MOVEMENT_LABEL: Record<MovementKind, string> = {
  passenger_checkin: 'Passager enregistré',
  passenger_boarded: 'Passager embarqué',
  passenger_offloaded: 'Passager débarqué',
  baggage_declared: 'Bagage déclaré au check-in',
  baggage_belt: 'Bagage enregistré au tapis',
  rush_announced: 'Bagage rush annoncé par le superviseur',
  baggage_rush_in: 'Bagage expédié (rush) enregistré',
  rush_approved: 'Expédition rush autorisée',
  rush_denied: 'Expédition rush refusée',
  baggage_cancelled: 'Bagage annulé',
  baggage_pulled: 'Bagage retiré de la soute',
  baggage_dolly: 'Bagage contrôlé au rayon X',
  baggage_soute: 'Bagage affecté en soute',
  baggage_hold: 'Bagage chargé en soute',
  baggage_rush: 'Bagage restant (à réacheminer)',
  baggage_arrived: 'Bagage arrivé à destination',
  fraud_opened: 'Alerte fraude levée',
  fraud_resolved: 'Alerte fraude résolue',
  dispute_opened: 'Litige ouvert',
  dispute_resolved: 'Litige résolu',
} as const;

/** Famille d'un mouvement, pour le regroupement visuel. */
export type MovementFamily = 'passenger' | 'baggage' | 'fraud' | 'dispute';

export const MOVEMENT_FAMILY: Record<MovementKind, MovementFamily> = {
  passenger_checkin: 'passenger',
  passenger_boarded: 'passenger',
  passenger_offloaded: 'passenger',
  baggage_declared: 'baggage',
  baggage_belt: 'baggage',
  rush_announced: 'baggage',
  baggage_rush_in: 'baggage',
  rush_approved: 'baggage',
  rush_denied: 'baggage',
  baggage_cancelled: 'baggage',
  baggage_pulled: 'baggage',
  baggage_dolly: 'baggage',
  baggage_soute: 'baggage',
  baggage_hold: 'baggage',
  baggage_rush: 'baggage',
  baggage_arrived: 'baggage',
  fraud_opened: 'fraud',
  fraud_resolved: 'fraud',
  dispute_opened: 'dispute',
  dispute_resolved: 'dispute',
} as const;

/**
 * Une ligne du journal d'audit.
 *
 * `actor_id` est nul pour les alertes fraude : elles sont levées par les règles
 * anti-fraude, pas par un agent. Voir la vue `movement_log`.
 */
export interface Movement {
  at: string;
  kind: MovementKind;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  flight_id: string | null;
  flight_number: string | null;
  flight_date: string | null;
  origin: string | null;
  destination: string | null;
  passenger_id: string | null;
  passenger_name: string | null;
  pnr: string | null;
  baggage_id: string | null;
  tag_number: string | null;
  detail: string | null;
}
