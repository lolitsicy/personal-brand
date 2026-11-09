// Stand-in for a courier / last-mile delivery provider.

export function createMockCourier() {
  let seq = 1000;
  return {
    name: 'courier-mock',
    async book(fulfilment) {
      if (!fulfilment.address) throw Object.assign(new Error('Delivery address required'), { status: 400 });
      return { provider: 'MockCourier', trackingRef: `MC${++seq}NZ` };
    },
  };
}
