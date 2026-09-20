import type { AppState, Opportunity, Profile, Fit } from './types.js';

export const blankProfile: Profile = {
  name: '', headline: '', location: '', background: '', skills: [], projects: '', qualifications: '', ambitions: '',
  workAuthorization: '', salaryMin: 0, currency: 'GBP', workModes: ['Remote', 'Hybrid'], locations: '', industries: '',
  excludedIndustries: '', seniority: '', commute: '', priorities: { fit: 5, compensation: 3, flexibility: 4, growth: 4 },
};

export function initialState(demo = true): AppState {
  const profile: Profile = demo ? {
    ...structuredClone(blankProfile), name: 'Alex Morgan', headline: 'Product manager · 6 years of building useful things',
    location: 'London, UK', background: 'Senior Product Manager at a B2B SaaS startup (2022–present). Led a cross-functional team of 8. Launched a self-service onboarding flow that increased activation by 24%. Previously Product Analyst (2020–2022): built SQL dashboards, ran customer interviews, and supported roadmap prioritisation. Earlier Customer Success Associate (2018–2020): worked with enterprise clients and translated recurring customer pain into product requirements.',
    skills: ['Product strategy', 'SQL', 'User research', 'Experimentation', 'Stakeholder management', 'B2B SaaS'],
    projects: 'Led an onboarding redesign and a customer discovery programme. Built a community mentoring programme for aspiring product managers.',
    qualifications: 'BSc Business Management. Professional Scrum Product Owner I.', ambitions: 'Own a meaningful product area. Move closer to climate, education, or useful B2B tools. Keep doing customer discovery. Open to an adjacent role with a clear growth path.',
    workAuthorization: 'Right to work in the UK; no sponsorship required.', salaryMin: 80000, locations: 'London or UK remote',
    industries: 'Climate tech, B2B SaaS, Education', excludedIndustries: 'Consulting', seniority: 'Senior individual contributor or Lead', commute: 'Up to 45 minutes; maximum 2 office days per week',
  } : structuredClone(blankProfile);
  const specs: [string, string, string, Fit, number, number, Opportunity['workMode'], string, number][] = [
    ['Forma', 'Senior Product Manager', 'B2B SaaS', 'direct', 90000, 115000, 'Hybrid', 'London, UK', 94],
    ['Canopy', 'Product Lead, Climate Platform', 'Climate tech', 'adjacent', 85000, 110000, 'Remote', 'United Kingdom', 91],
    ['Orbit', 'Product Operations Lead', 'B2B SaaS', 'adjacent', 80000, 100000, 'Remote', 'United Kingdom', 87],
    ['Goodwork', 'Principal Product Manager', 'Education', 'stretch', 105000, 135000, 'Hybrid', 'London, UK', 83],
    ['Morrow', 'Senior Growth Product Manager', 'B2B SaaS', 'direct', 85000, 105000, 'Remote', 'United Kingdom', 88],
    ['Fieldnotes', 'Customer Insights Lead', 'Education', 'adjacent', 75000, 90000, 'Hybrid', 'London, UK', 82],
  ];
  const roles: Opportunity[] = demo ? specs.map(([company, title, industry, fit, min, max, workMode, location, score], i) => ({
    id: `sample-${i + 1}`, company, title, industry, location, workMode, salaryMin: min, salaryMax: max, currency: 'GBP', salaryPeriod: 'year', seniority: i === 3 ? 'Principal' : 'Senior', fit,
    summary: [
      'Own the core product experience for a growing B2B platform. Your mix of customer discovery, product strategy, and hands-on analytics makes this a natural next step.',
      'Bring your product craft to a new domain. This role values translating complex customer problems into clear product decisions; climate expertise is desirable, not essential.',
      'Turn the way a product team works into your product. Your cross-functional leadership and analytical background transfer well to product operations.',
      'A bigger scope, with room to grow. Your product outcomes are relevant, but this role asks for portfolio-level influence that your profile does not yet demonstrate.',
      'Build on your activation work to own a full growth surface. Your experience running experiments and using SQL gives you credible evidence to lead with.',
      'Move closer to the customer. Your discovery and customer success background are a strong foundation; research methodology depth needs investigation.',
    ][i],
    responsibilities: ['Set priorities with a cross-functional team and measure outcomes.', 'Speak directly with customers to understand unmet needs.', 'Translate research and product data into a focused roadmap.'],
    evidence: [
      { requirement: 'Lead cross-functional product delivery', importance: 'essential', assessment: 'supported', candidateEvidence: 'You led a team of 8 at a B2B SaaS startup.', explanation: 'Direct evidence of coordinating design, engineering, and business stakeholders.' },
      { requirement: 'Use data to improve customer outcomes', importance: 'essential', assessment: 'supported', candidateEvidence: 'Your onboarding launch improved activation by 24%; you built SQL dashboards.', explanation: 'Prepare the baseline, experiment design, and your specific contribution.' },
      { requirement: i === 1 ? 'Experience in climate technology' : 'Experience operating at broader organisational scale', importance: 'desirable', assessment: 'gap', candidateEvidence: 'This is not demonstrated in your sample profile.', explanation: 'Ask what depth is needed on day one. Do not claim experience you have not had.' },
    ],
    gaps: [i === 3 ? 'Portfolio-level product leadership is not yet evidenced.' : i === 1 ? 'Climate-domain knowledge would need to be developed.' : 'The size and complexity of the target team need investigation.'],
    nonBlockers: [i === 1 ? 'Climate experience is listed as desirable in this illustrative example.' : 'A different previous job title can be supported by relevant responsibilities and outcomes.'],
    questions: ['What would a successful first six months look like?', 'Which requirements are genuinely essential on day one?', 'How many office days are expected, and what does the salary range include?'],
    strategy: ['Lead with the onboarding redesign and the 24% activation improvement.', 'Explain how you combined customer interviews with SQL analysis to set priorities.', 'Prepare an honest example of the gap above and your plan to close it.'],
    interview: ['Tell the story of a difficult prioritisation decision, including what you said no to.', 'Prepare a STAR example of influencing a cross-functional team.', 'Walk through the activation experiment: hypothesis, baseline, measurement, and result.'],
    skills: i === 2 ? ['Stakeholder management', 'SQL', 'Product strategy'] : ['Product strategy', 'User research', 'B2B SaaS', 'Experimentation'],
    scores: { fit: score, compensation: i === 3 ? 98 : 90 - i * 2, flexibility: workMode === 'Remote' ? 98 : 80, growth: i === 1 ? 98 : 90 - i },
    sources: [], status: 'uncertain', workAuthorization: 'Sample only; employer requirements have not been verified.', demo: true, discoveredAt: '',
  })) : [];
  return {
    version: 1, demo, profile, roles,
    families: demo ? [
      { title: 'Senior Product Manager', fit: 'direct', why: 'Builds directly on your product ownership and measurable delivery outcomes.', skills: ['Product strategy', 'Experimentation'], gaps: ['Validate team scope'], searchTerms: ['Senior Product Manager', 'Lead Product Manager'] },
      { title: 'Product Operations Lead', fit: 'adjacent', why: 'Your analytical background and cross-functional experience could improve how whole product teams work.', skills: ['SQL', 'Stakeholder management'], gaps: ['Evidence of process design'], searchTerms: ['Product Operations Lead', 'Product Enablement'] },
      { title: 'Climate Product Lead', fit: 'adjacent', why: 'Transfers your product craft into an industry aligned with your ambitions.', skills: ['User research', 'Product strategy'], gaps: ['Climate-domain expertise'], searchTerms: ['Climate Product Manager', 'Sustainability Product Lead'] },
      { title: 'Principal Product Manager', fit: 'stretch', why: 'A credible longer-term direction if you can show influence beyond a single product team.', skills: ['Product strategy'], gaps: ['Portfolio-level leadership'], searchTerms: ['Principal Product Manager', 'Group Product Manager'] },
    ] : [],
    saved: [], applications: [], feedback: [], runs: [],
    summary: demo ? 'Your product craft travels further than your job title. Product operations and climate technology look like promising directions to explore.' : '',
    questions: demo ? ['Would you trade some salary for a role in climate technology?', 'Would you like to manage people, or stay close to the product?'] : [],
    profileRevision: 0, researchRevision: 0, settings: { jevEnabled: false, jevModel: 'jev-latest', researchSchedule: { enabled: false, time: '09:00', lastRunAt: '' } },
  };
}
