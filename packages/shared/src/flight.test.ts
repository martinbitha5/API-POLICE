import { describe, it, expect } from 'vitest';
import {
  flightNumbersMatch,
  formatRoute,
  operationAllowed,
  operationDenial,
  stationRole,
} from './flight.js';

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

describe('stationRole', () => {
  const direct = { origin: 'FIH', destination: 'FBM', stops: null };
  const transit = { origin: 'FIH', destination: 'FBM', stops: ['FKI'] };

  it('situe chaque aéroport sur le vol', () => {
    expect(stationRole(direct, 'FIH')).toBe('origin');
    expect(stationRole(direct, 'FBM')).toBe('destination');
    expect(stationRole(transit, 'FKI')).toBe('stop');
  });

  it('tolère la casse et les espaces du code', () => {
    expect(stationRole(direct, ' fih ')).toBe('origin');
  });

  it('ne tranche pas sans aéroport ni hors de la route', () => {
    expect(stationRole(direct, null)).toBe('unknown');
    expect(stationRole(direct, '')).toBe('unknown');
    expect(stationRole(direct, 'GOM')).toBe('unknown');
  });

  it('traite un aller-retour comme une escale', () => {
    expect(stationRole({ origin: 'FIH', destination: 'FIH', stops: ['FBM'] }, 'FIH')).toBe('stop');
  });
});

describe('operationAllowed', () => {
  it("au départ : tout sauf l'arrivée", () => {
    expect(operationAllowed('checkin', 'origin')).toBe(true);
    expect(operationAllowed('rush', 'origin')).toBe(true);
    expect(operationAllowed('expedition_rush', 'origin')).toBe(true);
    expect(operationAllowed('arrivee', 'origin')).toBe(false);
  });

  it("à destination : l'arrivée seulement", () => {
    expect(operationAllowed('arrivee', 'destination')).toBe(true);
    expect(operationAllowed('checkin', 'destination')).toBe(false);
    expect(operationAllowed('rush', 'destination')).toBe(false);
    expect(operationAllowed('expedition_rush', 'destination')).toBe(false);
  });

  it('à une escale : tout', () => {
    expect(operationAllowed('checkin', 'stop')).toBe(true);
    expect(operationAllowed('arrivee', 'stop')).toBe(true);
  });

  it('ne bloque rien quand le rôle est indéterminé', () => {
    expect(operationAllowed('checkin', 'unknown')).toBe(true);
    expect(operationAllowed('arrivee', 'unknown')).toBe(true);
  });
});

describe('operationDenial', () => {
  const direct = { origin: 'FIH', destination: 'FBM', stops: null };

  it('renvoie null quand le geste a un sens', () => {
    expect(operationDenial('checkin', direct, 'FIH')).toBeNull();
    expect(operationDenial('arrivee', direct, 'FBM')).toBeNull();
  });

  it('dit où se fait la réception au départ', () => {
    expect(operationDenial('arrivee', direct, 'FIH')).toContain('Lubumbashi (FBM)');
  });

  it('dit où se font les opérations de départ à destination', () => {
    expect(operationDenial('checkin', direct, 'FBM')).toContain('Kinshasa (FIH)');
  });
});
