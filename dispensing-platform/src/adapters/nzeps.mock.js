// In-memory stand-in for the NZePS broker. Mimics the behaviour described in
// Health NZ's public guidance: lookup by SCID, a BUS002-style "not found"
// error, status moving to "Repeats Remaining" / "Dispensed", and refusal to
// release a script that is already fully dispensed. Replace with a real
// client once Health NZ provides the spec and test environment.

import { makeScid } from '../domain/scid.js';

export class BrokerError extends Error {
  constructor(code, message, status = 502) {
    super(`${code}: ${message}`);
    this.code = code;
    this.status = status;
  }
}

const SAMPLES = [
  {
    body: '1A2B3C4D5E6F7G8H9',
    patient: { nhi: 'ZZZ0016', name: 'Aroha Ngata', dob: '1958-03-14', address: '12 Kauri St, Ponsonby, Auckland', phone: '021 555 0101' },
    prescriber: { cpn: '12ABCD', name: 'Dr Mere Tane', facilityHpi: 'F0A123-B', facilityName: 'Ponsonby Medical Centre' },
    items: [
      { itemRef: '1', medicineCode: 'MET500', directions: 'Take ONE tablet twice daily with food', quantity: 60, repeats: 2, periodDays: 30, doseUnits: 1, dosesPerDay: 2 },
      { itemRef: '2', medicineCode: 'ATO40', directions: 'Take ONE tablet at night', quantity: 30, repeats: 2, periodDays: 30, doseUnits: 1, dosesPerDay: 1 },
    ],
  },
  {
    body: 'B7C8D9E0F1G2H3J4K',
    patient: { nhi: 'ZZZ0024', name: 'James Wilson', dob: '1990-11-02', address: '4 Rimu Rd, Mt Eden, Auckland', phone: '022 555 0199' },
    prescriber: { cpn: '34EFGH', name: 'Dr Sam Patel', facilityHpi: 'F0B456-C', facilityName: 'Mt Eden Family Doctors' },
    items: [
      { itemRef: '1', medicineCode: 'AMX500', directions: 'Take ONE capsule three times daily until finished', quantity: 15, repeats: 0, periodDays: 5, doseUnits: 1, dosesPerDay: 3 },
    ],
  },
  {
    body: 'C1D2E3F4G5H6J7K8L',
    patient: { nhi: 'ZZZ0032', name: 'Grace Lee', dob: '1972-06-21', address: '88 Queen St, Auckland CBD', phone: '027 555 0142' },
    prescriber: { cpn: '56JKLM', name: 'Dr Hana Kim', facilityHpi: 'F0C789-D', facilityName: 'City Health Clinic' },
    items: [
      { itemRef: '1', medicineCode: 'OXY5', directions: 'Take ONE capsule every 6 hours when required for pain. Max 4 per day.', quantity: 20, repeats: 0, periodDays: 5, doseUnits: 1, dosesPerDay: 4 },
      { itemRef: '2', medicineCode: 'PAR500', directions: 'Take TWO tablets four times daily when required', quantity: 100, repeats: 0, periodDays: 12, doseUnits: 2, dosesPerDay: 4 },
    ],
  },
];

export function createMockNzeps() {
  const scripts = new Map();
  for (const s of SAMPLES) {
    const scid = makeScid(s.body);
    scripts.set(scid, {
      externalId: scid,
      source: 'nzeps',
      prescribedAt: new Date().toISOString().slice(0, 10),
      patient: s.patient,
      prescriber: s.prescriber,
      items: s.items.map((i) => ({ ...i, brokerStatus: 'Active', dispensed: 0 })),
    });
  }

  return {
    name: 'nzeps',
    list() {
      return [...scripts.values()].map((s) => ({
        scid: s.externalId,
        patient: s.patient.name,
        items: s.items.map((i) => `${i.medicineCode} (${i.brokerStatus})`),
      }));
    },
    async fetch(scid) {
      const s = scripts.get(scid);
      if (!s) throw new BrokerError('BUS002', 'Prescription not found on NZePS — dispense manually from the paper copy', 404);
      if (s.items.every((i) => i.brokerStatus === 'Dispensed')) {
        throw new BrokerError('DISPENSED', 'This prescription has already been fully dispensed', 409);
      }
      // Strip broker-internal fields before returning the canonical shape.
      return structuredClone({ ...s, items: s.items.map(({ brokerStatus, dispensed, ...rest }) => rest) });
    },
    async markDispensed(scid, { itemRef, remainingRepeats }) {
      const s = scripts.get(scid);
      const item = s?.items.find((i) => i.itemRef === String(itemRef));
      if (!item) return; // manual / non-broker scripts: nothing to update
      item.dispensed++;
      item.brokerStatus = remainingRepeats > 0 ? 'Repeats Remaining' : 'Dispensed';
    },
  };
}
