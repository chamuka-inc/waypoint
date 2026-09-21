import { createIcons, icons } from 'lucide';
import type { AppState, Opportunity, Profile, Fit, FeedbackKind, Application, RuntimeStatus, ResearchRun } from './types.js';
import { priorityScore, salary, constraints } from './ranking.js';
import { blankProfile } from './demo.js';
import './style.css';

declare global { interface Window { waypoint?: { call: (method: string, ...args: unknown[]) => Promise<unknown> } } }
const root = document.querySelector<HTMLDivElement>('#app')!;
let state: AppState;
let runtime: RuntimeStatus | undefined;
let page = 'discover';
let fitFilter = 'all';
let query = '';
let modeFilter = 'all';
let salaryFilter = false;
let hideConflicts = false;
let sort = 'priority';
let selected: string | null = null;
let detailTab = 'overview';
let modal: 'filters' | 'new' | null = null;
let profileStep = 'story';
let draft: Profile | null = null;
let dirty = false;
const notesDraft: Record<string, string> = {};
const selectedRoleIds = new Set<string>();

let busy = false;
let toastTimer: ReturnType<typeof setTimeout>;
let focusBeforeDialog: HTMLElement | null = null;

const labels: Record<string, string> = { discover: 'Discover', paths: 'Career paths', saved: 'Shortlist', applications: 'Applications', profile: 'My profile', research: 'Research activity', settings: 'Settings' };
const fitLabel: Record<Fit, string> = { direct: 'Direct fit', adjacent: 'Adjacent fit', stretch: 'Stretch opportunity' };
const feedbackLabels: Record<FeedbackKind, string> = { more: 'More like this', 'too-technical': 'Too technical', 'too-junior': 'Too junior', 'salary-low': 'Salary too low', 'no-industry': 'Not this industry', 'not-interested': 'Not for me' };
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const icon = (name: string, cls = '') => `<i data-lucide="${name}" class="${cls}" aria-hidden="true"></i>`;
const badge = (fit: Fit) => `<span class="fit-badge ${fit}"><span></span>${fitLabel[fit]}</span>`;
const date = (value?: string) => value ? new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Not yet researched';
function toast(message: string) { const el = document.querySelector<HTMLDivElement>('#toast')!; el.textContent = message; el.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 5500); }
async function call<T = AppState>(method: string, ...args: unknown[]): Promise<T> {
  if (window.waypoint) return window.waypoint.call(method, ...args) as Promise<T>;
  const response = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Waypoint-Client': 'desktop-preview' }, body: JSON.stringify({ method, args }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not complete the action.');
  return data.result as T;
}
async function mutate(method: string, args: unknown[] = [], message?: string) {
  if (busy) return;
  busy = true;
  try { state = await call(method, ...args); render(); if (message) toast(message); }
  catch (e) { toast((e as Error).message); }
  finally { busy = false; }
}
function download(filename: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function activeRun() { return state.runs.find(r => r.status === 'running'); }
function navigate(next: string) {
  if (dirty && page === 'profile' && next !== page && !confirm('Leave without saving your profile changes?')) return;
  if (next !== 'profile') { draft = null; dirty = false; }
  page = next; selected = null; modal = null; query = ''; selectedRoleIds.clear(); render(); window.scrollTo(0, 0);
}
function openDialog() { focusBeforeDialog = document.activeElement as HTMLElement; }
function closeDialog() { selected = null; modal = null; render(); focusBeforeDialog?.focus(); }
function currentRoles() {
  let roles = state.roles.filter(r => page !== 'saved' || state.saved.includes(r.id));
  roles = roles.filter(r => (fitFilter === 'all' || r.fit === fitFilter) && (modeFilter === 'all' || r.workMode === modeFilter) && (!salaryFilter || (r.currency === state.profile.currency && r.salaryPeriod === 'year' && r.salaryMax !== null && r.salaryMax >= state.profile.salaryMin)) && (!hideConflicts || constraints(r, state.profile).filter(c => c !== 'Availability uncertain').length === 0));
  if (query) { const q = query.toLowerCase(); roles = roles.filter(r => `${r.title} ${r.company} ${r.industry} ${r.skills.join(' ')}`.toLowerCase().includes(q)); }
  return [...roles].sort((a, b) => sort === 'salary' ? comparableSalary(b) - comparableSalary(a) : priorityScore(b, state.profile, state.feedback) - priorityScore(a, state.profile, state.feedback));
}
function comparableSalary(r: Opportunity) { return r.currency === state.profile.currency && r.salaryPeriod === 'year' ? r.salaryMax || -1 : -1; }

function sidebar() {
  const nav = (id: string, glyph: string, count?: number) => `<button class="nav-item ${page === id ? 'active' : ''}" data-nav="${id}" ${page === id ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${labels[id]}</span>${count ? `<small>${count}</small>` : ''}</button>`;
  return `<aside class="sidebar"><a href="#" class="brand" data-nav="discover"><span class="brand-mark">${icon('route')}</span>waypoint<span class="brand-dot">.</span></a><div class="workspace-label">YOUR NEXT CHAPTER</div><nav aria-label="Main navigation">${nav('discover', 'compass')}${nav('paths', 'git-branch')}${nav('saved', 'bookmark', state.saved.length)}${nav('applications', 'briefcase-business', state.applications.length)}<div class="nav-separator"></div>${nav('profile', 'user-round')}${nav('research', 'activity')}</nav><div class="sidebar-bottom"><div class="agent-card"><div class="agent-icon">${icon('sparkles')}</div><strong>A little more possibility.</strong><p>Your next role might have a title you haven’t searched for.</p><button data-nav="paths">Explore your paths ${icon('arrow-up-right')}</button></div>${nav('settings', 'settings-2')}<button class="user-card" data-nav="profile"><span class="avatar">${esc((state.profile.name || 'You').split(' ').map(s => s[0]).slice(0, 2).join(''))}</span><span><strong>${esc(state.profile.name || 'Your workspace')}</strong><small>${state.demo ? 'Sample profile' : 'Personal workspace'}</small></span>${icon('chevrons-up-down')}</button></div></aside>`;
}
function shell(content: string) {
  return `${sidebar()}<div class="main-shell"><header class="topbar"><div class="breadcrumb">My workspace ${icon('chevron-right')} <strong>${labels[page]}</strong></div><div class="top-actions"><span class="local-status"><span></span>Local workspace</span><button class="icon-button" data-nav="settings" aria-label="AI connection settings">${icon('sliders-horizontal')}</button></div></header><main id="main">${state.demo ? `<div class="demo-banner"><span>${icon('flask-conical')} <strong>Take a look around.</strong> You’re exploring a sample profile and fictional opportunities.</span><button data-action="new">Make it yours ${icon('arrow-right')}</button></div>` : ''}${content}</main><footer class="footer"><span>${icon('route')} A career that feels like you.</span><span>Thoughtful research. Your decisions.</span></footer></div>${selected ? detailDrawer() : ''}${modal ? modalView() : ''}`;
}
function compassArt() {
  return `<div class="compass-art" aria-hidden="true"><svg viewBox="0 0 390 210"><defs><linearGradient id="line" x1="0" x2="1"><stop offset="0" stop-color="#b2c7b3"/><stop offset="1" stop-color="#507a5d"/></linearGradient></defs><circle cx="238" cy="106" r="84" fill="none" stroke="#cfdbca"/><circle cx="238" cy="106" r="57" fill="none" stroke="#cfdbca" stroke-dasharray="3 5"/><path d="M21 178 C100 183 103 64 174 104 S246 158 291 65" fill="none" stroke="url(#line)" stroke-width="2" stroke-dasharray="5 5"/><circle cx="174" cy="104" r="5" fill="#607c65"/><circle cx="291" cy="65" r="6" fill="#375d43"/><path d="M238 83 L253 123 L238 115 L223 123 Z" fill="#355c44" transform="rotate(28 238 106)"/><circle cx="238" cy="106" r="28" fill="none" stroke="#a5bba3"/><text x="235" y="14" fill="#859984" font-size="10">N</text><text x="335" y="110" fill="#859984" font-size="10">E</text><text x="235" y="205" fill="#859984" font-size="10">S</text><text x="140" y="110" fill="#859984" font-size="10">W</text></svg><span class="art-label art-you">${icon('circle-dot')} Where you are</span><span class="art-label art-next">${icon('sparkles')} What’s possible</span></div>`;
}
function discover() {
  const roles = currentRoles();
  const adj = state.roles.filter(r => r.fit === 'adjacent').length;
  return `<section class="page-heading"><div><div class="eyebrow">YOUR CAREER, WITH A WIDER LENS</div><h1>Your next chapter starts here<span>.</span></h1><p>Good opportunities fit your experience. Great ones expand your possibilities.</p></div><button class="button primary" data-action="research">${icon(activeRun() ? 'loader-circle' : 'sparkles')}${activeRun() ? 'Research in progress' : 'Research opportunities'}</button></section>
  <section class="hero"><div class="hero-content"><span class="mini-label">${icon('compass')} YOUR CAREER COMPASS</span><h2>You’re more than<br>your last job title.</h2><p>${state.families.length ? `We’re exploring ${state.families.length} career directions that connect what you’ve done with where you want to go.` : 'Build a picture of your experience, then explore the directions it could take you.'}</p><button class="text-button" data-nav="paths">See your career paths ${icon('arrow-right')}</button></div>${compassArt()}</section>
  <section class="stats-strip"><div><span class="stat-icon">${icon('scan-search')}</span><div><strong>${state.roles.length}<small>opportunities to explore</small></strong><p>${state.demo ? 'Illustrative matches for Alex' : state.runs[0]?.status === 'completed' ? 'From your latest research + saved roles' : 'Your research workspace'}</p></div></div><div><span class="stat-icon lavender">${icon('git-branch')}</span><div><strong>${adj}<small>adjacent possibilities</small></strong><p>A different title. Transferable strengths.</p></div></div><div><span class="stat-icon peach">${icon('bookmark')}</span><div><strong>${state.saved.length}<small>on your shortlist</small></strong><p>Make room for the ones that stand out.</p></div></div></section>
  <div class="discovery-grid"><section class="opportunities"><div class="section-title"><div><h2>Picked for your potential</h2><p>${state.demo ? 'Sample opportunities · explore how matching works' : state.profileRevision !== state.researchRevision ? 'Profile updated · run research to refresh the evidence' : 'Evidence, context, and a reason to look closer'}</p></div><button class="icon-button" data-action="filters" aria-label="Filter opportunities">${icon('sliders-horizontal')}</button></div>${toolbar()}${selectionToolbar(roles)}<div id="role-list" class="role-grid">${roles.length ? roles.map(roleCard).join('') : empty('No opportunities here yet', state.roles.length ? 'Try a different filter or search term.' : 'Add your profile and start a research run to find sourced vacancies.', state.roles.length ? 'Clear filters' : 'Build my profile', state.roles.length ? 'clear-filters' : 'profile')}</div></section>${insights()}</div>`;
}
function toolbar() {
  const all = state.roles.filter(r => page !== 'saved' || state.saved.includes(r.id));
  return `<div class="fit-tabs" role="group" aria-label="Role fit filter">${[['all', 'All opportunities'], ['direct', 'Direct fit'], ['adjacent', 'Adjacent'], ['stretch', 'Stretch']].map(([id, label]) => `<button class="${fitFilter === id ? 'selected' : ''}" data-fit="${id}">${label}<span>${id === 'all' ? all.length : all.filter(r => r.fit === id).length}</span></button>`).join('')}</div><div class="search-row"><label class="search-field">${icon('search')}<input id="search" aria-label="Search opportunities" placeholder="Search roles, companies, or skills" value="${esc(query)}"><kbd>/</kbd></label><select id="sort" aria-label="Sort opportunities"><option value="priority" ${sort === 'priority' ? 'selected' : ''}>Best for you</option><option value="salary" ${sort === 'salary' ? 'selected' : ''}>Highest salary</option></select></div>${modeFilter !== 'all' || salaryFilter || hideConflicts ? '<button class="filter-active" data-action="clear-filters">Filters active · Clear all ×</button>' : ''}`;
}
function roleCard(role: Opportunity) {
  const saved = state.saved.includes(role.id);
  const score = priorityScore(role, state.profile, state.feedback);
  const checked = selectedRoleIds.has(role.id);
  return `<article class="role-card ${checked ? 'selected-for-removal' : ''}"><div class="card-top"><label class="role-selector" title="Select ${esc(role.title)}"><input type="checkbox" data-select-role="${esc(role.id)}" ${checked ? 'checked' : ''}><span aria-hidden="true">${icon('check')}</span><span class="sr-only">Select ${esc(role.title)} at ${esc(role.company)}</span></label><span class="company-logo logo-${role.company.charCodeAt(0) % 5}">${esc(role.company.slice(0, 1))}<span>·</span></span><div class="company-meta"><strong>${esc(role.company)}</strong><small>${esc(role.industry)}</small></div><button class="save-button ${saved ? 'saved' : ''}" data-save="${esc(role.id)}" aria-label="${saved ? 'Unsave' : 'Save'} ${esc(role.title)} at ${esc(role.company)}" aria-pressed="${saved}">${icon('bookmark')}</button></div><button class="role-open" data-role="${esc(role.id)}"><h3>${esc(role.title)}</h3></button>${badge(role.fit)}<p class="role-summary">${esc(role.summary)}</p><div class="role-meta"><span>${icon('map-pin')}${esc(role.location)}</span><span>${icon('laptop')}${role.workMode}</span></div><div class="salary-line">${esc(salary(role))}<span>${esc(role.seniority)}</span></div><div class="card-bottom"><span class="priority" title="Weighted preference score, not a hiring probability">${icon('sparkles')} ${score}<small>priority score</small></span><button data-role="${esc(role.id)}">Explore role ${icon('arrow-up-right')}</button></div></article>`;
}
function selectionToolbar(roles: Opportunity[]) {
  const selectedCount = selectedRoleIds.size;
  const allVisibleSelected = roles.length > 0 && roles.every(role => selectedRoleIds.has(role.id));
  return `<div class="selection-toolbar"><span>${selectedCount ? `${selectedCount} selected` : `Up to 50 opportunities · newest replace oldest`}</span><div><button class="text-button" data-action="select-visible">${allVisibleSelected ? 'Clear shown' : 'Select all shown'}</button><button class="button danger" data-action="remove-selected" ${selectedCount ? '' : 'disabled'}>${icon('trash-2')}Remove selected</button></div></div>`;
}
function insights() {
  return `<aside class="insights"><section class="insight-card"><div class="insight-heading">${icon('sparkles')} A DIFFERENT ANGLE</div><h3>Your skills have<br>more than one home.</h3><p>${esc(state.summary || 'Once you add your story, your agent can connect transferable skills to career paths you might not have considered.')}</p><button class="text-button" data-nav="paths">Explore the connections ${icon('arrow-right')}</button><div class="insight-decoration">↗</div></section><section class="legend-card"><h3>A little context on fit</h3><div><span class="fit-dot direct"></span><p><strong>Direct fit</strong><small>Familiar work. A natural next step.</small></p></div><div><span class="fit-dot adjacent"></span><p><strong>Adjacent fit</strong><small>Your strengths, in a new setting.</small></p></div><div><span class="fit-dot stretch"></span><p><strong>Stretch opportunity</strong><small>A bigger leap, with a path to grow.</small></p></div></section><section class="preferences-card"><div><h3>On your terms</h3><button class="icon-button" data-action="preferences" aria-label="Edit career preferences">${icon('pencil')}</button></div><p>${icon('banknote')} ${state.profile.salaryMin ? esc(new Intl.NumberFormat('en-GB', { style: 'currency', currency: state.profile.currency, maximumFractionDigits: 0 }).format(state.profile.salaryMin)) + '+ / year' : 'Set your salary floor'}</p><p>${icon('laptop')} ${esc(state.profile.workModes.join(' or ') || 'Any work arrangement')}</p><p>${icon('map-pin')} ${esc(state.profile.locations || 'Choose your locations')}</p><span class="small-note">You define what a good move looks like.</span></section></aside>`;
}
function empty(title: string, subtitle: string, button?: string, action?: string) {
  return `<div class="empty-state">${icon('compass')}<h3>${title}</h3><p>${subtitle}</p>${button ? `<button class="button secondary" data-action="${action}">${button}${icon('arrow-right')}</button>` : ''}</div>`;
}
function pageHeading(eyebrow: string, title: string, subtitle: string, action = '') {
  return `<section class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}<span>.</span></h1><p>${subtitle}</p></div>${action}</section>`;
}
function pathsPage() {
  return `${pageHeading('THINK BEYOND THE TITLE', 'A few directions worth taking', 'Your experience is a starting point, not a boundary.')}<div class="path-intro">${icon('route')}<p>${esc(state.summary || 'Your first research run will map direct-fit, adjacent, and stretch career directions from your experience.')}</p></div><div class="path-columns">${(['direct', 'adjacent', 'stretch'] as Fit[]).map(fit => `<section><div class="path-column-heading">${badge(fit)}<span>${state.families.filter(f => f.fit === fit).length} paths</span></div>${state.families.filter(f => f.fit === fit).map(f => `<article class="path-card"><span class="path-icon ${fit}">${icon(fit === 'direct' ? 'target' : fit === 'adjacent' ? 'git-branch' : 'move-up-right')}</span><h2>${esc(f.title)}</h2><p>${esc(f.why)}</p><h4>STRENGTHS THAT TRAVEL</h4><div class="skill-tags">${f.skills.map(s => `<span>${esc(s)}</span>`).join('')}</div><h4>WHAT TO INVESTIGATE</h4><ul>${f.gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul><div class="search-terms"><strong>Search language to try</strong>${f.searchTerms.map(t => `<span>${esc(t)}</span>`).join('')}</div><button class="text-button" data-path-fit="${fit}">See ${fit} opportunities ${icon('arrow-right')}</button></article>`).join('') || `<p class="small-note">Run research to discover these paths.</p>`}</section>`).join('')}</div>`;
}
function savedPage() {
  const roles = currentRoles();
  return `${pageHeading('A LITTLE CLOSER TO YOUR NEXT MOVE', 'Your shortlist', 'Keep the possibilities you want to come back to.', `<button class="button secondary" data-action="export-shortlist">${icon('download')}Export shortlist</button>`)}${toolbar()}${selectionToolbar(roles)}<div class="saved-grid" id="role-list">${roles.length ? roles.map(roleCard).join('') : empty('Make room for possibility', 'Save an opportunity to keep its evidence, questions, and next steps close.', 'Explore opportunities', 'discover')}</div>`;
}
function applicationsPage() {
  const stages: Application['stage'][] = ['Preparing', 'Applied', 'Interview', 'Offer'];
  return `${pageHeading('TURN POSSIBILITY INTO PROGRESS', 'One thoughtful application at a time', 'Track your next steps and keep the context that matters.')}<div class="pipeline">${stages.map(stage => `<section class="pipeline-column"><div class="pipeline-heading"><span>${stage}</span><b>${state.applications.filter(a => a.stage === stage || (stage === 'Preparing' && a.stage === 'Saved')).length}</b></div>${state.applications.filter(a => a.stage === stage || (stage === 'Preparing' && a.stage === 'Saved')).map(a => { const r = state.roles.find(r => r.id === a.roleId); return r ? `<article class="application-card"><span class="company-logo logo-${r.company.charCodeAt(0) % 5}">${esc(r.company[0])}</span><small>${esc(r.company)}</small><button class="role-open" data-role="${esc(r.id)}"><h3>${esc(r.title)}</h3></button>${badge(r.fit)}<p>${esc(a.notes || 'Add notes and prepare your next step.')}</p><label>Move to<select data-stage="${esc(r.id)}">${stages.map(s => `<option ${s === stage ? 'selected' : ''}>${s}</option>`).join('')}</select></label><small>Updated ${date(a.updatedAt)}</small></article>` : ''; }).join('') || '<div class="pipeline-empty">A little space for what’s next.</div>'}</section>`).join('')}</div><div class="callout">${icon('info')}Open a role and choose “Prepare application” to add it here. Waypoint never submits applications for you.</div>`;
}
function field(key: keyof Profile, label: string, placeholder: string, multiline = false, hint = '') {
  const value = draft![key];
  return `<label class="form-field ${multiline ? 'full' : ''}"><span>${label}</span>${multiline ? `<textarea name="${key}" rows="${key === 'background' ? 9 : 3}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input name="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}">`}${hint ? `<small>${hint}</small>` : ''}</label>`;
}
function captureProfile() {
  if (!draft) return;
  const form = document.querySelector<HTMLFormElement>('#profile-form'); if (!form) return;
  const fd = new FormData(form);
  for (const [key, value] of fd.entries()) {
    if (key.startsWith('priority-')) draft.priorities[key.slice(9) as keyof Profile['priorities']] = Number(value);
    else if (key === 'skills') draft.skills = String(value).split(',').map(x => x.trim()).filter(Boolean);
    else if (key === 'salaryMin') draft.salaryMin = Number(value);
    else if (key !== 'workModes') (draft as unknown as Record<string, unknown>)[key] = value;
  }
  if (profileStep === 'preferences') draft.workModes = fd.getAll('workModes') as Profile['workModes'];
}
function profilePage() {
  if (!draft) draft = structuredClone(state.profile);
  return `${pageHeading('THE PERSON BEHIND THE PROFILE', 'Let’s start with you', 'The more context you share, the more useful your research becomes.', `<button class="button primary" data-action="save-profile">${icon('check')}Save profile</button>`)}<div class="profile-layout"><aside class="profile-steps">${[['story', 'Your story', 'Experience & strengths', 'user-round'], ['preferences', 'Your next move', 'Preferences & ambitions', 'compass'], ['priorities', 'What matters most', 'Personal priorities', 'sliders-horizontal']].map(([id, title, sub, glyph], i) => `<button class="${profileStep === id ? 'active' : ''}" data-step="${id}"><span>${icon(glyph)}</span><div><strong>${title}</strong><small>${sub}</small></div><b>0${i + 1}</b></button>`).join('')}<div class="privacy-note">${icon('lock-keyhole')}<p>Your profile is saved on this device. Starting research shares it with your configured Codex provider.</p></div>${state.questions.length ? `<div class="followups"><h4>A little more to think about</h4>${state.questions.map(q => `<p>${esc(q)}</p>`).join('')}<small>Add your answers to your ambitions or career history.</small></div>` : ''}</aside><form id="profile-form" class="form-panel">${profileStep === 'story' ? `<div class="form-heading"><span>01 / YOUR STORY</span><h2>Connect the dots in your experience.</h2><p>Titles matter less than the work you’ve done and what you learned.</p></div><label class="upload-zone">${icon('file-up')}<strong>Bring your CV along</strong><span>Choose a PDF, DOCX, TXT, or Markdown file · up to 8 MB</span><input type="file" id="cv-upload" accept=".pdf,.docx,.txt,.md"><small>Text is extracted locally. Review it below before saving.</small></label><div class="form-grid">${field('name', 'Your name', 'Alex Morgan')}${field('location', 'Based in', 'London, UK')}${field('headline', 'A short introduction', 'What do you do, in your own words?')}${field('qualifications', 'Qualifications & certifications', 'Degrees, licences, professional qualifications')}${field('background', 'Career history / profile', 'Paste your CV or LinkedIn-style profile. Include responsibilities, outcomes, dates, and scope.', true, 'Include specific outcomes and your personal contribution. No LinkedIn login is needed.')}<label class="form-field full"><span>Skills & strengths</span><input name="skills" value="${esc(draft.skills.join(', '))}" placeholder="Product strategy, SQL, customer research"><small>Separate skills with commas.</small></label>${field('projects', 'Projects you’re proud of', 'Side projects, volunteering, published work, or meaningful achievements', true)}</div>` : profileStep === 'preferences' ? `<div class="form-heading"><span>02 / YOUR NEXT MOVE</span><h2>What would a good move look like?</h2><p>Be specific about the things a job description can’t decide for you.</p></div><div class="form-grid">${field('ambitions', 'Career ambitions', 'What would you like more of? What are you ready to leave behind?', true)}<label class="form-field"><span>Minimum annual base salary</span><input name="salaryMin" type="number" min="0" max="100000000" value="${draft.salaryMin}"></label><label class="form-field"><span>Currency</span><select name="currency">${['GBP', 'USD', 'EUR', 'CAD', 'AUD', 'INR', 'CHF', 'SGD'].map(c => `<option ${draft!.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label><fieldset class="form-field full"><legend>How you want to work</legend><div class="checkbox-group">${['Remote', 'Hybrid', 'On-site'].map(m => `<label><input type="checkbox" name="workModes" value="${m}" ${draft!.workModes.includes(m as Profile['workModes'][number]) ? 'checked' : ''}>${icon(m === 'Remote' ? 'laptop' : 'building-2')}${m}</label>`).join('')}</div></fieldset>${field('locations', 'Preferred locations', 'London or UK remote')}${field('commute', 'Commute & office days', 'Up to 45 minutes, 2 days a week')}${field('seniority', 'Scope & seniority', 'Senior individual contributor, team lead…')}${field('workAuthorization', 'Work authorisation / sponsorship needs', 'Where can you work? Is sponsorship required?')}${field('industries', 'Industries you’re drawn to', 'Climate tech, education, B2B SaaS')}${field('excludedIndustries', 'Industries to avoid', 'Consulting, gambling…')}</div>` : `<div class="form-heading"><span>03 / WHAT MATTERS MOST</span><h2>A good fit is personal.</h2><p>These weights change opportunity ordering immediately. They are preference scores, not predictions of getting hired.</p></div><div class="priority-sliders">${[['fit', 'Experience fit', 'How closely the work connects to demonstrated strengths.', 'target'], ['growth', 'Career progression', 'Room to grow towards your ambitions.', 'trending-up'], ['flexibility', 'Flexibility', 'Work arrangements that fit your life.', 'laptop'], ['compensation', 'Compensation', 'How well disclosed salary aligns with your expectations.', 'banknote']].map(([key, title, sub, glyph]) => `<label><div>${icon(glyph)}<span><strong>${title}</strong><small>${sub}</small></span><output>${draft!.priorities[key as keyof Profile['priorities']]}</output></div><input type="range" name="priority-${key}" min="0" max="5" step="1" value="${draft!.priorities[key as keyof Profile['priorities']]}"><div class="range-labels"><span>Less important</span><span>Essential to me</span></div></label>`).join('')}</div><div class="callout">${icon('info')}Salary, location, and work-authorisation questions are still shown separately. A high preference score does not erase a potential blocker.</div>`}<div class="form-bottom"><span>${state.demo ? 'Saving creates your personal workspace and removes sample roles.' : 'Your changes stay on this device.'}</span><button type="button" class="button primary" data-action="${profileStep === 'priorities' ? 'save-profile' : 'next-step'}">${profileStep === 'priorities' ? 'Save profile' : 'Continue'}${icon('arrow-right')}</button></div></form></div>`;
}
function researchSources(run: ResearchRun) {
  const sources = run.sources ?? [];
  if (!sources.length) return run.status === 'running' ? `<section class="live-sources waiting" aria-live="polite"><span class="source-state reviewing">${icon('loader-circle')}</span><div><strong>Looking for credible vacancy sources…</strong><small>Pages will appear here as Codex finds and opens them.</small></div></section>` : '';
  return `<section class="live-sources" aria-live="polite"><div class="live-sources-heading"><div><span class="mini-label">${icon('globe-2')} SOURCES IN VIEW</span><h3>${run.status === 'running' ? 'What’s being looked at now' : 'Sources seen during this run'}</h3></div><span>${sources.length} ${sources.length === 1 ? 'source' : 'sources'}</span></div><div class="live-source-list">${sources.slice().reverse().map(source => { const host = new URL(source.url).hostname.replace(/^www\./, ''); return `<a class="live-source" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer"><span class="source-state ${source.status}">${icon(source.status === 'reviewed' ? 'circle-check' : source.status === 'reviewing' ? 'loader-circle' : 'search')}</span><span><strong>${esc(source.title)}</strong><small>${esc(host)} · ${source.status === 'found' ? 'found in search' : source.status}</small></span>${icon('arrow-up-right')}</a>`; }).join('')}</div></section>`;
}
function researchPage() {
  const run = state.runs[0];
  return `${pageHeading('A RESEARCH PARTNER IN YOUR CORNER', 'Follow the thinking', 'Live progress, source evidence, and a clear record of what happened.', `<button class="button ${activeRun() ? 'secondary' : 'primary'}" data-action="${activeRun() ? 'cancel-research' : 'research'}">${icon(activeRun() ? 'square' : 'sparkles')}${activeRun() ? 'Stop research' : 'Start research'}</button>`)}<div class="research-layout"><section class="research-panel"><div class="section-title"><h2>${run ? (run.status === 'running' ? 'Research is underway' : run.status === 'completed' ? 'Your latest research' : 'Research paused') : 'Ready when you are'}</h2>${run ? `<span class="status-pill ${run.status}">${run.status}</span>` : ''}</div><div class="research-stages">${[['user-round', 'Understand you'], ['git-branch', 'Explore directions'], ['scan-search', 'Research vacancies'], ['list-checks', 'Explain the fit']].map(([glyph, title]) => `<div>${icon(glyph)}<strong>${title}</strong></div>`).join('')}</div>${run ? `<div class="run-meta"><span>Started ${date(run.startedAt)}</span><span>${run.finishedAt ? `Finished ${date(run.finishedAt)}` : 'You can keep exploring while this runs.'}</span></div>${researchSources(run)}<ol class="event-list">${run.events.map((e, i) => `<li><span>${String(i + 1).padStart(2, '0')}</span><p>${esc(e)}</p></li>`).join('')}</ol>${run.status === 'completed' ? `<div class="research-summary"><h3>${run.count} opportunities found</h3><p>${esc(state.summary)}</p><button class="text-button" data-nav="discover">Explore the results ${icon('arrow-right')}</button></div>` : ''}` : empty('A wider search. A closer look.', 'Start with your profile. Codex will investigate current vacancies and return evidence-backed opportunities.', state.demo ? 'Create my profile' : 'Review my profile', state.demo ? 'new' : 'profile')}</section><aside><section class="preferences-card"><h3>What your agent looks for</h3><p>${icon('check')}Real vacancy pages with sources</p><p>${icon('check')}Transferable skills, beyond titles</p><p>${icon('check')}Essential vs desirable requirements</p><p>${icon('check')}Gaps and unanswered questions</p><p>${icon('check')}Truthful application next steps</p></section><section class="legend-card"><h3>Previous research</h3>${state.runs.slice(1).map(r => `<div class="past-run"><span>${date(r.startedAt)}</span><small>${r.status} · ${r.count} roles</small></div>`).join('') || '<p class="small-note">Your research history will appear here.</p>'}</section></aside></div>`;
}
function settingsPage() {
  const schedule = state.settings.researchSchedule;
  return `${pageHeading('YOUR WORKSPACE, YOUR WAY', 'A thoughtful setup', 'Connect your agents and understand where your information goes.')}<div class="settings-grid"><section class="form-panel"><div class="settings-title"><span class="integration-icon">${icon('terminal')}</span><div><h2>Codex</h2><p>Research & reasoning · local CLI process</p></div><span class="status-pill ${runtime?.codex ? 'completed' : ''}">${runtime ? runtime.codex ? 'Detected' : 'Not detected' : 'Checking…'}</span></div><p>The app starts your installed Codex CLI using your existing sign-in. Codex researches the market and writes the evidence-backed explanations.</p><div class="code-line">npm install -g @openai/codex<br>codex login</div><p class="small-note">${runtime?.codexVersion ? esc(runtime.codexVersion) : 'Restart Waypoint after installing Codex. If needed, set CODEX_BIN to its executable path.'} The CLI runs locally; inference and web search use your configured provider.</p><button class="button secondary" data-action="check-status">${icon('refresh-cw')}Check connection</button></section><section class="form-panel"><div class="settings-title"><span class="integration-icon jev">∵</span><div><h2>TypeSafe Jev</h2><p>Typed assessments · hosted API</p></div><span class="status-pill ${runtime?.jevConfigured ? 'completed' : ''}">${runtime?.jevConfigured ? 'Key configured' : 'Optional'}</span></div><p>Jev assesses fit type, essential-skill support, and growth alignment. Uncertain or conflicting classifications stay flagged for review.</p><form id="settings-form"><label class="form-field"><span>TypeSafe API key</span><input type="password" name="key" autocomplete="off" placeholder="${runtime?.jevConfigured ? 'Key configured · leave blank to keep it' : 'Enter your TypeSafe API key'}"></label><label class="form-field"><span>Model</span><input name="model" value="${esc(state.settings.jevModel)}"></label><label class="toggle-label"><input type="checkbox" name="enabled" ${state.settings.jevEnabled ? 'checked' : ''}><span>Use Jev in future research runs</span></label><p class="small-note">Enabling Jev sends skills, ambitions, role evidence, and preference feedback to TypeSafe. The raw CV and name are omitted, but evidence may contain personal details. Desktop keys use OS encryption when available; otherwise they stay in memory for this session.</p><button class="button primary" type="submit">Save AI settings ${icon('check')}</button></form></section><section class="form-panel"><div class="settings-title"><span class="integration-icon">${icon('calendar-clock')}</span><div><h2>Daily research</h2><p>Automatic searches · desktop notifications</p></div><span class="status-pill ${schedule.enabled ? 'completed' : ''}">${schedule.enabled ? 'Enabled' : 'Off'}</span></div><p>Research once each day at your chosen local time and notify you only when a genuinely new opportunity appears.</p><form id="schedule-form"><label class="toggle-label"><input type="checkbox" name="enabled" ${schedule.enabled ? 'checked' : ''}><span>Enable daily research</span></label><label class="form-field"><span>Local time</span><input type="time" name="time" value="${esc(schedule.time)}"></label><p class="small-note">Waypoint must remain open or minimized. Scheduled runs use your saved profile and configured Codex account; they never apply or contact anyone. ${schedule.lastRunAt ? `Last scheduled start: ${date(schedule.lastRunAt)}.` : ''}</p><button class="button primary" type="submit">Save schedule ${icon('check')}</button></form></section><section class="form-panel"><div class="settings-title"><span class="integration-icon">${icon('hard-drive')}</span><div><h2>Your data</h2><p>Local by default, under your control</p></div></div><p>Your profile, matches, notes, and feedback are stored in a local JSON file. Profile data is not encrypted by the app; use your device’s disk encryption for protection.</p><div class="button-row"><button class="button secondary" data-action="export-data">${icon('download')}Export workspace</button><button class="button danger" data-action="new">${icon('rotate-ccw')}Start fresh</button></div></section><section class="form-panel"><div class="settings-title"><span class="integration-icon">${icon('message-circle-heart')}</span><div><h2>What you’ve taught Waypoint</h2><p>Feedback changes ranking and future research</p></div></div><div class="feedback-history">${state.feedback.length ? state.feedback.slice().reverse().map(f => `<div><span><strong>${feedbackLabels[f.kind]}</strong><small>${esc(f.title)} · ${esc(f.company)}</small></span><button class="icon-button" data-undo="${f.id}" aria-label="Undo ${esc(feedbackLabels[f.kind])}">${icon('undo-2')}</button></div>`).join('') : '<p class="small-note">Give feedback on an opportunity to start shaping the next search.</p>'}</div></section></div>`;
}
function detailDrawer() {
  const role = state.roles.find(r => r.id === selected);
  if (!role) { selected = null; return ''; }
  const flags = constraints(role, state.profile).filter(f => !role.demo || f !== 'Availability uncertain');
  const application = state.applications.find(a => a.roleId === role.id);
  return `<div class="overlay" data-backdrop="true"><section class="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title"><div class="drawer-toolbar"><span>${icon('scan-search')} OPPORTUNITY BRIEF</span><button class="icon-button" data-action="close" aria-label="Close opportunity">${icon('x')}</button></div><div class="drawer-header"><div class="card-top"><span class="company-logo large logo-${role.company.charCodeAt(0) % 5}">${esc(role.company[0])}</span><div class="company-meta"><strong>${esc(role.company)}</strong><small>${esc(role.industry)}</small></div>${badge(role.fit)}</div><h2 id="detail-title">${esc(role.title)}</h2><div class="role-meta"><span>${icon('map-pin')}${esc(role.location)}</span><span>${icon('laptop')}${role.workMode}</span><span>${esc(salary(role))}</span></div><div class="drawer-actions"><button class="button primary" data-action="prepare">${icon('briefcase-business')}${application ? 'Application preparation' : 'Prepare application'}</button><button class="button secondary" data-save="${esc(role.id)}">${icon('bookmark')}${state.saved.includes(role.id) ? 'Saved' : 'Shortlist'}</button></div>${role.demo ? '<div class="sample-note">Illustrative opportunity · fictional company and vacancy. No live availability is implied.</div>' : `<div class="small-note">Discovered ${date(role.discoveredAt)} · ${role.status === 'open' ? 'Reported open by research agent' : 'Availability needs confirmation'} · Verify before applying.</div>`}</div><div class="detail-tabs" role="tablist">${[['overview', 'The opportunity'], ['evidence', 'Why it fits'], ['prepare', 'Your next steps']].map(([id, title]) => `<button role="tab" aria-selected="${detailTab === id}" class="${detailTab === id ? 'active' : ''}" data-detail-tab="${id}">${title}</button>`).join('')}</div><div class="drawer-body">${detailTab === 'overview' ? `<section class="match-summary"><span class="mini-label">${icon('sparkles')} THE PERSONAL PERSPECTIVE</span><p>${esc(role.summary)}</p><div><strong>${priorityScore(role, state.profile, state.feedback)}<small>/ 100</small></strong><span>Priority score<br><small>Your weighted preferences, not hiring odds</small></span></div></section><h3>What you’d actually do</h3>${list(role.responsibilities)}<div class="detail-facts"><div><small>Seniority</small><strong>${esc(role.seniority)}</strong></div><div><small>Work authorisation</small><strong>${esc(role.workAuthorization)}</strong></div></div>${flags.length ? `<section class="gap-box"><h3>${icon('circle-help')}Worth checking</h3>${list(flags)}</section>` : ''}<h3>Go to the evidence</h3>${role.sources.length ? role.sources.map(s => `<a class="source-link" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"><span>${icon('external-link')}</span><div><strong>${esc(s.title)}</strong><small>${esc(new URL(s.url).hostname)} · agent checked ${date(s.checkedAt)}</small><p>“${esc(s.excerpt)}”</p></div></a>`).join('') : '<p class="small-note">Sample data has no vacancy sources. Live research must include source links and supporting excerpts.</p>'}` : detailTab === 'evidence' ? `<h3>A match you can inspect</h3><p class="body-copy">Every requirement should connect to something real in your experience. Missing evidence is a question to investigate.</p>${role.evidence.map(e => `<article class="evidence-card ${e.assessment}"><div>${icon(e.assessment === 'supported' ? 'circle-check' : 'circle-help')}<strong>${esc(e.requirement)}</strong><small>${e.importance}</small></div><span class="assessment-label">${e.assessment === 'supported' ? 'Supported by your profile' : e.assessment === 'gap' ? 'A gap to explore' : 'Evidence not yet available'}</span><p>${esc(e.candidateEvidence)}</p><small>${esc(e.explanation)}</small></article>`).join('')}<section class="gap-box"><h3>Where you may need to grow</h3>${list(role.gaps)}</section><section class="nonblocker-box"><h3>What may not be a blocker</h3>${list(role.nonBlockers)}</section>${role.jev ? `<section class="jev-result"><h3>Jev’s second perspective</h3><p>Classification: <strong>${esc(role.jev.fit)}</strong> · confidence ${Math.round(role.jev.confidence * 100)}%</p><p>Essential-skill support: ${Math.round(role.jev.supported * 100)}% · ambition alignment: ${Math.round(role.jev.growth * 100)}%</p><small>${role.jev.review ? 'Review needed: low confidence or disagreement with the research. No automatic fit override.' : 'This assessment contributes to the preference score.'} Model assessments are not hiring probabilities.</small></section>` : ''}` : `<h3>Make a considered application</h3><p class="body-copy">Use these suggestions to tell your story clearly. Keep every claim grounded in your actual experience.</p><h4>CV TAILORING & APPLICATION STRATEGY</h4>${list(role.strategy, true)}<h4>INTERVIEW PREPARATION</h4>${list(role.interview)}<h4>QUESTIONS BEFORE YOU APPLY</h4>${list(role.questions)}<form id="application-form"><label class="form-field"><span>Your preparation notes</span><textarea name="notes" rows="4" placeholder="Examples to prepare, questions to ask, dates to remember…">${esc(notesDraft[role.id] ?? application?.notes ?? '')}</textarea></label><div class="application-form-bottom"><label class="form-field"><span>Stage</span><select name="stage">${['Preparing', 'Applied', 'Interview', 'Offer'].map(s => `<option ${application?.stage === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label><button class="button primary" type="submit">Save preparation</button></div></form><button class="button secondary full-width" data-action="export-brief">${icon('download')}Export application brief</button>`}<section class="feedback-box"><h3>Does this feel like you?</h3><p>A little feedback makes the next search more personal.</p><div>${(Object.keys(feedbackLabels) as FeedbackKind[]).map(kind => `<button class="feedback-chip ${state.feedback.some(f => f.roleId === role.id && f.kind === kind) ? 'chosen' : ''}" data-feedback="${kind}">${kind === 'more' ? icon('thumbs-up') : ''}${feedbackLabels[kind]}</button>`).join('')}</div><small>Feedback is saved. Undo it any time in Settings.</small></section></div></section></div>`;
}
function list(items: string[], ordered = false) { const tag = ordered ? 'ol' : 'ul'; return `<${tag} class="detail-list">${items.map(x => `<li>${esc(x)}</li>`).join('') || '<li>No additional details were reported.</li>'}</${tag}>`; }
function modalView() {
  return `<div class="overlay centered" data-backdrop="true"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button class="icon-button modal-close" data-action="close" aria-label="Close dialog">${icon('x')}</button>${modal === 'filters' ? `<span class="mini-label">ON YOUR TERMS</span><h2 id="modal-title">A little more focus.</h2><p>Find the opportunities that work for your life.</p><form id="filter-form"><label class="form-field"><span>Work arrangement</span><select name="mode"><option value="all">All arrangements</option>${['Remote', 'Hybrid', 'On-site'].map(m => `<option ${m === modeFilter ? 'selected' : ''}>${m}</option>`).join('')}</select></label><label class="check-row"><input name="salary" type="checkbox" ${salaryFilter ? 'checked' : ''}><span>Salary meets my minimum<small>Only disclosed annual salaries in ${state.profile.currency}. Unknowns are excluded.</small></span></label><label class="check-row"><input name="conflicts" type="checkbox" ${hideConflicts ? 'checked' : ''}><span>Hide salary, arrangement, and industry conflicts<small>Also excludes roles with missing salary or uncertain Jev fit.</small></span></label><button class="button primary full-width" type="submit">Show opportunities ${icon('arrow-right')}</button></form>` : `<span class="mini-label">YOUR NEXT CHAPTER</span><h2 id="modal-title">Let’s make it yours.</h2><p>${state.demo ? 'Start with a blank profile. The sample opportunities will be removed so your research is grounded in your own experience.' : 'This clears your profile, research, shortlist, application notes, and feedback. Your AI connection settings are kept.'}</p>${!state.demo ? '<button class="button secondary full-width" data-action="export-data">Export my workspace first</button>' : ''}<button class="button primary full-width" data-action="confirm-new">${state.demo ? 'Create my profile' : 'Clear workspace & start fresh'} ${icon('arrow-right')}</button>`}</section></div>`;
}

function render() {
  for (const id of selectedRoleIds) if (!state.roles.some(role => role.id === id)) selectedRoleIds.delete(id);
  const views: Record<string, () => string> = { discover, paths: pathsPage, saved: savedPage, applications: applicationsPage, profile: profilePage, research: researchPage, settings: settingsPage };
  root.innerHTML = shell(views[page]());
  createIcons({ icons, attrs: { 'stroke-width': 1.65 } });
  document.body.classList.toggle('dialog-open', Boolean(selected || modal));
  document.querySelector('.main-shell')?.setAttribute('aria-hidden', selected || modal ? 'true' : 'false');
  if (selected || modal) document.querySelector<HTMLElement>('[role="dialog"] button')?.focus();
}
async function research() {
  if (activeRun()) { navigate('research'); return; }
  if (state.demo) { openDialog(); modal = 'new'; render(); return; }
  if (state.profile.background.trim().length < 80 || !state.profile.ambitions.trim() || !state.profile.locations.trim() || !state.profile.workAuthorization.trim()) {
    navigate('profile'); toast('Complete your career history, ambitions, preferred locations, and work-authorisation details before researching.'); return;
  }
  await mutate('startResearch');
  if (activeRun()) navigate('research');
}
async function removeSelectedRoles() {
  const ids = [...selectedRoleIds];
  if (!ids.length || !confirm(`Remove ${ids.length} selected ${ids.length === 1 ? 'opportunity' : 'opportunities'}? Shortlist entries, application notes, and feedback for them will also be removed.`)) return;
  busy = true;
  try { state = await call('removeRoles', ids); selectedRoleIds.clear(); render(); toast(`${ids.length} ${ids.length === 1 ? 'opportunity' : 'opportunities'} removed.`); }
  catch (e) { toast((e as Error).message); }
  finally { busy = false; }
}
async function saveProfile() {
  captureProfile();
  if (!draft) return;
  try {
    state = await call('saveProfile', draft); dirty = false; draft = structuredClone(state.profile); render(); toast('Profile saved. Your next research run will use this context.');
  } catch (e) { toast((e as Error).message); }
}
function exportBrief(role: Opportunity) {
  const app = state.applications.find(a => a.roleId === role.id);
  const section = (title: string, items: string[]) => `\n## ${title}\n${items.map(x => `- ${x}`).join('\n')}\n`;
  download(`waypoint-${role.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-brief.md`, `# ${role.title} · ${role.company}\n\n${role.demo ? 'ILLUSTRATIVE SAMPLE — not a real vacancy.\n\n' : ''}${role.summary}\n\n${salary(role)} · ${role.location} · ${role.workMode}\n${section('Application strategy', role.strategy)}${section('Interview preparation', role.interview)}${section('Questions to investigate', role.questions)}${section('Gaps', role.gaps)}${section('Sources', role.sources.map(s => `${s.title}: ${s.url} (agent checked ${s.checkedAt})`))}\n## My notes\n${app?.notes || ''}\n`);
}

root.addEventListener('click', async event => {
  const target = event.target as HTMLElement;
  if (target.dataset.backdrop) { closeDialog(); return; }
  const button = target.closest<HTMLElement>('button,a'); if (!button) return;
  if (button.dataset.nav) { event.preventDefault(); navigate(button.dataset.nav); return; }
  if (button.dataset.role) { openDialog(); selected = button.dataset.role; detailTab = 'overview'; render(); return; }
  if (button.dataset.save) { await mutate('toggleSave', [button.dataset.save]); return; }
  if (button.dataset.fit) { fitFilter = button.dataset.fit; render(); return; }
  if (button.dataset.pathFit) { fitFilter = button.dataset.pathFit; navigate('discover'); return; }
  if (button.dataset.step) { captureProfile(); profileStep = button.dataset.step; render(); return; }
  if (button.dataset.detailTab) { detailTab = button.dataset.detailTab; render(); return; }
  if (button.dataset.feedback && selected) { await mutate('feedback', [selected, button.dataset.feedback], 'Got it. Your feedback will shape ranking and future research.'); return; }
  if (button.dataset.undo) { await mutate('undoFeedback', [button.dataset.undo], 'Feedback removed.'); return; }
  switch (button.dataset.action) {
    case 'new': openDialog(); modal = 'new'; render(); break;
    case 'confirm-new':
      try { state = await call('reset'); modal = null; draft = structuredClone(blankProfile); dirty = false; page = 'profile'; profileStep = 'story'; render(); } catch (e) { toast((e as Error).message); } break;
    case 'close': closeDialog(); break;
    case 'filters': openDialog(); modal = 'filters'; render(); break;
    case 'clear-filters': fitFilter = 'all'; modeFilter = 'all'; query = ''; salaryFilter = false; hideConflicts = false; render(); break;
    case 'select-visible': {
      const roles = currentRoles(); const clear = roles.length > 0 && roles.every(role => selectedRoleIds.has(role.id));
      for (const role of roles) clear ? selectedRoleIds.delete(role.id) : selectedRoleIds.add(role.id);
      render(); break;
    }
    case 'remove-selected': await removeSelectedRoles(); break;
    case 'profile': navigate('profile'); break;
    case 'discover': navigate('discover'); break;
    case 'preferences': profileStep = 'preferences'; navigate('profile'); break;
    case 'next-step': captureProfile(); profileStep = profileStep === 'story' ? 'preferences' : 'priorities'; render(); break;
    case 'save-profile': await saveProfile(); break;
    case 'research': await research(); break;
    case 'cancel-research': await mutate('cancelResearch', [], 'Research cancellation requested.'); break;
    case 'prepare': detailTab = 'prepare'; render(); break;
    case 'check-status': runtime = await call<RuntimeStatus>('status'); render(); toast(runtime.codex ? 'Codex CLI detected.' : 'Codex was not found. See the setup instructions.'); break;
    case 'export-data': download('waypoint-workspace.json', JSON.stringify(state, null, 2), 'application/json'); toast('Workspace exported. It contains your personal profile and notes.'); break;
    case 'export-shortlist': download('waypoint-shortlist.json', JSON.stringify(state.roles.filter(r => state.saved.includes(r.id)), null, 2), 'application/json'); break;
    case 'export-brief': if (selected) exportBrief(state.roles.find(r => r.id === selected)!); break;
  }
});
root.addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'search') {
    query = input.value; const list = document.querySelector('#role-list'); const roles = currentRoles();
    if (list) { list.innerHTML = roles.length ? roles.map(roleCard).join('') : empty('No matching opportunities', 'Try a different role, company, or skill.', 'Clear filters', 'clear-filters'); createIcons({ icons }); }
  }
  if (input.closest('#application-form') && input.name === 'notes' && selected) notesDraft[selected] = input.value;
  if (input.closest('#profile-form')) { dirty = true; if (input.type === 'range') { const output = input.closest('label')?.querySelector('output'); if (output) output.textContent = input.value; } }
});
root.addEventListener('change', async event => {
  const input = event.target as HTMLInputElement;
  if (input.dataset.selectRole) { input.checked ? selectedRoleIds.add(input.dataset.selectRole) : selectedRoleIds.delete(input.dataset.selectRole); render(); return; }
  if (input.id === 'sort') { sort = input.value; render(); }
  if (input.dataset.stage) { const a = state.applications.find(a => a.roleId === input.dataset.stage); await mutate('setApplication', [input.dataset.stage, input.value, a?.notes || ''], 'Application stage updated.'); }
  if (input.id === 'cv-upload' && input.files?.[0]) {
    const file = input.files[0];
    if (file.size > 8 * 1024 * 1024) { toast('Choose a CV smaller than 8 MB.'); return; }
    captureProfile(); toast('Extracting your CV locally…');
    try {
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
      const text = await call<string>('importCV', file.name, data);
      if (draft) { draft.background = text; dirty = true; render(); toast('CV imported. Review the extracted career history before saving.'); }
    } catch (e) { toast((e as Error).message); }
  }
});
root.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target as HTMLFormElement; const fd = new FormData(form);
  if (form.id === 'profile-form') { await saveProfile(); return; }
  if (form.id === 'filter-form') { modeFilter = String(fd.get('mode')); salaryFilter = fd.has('salary'); hideConflicts = fd.has('conflicts'); closeDialog(); return; }
  if (form.id === 'settings-form') {
    try { state = await call('settings', { ...state.settings, jevEnabled: fd.has('enabled'), jevModel: String(fd.get('model')).trim() }, String(fd.get('key')).trim() || undefined); runtime = await call<RuntimeStatus>('status'); render(); toast('AI settings saved.'); } catch (e) { toast((e as Error).message); }
  }
  if (form.id === 'schedule-form') {
    try { state = await call('schedule', { enabled: fd.has('enabled'), time: String(fd.get('time')) }); render(); toast(fd.has('enabled') ? 'Daily research enabled.' : 'Daily research disabled.'); } catch (e) { toast((e as Error).message); }
  }
  if (form.id === 'application-form' && selected) { await mutate('setApplication', [selected, String(fd.get('stage')), String(fd.get('notes'))], 'Application preparation saved.'); }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && (selected || modal)) closeDialog();
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) { const search = document.querySelector<HTMLInputElement>('#search'); if (search) { event.preventDefault(); search.focus(); } }
  if (event.key === 'Tab' && (selected || modal)) {
    const focusable = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="dialog"] input, [role="dialog"] select, [role="dialog"] textarea, [role="dialog"] a')].filter(e => !e.hasAttribute('disabled'));
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
window.addEventListener('beforeunload', event => { if (dirty) event.preventDefault(); });
async function boot() {
  try {
    state = await call('getState'); render();
    window.dispatchEvent(new CustomEvent('waypoint-ready'));
    runtime = await call<RuntimeStatus>('status'); if (page === 'settings') render();
    setInterval(async () => {
      if (!activeRun()) return;
      try { const fresh = await call<AppState>('getState'); const completed = !fresh.runs.some(r => r.status === 'running'); state = fresh; if (!selected && !modal && page !== 'profile') render(); if (completed) toast(fresh.runs[0].status === 'completed' ? 'Your research is ready to explore.' : fresh.runs[0].error || 'Research stopped.'); } catch { /* transient fetch failure leaves last-known state visible */ }
    }, 1800);
  } catch (e) { root.innerHTML = `<div class="startup-error"><h1>Let’s get Waypoint running.</h1><p>${esc((e as Error).message)}</p><p>Start the local app with <code>npm run dev</code> or <code>npm start</code>, then reload.</p></div>`; }
}
void boot();
