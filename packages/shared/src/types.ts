// Types partagÃ©s entre mobile, web et api.
// Source de vÃ©ritÃ© unique â€” ne jamais dupliquer ces types ailleurs.

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Enums / unions
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type UserRole = 'admin' | 'supervisor' | 'agent';

/** Compartiment soute de l'avion (avant / arriÃ¨re). */
export type SoutePosition = 'avant' | 'arriere';

export const SOUTE_LABEL: Record<SoutePosition, string> = {
  avant: 'Soute avant',
  arriere: 'Soute arriÃ¨re',
} as const;

/**
 * Cycle de vie d'un vol.
 *
 *   scheduled â†’ boarding â†’ closed â†’ departed â†’ arrived
 *
 * `closed` signifie seulement que l'embarquement est terminÃ© (porte fermÃ©e) :
 * l'avion peut rester au sol. `departed` et `arrived` disent la suite.
 * `delayed` et `cancelled` sont des Ã©carts posÃ©s par le superviseur.
 */
export type FlightStatus =
  | 'scheduled'
  | 'delayed'
  | 'boarding'
  | 'closed'
  | 'departed'
  | 'arrived'
  | 'cancelled';

/** Ordre d'affichage des statuts dans un sÃ©lecteur : le parcours, puis les Ã©carts. */
export const FLIGHT_STATUS_ORDER: readonly FlightStatus[] = [
  'scheduled',
  'boarding',
  'closed',
  'departed',
  'arrived',
  'delayed',
  'cancelled',
] as const;

/** LibellÃ©s franÃ§ais des statuts de vol (partagÃ©s web / public / mobile). */
export const FLIGHT_STATUS_LABEL: Record<FlightStatus, string> = {
  scheduled: 'ProgrammÃ©',
  delayed: 'RetardÃ©',
  boarding: 'Embarquement',
  closed: 'Embarquement terminÃ©',
  departed: 'DÃ©collÃ©',
  arrived: 'ArrivÃ©',
  cancelled: 'AnnulÃ©',
} as const;

/**
 * Les scans de check-in et d'embarquement sont-ils fermÃ©s pour ce statut ?
 * DÃ¨s la porte fermÃ©e, et pour tout ce qui suit ou annule le vol.
 */
export function isFlightLocked(status: FlightStatus): boolean {
  return status === 'closed' || status === 'departed' || status === 'arrived' || status === 'cancelled';
}

/** L'avion a quittÃ© le sol (ou est dÃ©jÃ  arrivÃ©). */
export function hasFlightDeparted(status: FlightStatus): boolean {
  return status === 'departed' || status === 'arrived';
}

/** Raison affichÃ©e Ã  l'agent quand un vol est verrouillÃ©, par statut. */
export const FLIGHT_LOCK_REASON: Partial<Record<FlightStatus, string>> = {
  closed: 'Embarquement terminÃ©',
  departed: 'Vol dÃ©collÃ©',
  arrived: 'Vol arrivÃ©',
  cancelled: 'Vol annulÃ©',
} as const;

/**
 * Famille d'une ligne baggage :
 *  â€¢ passenger    : bagage d'un passager du vol (rÃ©conciliation tapis, rÃ¨gles anti-fraude).
 *  â€¢ rush_forward : bagage expÃ©diÃ© SANS passager sur ce vol (Ã©cran ExpÃ©dition rush).
 */
export type BaggageKind = 'passenger' | 'rush_forward';

/**
 * Validation d'un bagage expÃ©diÃ© (rush_forward uniquement) :
 *  â€¢ expected : annoncÃ© par le superviseur, pas encore arrivÃ© au scan.
 *    L'annonce vaut validation anticipÃ©e : le scan le passera Ã  approved.
 *  â€¢ approved : peut embarquer â€” annoncÃ©, restant connu chez nous, ou dÃ©cision
 *    du superviseur pour un bagage externe arrivÃ© sans annonce.
 *  â€¢ pending  : bagage externe en attente de dÃ©cision â€” le dolly le refuse.
 *  â€¢ denied   : refusÃ© par le superviseur (ou annonce annulÃ©e).
 */
export type RushValidationStatus = 'expected' | 'pending' | 'approved' | 'denied';

export const RUSH_VALIDATION_LABEL: Record<RushValidationStatus, string> = {
  expected: "AnnoncÃ©, en attente d'arrivÃ©e",
  pending: 'En attente de validation',
  approved: 'AutorisÃ©',
  denied: 'RefusÃ©',
} as const;

/** Statut d'un dossier de litige bagage. */
export type DisputeStatus = 'open' | 'investigating' | 'resolved';

export const DISPUTE_STATUS_LABEL: Record<DisputeStatus, string> = {
  open: 'Ouvert',
  investigating: 'En cours',
  resolved: 'RÃ©solu',
} as const;

/** Raisons de rejet d'un bagage (rÃ¨gles anti-fraude 1 Ã  5). */
export const FRAUD_REASON = {
  /**
   * RÃ¨gle 1 â€” l'Ã©tiquette ne correspond Ã  aucun bagage dÃ©clarÃ© sur un boarding
   * pass de ce vol. On ne sait pas Ã  qui elle appartient : le libellÃ© dÃ©crit ce
   * qu'on constate (une Ã©tiquette orpheline), pas une conclusion sur le passager.
   */
  UNLINKED_TAG: 'Ã‰tiquette non rattachÃ©e Ã  un passager',
  /**
   * @deprecated Ancien libellÃ© de la rÃ¨gle 1, conservÃ© pour les alertes
   * historiques dÃ©jÃ  en base. Ne plus Ã©mettre : voir UNLINKED_TAG.
   */
  PASSENGER_NOT_REGISTERED: 'Passager non enregistrÃ©',
  ZERO_DECLARED: '0 bagage dÃ©clarÃ© sur boarding pass',
  QUOTA_EXCEEDED: 'Quota bagage dÃ©passÃ©',
  ALREADY_SCANNED: 'Bagage dÃ©jÃ  enregistrÃ©',
  WRONG_FLIGHT: 'Bagage appartient Ã  un autre vol',
  /** Rejets sans alerte fraude : dÃ©cisions superviseur ou mauvais Ã©cran. */
  CANCELLED: 'Bagage annulÃ© par le superviseur',
  OFFLOADED: 'Passager dÃ©barquÃ©',
  RUSH_FORWARD: 'Bagage expÃ©dition rush',
} as const;

export type FraudReason = (typeof FRAUD_REASON)[keyof typeof FRAUD_REASON];

/** CatÃ©gories de rÃ©clamation passager (app tracking â†’ litige). */
export type ClaimCategory = 'missing' | 'damaged' | 'contents' | 'delayed' | 'other';

/** LibellÃ© franÃ§ais stockÃ© en base (l'app litige est en franÃ§ais). */
export const CLAIM_CATEGORY_LABEL: Record<ClaimCategory, string> = {
  missing: 'Bagage manquant',
  damaged: 'Bagage endommagÃ©',
  contents: 'Objet manquant dans le bagage',
  delayed: 'Bagage retardÃ©',
  other: 'Autre problÃ¨me',
} as const;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// RÃ©sultats de parsing
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Lignes de base de donnÃ©es (Supabase)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  /** Escales intermÃ©diaires en ordre de trajet (vols avec transit). Route complÃ¨te = origin â†’ stops â†’ destination. */
  stops: string[] | null;
  /** Transporteur, dÃ©rivÃ© du prÃ©fixe de flight_number. Colonne gÃ©nÃ©rÃ©e : sert au cloisonnement par compagnie. */
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
  /** true = passager physiquement embarquÃ© (boarding pass scannÃ© Ã  la porte). */
  boarded: boolean;
  boarded_at: string | null;
  boarded_by: string | null;
  /** true = passager dÃ©barquÃ© par le superviseur. Ses bagages sont annulÃ©s. */
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
  /** true = bagage chargÃ© en soute pour la destination (fonction Â« Charger Â»). */
  in_hold: boolean;
  in_hold_at: string | null;
  in_hold_by: string | null;
  /** true = bagage contrÃ´lÃ© au rayon X et placÃ© sur le dolly (avant chargement). */
  on_dolly: boolean;
  on_dolly_at: string | null;
  on_dolly_by: string | null;
  /** true = bagage restant marquÃ© pour rÃ©acheminement sur le prochain vol. */
  rush: boolean;
  rush_at: string | null;
  rush_by: string | null;
  /** Compartiment soute oÃ¹ le bagage a Ã©tÃ© placÃ© (null = pas encore scannÃ© en soute). */
  soute: SoutePosition | null;
  soute_at: string | null;
  soute_by: string | null;
  /** true = bagage scannÃ© Ã  l'arrivÃ©e par l'escale de destination. */
  arrived: boolean;
  arrived_at: string | null;
  arrived_by: string | null;
  scanned_at: string;
  scanned_by: string | null;
  /** Famille de la ligne : bagage passager ou expÃ©dition rush (sans passager). */
  kind: BaggageKind;
  /** DeuxiÃ¨me Ã©tiquette physique (RUSH) d'un bagage expÃ©diÃ©, sinon null. */
  rush_tag_number: string | null;
  rush_serial_number: string | null;
  /** Ligne d'origine (le restant) quand le bagage expÃ©diÃ© est connu chez nous. */
  origin_baggage_id: string | null;
  /** Validation d'un bagage expÃ©diÃ©. null pour un bagage passager. */
  rush_status: RushValidationStatus | null;
  rush_status_at: string | null;
  rush_status_by: string | null;
  /** Annonce superviseur (rush_forward) : saisie avant l'arrivÃ©e du colis. */
  announced_at: string | null;
  announced_by: string | null;
  /** Provenance saisie par le superviseur ("Air Congo, arrivÃ© de GMA"). */
  rush_origin: string | null;
  /** PropriÃ©taire saisi par le superviseur (bagage externe, hors base). */
  rush_owner_name: string | null;
  rush_note: string | null;
  /** true = bagage annulÃ© par le superviseur (ou passager dÃ©barquÃ©). */
  cancelled: boolean;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  /** true = bagage annulÃ© retirÃ© de la soute, confirmÃ© par scan. */
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
   * Diagnostic de liaison au moment du rejet (d'oÃ¹ vient l'Ã©tiquette, ce qu'on
   * a cherchÃ©), ou explication de la rÃ©solution. Sans Ã§a, une alerte rÃ¨gle 1
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
  /** true = ouvert via une rÃ©clamation passager (app tracking), pas par un superviseur. */
  from_passenger: boolean;
  created_by: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// RÃ©sultats d'opÃ©rations de scan (api â†’ clients)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface BaggageScanAccepted {
  status: 'accepted';
  passengerName: string;
  confirmedCount: number;
  declaredCount: number;
}

export interface BaggageScanRejected {
  status: 'rejected';
  reason: FraudReason;
  /** true = une alerte fraude a Ã©tÃ© crÃ©Ã©e (rÃ¨gles 1, 2, 3). */
  fraudAlert: boolean;
  message: string;
}

export type BaggageScanResult = BaggageScanAccepted | BaggageScanRejected;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Actions soute : Charger (in_hold) / Rush (rÃ©acheminement)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface BaggageActionAccepted {
  status: 'accepted';
  passengerName: string;
  tagNumber: string;
  /** Nombre de bagages de ce passager dÃ©jÃ  dans cet Ã©tat (chargÃ©s ou rush). */
  count: number;
  declaredCount: number;
  message: string;
}

export interface BaggageActionRejected {
  status: 'rejected';
  message: string;
}

export type BaggageActionResult = BaggageActionAccepted | BaggageActionRejected;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ExpÃ©dition rush : bagage voyageant sans passager sur le vol.
// Flux Ã  deux scans : le bagage porte son Ã©tiquette d'origine ET l'Ã©tiquette
// RUSH imprimÃ©e au rÃ©acheminement. L'agent scanne les deux, dans n'importe
// quel ordre ; le premier appel (sans otherTag) identifie, le second enregistre.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** RÃ©ponse au premier scan : le systÃ¨me dit ce qu'il a reconnu et attend l'autre Ã©tiquette. */
export interface ExpeditionRushLookup {
  status: 'lookup';
  /** true = l'Ã©tiquette correspond Ã  un restant connu chez nous. */
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
 * Chargement groupÃ© en soute (fonction Â« Charger Â») : pas de scan, on pousse
 * d'un coup tous les bagages enregistrÃ©s non-rush du vol.
 */
export interface BaggageLoadAllAccepted {
  status: 'accepted';
  /** Bagages nouvellement chargÃ©s par cette action. */
  loaded: number;
  /** Bagages dÃ©jÃ  chargÃ©s avant l'action. */
  alreadyLoaded: number;
  /** Bagages exclus car marquÃ©s rush (rÃ©acheminement). */
  rushed: number;
  /** Total des bagages enregistrÃ©s (confirmÃ©s) du vol. */
  confirmed: number;
  message: string;
}

export interface BaggageLoadAllRejected {
  status: 'rejected';
  message: string;
}

export type BaggageLoadAllResult = BaggageLoadAllAccepted | BaggageLoadAllRejected;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Dolly : contrÃ´le rayon X avant chargement
// Seuls les bagages enregistrÃ©s (is_confirmed) sont admis sur le dolly.
// Le dolly Â« attend Â» le nombre exact de bagages enregistrÃ©s du vol.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface DollyScanAccepted {
  status: 'accepted';
  passengerName: string;
  tagNumber: string;
  /** Bagages actuellement sur le dolly pour ce vol. */
  onDolly: number;
  /** Cible : total des bagages enregistrÃ©s (confirmÃ©s) du vol. */
  confirmed: number;
  /** true = ce bagage Ã©tait dÃ©jÃ  sur le dolly (re-scan). */
  alreadyOnDolly: boolean;
  /** true = tous les bagages enregistrÃ©s sont sur le dolly (onDolly â‰¥ confirmed). */
  complete: boolean;
  message: string;
}

export interface DollyScanRejected {
  status: 'rejected';
  message: string;
}

export type DollyScanResult = DollyScanAccepted | DollyScanRejected;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ArrivÃ©e : rÃ©ception des bagages Ã  l'escale de destination
// La cible est le nombre de bagages rÃ©ellement partis en soute (hors rush) :
// 100 chargÃ©s au dÃ©part = 100 Ã  scanner Ã  l'arrivÃ©e. L'Ã©cart = manquants.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ArrivalScanAccepted {
  status: 'accepted';
  passengerName: string;
  tagNumber: string;
  /** Bagages dÃ©jÃ  scannÃ©s Ã  l'arrivÃ©e pour ce vol. */
  arrived: number;
  /** Cible : bagages partis en soute sur ce vol (in_hold, hors rush). */
  expected: number;
  /** true = ce bagage Ã©tait dÃ©jÃ  scannÃ© Ã  l'arrivÃ©e (re-scan). */
  alreadyArrived: boolean;
  /** true = tous les bagages partis sont arrivÃ©s (arrived â‰¥ expected). */
  complete: boolean;
  message: string;
}

export interface ArrivalScanRejected {
  status: 'rejected';
  message: string;
}

export type ArrivalScanResult = ArrivalScanAccepted | ArrivalScanRejected;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Embarquement Ã  la porte (boarding pass scannÃ© au gate)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Compteurs d'embarquement d'un vol. reste = registered âˆ’ boarded. */
export interface BoardingCounts {
  /** Passagers enregistrÃ©s au check-in. */
  registered: number;
  /** Passagers physiquement embarquÃ©s. */
  boarded: number;
  /** Reste Ã  embarquer (registered âˆ’ boarded). */
  remaining: number;
}

export interface BoardingGateAccepted {
  status: 'accepted';
  passengerName: string;
  seat: string;
  /** true = ce passager Ã©tait dÃ©jÃ  marquÃ© embarquÃ© (re-scan). */
  alreadyBoarded: boolean;
  counts: BoardingCounts;
}

export interface BoardingGateRejected {
  status: 'rejected';
  message: string;
}

export type BoardingGateResult = BoardingGateAccepted | BoardingGateRejected;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Suivi bagage cÃ´tÃ© passager (app tracking, public)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Ã‰tat d'un bagage du point de vue passager (du plus avancÃ© au moins avancÃ©) :
 *  â€¢ rush       : restant, marquÃ© pour rÃ©acheminement sur le prochain vol.
 *  â€¢ arrived    : scannÃ© Ã  l'arrivÃ©e par l'escale de destination.
 *  â€¢ in_transit : chargÃ© en soute, part avec l'appareil.
 *  â€¢ registered : Ã©tiquette scannÃ©e au tapis (enregistrÃ©, anti-fraude OK).
 *  â€¢ pending    : dÃ©clarÃ© mais pas encore scannÃ©.
 */
export type BaggageStatus = 'pending' | 'registered' | 'in_transit' | 'arrived' | 'rush';

export const BAGGAGE_STATUS_LABEL: Record<BaggageStatus, string> = {
  pending: 'En attente',
  registered: 'EnregistrÃ©',
  in_transit: 'En route',
  arrived: 'ArrivÃ© Ã  destination',
  rush: 'RÃ©acheminement',
} as const;

export interface TrackedBag {
  tagNumber: string;
  status: BaggageStatus;
  /** Date du dernier Ã©vÃ©nement pertinent (chargement, enregistrementâ€¦). */
  scannedAt: string | null;
  /** Statut du litige/rÃ©clamation si le passager a signalÃ© un problÃ¨me, sinon null. */
  claimStatus: DisputeStatus | null;
}

export interface TrackedPassenger {
  passengerName: string;
  pnr: string;
  flightNumber: string;
  /** Route complÃ¨te, escales comprises : "FIH â†’ FKI â†’ FBM". */
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// RÃ©clamation passager (app tracking â†’ litige superviseur)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface BaggageClaimAccepted {
  status: 'accepted';
  message: string;
}

export interface BaggageClaimRejected {
  status: 'rejected';
  message: string;
}

export type BaggageClaimResult = BaggageClaimAccepted | BaggageClaimRejected;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Journal d'audit (vue `movement_log`, rÃ©servÃ©e aux admins)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Nature d'un mouvement enregistrÃ© par le systÃ¨me. */
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

/** Ordre d'affichage dans le filtre : le parcours rÃ©el, du check-in Ã  l'arrivÃ©e. */
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
  passenger_checkin: 'Passager enregistrÃ©',
  passenger_boarded: 'Passager embarquÃ©',
  passenger_offloaded: 'Passager dÃ©barquÃ©',
  baggage_declared: 'Bagage dÃ©clarÃ© au check-in',
  baggage_belt: 'Bagage enregistrÃ© au tapis',
  rush_announced: 'Bagage rush annoncÃ© par le superviseur',
  baggage_rush_in: 'Bagage expÃ©diÃ© (rush) enregistrÃ©',
  rush_approved: 'ExpÃ©dition rush autorisÃ©e',
  rush_denied: 'ExpÃ©dition rush refusÃ©e',
  baggage_cancelled: 'Bagage annulÃ©',
  baggage_pulled: 'Bagage retirÃ© de la soute',
  baggage_dolly: 'Bagage contrÃ´lÃ© au rayon X',
  baggage_soute: 'Bagage affectÃ© en soute',
  baggage_hold: 'Bagage chargÃ© en soute',
  baggage_rush: 'Bagage restant (Ã  rÃ©acheminer)',
  baggage_arrived: 'Bagage arrivÃ© Ã  destination',
  fraud_opened: 'Alerte fraude levÃ©e',
  fraud_resolved: 'Alerte fraude rÃ©solue',
  dispute_opened: 'Litige ouvert',
  dispute_resolved: 'Litige rÃ©solu',
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
 * `actor_id` est nul pour les alertes fraude : elles sont levÃ©es par les rÃ¨gles
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
