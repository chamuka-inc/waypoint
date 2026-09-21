import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { initialState } from '../src/demo.js';
import type { AppState, CreateWorkspaceInput, WorkspaceBootstrap, WorkspaceSummary } from '../src/types.js';
import { CareerService, dispatch as dispatchService } from './service.js';

interface CatalogEntry {
  id: string; name: string; relativeDirectory: string; createdAt: string; updatedAt: string; lastOpenedAt: string;
  archivedAt: string; deletedAt: string;
}
interface Catalog { version: 1; currentWorkspaceId: string; epoch: number; workspaces: CatalogEntry[] }

const now = () => new Date().toISOString();
const cleanName = (value: unknown) => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > 80) throw new Error('Workspace name must be between 1 and 80 characters.');
  return name;
};

export class PreviewWorkspaceManager {
  private catalog!: Catalog;
  private current!: CatalogEntry;
  currentService!: CareerService;
  private readonly catalogPath: string;
  constructor(readonly root: string, private readonly rootService: CareerService) { this.catalogPath = join(root, 'catalog.json'); }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await readFile(this.catalogPath, 'utf8')) as Catalog;
      if (value.version !== 1 || !Array.isArray(value.workspaces) || typeof value.currentWorkspaceId !== 'string') throw new Error();
      this.catalog = value;
      this.current = this.entry(value.currentWorkspaceId);
      if (this.current.relativeDirectory === '.') this.currentService = this.rootService;
      else { await this.rootService.shutdown(); this.currentService = await this.rootService.createSibling(this.directory(this.current)).init(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read the workspace catalog. Its existing file has been preserved.');
      const stamp = now();
      const entry: CatalogEntry = { id: randomUUID(), name: this.rootService.state.demo ? 'Sample workspace' : 'My workspace', relativeDirectory: '.', createdAt: stamp, updatedAt: stamp, lastOpenedAt: stamp, archivedAt: '', deletedAt: '' };
      this.catalog = { version: 1, currentWorkspaceId: entry.id, epoch: 1, workspaces: [entry] };
      this.current = entry; this.currentService = this.rootService;
      await this.persistCatalog();
    }
    return this;
  }

  private entry(id: string) {
    const item = this.catalog.workspaces.find(workspace => workspace.id === id);
    if (!item) throw new Error('Workspace not found.');
    return item;
  }
  private directory(entry: CatalogEntry) {
    if (entry.relativeDirectory === '.') return this.root;
    if (entry.relativeDirectory !== `workspaces/${entry.id}` || basename(entry.id) !== entry.id) throw new Error('Workspace path is invalid.');
    const directory = resolve(this.root, entry.relativeDirectory);
    if (!directory.startsWith(resolve(this.root) + '/')) throw new Error('Workspace path escapes the data directory.');
    return directory;
  }
  private async persistCatalog() {
    const temp = `${this.catalogPath}.tmp`;
    await writeFile(temp, JSON.stringify(this.catalog, null, 2), { mode: 0o600 });
    await rename(temp, this.catalogPath);
  }
  private ensureUnique(name: string, except = '') {
    if (this.catalog.workspaces.some(item => item.id !== except && item.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) throw new Error('A workspace with that name already exists.');
  }
  private summary(entry: CatalogEntry, state?: AppState, unavailable = false): WorkspaceSummary {
    return { id: entry.id, name: entry.name, current: entry.id === this.current.id, demo: Boolean(state?.demo), opportunityCount: state?.roles.length || 0, savedCount: state?.saved.length || 0, profileComplete: Boolean(state?.profile.name.trim() && state?.profile.background.trim()), researchRunning: entry.id === this.current.id && this.currentService.isResearchActive(), createdAt: entry.createdAt, updatedAt: entry.updatedAt, lastOpenedAt: entry.lastOpenedAt, archivedAt: entry.archivedAt || undefined, deletedAt: entry.deletedAt || undefined, unavailable };
  }
  private async summaries() {
    const result: WorkspaceSummary[] = [];
    for (const entry of [...this.catalog.workspaces].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))) {
      if (entry.id === this.current.id) { result.push(this.summary(entry, this.currentService.getState())); continue; }
      try {
        const loaded = JSON.parse(await readFile(join(this.directory(entry), 'state.json'), 'utf8')) as AppState;
        result.push(this.summary(entry, loaded));
      } catch { result.push(this.summary(entry, undefined, true)); }
    }
    return result;
  }
  async bootstrap(): Promise<WorkspaceBootstrap> {
    const workspaces = await this.summaries();
    return { workspace: workspaces.find(item => item.id === this.current.id)!, workspaces, state: this.currentService.getState(), epoch: this.catalog.epoch };
  }
  private assertIdle() { if (this.currentService.isResearchActive()) throw new Error('Stop research before creating or switching workspaces.'); }
  async create(input: CreateWorkspaceInput) {
    this.assertIdle(); const name = cleanName(input?.name); this.ensureUnique(name);
    if (!['blank', 'copy', 'import'].includes(input?.mode)) throw new Error('Choose how to start the workspace.');
    const id = randomUUID(); const stamp = now();
    const entry: CatalogEntry = { id, name, relativeDirectory: `workspaces/${id}`, createdAt: stamp, updatedAt: stamp, lastOpenedAt: stamp, archivedAt: '', deletedAt: '' };
    const service = await this.rootService.createSibling(this.directory(entry)).init();
    try {
      if (input.mode === 'blank') await service.importState(initialState(false));
      if (input.mode === 'copy') {
        const copied = initialState(false); const source = this.currentService.getState();
        copied.profile = structuredClone(source.profile); copied.profileRevision = 1;
        copied.settings.jevEnabled = source.settings.jevEnabled; copied.settings.jevModel = source.settings.jevModel;
        await service.importState(copied);
      }
      if (input.mode === 'import') {
        if (!input.state) throw new Error('Choose a valid Waypoint workspace export.');
        await service.importState(input.state);
      }
      this.catalog.workspaces.push(entry); this.catalog.currentWorkspaceId = id; this.catalog.epoch++;
      await this.persistCatalog();
    } catch (error) { await service.shutdown(); await rm(this.directory(entry), { recursive: true, force: true }); throw error; }
    const old = this.currentService; this.current = entry; this.currentService = service; await old.shutdown();
    return this.bootstrap();
  }
  async switch(id: string) {
    this.assertIdle(); if (id === this.current.id) return this.bootstrap();
    const entry = this.entry(id); if (entry.archivedAt || entry.deletedAt) throw new Error('Restore this workspace before opening it.');
    let service: CareerService;
    try { service = await this.rootService.createSibling(this.directory(entry)).init(); } catch { throw new Error('The workspace could not be opened; the current workspace is unchanged.'); }
    const old = this.currentService; const stamp = now(); entry.lastOpenedAt = stamp; entry.updatedAt = stamp;
    this.catalog.currentWorkspaceId = id; this.catalog.epoch++;
    try { await this.persistCatalog(); } catch (error) { await service.shutdown(); throw error; }
    this.current = entry; this.currentService = service; await old.shutdown(); return this.bootstrap();
  }
  async renameWorkspace(id: string, requested: string) {
    const name = cleanName(requested); this.ensureUnique(name, id); const entry = this.entry(id);
    entry.name = name; entry.updatedAt = now(); await this.persistCatalog(); return this.bootstrap();
  }
  async lifecycle(id: string, action: 'archive' | 'restore' | 'delete') {
    const entry = this.entry(id);
    if (action !== 'restore' && id === this.current.id) throw new Error(`Switch workspaces before ${action === 'archive' ? 'archiving' : 'deleting'} the current one.`);
    if (action === 'archive') entry.archivedAt = now();
    if (action === 'delete') { const active = this.catalog.workspaces.filter(item => !item.archivedAt && !item.deletedAt).length; if (!entry.archivedAt && active <= 1) throw new Error('Keep at least one active workspace.'); entry.deletedAt = now(); }
    if (action === 'restore') { entry.archivedAt = ''; entry.deletedAt = ''; }
    entry.updatedAt = now(); await this.persistCatalog(); return this.bootstrap();
  }
  async permanentlyDelete(id: string, confirmation: string) {
    const entry = this.entry(id); if (id === this.current.id) throw new Error('The current workspace cannot be deleted.');
    if (!entry.deletedAt || confirmation !== entry.name) throw new Error('Type the workspace name exactly to delete it permanently.');
    if (entry.relativeDirectory !== '.') await rm(this.directory(entry), { recursive: true, force: true });
    else { await rm(join(this.root, 'state.json'), { force: true }); await rm(join(this.root, 'state.tmp'), { force: true }); }
    this.catalog.workspaces = this.catalog.workspaces.filter(item => item.id !== id); await this.persistCatalog(); return this.bootstrap();
  }
  async exportWorkspace(id: string) {
    if (id === this.current.id) return this.currentService.getState();
    return JSON.parse(await readFile(join(this.directory(this.entry(id)), 'state.json'), 'utf8')) as AppState;
  }
  async dispatch(method: string, args: unknown[]) {
    if (method === 'bootstrap') return this.bootstrap();
    if (method === 'createWorkspace') return this.create(args[0] as CreateWorkspaceInput);
    if (method === 'switchWorkspace') return this.switch(String(args[0]));
    if (method === 'renameWorkspace') return this.renameWorkspace(String(args[0]), String(args[1]));
    if (method === 'archiveWorkspace') return this.lifecycle(String(args[0]), 'archive');
    if (method === 'restoreWorkspace') return this.lifecycle(String(args[0]), 'restore');
    if (method === 'deleteWorkspace') return this.lifecycle(String(args[0]), 'delete');
    if (method === 'deleteWorkspacePermanently') return this.permanentlyDelete(String(args[0]), String(args[1]));
    if (method === 'exportWorkspace') return this.exportWorkspace(String(args[0]));
    return dispatchService(this.currentService, method, args);
  }
  async shutdown() { await this.currentService.shutdown(); }
}
