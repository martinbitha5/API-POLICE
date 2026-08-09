import { describe, it, expect, vi, afterEach } from 'vitest';
import { isoDate, todayLocal, todayInTimeZone } from './date.js';
import { airportTimeZone, todayAtAirport } from './airports.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('isoDate', () => {
  it('formate en AAAA-MM-JJ avec les zéros de tête', () => {
    expect(isoDate(new Date(2026, 0, 9, 12))).toBe('2026-01-09');
    expect(isoDate(new Date(2026, 11, 31, 12))).toBe('2026-12-31');
  });
});

describe('todayInTimeZone', () => {
  it('bascule à minuit à Kinshasa, pas à minuit UTC', () => {
    // 2026-08-08 23h30 UTC = 2026-08-09 00h30 à Kinshasa (UTC+1).
    // C'est précisément la fenêtre où toISOString() renvoyait la veille.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T23:30:00Z'));

    expect(new Date().toISOString().slice(0, 10)).toBe('2026-08-08'); // l'ancien calcul
    expect(todayInTimeZone('Africa/Kinshasa')).toBe('2026-08-09'); // le nouveau
  });

  it('donne une date différente à Kinshasa et à Lubumbashi dans la fenêtre horaire', () => {
    // 2026-08-08 22h30 UTC : minuit est déjà passé à Lubumbashi (UTC+2),
    // pas encore à Kinshasa (UTC+1).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T22:30:00Z'));

    expect(todayInTimeZone('Africa/Kinshasa')).toBe('2026-08-08');
    expect(todayInTimeZone('Africa/Lubumbashi')).toBe('2026-08-09');
  });

  it('retombe sur la date de l’appareil si le fuseau est inconnu du moteur', () => {
    expect(todayInTimeZone('Mars/Olympus_Mons')).toBe(todayLocal());
  });
});

describe('airportTimeZone', () => {
  it('sépare les deux fuseaux de la RD Congo', () => {
    expect(airportTimeZone('FIH')).toBe('Africa/Kinshasa');
    expect(airportTimeZone('MDK')).toBe('Africa/Kinshasa');
    expect(airportTimeZone('FBM')).toBe('Africa/Lubumbashi');
    expect(airportTimeZone('FKI')).toBe('Africa/Lubumbashi');
  });

  it('accepte un code en minuscules ou espacé', () => {
    expect(airportTimeZone(' fbm ')).toBe('Africa/Lubumbashi');
  });

  it('retombe sur le hub si le code est inconnu, vide ou absent', () => {
    expect(airportTimeZone('ZZZ')).toBe('Africa/Kinshasa');
    expect(airportTimeZone('')).toBe('Africa/Kinshasa');
    expect(airportTimeZone(null)).toBe('Africa/Kinshasa');
    expect(airportTimeZone(undefined)).toBe('Africa/Kinshasa');
  });
});

describe('todayAtAirport', () => {
  it('renvoie la journée d’exploitation de l’aéroport donné', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T22:30:00Z'));

    expect(todayAtAirport('FIH')).toBe('2026-08-08');
    expect(todayAtAirport('FBM')).toBe('2026-08-09');
  });
});
