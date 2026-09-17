import { describe, it, expect } from 'vitest';
import { encode } from 'bcbp';
import { parseBoardingPass } from './boarding.js';

describe('parseBoardingPass', () => {
  it('parse un boarding pass mono-leg', () => {
    const raw = encode({
      data: {
        passengerName: 'KALONJI KABWE/OSCAR',
        // Le nombre de bagages vient des 3 derniers chiffres du n° d'étiquette.
        baggageTagNumber: '4071303791002',
        legs: [
          {
            operatingCarrierPNR: 'EYFMKNE',
            departureAirport: 'FIH',
            arrivalAirport: 'FBM',
            operatingCarrierDesignator: 'ET',
            flightNumber: '0062',
            compartmentCode: 'Y',
            seatNumber: '013A',
            checkInSequenceNumber: '0047',
            passengerStatus: '1',
          },
        ],
      },
    });

    const result = parseBoardingPass(raw);
    expect(result.fullName).toBe('KALONJI KABWE Oscar');
    expect(result.pnr).toBe('EYFMKNE');
    expect(result.flightNumber).toBe('ET0062');
    expect(result.seat).toBe('013A');
    expect(result.class).toBe('Y');
    expect(result.sequenceNumber).toBe(47);
    expect(result.declaredBaggageCount).toBe(2);
    expect(result.legs).toEqual([
      { origin: 'FIH', destination: 'FBM', flightNumber: 'ET0062', order: 1 },
    ]);
    expect(result.rawBcbp).toBe(raw);
  });

  it('parse un boarding pass multi-leg (FIH → FKI → FBM)', () => {
    const raw = encode({
      data: {
        passengerName: 'MUKEBA/JEAN',
        legs: [
          {
            operatingCarrierPNR: 'ABCDEF',
            departureAirport: 'FIH',
            arrivalAirport: 'FKI',
            operatingCarrierDesignator: 'ET',
            flightNumber: '0105',
            compartmentCode: 'Y',
            seatNumber: '007C',
            checkInSequenceNumber: '0012',
            passengerStatus: '1',
          },
          {
            operatingCarrierPNR: 'ABCDEF',
            departureAirport: 'FKI',
            arrivalAirport: 'FBM',
            operatingCarrierDesignator: 'ET',
            flightNumber: '0062',
            compartmentCode: 'Y',
            seatNumber: '007C',
            checkInSequenceNumber: '0012',
            passengerStatus: '1',
          },
        ],
      },
    });

    const result = parseBoardingPass(raw);
    expect(result.legs).toHaveLength(2);
    expect(result.legs[0]).toEqual({
      origin: 'FIH',
      destination: 'FKI',
      flightNumber: 'ET0105',
      order: 1,
    });
    expect(result.legs[1]).toEqual({
      origin: 'FKI',
      destination: 'FBM',
      flightNumber: 'ET0062',
      order: 2,
    });
  });

  it('déclare 0 bagage quand le boarding pass ne porte aucune étiquette', () => {
    const raw = encode({
      data: {
        passengerName: 'DIASOLWA/PIERRE',
        legs: [
          {
            operatingCarrierPNR: 'XYZ123',
            departureAirport: 'FIH',
            arrivalAirport: 'FBM',
            operatingCarrierDesignator: 'ET',
            flightNumber: '0062',
            compartmentCode: 'Y',
            seatNumber: '022F',
            checkInSequenceNumber: '0099',
            passengerStatus: '1',
            freeBaggageAllowance: '20K',
          },
        ],
      },
    });

    expect(parseBoardingPass(raw).declaredBaggageCount).toBe(0);
  });

  it('extrait le billet électronique (code compagnie + n° de document)', () => {
    const raw = encode({
      data: {
        passengerName: 'AFZAL/MUZAHIR MR',
        legs: [
          {
            operatingCarrierPNR: 'KFZVZU',
            departureAirport: 'FIH',
            arrivalAirport: 'FKI',
            operatingCarrierDesignator: 'ET',
            flightNumber: '0070',
            compartmentCode: 'Y',
            seatNumber: '022L',
            checkInSequenceNumber: '0010',
            passengerStatus: '1',
            airlineNumericCode: '071',
            serialNumber: '2163324677',
          },
        ],
      },
    });

    expect(parseBoardingPass(raw).ticketNumber).toBe('0712163324677');
  });

  it('billet vide quand la section conditionnelle manque', () => {
    const raw = encode({
      data: {
        passengerName: 'MUKEBA/JEAN',
        legs: [
          {
            operatingCarrierPNR: 'ABCDEF',
            departureAirport: 'FIH',
            arrivalAirport: 'FBM',
            operatingCarrierDesignator: 'ET',
            flightNumber: '0062',
            compartmentCode: 'Y',
            seatNumber: '007C',
            checkInSequenceNumber: '0012',
            passengerStatus: '1',
          },
        ],
      },
    });

    expect(parseBoardingPass(raw).ticketNumber).toBe('');
  });

  it('lit le billet sur un boarding pass Sabre réel (réédition après changement de siège)', () => {
    const first =
      'M1AFZAL/MUZAHIR MR    EKFZVZU FIHFKIET 0070 259Y023A0014 377>8321OO6259BET 4071165222001                          2A0712163324677 1ET                        N*30601018K0900';
    const reissued =
      'M1AFZAL/MUZAHIR MR    EKFZVZU FIHFKIET 0070 259Y022L0010 177>8321OO6259BET                                        2A0712163324677 1ET                        N*306      0900';
    const a = parseBoardingPass(first);
    const b = parseBoardingPass(reissued);
    expect(a.ticketNumber).toBe('0712163324677');
    expect(b.ticketNumber).toBe(a.ticketNumber);
    // Tout le reste a changé : c'est bien le billet qui identifie le passager.
    expect(b.seat).not.toBe(a.seat);
    expect(b.sequenceNumber).not.toBe(a.sequenceNumber);
    expect(a.declaredBaggageCount).toBe(1);
    expect(b.declaredBaggageCount).toBe(0);
  });

  it('lève une erreur si aucun leg', () => {
    expect(() => parseBoardingPass('GARBAGE')).toThrow();
  });
});
