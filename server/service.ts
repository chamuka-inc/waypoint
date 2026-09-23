import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialState } from '../src/demo.js';
import type { AppState, Profile, FeedbackKind, Application, ResearchResult, ResearchSourceActivity, ResearchSchedule, ApplicationDraft } from '../src/types.js';
import { parseProfile, parseWorkspaceState } from './schema.js';
import { runCodex, codexStatus } from './codex.js';
import { assessWithJev } from './jev.js';
import { runCodexDraft, validateDraftContent, fingerprint, type Drafter, type DraftInput } from './drafting.js';

export type Researcher = (state: AppState, signal: AbortSignal, event: (message: string, source?: ResearchSourceActivity) => void) => Promise<ResearchResult>;
export const MAX_OPPORTUNITIES = 50;
export function scheduleDue(schedule: ResearchSchedule, now = new Date()) {
  if (!schedule.enabled || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) return false;
  const [hour, minute] = schedule.time.split(':').map(Number);
  const slot = new Date(now); slot.setHours(hour, minute, 0, 0);
  if (slot > now) slot.setDate(slot.getDate() - 1);
  return !schedule.lastRunAt || Date.parse(schedule.lastRunAt) < slot.getTime();
}
export class CareerService {
  state: AppState = initialState();
  private queue = Promise.resolve();
  private active?: AbortController;
  private activeDraft?: AbortController;
  private sessionKey = '';
  constructor(readonly directory: string, readonly desktop = false, private researcher: Researcher = runCodex, private keyStore?: { read: () => string; write: (key: string) => void }, private drafter: Drafter = runCodexDraft) {}
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const loaded = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
      if (loaded.version !== 1 || !Array.isArray(loaded.roles) || !Array.isArray(loaded.runs)) throw new Error('Unsupported data format.');
      parseProfile(loaded.profile);
      this.state = loaded;
      this.state.drafts ||= [];
      for (const draft of this.state.drafts) if (draft.status === 'running') { draft.status = 'failed'; draft.error = 'The application closed before drafting finished.'; }
      const savedSchedule = loaded.settings?.researchSchedule;
      this.state.settings = { ...initialState(false).settings, ...loaded.settings, researchSchedule: { enabled: Boolean(savedSchedule?.enabled), time: typeof savedSchedule?.time === 'string' ? savedSchedule.time : '09:00', lastRunAt: typeof savedSchedule?.lastRunAt === 'string' ? savedSchedule.lastRunAt : '' } };
      for (const r of this.state.runs) if (r.status === 'running') { r.status = 'failed'; r.error = 'The application closed before research finished.'; r.finishedAt = new Date().toISOString(); }
      this.capOpportunities();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read your saved workspace. The existing file has been preserved. Restore a valid state.json backup to continue.');
    }
    await this.persist();
    return this;
  }
  private persist() {
    const data = JSON.stringify(this.state, null, 2);
    const operation = this.queue.then(async () => {
      const temp = join(this.directory, 'state.tmp');
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, join(this.directory, 'state.json'));
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  getState() { return structuredClone(this.state); }
  createSibling(directory: string) { return new CareerService(directory, this.desktop, this.researcher, this.keyStore, this.drafter); }
  isResearchActive() { return Boolean(this.active || this.activeDraft); }
  async importState(value: AppState) {
    if (this.active || this.activeDraft) throw new Error('Cancel active work before importing a workspace.');
    this.state = parseWorkspaceState(value);
    for (const run of this.state.runs) if (run.status === 'running') { run.status = 'failed'; run.error = 'The application closed before research finished.'; run.finishedAt = new Date().toISOString(); }
    this.capOpportunities();
    await this.persist(); return this.getState();
  }
  async saveProfile(value: Profile) {
    if (this.active || this.activeDraft) throw new Error('Finish or cancel the current work before changing your profile.');
    const profile = parseProfile(value);
    if (this.state.demo) {
      const settings = this.state.settings;
      this.state = initialState(false); this.state.settings = settings;
    }
    this.state.profile = profile;
    this.state.profileRevision++;
    await this.persist(); return this.getState();
  }
  async reset() {
    if (this.active || this.activeDraft) throw new Error('Cancel the active work before starting a new profile.');
    const settings = this.state.settings;
    this.state = initialState(false); this.state.settings = settings;
    await this.persist(); return this.getState();
  }
  private role(id: string) { const role = this.state.roles.find(r => r.id === id); if (!role) throw new Error('This opportunity is no longer available.'); return role; }
  private removeRoleData(ids: Set<string>) {
    this.state.roles = this.state.roles.filter(role => !ids.has(role.id));
    this.state.saved = this.state.saved.filter(id => !ids.has(id));
    this.state.applications = this.state.applications.filter(application => !ids.has(application.roleId));
    this.state.drafts = this.state.drafts.filter(draft => !ids.has(draft.roleId));
    this.state.feedback = this.state.feedback.filter(item => !ids.has(item.roleId));
  }
  private capOpportunities() {
    const time = (value: string) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };
    const ordered = [...this.state.roles].sort((a, b) => time(b.discoveredAt) - time(a.discoveredAt));
    const protectedIds = new Set(this.state.drafts.map(draft => draft.roleId));
    const removed = new Set<string>();
    for (let index = ordered.length - 1; index >= 0 && ordered.length - removed.size > MAX_OPPORTUNITIES; index--) if (!protectedIds.has(ordered[index].id)) removed.add(ordered[index].id);
    this.state.roles = ordered;
    this.removeRoleData(removed);
  }
  async removeRoles(ids: string[]) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_OPPORTUNITIES || ids.some(id => typeof id !== 'string')) throw new Error('Choose between 1 and 50 opportunities to remove.');
    if (this.activeDraft) throw new Error('Cancel draft generation before removing opportunities.');
    this.removeRoleData(new Set(ids));
    await this.persist(); return this.getState();
  }
  async toggleSave(id: string) {
    this.role(id);
    this.state.saved = this.state.saved.includes(id) ? this.state.saved.filter(x => x !== id) : [...this.state.saved, id];
    await this.persist(); return this.getState();
  }
  async feedback(id: string, kind: FeedbackKind) {
    if (!['more', 'too-technical', 'too-junior', 'salary-low', 'no-industry', 'not-interested'].includes(kind)) throw new Error('Unknown feedback type.');
    const role = this.role(id);
    this.state.feedback = this.state.feedback.filter(x => !(x.roleId === id && x.kind === kind));
    this.state.feedback.push({ id: randomUUID(), roleId: id, kind, company: role.company, title: role.title, industry: role.industry, skills: role.skills, createdAt: new Date().toISOString() });
    await this.persist(); return this.getState();
  }
  async undoFeedback(id: string) { this.state.feedback = this.state.feedback.filter(f => f.id !== id); await this.persist(); return this.getState(); }
  async setApplication(id: string, stage: Application['stage'], notes: string) {
    this.role(id);
    if (!['Saved', 'Preparing', 'Applied', 'Interview', 'Offer'].includes(stage) || typeof notes !== 'string' || notes.length > 20000) throw new Error('Invalid application details.');
    const item = { roleId: id, stage, notes, updatedAt: new Date().toISOString() };
    const index = this.state.applications.findIndex(x => x.roleId === id);
    if (index < 0) this.state.applications.push(item); else this.state.applications[index] = item;
    if (!this.state.saved.includes(id)) this.state.saved.push(id);
    await this.persist(); return this.getState();
  }
  async startDraft(id: string, focus: string, description: string) {
    if (this.activeDraft || this.active) throw new Error('Finish the current Codex work before creating a draft.');
    if (this.state.demo) throw new Error('Create your profile and research a real opportunity first.');
    if (typeof focus !== 'string' || typeof description !== 'string' || focus.length > 4000 || description.length > 30000) throw new Error('Drafting instructions are too long.');
    const role = this.role(id);
    if (role.demo || this.state.profile.background.trim().length < 80) throw new Error('Add your career history and choose a real opportunity before drafting.');
    if (!role.sources.length && description.trim().length < 80) throw new Error('Add the vacancy description before drafting.');
    const input: DraftInput = { profile: structuredClone(this.state.profile), role: structuredClone(role), notes: this.state.applications.find(item => item.roleId === id)?.notes || '', focus: focus.trim(), description: description.trim() };
    const previous = this.getState();
    const controller = new AbortController(); this.activeDraft = controller;
    const now = new Date().toISOString();
    let draft = this.state.drafts.find(item => item.roleId === id);
    if (!draft) {
      draft = { roleId: id, company: role.company, title: role.title, sourceUrl: role.sources[0]?.url || '', sourceCheckedAt: role.sources[0]?.checkedAt || '', profileRevision: this.state.profileRevision, roleFingerprint: fingerprint(role), revision: 1, status: 'running', error: '', generated: { application: '', resume: '', evidence: [], questions: [] }, edited: { application: '', resume: '', evidence: [], questions: [] }, applicationReviewed: false, resumeReviewed: false, createdAt: now, updatedAt: now };
      this.state.drafts.push(draft);
    }
    draft.status = 'running'; draft.error = ''; delete draft.pending; draft.updatedAt = now; draft.profileRevision = this.state.profileRevision; draft.roleFingerprint = fingerprint(role); draft.sourceCheckedAt = role.sources[0]?.checkedAt || '';
    if (!this.state.saved.includes(id)) this.state.saved.push(id);
    if (!this.state.applications.some(item => item.roleId === id)) this.state.applications.push({ roleId: id, stage: 'Preparing', notes: '', updatedAt: now });
    try { await this.persist(); } catch (error) { this.activeDraft = undefined; this.state = previous; throw error; }
    void this.executeDraft(id, input, controller).catch(() => {
      const failed = this.state.drafts.find(item => item.roleId === id);
      if (failed) { failed.status = 'failed'; failed.error = 'Draft generation finished but could not be saved. Check available disk space.'; }
      this.activeDraft = undefined;
    });
    return this.getState();
  }
  private async executeDraft(id: string, input: DraftInput, controller: AbortController) {
    let content: ApplicationDraft['generated'] | undefined, error = '';
    try { content = validateDraftContent(await this.drafter(input, controller.signal), input); } catch (e) { error = (e as Error).message; }
    if (this.activeDraft !== controller) return;
    this.activeDraft = undefined;
    const draft = this.state.drafts.find(item => item.roleId === id);
    if (!draft) return;
    if (controller.signal.aborted) { draft.status = 'cancelled'; draft.error = 'Draft generation cancelled.'; }
    else if (error || !content) { draft.status = 'failed'; draft.error = error || 'Could not create drafts.'; }
    else if (draft.edited.application || draft.edited.resume) { draft.pending = content; draft.status = 'ready'; }
    else { draft.generated = content; draft.edited = structuredClone(content); draft.status = 'ready'; draft.applicationReviewed = false; draft.resumeReviewed = false; }
    draft.updatedAt = new Date().toISOString(); draft.revision++;
    await this.persist();
  }
  async cancelDraft() {
    this.activeDraft?.abort(); this.activeDraft = undefined;
    for (const draft of this.state.drafts) if (draft.status === 'running') { draft.status = 'cancelled'; draft.error = 'Draft generation cancelled.'; draft.updatedAt = new Date().toISOString(); }
    await this.persist(); return this.getState();
  }
  async saveDraft(input: { id: string; revision: number; application: string; resume: string }) {
    if (typeof input?.application !== 'string' || typeof input.resume !== 'string' || input.application.length > 30000 || input.resume.length > 50000) throw new Error('Draft text is too long.');
    const draft = this.state.drafts.find(item => item.roleId === input.id);
    if (!draft) throw new Error('This draft is not ready.');
    if (draft.revision !== input.revision) throw new Error('This draft changed in another view. Reload it before saving.');
    if (draft.edited.application !== input.application) draft.applicationReviewed = false;
    if (draft.edited.resume !== input.resume) draft.resumeReviewed = false;
    draft.edited.application = input.application; draft.edited.resume = input.resume; draft.revision++; draft.updatedAt = new Date().toISOString();
    await this.persist(); return this.getState();
  }
  async reviewDraft(id: string, revision: number, kind: 'application' | 'resume') {
    const draft = this.state.drafts.find(item => item.roleId === id);
    if (!draft || draft.revision !== revision) throw new Error('Reload the current draft before reviewing.');
    if (kind === 'application' && draft.edited.application.trim()) draft.applicationReviewed = true;
    else if (kind === 'resume' && draft.edited.resume.trim()) draft.resumeReviewed = true;
    else throw new Error('Choose a complete artifact to review.');
    draft.revision++; draft.updatedAt = new Date().toISOString(); await this.persist(); return this.getState();
  }
  async acceptDraft(id: string, revision: number) {
    const draft = this.state.drafts.find(item => item.roleId === id);
    if (!draft || draft.revision !== revision || !draft.pending) throw new Error('No current regenerated draft is available.');
    draft.generated = draft.pending; draft.edited = structuredClone(draft.pending); delete draft.pending;
    draft.applicationReviewed = false; draft.resumeReviewed = false; draft.revision++; draft.updatedAt = new Date().toISOString();
    await this.persist(); return this.getState();
  }
  async settings(settings: AppState['settings'], key?: string) {
    if (this.active || this.activeDraft) throw new Error('Finish Codex work before changing AI settings.');
    if (typeof settings?.jevEnabled !== 'boolean' || typeof settings.jevModel !== 'string' || !/^jev-[a-zA-Z0-9._-]{1,80}$/.test(settings.jevModel)) throw new Error('Enter a valid Jev model identifier.');
    if (key !== undefined) {
      if (typeof key !== 'string' || key.length > 2000) throw new Error('Invalid API key.');
      if (this.keyStore) this.keyStore.write(key.trim()); else this.sessionKey = key.trim();
    }
    if (settings.jevEnabled && !this.getKey()) throw new Error('Add a TypeSafe API key before enabling Jev.');
    this.state.settings = { ...structuredClone(settings), researchSchedule: this.state.settings.researchSchedule }; await this.persist(); return this.getState();
  }
  async schedule(schedule: Omit<ResearchSchedule, 'lastRunAt'>) {
    if (typeof schedule?.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error('Choose a valid research schedule.');
    if (schedule.enabled && this.state.demo) throw new Error('Create your profile before enabling scheduled research.');
    const enabling = schedule.enabled && !this.state.settings.researchSchedule.enabled;
    this.state.settings.researchSchedule = { ...schedule, lastRunAt: enabling ? new Date().toISOString() : this.state.settings.researchSchedule.lastRunAt };
    await this.persist(); return this.getState();
  }
  async startScheduledResearch(now = new Date()) {
    if (!scheduleDue(this.state.settings.researchSchedule, now) || this.active || this.activeDraft) return false;
    await this.startResearch();
    this.state.settings.researchSchedule.lastRunAt = now.toISOString();
    await this.persist(); return true;
  }
  private getKey() { return this.keyStore?.read() || this.sessionKey || process.env.TYPESAFE_API_KEY || ''; }
  async status() { return { ...await codexStatus(), desktop: this.desktop, jevConfigured: Boolean(this.getKey()), storage: this.desktop ? 'Device workspace' : 'Local preview workspace' }; }
  async startResearch() {
    if (this.active || this.activeDraft) throw new Error('Codex is already running in this workspace.');
    if (this.state.demo) throw new Error('Create your own profile before starting live research.');
    const p = this.state.profile;
    if (p.background.trim().length < 80 || !p.ambitions.trim() || !p.locations.trim() || !p.workAuthorization.trim()) throw new Error('Add your career history (at least 80 characters), ambitions, preferred locations, and work-authorisation details first.');
    const controller = new AbortController(); this.active = controller;
    const snapshot = this.getState();
    const run = { id: randomUUID(), startedAt: new Date().toISOString(), status: 'running' as const, events: ['Preparing your profile and research brief.'], sources: [] as ResearchSourceActivity[], count: 0 };
    this.state.runs.unshift(run); this.state.runs = this.state.runs.slice(0, 30);
    try { await this.persist(); } catch (error) { this.active = undefined; this.state.runs.shift(); throw error; }
    void this.execute(snapshot, controller, run.id).catch(() => {
      const failed = this.state.runs.find(r => r.id === run.id);
      if (failed) { failed.status = 'failed'; failed.error = 'Research finished but the workspace could not be saved. Check available disk space.'; }
      this.active = undefined;
    });
    return this.getState();
  }
  private async execute(snapshot: AppState, controller: AbortController, id: string) {
    const run = this.state.runs.find(x => x.id === id)!;
    const event = (message: string, source?: ResearchSourceActivity) => {
      if (message && run.events.at(-1) !== message) run.events.push(message);
      run.events = run.events.slice(-60);
      if (!source) return;
      run.sources ||= [];
      const existing = run.sources.find(item => item.url === source.url);
      if (existing) {
        const rank = { found: 0, reviewing: 1, reviewed: 2 };
        if (rank[source.status] >= rank[existing.status]) existing.status = source.status;
        if (source.title && source.title !== new URL(source.url).hostname.replace(/^www\./, '')) existing.title = source.title;
      } else run.sources.push(source);
      run.sources = run.sources.slice(-40);
    };
    try {
      const result = await this.researcher(snapshot, controller.signal, event);
      if (controller.signal.aborted) throw new Error('Research cancelled.');
      if (snapshot.settings.jevEnabled) {
        event(`Assessing ${result.roles.length} opportunities with Jev.`);
        let failures = 0;
        // Bounded batches avoid launching unbounded paid calls.
        for (let i = 0; i < result.roles.length; i += 3) {
          if (controller.signal.aborted) throw new Error('Research cancelled.');
          await Promise.all(result.roles.slice(i, i + 3).map(async role => {
            try { role.jev = await assessWithJev(role, snapshot.profile, snapshot.feedback, this.getKey(), snapshot.settings.jevModel, controller.signal); }
            catch { failures++; }
          }));
        }
        if (failures) event(`Jev was unavailable for ${failures} roles. Their Codex assessments are retained and labelled without Jev.`);
      }
      if (controller.signal.aborted) throw new Error('Research cancelled.');
      const ids = new Set(result.roles.map(r => r.id));
      const retained = this.state.roles.filter(r => !ids.has(r.id) && (this.state.saved.includes(r.id) || this.state.applications.some(a => a.roleId === r.id))).map(r => ({ ...r, status: 'uncertain' as const }));
      this.state.roles = [...result.roles, ...retained];
      this.capOpportunities();
      this.state.families = result.families; this.state.questions = result.questions; this.state.summary = result.summary;
      this.state.researchRevision = snapshot.profileRevision;
      run.status = 'completed'; run.count = result.roles.filter(role => this.state.roles.some(kept => kept.id === role.id)).length;
      event(`${run.count} sourced opportunities added. ${run.count < result.roles.length ? 'The 50-opportunity limit kept saved drafts; some new roles were omitted. ' : ''}${retained.length ? 'Older saved roles remain marked for rechecking.' : ''}`.trim());
    } catch (e) {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed'; run.error = (e as Error).message;
      event(run.error);
    } finally {
      run.finishedAt = new Date().toISOString(); this.active = undefined;
      await this.persist();
    }
  }
  async cancelResearch() {
    this.active?.abort();
    const run = this.state.runs.find(x => x.status === 'running');
    if (run) { run.status = 'cancelled'; run.finishedAt = new Date().toISOString(); run.events.push('Cancellation requested.'); }
    await this.persist(); return this.getState();
  }
  async shutdown() { this.active?.abort(); this.activeDraft?.abort(); await this.queue; }
  async importCV(name: string, encoded: string) {
    if (typeof name !== 'string' || typeof encoded !== 'string' || encoded.length > 11_200_000) throw new Error('Choose a CV smaller than 8 MB.');
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.length > 8 * 1024 * 1024) throw new Error('Choose a CV smaller than 8 MB.');
    const extension = extname(name).toLowerCase();
    let text = '';
    if (extension === '.pdf') {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const loadingTask = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
      const document = await loadingTask.promise;
      try {
        if (document.numPages > 40) throw new Error('CVs are limited to 40 pages.');
        for (let i = 1; i <= document.numPages; i++) {
          const page = await document.getPage(i); const content = await page.getTextContent();
          text += content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('') + '\n';
        }
      } finally { await loadingTask.destroy(); }
    } else if (extension === '.docx') {
      const mammoth = await import('mammoth'); text = (await mammoth.extractRawText({ buffer })).value;
    } else if (['.txt', '.md'].includes(extension)) text = buffer.toString('utf8');
    else throw new Error('Use PDF, DOCX, TXT, or Markdown.');
    if (text.trim().length < 30) throw new Error('No usable text was found. For a scanned PDF, paste an OCR text version of your CV.');
    if (text.length > 60000) throw new Error('The extracted CV is too long. Use a shorter document.');
    return text.trim();
  }
}

export const actions = ['getState', 'saveProfile', 'reset', 'toggleSave', 'removeRoles', 'feedback', 'undoFeedback', 'setApplication', 'startDraft', 'cancelDraft', 'saveDraft', 'reviewDraft', 'acceptDraft', 'startResearch', 'cancelResearch', 'status', 'settings', 'schedule', 'importCV'] as const;
export async function dispatch(service: CareerService, method: string, args: unknown[]) {
  if (!(actions as readonly string[]).includes(method) || !Array.isArray(args) || args.length > 3) throw new Error('Unknown action.');
  const fn = service[method as typeof actions[number]] as (...args: unknown[]) => unknown;
  return fn.apply(service, args);
}
