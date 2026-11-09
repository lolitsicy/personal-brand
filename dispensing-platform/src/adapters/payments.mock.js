// Stand-in for a card payments provider (e.g. a Stripe Terminal integration).
// Cash is recorded locally; card charges and refunds get a mock reference.

export function createMockPayments() {
  let seq = 0;
  return {
    name: 'payments-mock',
    async charge({ amountCents, method }) {
      if (!['card', 'cash'].includes(method)) throw Object.assign(new Error(`Unsupported payment method "${method}"`), { status: 400 });
      if (amountCents < 0) throw Object.assign(new Error('Amount must be positive'), { status: 400 });
      return { ref: method === 'cash' ? `CASH-${++seq}` : `pi_mock_${String(++seq).padStart(6, '0')}` };
    },
    async refund({ ref, amountCents }) {
      return { ref: `re_mock_${ref}_${amountCents}` };
    },
  };
}
