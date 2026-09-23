import Ajv from 'ajv';
import type { AppState, Profile, ResearchResult } from '../src/types.js';

const str = { type: 'string', maxLength: 12000 };
const strings = { type: 'array', items: str, maxItems: 40 };
const en = (...values: string[]) => ({ type: 'string', enum: values });
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const num = { type: 'number', minimum: 0, maximum: 100 };
const nullableSalary = { type: ['number', 'null'], minimum: 0, maximum: 100000000 };
const evidence = obj({ requirement: str, importance: en('essential', 'desirable'), assessment: en('supported', 'gap', 'unknown'), candidateEvidence: str, explanation: str });
const source = obj({ url: { type: 'string', maxLength: 2048 }, title: str, excerpt: { type: 'string', maxLength: 1000 }, checkedAt: str });
const family = obj({ title: str, fit: en('direct', 'adjacent', 'stretch'), why: str, skills: strings, gaps: strings, searchTerms: strings });
const profileSchema = obj({
  name: str, headline: str, location: str, background: { type: 'string', maxLength: 60000 }, skills: strings,
  projects: str, qualifications: str, ambitions: str, workAuthorization: str,
  salaryMin: { type: 'number', minimum: 0, maximum: 100000000 }, currency: { type: 'string', pattern: '^[A-Z]{3}$' },
  workModes: { type: 'array', items: en('Remote', 'Hybrid', 'On-site', 'Unknown'), maxItems: 4, uniqueItems: true },
  locations: str, industries: str, excludedIndustries: str, seniority: str, commute: str,
  priorities: obj({ compensation: { type: 'number', minimum: 0, maximum: 5 }, flexibility: { type: 'number', minimum: 0, maximum: 5 }, growth: { type: 'number', minimum: 0, maximum: 5 }, fit: { type: 'number', minimum: 0, maximum: 5 } }),
});
const roleProperties = {
  id: str, company: str, title: str, industry: str, location: str,
  workMode: en('Remote', 'Hybrid', 'On-site', 'Unknown'), salaryMin: nullableSalary, salaryMax: nullableSalary,
  currency: { type: 'string', pattern: '^[A-Z]{3}$' }, salaryPeriod: en('year', 'month', 'hour', 'unknown'),
  seniority: str, fit: en('direct', 'adjacent', 'stretch'), summary: str, responsibilities: strings,
  evidence: { type: 'array', items: evidence, maxItems: 30 }, gaps: strings, nonBlockers: strings,
  questions: strings, strategy: strings, interview: strings, skills: strings,
  scores: obj({ fit: num, growth: num, flexibility: num, compensation: num }),
  status: en('open', 'uncertain', 'closed'), workAuthorization: str, discoveredAt: str,
};
const role = {
  type: 'object', additionalProperties: false, required: [...Object.keys(roleProperties), 'sources', 'demo'],
  properties: { ...roleProperties, sources: { type: 'array', items: source, maxItems: 8 }, demo: { type: 'boolean' }, jev: obj({ fit: en('direct', 'adjacent', 'stretch', 'uncertain'), confidence: { type: 'number', minimum: 0, maximum: 1 }, supported: { type: 'number', minimum: 0, maximum: 1 }, growth: { type: 'number', minimum: 0, maximum: 1 }, review: { type: 'boolean' } }) },
};
const researchRole = obj({ ...roleProperties, sources: { type: 'array', items: source, minItems: 1, maxItems: 8 }, demo: { type: 'boolean', const: false } });
export const researchSchema = obj({
  summary: str, questions: strings,
  families: { type: 'array', items: family, maxItems: 12 },
  roles: { type: 'array', maxItems: 20, items: researchRole },
});
const researchSource = obj({ url: { type: 'string', maxLength: 2048 }, title: str, status: en('found', 'reviewing', 'reviewed'), seenAt: str });
const runProperties = { id: str, startedAt: str, status: en('running', 'completed', 'failed', 'cancelled'), events: { type: 'array', items: str, maxItems: 60 }, count: { type: 'integer', minimum: 0 } };
const run = { type: 'object', additionalProperties: false, required: Object.keys(runProperties), properties: { ...runProperties, finishedAt: str, sources: { type: 'array', items: researchSource, maxItems: 60 }, error: str } };
const draftContent = obj({ application: { type: 'string', maxLength: 30000 }, resume: { type: 'string', maxLength: 50000 }, evidence: { type: 'array', maxItems: 60, items: obj({ claim: { type: 'string', maxLength: 1000 }, source: { type: 'string', maxLength: 1000 }, requirement: { type: 'string', maxLength: 1000 } }) }, questions: { type: 'array', maxItems: 30, items: str } });
const applicationDraft = { type: 'object', additionalProperties: false, required: ['roleId', 'company', 'title', 'sourceUrl', 'profileRevision', 'roleFingerprint', 'revision', 'status', 'error', 'generated', 'edited', 'applicationReviewed', 'resumeReviewed', 'createdAt', 'updatedAt'], properties: { roleId: str, company: str, title: str, sourceUrl: str, sourceCheckedAt: str, profileRevision: { type: 'integer', minimum: 0 }, roleFingerprint: str, revision: { type: 'integer', minimum: 1 }, status: en('running', 'ready', 'failed', 'cancelled'), error: str, generated: draftContent, edited: draftContent, pending: draftContent, applicationReviewed: { type: 'boolean' }, resumeReviewed: { type: 'boolean' }, createdAt: str, updatedAt: str } };
const workspaceStateSchema = obj({
  version: { type: 'integer', const: 1 }, demo: { type: 'boolean' }, profile: profileSchema,
  roles: { type: 'array', items: role, maxItems: 50 }, families: { type: 'array', items: family, maxItems: 12 },
  saved: { type: 'array', items: str, maxItems: 50, uniqueItems: true },
  applications: { type: 'array', items: obj({ roleId: str, stage: en('Saved', 'Preparing', 'Applied', 'Interview', 'Offer'), notes: { type: 'string', maxLength: 20000 }, updatedAt: str }), maxItems: 50 },
  drafts: { type: 'array', items: applicationDraft, maxItems: 50 },
  feedback: { type: 'array', items: obj({ id: str, roleId: str, kind: en('more', 'too-technical', 'too-junior', 'salary-low', 'no-industry', 'not-interested'), company: str, title: str, industry: str, skills: strings, createdAt: str }) },
  runs: { type: 'array', items: run, maxItems: 30 }, summary: str, questions: strings,
  profileRevision: { type: 'integer', minimum: 0 }, researchRevision: { type: 'integer', minimum: 0 },
  settings: obj({ jevEnabled: { type: 'boolean' }, jevModel: { type: 'string', pattern: '^jev-[a-zA-Z0-9._-]{1,80}$' }, researchSchedule: obj({ enabled: { type: 'boolean' }, time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, lastRunAt: str }) }),
});
workspaceStateSchema.required = workspaceStateSchema.required.filter(key => key !== 'drafts');
// Ajv's default CJS export is the constructor in Node's ESM interop.
const ajv = new (Ajv as unknown as { new(options?: unknown): import('ajv').default })({ allErrors: true });
const validateResult = ajv.compile(researchSchema);
const validateProfile = ajv.compile(profileSchema);
const validateWorkspaceState = ajv.compile(workspaceStateSchema);

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

export function parseWorkspaceState(input: unknown): AppState {
  if (!validateWorkspaceState(input)) throw new Error('The workspace backup is invalid or incompatible.');
  const state = structuredClone(input) as unknown as AppState;
  state.drafts ||= [];
  if (Object.values(state.profile.priorities).every(value => value === 0)) throw new Error('The workspace backup is invalid or incompatible.');
  const roleIds = new Set<string>();
  for (const role of state.roles) {
    if (!role.id || roleIds.has(role.id) || role.demo !== state.demo || (!role.demo && !role.sources.length) || (role.salaryMin !== null && role.salaryMax !== null && role.salaryMin > role.salaryMax)) throw new Error('The workspace backup is invalid or incompatible.');
    if (role.sources.some(item => !safeURL(item.url) || !item.excerpt.trim())) throw new Error('The workspace backup is invalid or incompatible.');
    roleIds.add(role.id);
  }
  if (state.saved.some(id => !roleIds.has(id))) throw new Error('The workspace backup is invalid or incompatible.');
  const applicationIds = new Set<string>();
  for (const item of state.applications) {
    if (!roleIds.has(item.roleId) || applicationIds.has(item.roleId)) throw new Error('The workspace backup is invalid or incompatible.');
    applicationIds.add(item.roleId);
  }
  const draftIds = new Set<string>();
  for (const item of state.drafts) {
    if (!roleIds.has(item.roleId) || draftIds.has(item.roleId) || (item.sourceUrl && !safeURL(item.sourceUrl))) throw new Error('The workspace backup is invalid or incompatible.');
    draftIds.add(item.roleId);
  }
  const feedbackIds = new Set<string>();
  for (const item of state.feedback) {
    if (!item.id || feedbackIds.has(item.id) || !roleIds.has(item.roleId)) throw new Error('The workspace backup is invalid or incompatible.');
    feedbackIds.add(item.id);
  }
  const runIds = new Set<string>();
  for (const item of state.runs) {
    if (!item.id || runIds.has(item.id) || item.sources?.some(sourceItem => !safeURL(sourceItem.url))) throw new Error('The workspace backup is invalid or incompatible.');
    runIds.add(item.id);
  }
  if (state.settings.researchSchedule.lastRunAt && !Number.isFinite(Date.parse(state.settings.researchSchedule.lastRunAt))) throw new Error('The workspace backup is invalid or incompatible.');
  return state;
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
