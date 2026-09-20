export type Fit = 'direct' | 'adjacent' | 'stretch';
export type WorkMode = 'Remote' | 'Hybrid' | 'On-site' | 'Unknown';
export type FeedbackKind = 'more' | 'too-technical' | 'too-junior' | 'salary-low' | 'no-industry' | 'not-interested';
export interface Profile {
  name: string; headline: string; location: string; background: string; skills: string[];
  projects: string; qualifications: string; ambitions: string; workAuthorization: string;
  salaryMin: number; currency: string; workModes: WorkMode[]; locations: string;
  industries: string; excludedIndustries: string; seniority: string; commute: string;
  priorities: { compensation: number; flexibility: number; growth: number; fit: number };
}
export interface Evidence {
  requirement: string; importance: 'essential' | 'desirable'; assessment: 'supported' | 'gap' | 'unknown';
  candidateEvidence: string; explanation: string;
}
export interface Source { url: string; title: string; excerpt: string; checkedAt: string }
export interface Opportunity {
  id: string; company: string; title: string; industry: string; location: string; workMode: WorkMode;
  salaryMin: number | null; salaryMax: number | null; currency: string; salaryPeriod: 'year' | 'month' | 'hour' | 'unknown';
  seniority: string; fit: Fit; summary: string; responsibilities: string[]; evidence: Evidence[];
  gaps: string[]; nonBlockers: string[]; questions: string[]; strategy: string[]; interview: string[];
  skills: string[]; scores: { fit: number; growth: number; flexibility: number; compensation: number };
  sources: Source[]; status: 'open' | 'uncertain' | 'closed'; workAuthorization: string;
  demo: boolean; discoveredAt: string;
  jev?: { fit: Fit | 'uncertain'; confidence: number; supported: number; growth: number; review: boolean };
}
export interface RoleFamily { title: string; fit: Fit; why: string; skills: string[]; gaps: string[]; searchTerms: string[] }
export interface Feedback { id: string; roleId: string; kind: FeedbackKind; company: string; title: string; industry: string; skills: string[]; createdAt: string }
export interface Application { roleId: string; stage: 'Saved' | 'Preparing' | 'Applied' | 'Interview' | 'Offer'; notes: string; updatedAt: string }
export interface ResearchResult { summary: string; roles: Opportunity[]; families: RoleFamily[]; questions: string[] }
export interface ResearchSourceActivity { url: string; title: string; status: 'found' | 'reviewing' | 'reviewed'; seenAt: string }
export interface ResearchRun { id: string; startedAt: string; finishedAt?: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; events: string[]; sources?: ResearchSourceActivity[]; count: number; error?: string }
export interface AppState {
  version: 1; demo: boolean; profile: Profile; roles: Opportunity[]; families: RoleFamily[];
  saved: string[]; applications: Application[]; feedback: Feedback[]; runs: ResearchRun[];
  summary: string; questions: string[]; profileRevision: number; researchRevision: number;
  settings: { jevEnabled: boolean; jevModel: string };
}
export interface RuntimeStatus { desktop: boolean; codex: boolean; codexVersion: string; jevConfigured: boolean; storage: string }
export interface API {
  getState(): Promise<AppState>;
  saveProfile(profile: Profile): Promise<AppState>;
  reset(): Promise<AppState>;
  toggleSave(id: string): Promise<AppState>;
  removeRoles(ids: string[]): Promise<AppState>;
  feedback(id: string, kind: FeedbackKind): Promise<AppState>;
  undoFeedback(id: string): Promise<AppState>;
  setApplication(id: string, stage: Application['stage'], notes: string): Promise<AppState>;
  startResearch(): Promise<AppState>;
  cancelResearch(): Promise<AppState>;
  status(): Promise<RuntimeStatus>;
  settings(settings: AppState['settings'], key?: string): Promise<AppState>;
  importCV(name: string, data: string): Promise<string>;
}
