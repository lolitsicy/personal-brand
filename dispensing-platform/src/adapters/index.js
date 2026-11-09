// Integration adapters. The platform core only ever talks to these
// interfaces, never to a specific government system or courier, which is
// what makes it "universal": a new script source, identity service, payer or
// delivery provider is a new adapter, not a change to the dispensing logic.
//
// Interfaces (all methods async):
//
//   ScriptSource   { name, fetch(id) -> CanonicalPrescription,
//                    markDispensed(id, { itemRef, sequence, remainingRepeats }) }
//   IdentityService{ lookupPatient(nhi) -> { nhi, name, dob, address } | null }
//   ClaimsGateway  { submit(claims[]) -> { batchRef, results: [{ claimId, accepted, reason }] } }
//   Courier        { book(fulfilment) -> { provider, trackingRef } }
//   Reviewer       { name, review(deidentifiedCase) -> { findings[], counselling } }
//   Payments       { charge({ amountCents, method }) -> { ref }, refund({ ref, amountCents }) -> { ref } }
//
// CanonicalPrescription:
//   { externalId, source, prescribedAt,
//     patient:    { nhi, name, dob, address, phone },
//     prescriber: { cpn, name, facilityHpi, facilityName },
//     items: [{ itemRef, medicineCode, directions, quantity, repeats, periodDays }] }

import { createMockNzeps } from './nzeps.mock.js';
import { createMockNhi } from './nhi.mock.js';
import { createMockClaims } from './claims.mock.js';
import { createMockCourier } from './courier.mock.js';
import { createMockReviewer } from './reviewer.mock.js';
import { createClaudeReviewer } from './reviewer.claude.js';
import { createMockPayments } from './payments.mock.js';

/** AI reviewer is opt-in: set AI_REVIEWER=claude to send de-identified cases to Claude. */
export function createReviewer(kind = process.env.AI_REVIEWER) {
  return kind === 'claude' ? createClaudeReviewer() : createMockReviewer();
}

export function createMockAdapters() {
  return {
    scriptSources: { nzeps: createMockNzeps() },
    identity: createMockNhi(),
    claims: createMockClaims(),
    couriers: { default: createMockCourier() },
    reviewer: createReviewer(),
    payments: createMockPayments(),
  };
}
