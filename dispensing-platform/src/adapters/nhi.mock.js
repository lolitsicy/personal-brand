// Stand-in for the NHI (National Health Index) lookup. Test NHIs starting
// with "ZZZ" are reserved for testing in NZ, so they are safe to use here.

const PEOPLE = {
  ZZZ0016: { nhi: 'ZZZ0016', name: 'Aroha Ngata', dob: '1958-03-14', address: '12 Kauri St, Ponsonby, Auckland' },
  ZZZ0024: { nhi: 'ZZZ0024', name: 'James Wilson', dob: '1990-11-02', address: '4 Rimu Rd, Mt Eden, Auckland' },
  ZZZ0032: { nhi: 'ZZZ0032', name: 'Grace Lee', dob: '1972-06-21', address: '88 Queen St, Auckland CBD' },
};

export function createMockNhi() {
  return {
    name: 'nhi-mock',
    async lookupPatient(nhi) {
      return PEOPLE[String(nhi).toUpperCase()] ?? null;
    },
  };
}
