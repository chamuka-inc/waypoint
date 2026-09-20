import Ajv from 'ajv';
import type { Profile, ResearchResult } from '../src/types.js';

const str = { type: 'string', maxLength: 12000 };
const strings = { type: 'array', items: str, maxItems: 40 };
const en = (...values: string[]) => ({ type: 'string', enum: values });
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const num = { type: 'number', minimum: 0, maximum: 100 };
const nullableSalary = { type: ['number', 'null'], minimum: 0, maximum: 100000000 };
const evidence = obj({ requirement: str, importance: en('essential', 'desirable'), assessment: en('supported', 'gap', 'unknown'), candidateEvidence: str, explanation: str });
const source = obj({ url: { type: 'string', maxLength: 2048 }, title: str, excerpt: { type: 'string', maxLength: 1000 }, checkedAt: str });
const family = obj({ title: str, fit: en('direct', 'adjacent', 'stretch'), why: str, skills: strings, gaps: strings, searchTerms: strings });
export const researchSchema = obj({
  summary: str, questions: strings,
  families: { type: 'array', items: family, maxItems: 12 },
  roles: { type: 'array', maxItems: 20, items: obj({
    id: str, company: str, title: str, industry: str, location: str,
    workMode: en('Remote', 'Hybrid', 'On-site', 'Unknown'), salaryMin: nullableSalary, salaryMax: nullableSalary,
    currency: { type: 'string', pattern: '^[A-Z]{3}$' }, salaryPeriod: en('year', 'month', 'hour', 'unknown'),
    seniority: str, fit: en('direct', 'adjacent', 'stretch'), summary: str, responsibilities: strings,
    evidence: { type: 'array', items: evidence, maxItems: 30 }, gaps: strings, nonBlockers: strings,
    questions: strings, strategy: strings, interview: strings, skills: strings,
    scores: obj({ fit: num, growth: num, flexibility: num, compensation: num }),
    sources: { type: 'array', items: source, minItems: 1, maxItems: 8 },
    status: en('open', 'uncertain', 'closed'), workAuthorization: str,
    demo: { type: 'boolean', const: false }, discoveredAt: str,
  }) },
});
// Ajv's default CJS export is the constructor in Node's ESM interop.
const ajv = new (Ajv as unknown as { new(options?: unknown): import('ajv').default })({ allErrors: true });
const validateResult = ajv.compile(researchSchema);
const validateProfile = ajv.compile(obj({
  name: str, headline: str, location: str, background: { type: 'string', maxLength: 60000 }, skills: strings,
  projects: str, qualifications: str, ambitions: str, workAuthorization: str,
  salaryMin: { type: 'number', minimum: 0, maximum: 100000000 }, currency: { type: 'string', pattern: '^[A-Z]{3}$' },
  workModes: { type: 'array', items: en('Remote', 'Hybrid', 'On-site', 'Unknown'), maxItems: 4, uniqueItems: true },
  locations: str, industries: str, excludedIndustries: str, seniority: str, commute: str,
  priorities: obj({ compensation: { type: 'number', minimum: 0, maximum: 5 }, flexibility: { type: 'number', minimum: 0, maximum: 5 }, growth: { type: 'number', minimum: 0, maximum: 5 }, fit: { type: 'number', minimum: 0, maximum: 5 } }),
}));

export function parseProfile(input: unknown): Profile {
  if (!validateProfile(input)) throw new Error('Profile fields are missing or invalid. Check your salary, currency, and preferences.');
  const p = input as unknown as Profile;
  if (Object.values(p.priorities).every(x => x === 0)) throw new Error('Set at least one priority above zero.');
  return structuredClone(p);
}

export function safeURL(input: string): string | null {
  try {
    const u = new URL(input);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!u.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(u.hostname) || /\.(local|internal|invalid|test|example)$/.test(u.hostname)) return null;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) return null;
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) if (key.startsWith('utm_')) u.searchParams.delete(key);
    return u.href;
  } catch { return null; }
}

export function parseResearch(input: unknown, now = new Date().toISOString()): ResearchResult {
  if (!validateResult(input)) throw new Error('Codex returned an incomplete research report. No opportunities were imported.');
  const result = structuredClone(input) as unknown as ResearchResult;
  const seen = new Set<string>();
  result.roles = result.roles.filter(role => {
    role.sources = role.sources.filter(s => safeURL(s.url) && s.excerpt.trim()).map(s => ({ ...s, url: safeURL(s.url)!, checkedAt: now }));
    if (!role.sources.length || role.status === 'closed') return false;
    if (role.salaryMin !== null && role.salaryMax !== null && role.salaryMin > role.salaryMax) throw new Error('The research contains an inconsistent salary range. Please run it again.');
    const key = `${role.company.trim().toLowerCase()}|${role.title.trim().toLowerCase()}|${role.location.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    // Stable ids preserve saves and application notes across repeat runs.
    role.id = `role-${Buffer.from(key).toString('base64url')}`;
    role.demo = false;
    role.discoveredAt = now;
    return true;
  });
  return result;
}
