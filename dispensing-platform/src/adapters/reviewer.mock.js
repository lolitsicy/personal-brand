// Offline stand-in for the AI clinical reviewer. Deterministic, so tests and
// demos run without an API key or network. Produces the same shape as the
// Claude reviewer.

const TEMPLATES = {
  en: (c) => `You have been given ${c.new_item.medicine} ${c.new_item.strength}. ${c.new_item.directions.replace(/\.?$/, '.')}`,
};

export function createMockReviewer() {
  return {
    name: 'mock-reviewer',
    async review(c) {
      const findings = [];
      if ((c.new_item.doses_per_day ?? 0) >= 3) {
        findings.push({
          specialist: 'advocacy',
          severity: 'moderate',
          code: 'ADHERENCE',
          message: 'Dosing three or more times a day: check the patient can fit doses around their day',
          reasoning: 'Higher daily dose frequency is associated with lower adherence (demo reviewer).',
          sources: ['Mock reviewer'],
        });
      }
      const lang = c.preferred_language || 'en';
      const base = (TEMPLATES[lang] ?? TEMPLATES.en)(c);
      return {
        findings,
        counselling: {
          language: lang,
          text: lang === 'en' ? base : `[Translation to "${lang}" needs the AI reviewer enabled]\n${base}`,
        },
      };
    },
  };
}
