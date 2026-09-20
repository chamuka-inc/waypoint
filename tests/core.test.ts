import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { initialState } from '../src/demo.js';
import { constraints, priorityScore } from '../src/ranking.js';
import { parseResearch, parseProfile, safeURL } from '../server/schema.js';
import { jevRequest, assessWithJev } from '../server/jev.js';
import { CareerService, dispatch, MAX_OPPORTUNITIES, scheduleDue } from '../server/service.js';
import { runCodex, webSearchUpdates } from '../server/codex.js';
import { createPreview } from '../server/preview.js';
import type { ResearchResult } from '../src/types.js';

function result(): ResearchResult {
  const d = initialState();
  return { summary: 'Sourced research', families: d.families, questions: ['What scope do you prefer?'], roles: d.roles.slice(0, 1).map(r => ({ ...r, demo: false, status: 'open', sources: [{ url: 'https://careers.acme.com/jobs/123?utm_source=test', title: 'Product Manager', excerpt: 'Lead a cross-functional product team.', checkedAt: '' }] })) };
}
const settle = async (service: CareerService) => {
  for (let n = 0; n < 100; n++) { if (service.state.runs[0]?.status !== 'running') return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Run did not settle');
};

test('source validation rejects missing evidence, unsafe URLs, duplicates, closed roles and inverted salary', () => {
  assert.equal(safeURL('javascript:alert(1)'), null);
  assert.equal(safeURL('https://127.0.0.1/a'), null);
  assert.equal(safeURL('https://company.internal/jobs'), null);
  const r = result(); r.roles.push(structuredClone(r.roles[0]));
  assert.equal(parseResearch(r).roles.length, 1);
  assert.equal(parseResearch(r).roles[0].sources[0].url, 'https://careers.acme.com/jobs/123');
  r.roles[0].sources[0].excerpt = ''; r.roles[1].status = 'closed';
  assert.equal(parseResearch(r).roles.length, 0);
  const bad = result(); bad.roles[0].salaryMin = 500000;
  assert.throws(() => parseResearch(bad), /inconsistent salary/);
  assert.throws(() => parseResearch({ roles: [] }), /incomplete research/);
});

test('preferences reject invalid profiles and expose constraints without hiding unknowns', () => {
  const d = initialState();
  assert.throws(() => parseProfile({ ...d.profile, salaryMin: -1 }), /invalid/);
  assert.throws(() => parseProfile({ ...d.profile, priorities: { fit: 0, compensation: 0, flexibility: 0, growth: 0 } }), /above zero/);
  const r = { ...d.roles[0], salaryMax: 50000, industry: 'Consulting', workMode: 'On-site' as const };
  assert.ok(constraints(r, d.profile).includes('Below salary floor'));
  assert.ok(constraints(r, d.profile).includes('Excluded industry'));
  assert.ok(constraints(r, d.profile).includes('Work arrangement mismatch'));
  assert.ok(constraints({ ...r, currency: 'USD' }, d.profile).includes('Salary needs comparison'));
  assert.ok(!constraints({ ...r, currency: 'USD' }, d.profile).includes('Below salary floor'));
});

test('feedback changes ordering and ambiguous Jev classification does not silently override fit', () => {
  const d = initialState(); const role = d.roles[0];
  const baseline = priorityScore(role, d.profile);
  const feedback = [{ id: 'f', roleId: role.id, kind: 'not-interested' as const, company: role.company, title: role.title, industry: role.industry, skills: role.skills, createdAt: '' }];
  assert.ok(priorityScore(role, d.profile, feedback) < baseline);
  assert.equal(priorityScore({ ...role, jev: { fit: 'uncertain', confidence: .2, supported: 0, growth: .4, review: true } }, d.profile), baseline);
});

test('Jev uses documented typed questions, redacts raw CV, validates probabilities and gates disagreement', async () => {
  const d = initialState(); const request = jevRequest(d.roles[0], d.profile, [], 'jev-latest');
  const serialized = JSON.stringify(request);
  assert.ok(!serialized.includes(d.profile.name)); assert.ok(!serialized.includes(d.profile.background));
  assert.equal(request.questions.fit.type, 'choice');
  let called = false;
  const fake = (async (url: string, init: RequestInit) => {
    called = true; assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-key');
    return new Response(JSON.stringify({ answers: { fit: { choice: 'stretch', confidence: .95 }, supported: { noul: .7 }, growth: { noul: .9 } } }));
  }) as typeof fetch;
  const a = await assessWithJev(d.roles[0], d.profile, [], 'test-key', 'jev-latest', undefined, fake);
  assert.ok(called); assert.equal(a.review, true);
  await assert.rejects(assessWithJev(d.roles[0], d.profile, [], 'test-key', 'jev-latest', undefined, (async () => new Response(JSON.stringify({ answers: { fit: { choice: 'direct', confidence: 4 } } }))) as typeof fetch), /invalid assessment/);
  await assert.rejects(assessWithJev(d.roles[0], d.profile, [], 'test-key', 'jev-latest', undefined, (async () => new Response('', { status: 401 })) as typeof fetch), /HTTP 401/);
});

test('workspace persists edits, feedback, application notes and repeat-run saves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'waypoint-test-'));
  try {
    const service = await new CareerService(dir, false, async () => parseResearch(result())).init();
    await assert.rejects(service.startResearch(), /Create your own profile/);
    await service.saveProfile(initialState().profile);
    assert.equal(service.state.demo, false); assert.equal(service.state.roles.length, 0);
    await service.startResearch(); await settle(service);
    assert.equal(service.state.runs[0].status, 'completed');
    const id = service.state.roles[0].id;
    await service.toggleSave(id); await service.feedback(id, 'more'); await service.setApplication(id, 'Preparing', 'Prepare the activation story.');
    await service.startResearch(); await settle(service);
    assert.ok(service.state.saved.includes(id)); assert.equal(service.state.applications[0].notes, 'Prepare the activation story.');
    await service.shutdown();
    const restored = await new CareerService(dir).init();
    assert.equal(restored.state.profile.name, 'Alex Morgan'); assert.equal(restored.state.feedback[0].kind, 'more');
    await assert.rejects(dispatch(restored, 'constructor', []), /Unknown action/);
    const cv = await restored.importCV('resume.txt', Buffer.from('A candidate with experience in product discovery, customer research and delivery.').toString('base64'));
    assert.ok(cv.includes('product discovery'));
    await assert.rejects(restored.importCV('malicious.exe', 'abcd'), /Use PDF/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancellation and failure preserve the previous workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'waypoint-cancel-'));
  try {
    const service = await new CareerService(dir, false, (_s, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }))).init();
    await service.saveProfile(initialState().profile); await service.startResearch();
    await assert.rejects(service.startResearch(), /already running/);
    await assert.rejects(service.saveProfile(initialState().profile), /cancel/);
    await service.cancelResearch(); await settle(service);
    assert.equal(service.state.runs[0].status, 'cancelled'); assert.equal(service.state.roles.length, 0);
    await new Promise(r => setTimeout(r, 20)); await service.shutdown();
    const fails = await new CareerService(dir, false, async () => { throw new Error('offline'); }).init();
    await fails.startResearch(); await settle(fails); assert.equal(fails.state.runs[0].error, 'offline');
    await fails.shutdown();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('opportunity removal cascades and newer research evicts the oldest over the cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'waypoint-cap-'));
  try {
    const service = await new CareerService(dir, false, async () => parseResearch(result())).init();
    await service.saveProfile(initialState().profile);
    const template = initialState().roles[0];
    service.state.roles = Array.from({ length: MAX_OPPORTUNITIES + 5 }, (_, index) => ({ ...structuredClone(template), id: `old-${index}`, demo: false, discoveredAt: new Date(Date.UTC(2020, 0, index + 1)).toISOString() }));
    service.state.saved = service.state.roles.map(role => role.id);
    service.state.applications = [{ roleId: 'old-0', stage: 'Preparing', notes: 'Old note', updatedAt: '' }];
    service.state.feedback = [{ id: 'feedback-old', roleId: 'old-0', kind: 'more', company: 'Old', title: 'Old', industry: 'Old', skills: [], createdAt: '' }];
    await service.startResearch(); await settle(service);
    assert.equal(service.state.roles.length, MAX_OPPORTUNITIES);
    assert.ok(!service.state.roles.some(role => role.id === 'old-0'));
    assert.ok(!service.state.applications.some(application => application.roleId === 'old-0'));
    assert.ok(!service.state.feedback.some(item => item.roleId === 'old-0'));
    const removable = service.state.roles.slice(0, 2).map(role => role.id);
    await service.removeRoles(removable);
    assert.ok(removable.every(id => !service.state.roles.some(role => role.id === id) && !service.state.saved.includes(id)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('research schedules become due once per matching local-time slot', () => {
  const schedule = { enabled: true, time: '09:00', lastRunAt: new Date(2026, 8, 20, 12).toISOString() };
  assert.equal(scheduleDue(schedule, new Date(2026, 8, 21, 8, 59)), false);
  assert.equal(scheduleDue(schedule, new Date(2026, 8, 21, 9, 0)), true);
  assert.equal(scheduleDue({ ...schedule, lastRunAt: new Date(2026, 8, 21, 9, 0).toISOString() }, new Date(2026, 8, 21, 12)), false);
});

test('preview API rejects cross-origin requests and allows same-origin app calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'waypoint-http-'));
  const preview = await createPreview({ directory: dir, port: 0, vite: false });
  const origin = `http://127.0.0.1:${(preview.server.address() as { port: number }).port}`;
  try {
    const body = JSON.stringify({ method: 'getState', args: [] });
    const headers = { 'Content-Type': 'application/json', 'X-Waypoint-Client': 'desktop-preview', Origin: origin };
    assert.equal((await fetch(`${origin}/api/action`, { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body })).status, 403);
    const response = await fetch(`${origin}/api/action`, { method: 'POST', headers, body });
    assert.equal(response.status, 200); assert.equal((await response.json()).result.demo, true);
    // fetch rewrites Host; use the HTTP client to exercise DNS-rebinding protection.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${origin}/api/action`, { method: 'POST', headers: { ...headers, Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end(body);
    });
    assert.equal(status, 403);
  } finally { await preview.close(); await rm(dir, { recursive: true, force: true }); }
});

test('real subprocess adapter sends profile through stdin, sets a read-only sandbox and parses output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'waypoint-cli-'));
  const binary = join(dir, 'fake-codex.mjs'); const old = process.env.CODEX_BIN;
  try {
    await writeFile(binary, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nif(!args.includes('read-only')||!args.includes('--search'))process.exit(9);\nlet input='';for await(const c of process.stdin)input+=c;\nif(!input.includes('Alex Morgan'))process.exit(8);\nfs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(${JSON.stringify(result())}));\nconsole.log(JSON.stringify({type:'thread.started'}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'web_search',query:'product roles',action:{type:'open_page',url:'https://careers.acme.com/jobs/123'}}}));\n`);
    await chmod(binary, 0o700); process.env.CODEX_BIN = binary;
    const events: string[] = []; const sources: string[] = [];
    const output = await runCodex(initialState(), new AbortController().signal, (message, source) => { if (message) events.push(message); if (source) sources.push(source.url); });
    assert.equal(output.roles.length, 1); assert.ok(output.roles[0].id.startsWith('role-')); assert.ok(events[0].includes('connected')); assert.deepEqual(sources, ['https://careers.acme.com/jobs/123']);
  } finally { if (old) process.env.CODEX_BIN = old; else delete process.env.CODEX_BIN; await rm(dir, { recursive: true, force: true }); }
});

test('web search activity exposes only safe public sources', () => {
  const updates = webSearchUpdates({ type: 'item.completed', item: { type: 'web_search', query: 'product roles', action: { type: 'search', query: 'product roles' }, results: [
    { url: 'https://jobs.example.org/role', title: 'Product role' },
    { url: 'http://unsafe.example.org/role', title: 'Unsafe' },
    { url: 'https://127.0.0.1/private', title: 'Private' },
  ] } }, '2026-09-20T12:00:00.000Z');
  assert.equal(updates[0].message, 'Searching live sources for “product roles”.');
  assert.deepEqual(updates.flatMap(update => update.source ? [update.source] : []), [{ url: 'https://jobs.example.org/role', title: 'Product role', status: 'found', seenAt: '2026-09-20T12:00:00.000Z' }]);
});

test('corrupt saved data is preserved instead of overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'waypoint-corrupt-'));
  try {
    await writeFile(join(dir, 'state.json'), 'not-json');
    await assert.rejects(new CareerService(dir).init(), /preserved/);
    assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), 'not-json');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PDF and DOCX imports extract reviewable text without a hosted document service', async () => {
  const service = new CareerService('/unused-import-only');
  for (const file of ['resume.pdf', 'resume.docx']) {
    const buffer = await readFile(new URL(`./fixtures/${file}`, import.meta.url));
    const text = await service.importCV(file, buffer.toString('base64'));
    assert.match(text, /customer research/);
    assert.match(text, /product discovery/);
  }
});
