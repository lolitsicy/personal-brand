// AI clinical reviewer using Claude.
//
// Privacy: the case passed in is ALREADY de-identified (no name, NHI, address
// or exact date of birth; age band only). See deidentify() in the screening
// service. The AI only adds recommendations. It cannot clear, downgrade or
// override the deterministic rule findings, and a pharmacist signs off
// everything.
//
// Enabled only when AI_REVIEWER=claude is set. Credentials come from the
// standard Anthropic SDK resolution (ANTHROPIC_API_KEY or an `ant auth login`
// profile).

const MODEL = process.env.AI_REVIEWER_MODEL ?? 'claude-opus-5-5';

const SPECIALISTS = ['pharma', 'pharmacology', 'regulatory', 'advocacy'];

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'counselling'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['specialist', 'severity', 'code', 'message', 'reasoning', 'sources'],
        properties: {
          specialist: { type: 'string', enum: SPECIALISTS },
          severity: { type: 'string', enum: ['high', 'moderate', 'info'] },
          code: { type: 'string' },
          message: { type: 'string' },
          reasoning: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    counselling: {
      type: 'object',
      additionalProperties: false,
      required: ['language', 'text'],
      properties: { language: { type: 'string' }, text: { type: 'string' } },
    },
  },
};

const SYSTEM = `You are a clinical decision-support reviewer working for a registered pharmacist in a New Zealand community pharmacy.

You receive a de-identified case: the new prescription item, the patient's whole current medication list, relevant clinical values, and the findings a deterministic rules engine has already raised.

Your job:
1. Review the whole medication list together with the new item, not just pairs. Look for clinically meaningful issues the rules engine did not raise: interactions (including CYP450 mechanisms), dosing that is inappropriate for the patient's age, renal or hepatic function, duplicated therapy, missing monitoring, and adherence or health-literacy concerns.
2. Do not repeat issues already in rule_findings. Do not contradict, downgrade or argue against them. They stand regardless of your view.
3. Report only findings you would defend to a pharmacist. If there is nothing material, return an empty findings list. Do not pad it.
4. Use severity "high" only when the pharmacist should act before supplying. Use "moderate" for things worth checking, and "info" for counselling points.
5. For each finding, give concise reasoning and name the type of source it rests on (for example "NZ Formulary interaction monograph", "product data sheet", "renal dosing guidance"). Do not invent citations, page numbers or URLs.
6. Write a short counselling script for the patient in the language named in preferred_language (use English for "en"). Use plain words at roughly a reading age of 12. Cover what the medicine is for, how to take it, the key side effects, and when to seek help. If you are not confident translating into that language, write it in English and say so in the first line.

The pharmacist makes every decision. Your output is a recommendation.`;

export function createClaudeReviewer() {
  let clientPromise;
  const getClient = () => (clientPromise ??= import('@anthropic-ai/sdk').then(({ default: Anthropic }) => ({ Anthropic, client: new Anthropic() })));

  return {
    name: `claude:${MODEL}`,
    async review(deidentifiedCase) {
      const { Anthropic, client } = await getClient();
      let response;
      try {
        response = await client.beta.messages.create({
          model: MODEL,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'high', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
          system: SYSTEM,
          messages: [{ role: 'user', content: JSON.stringify(deidentifiedCase, null, 2) }],
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new Error('AI reviewer: no valid Anthropic credentials');
        if (err instanceof Anthropic.RateLimitError) throw new Error('AI reviewer: rate limited, try again shortly');
        if (err instanceof Anthropic.APIError) throw new Error(`AI reviewer: API error ${err.status}`);
        throw err;
      }

      if (response.stop_reason === 'refusal') {
        return { findings: [], counselling: null, note: 'AI reviewer declined this case; rules-only screening applies' };
      }
      if (response.stop_reason === 'max_tokens') throw new Error('AI reviewer: response truncated');

      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const parsed = JSON.parse(text);
      return { findings: parsed.findings, counselling: parsed.counselling };
    },
  };
}
