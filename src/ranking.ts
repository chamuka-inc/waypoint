import type { AppState, Opportunity, Profile } from './types.js';

export function priorityScore(role: Opportunity, profile: Profile, feedback: AppState['feedback'] = []): number {
  const entries = Object.entries(profile.priorities) as [keyof Profile['priorities'], number][];
  const weight = entries.reduce((n, [, value]) => n + value, 0) || 1;
  let score = entries.reduce((n, [key, value]) => n + role.scores[key] * value, 0) / weight;
  if (role.jev && !role.jev.review) score = score * 0.75 + role.jev.supported * 25;
  for (const item of feedback) {
    const sameRole = role.id === item.roleId;
    const related = role.skills.some(skill => item.skills.includes(skill));
    if (item.kind === 'more' && (sameRole || related)) score += sameRole ? 5 : 2;
    if (sameRole && item.kind !== 'more') score -= 25;
    if (item.kind === 'no-industry' && item.industry.toLowerCase() === role.industry.toLowerCase()) score -= 30;
    if (item.kind === 'too-junior' && role.seniority === 'Junior') score -= 15;
  }
  return Math.round(Math.min(100, Math.max(0, score)));
}

export function constraints(role: Opportunity, p: Profile): string[] {
  const flags: string[] = [];
  if (role.salaryMax === null) flags.push('Salary not disclosed');
  else if (role.currency !== p.currency || role.salaryPeriod !== 'year') flags.push('Salary needs comparison');
  else if (role.salaryMax < p.salaryMin) flags.push('Below salary floor');
  if (p.workModes.length && !p.workModes.includes(role.workMode)) flags.push('Work arrangement mismatch');
  const exclusions = p.excludedIndustries.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (exclusions.some(x => role.industry.toLowerCase().includes(x))) flags.push('Excluded industry');
  if (role.status !== 'open') flags.push(role.status === 'closed' ? 'Vacancy closed' : 'Availability uncertain');
  if (role.jev?.review) flags.push('Fit needs review');
  return flags;
}

export function salary(role: Opportunity): string {
  if (role.salaryMin === null && role.salaryMax === null) return 'Salary undisclosed';
  const format = (n: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: role.currency, maximumFractionDigits: 0, notation: n >= 10000 ? 'compact' : 'standard' }).format(n);
  const range = role.salaryMin === null ? `Up to ${format(role.salaryMax!)}` : role.salaryMax === null ? `From ${format(role.salaryMin)}` : `${format(role.salaryMin)}–${format(role.salaryMax)}`;
  return range + (role.salaryPeriod === 'year' ? ' / yr' : role.salaryPeriod === 'unknown' ? ' · period unknown' : ` / ${role.salaryPeriod}`);
}
