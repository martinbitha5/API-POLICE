import { decode } from 'bcbp';
import type { BarcodedBoardingPass, Leg } from 'bcbp';
import type { ParsedBoardingPass, ParsedBoardingPassLeg } from '@police/shared';

export function parseBoardingPass(raw: string): ParsedBoardingPass {
  const parsed: BarcodedBoardingPass = decode(raw);
  const legs = parsed.data?.legs ?? [];
  const first = legs[0];

  if (!first) {
    throw new Error('Boarding pass invalide : aucun leg trouvé');
  }

  return {
    fullName: formatName(parsed.data?.passengerName ?? ''),
    pnr: first.operatingCarrierPNR ?? '',
    flightNumber: normalizeFlightNumber(first),
    seat: first.seatNumber ?? '',
    class: first.compartmentCode ?? '',
    sequenceNumber: parseSequence(first.checkInSequenceNumber),
    declaredBaggageCount: countDeclaredBags(parsed),
    baggageTags: extractBaggageTags(parsed),
    legs: legs.map(mapLeg),
    rawBcbp: raw,
  };
}

function mapLeg(leg: Leg, index: number): ParsedBoardingPassLeg {
  return {
    origin: leg.departureAirport ?? '',
    destination: leg.arrivalAirport ?? '',
    flightNumber: normalizeFlightNumber(leg),
    order: index + 1,
  };
}

/** "AC" + "0834" → "AC0834". Conserve le numéro brut si le carrier manque. */
function normalizeFlightNumber(leg: Leg): string {
  const carrier = leg.operatingCarrierDesignator?.trim() ?? '';
  const number = leg.flightNumber?.trim() ?? '';
  return carrier ? `${carrier}${number}` : number;
}

/** Format BCBP "NOM/PRENOM" → "NOM Prenom". */
function formatName(raw: string): string {
  const [last = '', first = ''] = raw.trim().split('/');
  const lastName = last.trim();
  const firstName = first.trim();
  if (!firstName) return lastName;
  const formattedFirst = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
  return `${lastName} ${formattedFirst}`;
}

function parseSequence(raw: string | undefined): number {
  const n = parseInt((raw ?? '').trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Nombre de bagages déclarés sur le boarding pass.
 *
 * Le BCBP n'a PAS de champ "nombre de bagages" : freeBaggageAllowance est la
 * franchise (souvent vide ou au poids "20K"). La vraie source est le champ
 * étiquette bagage (13 chiffres), dont les 3 derniers chiffres = "number of
 * consecutive bags" :
 *
 *   4 071 303791 002
 *   │  │     │    └── 3 derniers : nombre de bagages de cette plage
 *   │  │     └─────── 6 chiffres : n° de série
 *   │  └───────────── 3 chiffres : code compagnie
 *   └──────────────── 1 chiffre  : leading digit
 *
 * Jusqu'à 3 plages possibles (baggageTagNumber + first/second) → on somme.
 */
function countDeclaredBags(parsed: BarcodedBoardingPass): number {
  const data = parsed.data;
  if (!data) return 0;
  const tags = [data.baggageTagNumber, data.firstBaggageTagNumber, data.secondBaggageTagNumber];
  let total = 0;
  for (const tag of tags) {
    const digits = (tag ?? '').replace(/\D/g, '');
    if (digits.length >= 13) {
      total += parseInt(digits.slice(-3), 10) || 0;
    }
  }
  return total;
}

function extractBaggageTags(parsed: BarcodedBoardingPass): string[] {
  const data = parsed.data;
  if (!data) return [];
  return [data.baggageTagNumber, data.firstBaggageTagNumber, data.secondBaggageTagNumber].filter(
    (tag): tag is string => typeof tag === 'string' && tag.trim().length > 0,
  );
}
