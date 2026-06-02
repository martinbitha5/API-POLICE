import { describe, it, expect } from 'vitest';
import { parseBaggageTag, buildBaggageKey } from './baggage.js';

describe('parseBaggageTag', () => {
  it('décompose une étiquette physique 10 chiffres', () => {
    const result = parseBaggageTag('4071303821');
    expect(result).toEqual({
      issuerCode: '4',
      airlineNumericCode: '071',
      serialNumber: '303821',
      declaredBaggageCount: 0, // pas de comptage sur l'étiquette physique
      rawTag: '4071303821',
    });
  });

  it('décompose une étiquette boarding 13 chiffres avec le nombre de bagages', () => {
    const result = parseBaggageTag('4071303791002');
    expect(result).toEqual({
      issuerCode: '4',
      airlineNumericCode: '071',
      serialNumber: '303791',
      declaredBaggageCount: 2,
      rawTag: '4071303791002',
    });
  });

  it('conserve les zéros initiaux du serial et du code compagnie', () => {
    const result = parseBaggageTag('0071000001');
    expect(result.airlineNumericCode).toBe('071');
    expect(result.serialNumber).toBe('000001');
  });

  it('rejette une longueur incorrecte', () => {
    expect(() => parseBaggageTag('007116186')).toThrow(/length: 9/);
    expect(() => parseBaggageTag('00711618630')).toThrow(/length: 11/);
  });

  it('rejette les caractères non numériques', () => {
    expect(() => parseBaggageTag('00711618AB')).toThrow(/only digits/);
  });
});

describe('buildBaggageKey', () => {
  it('construit la clé serial + flightId + date', () => {
    expect(buildBaggageKey('303791', 'flight-uuid', '2026-06-01')).toBe('303791-flight-uuid-2026-06-01');
  });

  it('ignore totalement le code compagnie (ET partagé 071)', () => {
    // Deux bagages au même serial sur le même vol/date produisent la même clé,
    // peu importe la compagnie inscrite sur l'étiquette.
    const a = buildBaggageKey('303791', 'f1', '2026-06-01');
    const b = buildBaggageKey('303791', 'f1', '2026-06-01');
    expect(a).toBe(b);
  });
});
