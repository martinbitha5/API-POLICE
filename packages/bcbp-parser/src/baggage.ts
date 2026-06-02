import type { ParsedBaggageTag } from '@police/shared';

// Étiquette physique (scannée sur le tapis) : 10 chiffres.
// Étiquette portée par le boarding pass : 13 chiffres (= 10 + nb de bagages).
//
//   4 071 303791 002
//   │  │     │    └── 3 derniers : nombre de bagages consécutifs (boarding only)
//   │  │     └─────── 6 chiffres : numéro de série (CLÉ DE LIAISON)
//   │  └───────────── 3 chiffres : code numérique compagnie
//   └──────────────── 1 chiffre  : Baggage Tag Issuer Code
//
// L'étiquette physique 10 chiffres n'a PAS les 3 chiffres de comptage.
const PHYSICAL_LENGTH = 10;
const BOARDING_LENGTH = 13;

export function parseBaggageTag(tag: string): ParsedBaggageTag {
  if (!/^\d+$/.test(tag)) {
    throw new Error(`Invalid baggage tag: "${tag}" must contain only digits`);
  }
  if (tag.length !== PHYSICAL_LENGTH && tag.length !== BOARDING_LENGTH) {
    throw new Error(
      `Invalid baggage tag length: ${tag.length}, expected ${PHYSICAL_LENGTH} or ${BOARDING_LENGTH}`,
    );
  }

  return {
    issuerCode: tag[0]!,
    airlineNumericCode: tag.slice(1, 4),
    serialNumber: tag.slice(4, 10), // 6 chiffres = clé de liaison passager ↔ bagage
    declaredBaggageCount: tag.length === BOARDING_LENGTH ? parseInt(tag.slice(10, 13), 10) : 0,
    rawTag: tag,
  };
}

/**
 * Clé de liaison passager ↔ bagage.
 * Ne se base jamais sur le code compagnie (071 = ET = Ethiopian/Air Congo).
 */
export function buildBaggageKey(serialNumber: string, flightId: string, date: string): string {
  return `${serialNumber}-${flightId}-${date}`;
}
