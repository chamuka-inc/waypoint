import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CareerService } from '../server/service.js';
import { PreviewWorkspaceManager } from '../server/workspace-manager.js';

test('preview workspace catalog persists isolated state and lifecycle changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waypoint-workspaces-'));
  let manager: PreviewWorkspaceManager | undefined;
  try {
    manager = await new PreviewWorkspaceManager(directory, await new CareerService(directory).init()).init();
    const original = await manager.bootstrap();
    const profile = structuredClone(original.state.profile); profile.name = 'Root Candidate';
    await manager.dispatch('saveProfile', [profile]);
    const copied = await manager.create({ name: 'Second search', mode: 'copy' });
    assert.equal(copied.state.profile.name, 'Root Candidate');
    assert.equal(copied.state.roles.length, 0);
    const secondProfile = structuredClone(copied.state.profile); secondProfile.name = 'Second Candidate';
    await manager.dispatch('saveProfile', [secondProfile]);
    const switched = await manager.switch(original.workspace.id);
    assert.equal(switched.state.profile.name, 'Root Candidate');
    assert.ok(switched.epoch > copied.epoch);
    await manager.shutdown(); manager = undefined;

    manager = await new PreviewWorkspaceManager(directory, await new CareerService(directory).init()).init();
    assert.equal((await manager.bootstrap()).workspace.id, original.workspace.id);
    assert.equal((await manager.switch(copied.workspace.id)).state.profile.name, 'Second Candidate');
    await manager.switch(original.workspace.id);
    await manager.renameWorkspace(copied.workspace.id, 'Archived search');
    await manager.lifecycle(copied.workspace.id, 'archive');
    await assert.rejects(manager.switch(copied.workspace.id), /restore/i);
    await manager.lifecycle(copied.workspace.id, 'restore');
    await manager.lifecycle(copied.workspace.id, 'archive');
    await manager.lifecycle(copied.workspace.id, 'delete');
    await assert.rejects(manager.permanentlyDelete(copied.workspace.id, 'wrong'), /exactly/i);
    const copiedDirectory = join(directory, 'workspaces', copied.workspace.id);
    const unexpected = join(copiedDirectory, 'unexpected.txt');
    await writeFile(unexpected, 'preserve me');
    await assert.rejects(manager.permanentlyDelete(copied.workspace.id, 'Archived search'), /unexpected files/i);
    assert.ok((await readFile(join(copiedDirectory, 'state.json'), 'utf8')).includes('Second Candidate'));
    await rm(unexpected);
    const final = await manager.permanentlyDelete(copied.workspace.id, 'Archived search');
    assert.equal(final.workspaces.length, 1);
    const importedState = structuredClone(final.state); importedState.profile.name = 'Imported Candidate';
    const imported = await manager.create({ name: 'Imported backup', mode: 'import', state: importedState });
    assert.equal(imported.state.profile.name, 'Imported Candidate');
  } finally {
    await manager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('preview manager rejects duplicate names and switching while research is active', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'waypoint-workspaces-'));
  let manager: PreviewWorkspaceManager | undefined;
  try {
    const researcher = async (_state: unknown, signal: AbortSignal) => await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    manager = await new PreviewWorkspaceManager(directory, await new CareerService(directory, false, researcher).init()).init();
    const root = await manager.bootstrap();
    await assert.rejects(manager.create({ name: root.workspace.name.toUpperCase(), mode: 'blank' }), /already exists/i);
    const created = await manager.create({ name: 'Another', mode: 'blank' });
    manager.currentService.state.profile = { ...manager.currentService.state.profile, background: 'x'.repeat(100), ambitions: 'Grow', locations: 'London', workAuthorization: 'UK' };
    await manager.currentService.startResearch();
    await assert.rejects(manager.switch(root.workspace.id), /stop research/i);
    await manager.currentService.cancelResearch();
    for (let attempt = 0; attempt < 50 && manager.currentService.isResearchActive(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await manager.switch(root.workspace.id)).workspace.id, root.workspace.id);
    assert.notEqual(created.workspace.id, root.workspace.id);
  } finally {
    await manager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
