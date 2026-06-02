import { describe, it, expect } from 'vitest';
import { flightNumbersMatch, formatRoute } from './flight.js';

describe('flightNumbersMatch', () => {
  it('tolère le zéro-padding', () => {
    expect(flightNumbersMatch('ET64', 'ET0064')).toBe(true);
    expect(flightNumbersMatch('ET0062', 'ET62')).toBe(true);
  });

  it('tolère les espaces', () => {
    expect(flightNumbersMatch('ET 64', 'ET64')).toBe(true);
  });

  it('refuse un numéro différent', () => {
    expect(flightNumbersMatch('ET60', 'ET64')).toBe(false);
  });

  it('refuse une compagnie différente à numéro égal', () => {
    expect(flightNumbersMatch('ET64', 'AC64')).toBe(false);
  });

  it('compare le numéro seul si un préfixe manque', () => {
    expect(flightNumbersMatch('64', 'ET64')).toBe(true);
    expect(flightNumbersMatch('60', 'ET64')).toBe(false);
  });

  it('refuse en absence de partie numérique', () => {
    expect(flightNumbersMatch('ET', 'ET64')).toBe(false);
  });
});

describe('formatRoute', () => {
  it('vol direct', () => {
    expect(formatRoute({ origin: 'FIH', destination: 'FBM', stops: null })).toBe('FIH → FBM');
  });

  it('vol avec escales', () => {
    expect(formatRoute({ origin: 'FIH', destination: 'FBM', stops: ['FKI'] })).toBe('FIH → FKI → FBM');
    expect(formatRoute({ origin: 'FIH', destination: 'LUN', stops: ['FKI', 'FBM'] })).toBe(
      'FIH → FKI → FBM → LUN',
    );
  });

  it('ignore les escales vides', () => {
    expect(formatRoute({ origin: 'FIH', destination: 'FBM', stops: ['  '] })).toBe('FIH → FBM');
  });
});
