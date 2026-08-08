import { describe, it, expect } from 'vitest';
import { FRAUD_REASON } from '@police/shared';
import { evaluateBaggageScan, type BaggageScanContext } from './fraud.js';

const FLIGHT = 'flight-1';

function ctx(overrides: Partial<BaggageScanContext>): BaggageScanContext {
  return {
    parsedTag: {
      issuerCode: '0',
      airlineNumericCode: '071',
      serialNumber: '161',
      declaredBaggageCount: 2,
      rawTag: '0071161002',
    },
    flightId: FLIGHT,
    gate: 'Gate 3',
    registeredBag: { id: 'bag-1', passengerId: 'pax-1', tagNumber: '0071161002', isConfirmed: false },
    passenger: { id: 'pax-1', fullName: 'KALONJI KABWE Oscar', pnr: 'EYFMKNE', flightId: FLIGHT, declaredBaggageCount: 2 },
    confirmedCountForPassenger: 0,
    duplicateConfirmedTag: false,
    ...overrides,
  };
}

describe('evaluateBaggageScan', () => {
  it('accepte un bagage valide sous le quota et confirme la ligne', () => {
    const d = evaluateBaggageScan(ctx({ confirmedCountForPassenger: 0 }));
    expect(d.result.status).toBe('accepted');
    if (d.result.status !== 'accepted') throw new Error('unreachable');
    expect(d.result.confirmedCount).toBe(1);
    expect(d.result.declaredCount).toBe(2);
    expect(d.confirmBagId).toBe('bag-1');
    expect(d.fraudAlert).toBeNull();
  });

  it('Règle 1 — serial introuvable → alerte UNLINKED_TAG', () => {
    const d = evaluateBaggageScan(ctx({ registeredBag: null, passenger: null }));
    expect(d.result).toMatchObject({ status: 'rejected', reason: FRAUD_REASON.UNLINKED_TAG, fraudAlert: true });
    expect(d.fraudAlert?.reason).toBe(FRAUD_REASON.UNLINKED_TAG);
    expect(d.fraudAlert?.tag_number).toBe('0071161002');
    expect(d.confirmBagId).toBeNull();
  });

  it("Règle 1 — le diagnostic de la route est recopié dans l'alerte", () => {
    // Une alerte règle 1 n'a ni nom ni PNR : sans cette note, le superviseur
    // reçoit un numéro d'étiquette et rien d'autre.
    const note = 'Série 161002 dans la plage imprimée pour ce vol (160000 à 162000).';
    const d = evaluateBaggageScan(ctx({ registeredBag: null, passenger: null, tagNote: note }));
    expect(d.fraudAlert?.note).toBe(note);
    expect(d.fraudAlert?.pnr).toBeNull();
    expect(d.fraudAlert?.passenger_name).toBeNull();
  });

  it('Règle 2 — 0 bagage déclaré → alerte ZERO_DECLARED', () => {
    const d = evaluateBaggageScan(
      ctx({ passenger: { id: 'pax-1', fullName: 'DIASOLWA Pierre', pnr: 'XYZ', flightId: FLIGHT, declaredBaggageCount: 0 } }),
    );
    expect(d.result).toMatchObject({ status: 'rejected', reason: FRAUD_REASON.ZERO_DECLARED, fraudAlert: true });
    expect(d.fraudAlert?.passenger_name).toBe('DIASOLWA Pierre');
    expect(d.fraudAlert?.declared_baggage_count).toBe(0);
  });

  it('Règle 3 — quota dépassé → alerte QUOTA_EXCEEDED', () => {
    const d = evaluateBaggageScan(ctx({ confirmedCountForPassenger: 2 }));
    expect(d.result).toMatchObject({ status: 'rejected', reason: FRAUD_REASON.QUOTA_EXCEEDED, fraudAlert: true });
    expect(d.confirmBagId).toBeNull();
  });

  it('Règle 4 — doublon de tag déjà confirmé → rejet sans alerte', () => {
    const d = evaluateBaggageScan(ctx({ duplicateConfirmedTag: true }));
    expect(d.result).toMatchObject({ status: 'rejected', reason: FRAUD_REASON.ALREADY_SCANNED, fraudAlert: false });
    expect(d.fraudAlert).toBeNull();
  });

  it('Règle 4 bis — ligne déjà confirmée → rejet sans alerte', () => {
    const d = evaluateBaggageScan(
      ctx({ registeredBag: { id: 'bag-1', passengerId: 'pax-1', tagNumber: '0071161002', isConfirmed: true } }),
    );
    expect(d.result).toMatchObject({ status: 'rejected', reason: FRAUD_REASON.ALREADY_SCANNED, fraudAlert: false });
  });

  it('Règle 5 — bagage sur un autre vol → rejet sans alerte', () => {
    const d = evaluateBaggageScan(
      ctx({ passenger: { id: 'pax-1', fullName: 'X', pnr: 'P', flightId: 'autre-vol', declaredBaggageCount: 2 } }),
    );
    expect(d.result).toMatchObject({ status: 'rejected', reason: FRAUD_REASON.WRONG_FLIGHT, fraudAlert: false });
  });

  it("Règle 5 prime sur la règle 1 — une étiquette d'un autre vol n'est pas une fraude", () => {
    // La route fournit désormais la ligne baggage trouvée sur un autre vol du
    // jour. Sans elle, ce cas retombait en règle 1 et alertait le superviseur
    // pour une simple erreur de tapis.
    const d = evaluateBaggageScan(
      ctx({
        registeredBag: { id: 'bag-9', passengerId: 'pax-9', tagNumber: '0071161002', isConfirmed: true },
        passenger: { id: 'pax-9', fullName: 'Y', pnr: 'Q', flightId: 'autre-vol', declaredBaggageCount: 0 },
      }),
    );
    expect(d.result).toMatchObject({ status: 'rejected', reason: FRAUD_REASON.WRONG_FLIGHT, fraudAlert: false });
    expect(d.fraudAlert).toBeNull();
    expect(d.confirmBagId).toBeNull();
  });

  it('confirme le 2e bagage quand 1 est déjà confirmé (sous quota)', () => {
    const d = evaluateBaggageScan(ctx({ confirmedCountForPassenger: 1 }));
    expect(d.result.status).toBe('accepted');
    if (d.result.status !== 'accepted') throw new Error('unreachable');
    expect(d.result.confirmedCount).toBe(2);
  });
});
