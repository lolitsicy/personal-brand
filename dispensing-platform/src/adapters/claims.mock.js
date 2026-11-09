// Stand-in for the Health NZ pharmacy claiming gateway. Rejects claims that a
// real payer would reject for obvious data reasons, accepts the rest.

let batchSeq = 0;

export function createMockClaims() {
  return {
    name: 'claims-mock',
    async submit(claims) {
      const batchRef = `BATCH-${new Date().toISOString().slice(0, 10)}-${String(++batchSeq).padStart(4, '0')}`;
      const results = claims.map((c) => {
        if (!c.patient_nhi) return { claimId: c.id, accepted: false, reason: 'Missing NHI' };
        if (!c.prescriber_cpn) return { claimId: c.id, accepted: false, reason: 'Missing prescriber CPN' };
        return { claimId: c.id, accepted: true, reason: null };
      });
      return { batchRef, results };
    },
  };
}
