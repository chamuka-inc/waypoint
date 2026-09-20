# Waypoint

A personal career research desktop app. Bring your experience, preferences, and ambitions; investigate direct-fit, adjacent, and sensible stretch opportunities with source evidence and actionable next steps.

[Website](https://chamuka-inc.github.io/waypoint/) · [Download the latest release](https://github.com/chamuka-inc/waypoint/releases/latest)

**Implemented stack:** Electrobun 2 + Bun + system webviews, HTML/CSS/TypeScript, Vite, local Codex CLI, and TypeSafe Jev. The privileged main process and renderer communicate through a single typed Electrobun RPC boundary. The browser preview uses the same application service over a loopback-only HTTP bridge.

## Run the desktop app

Use Node.js 22.16 or later (Node 24 recommended), npm, and a supported desktop session: macOS 14+ on Apple Silicon, Windows 11+, or Ubuntu 24.04+. Other Linux distributions with GTK 3 and WebKitGTK 4.1 are community-supported by Electrobun. Electrobun 2 does not currently provide an Intel macOS runtime.

```sh
npm ci
npm start
```

The first launch has a clearly labelled sample profile and **fictional opportunities**. Click **Make it yours** to create a real profile. Existing demo matches are removed when you create or save your own profile.

For a browser preview using the same local service:

```sh
npm run dev
```

Open `http://127.0.0.1:4173`. The preview is bound to loopback and is not a hosted website. Do not open `index.html` directly; the application needs its local service. Desktop and preview use separate workspaces.

## Connect the AI

### Codex — research and explanations

Install and sign in to the Codex CLI on the same computer:

```sh
npm install -g @openai/codex
codex login
codex --version
```

Restart Waypoint, then check **Settings → Codex**. For applications launched outside a terminal, ensure Codex is on the inherited PATH, or launch with `CODEX_BIN` set to an absolute executable path. On Windows, use an actual executable rather than a shell-only `.cmd` shim; the app deliberately uses `shell: false`.

The app invokes the installed CLI with live web search, a read-only sandbox, an ephemeral session, JSON events, and a JSON output schema. It uses the account/model configured in your CLI. CV content is sent through stdin rather than a command-line argument. No key is embedded in the app.

The CLI process runs locally. **Model inference and search are not offline**: they use your configured Codex provider. The whole profile is included in the research brief; avoid including contact information you do not want sent. Prompts instruct the agent to use generic role/skill/location search terms, never raw CV text, and not to submit applications or contact people. The app does not override your installed Codex policy or configuration.

### Jev — narrow, typed assessments

TypeSafe Jev is a hosted structured-decision model, not a prose generator. Add a TypeSafe key in **Settings → TypeSafe Jev**, leave the model as `jev-latest` (or an available pinned Jev version), and enable it. An environment variable `TYPESAFE_API_KEY` is also supported.

After Codex produces a sourced report, Jev evaluates three separate questions per role:

| Question | Primitive | Use |
| --- | --- | --- |
| Relationship between experience and role | Choice | Direct / adjacent / stretch / uncertain |
| Evidence supporting essential responsibilities | Noul | Contributes to priority ranking when reliable |
| Alignment with career ambitions | Noul | Shown in the explanation for review |

The adapter calls `POST https://api.typesafe.ai/v1/systemone` with documented `state`, `model`, and `questions` fields. It validates response probabilities. Choice confidence below 0.65, an uncertain choice, or disagreement with Codex flags the assessment for review. Such assessments never silently change fit or ranking. The threshold is a product default, not a calibrated hiring guarantee. Jev failures leave Codex results intact and appear in research activity.

Jev receives skills, ambitions, seniority, opportunity responsibilities/evidence, selected preferences, and feedback. It does not receive the dedicated name field or raw CV, but free-text evidence can still contain personal information. Keys are kept out of the renderer and saved workspace. Desktop- and preview-entered keys remain in memory for the current session; `TYPESAFE_API_KEY` is the persistent deployment option until Electrobun exposes a cross-platform credential store.

## Candidate workflow

1. **My profile:** Import a PDF, DOCX, TXT, or Markdown CV, or paste a LinkedIn-style profile. Extraction is local and reviewable. Add skills, projects, qualifications, outcomes, scope, and history. Scanned PDFs need OCR text supplied by the user.
2. **Your next move:** Set salary/currency, location, remote/hybrid/on-site preferences, commute, industries, exclusions, seniority, work authorisation, and ambitions.
3. **What matters most:** Weight experience fit, compensation, flexibility, and progression. Scores are preference ordering aids, not hiring probabilities.
4. **Research opportunities:** Codex identifies role families, searches live sources, investigates vacancies, and returns a structured report. The research activity view shows safe public source links as they are found and reviewed. Research continues while you use other views. It has a 12-minute limit and can be cancelled.
5. **Discover / Career paths:** Explore direct, adjacent, and stretch options. Filter and search; inspect evidence, responsibilities, salary, location, gaps, and source excerpts. Select and remove one or more opportunities when they are no longer useful. Vacancy status is reported by the research agent and should be checked before applying.
6. **Shortlist / Applications:** Save roles, prepare truthful CV/interview examples, add notes, export a Markdown brief, and move applications through Preparing, Applied, Interview, and Offer.
7. **Feedback:** “More like this”, “Too technical”, “Too junior”, salary/industry objections, and “Not for me” influence ordering and subsequent research. Undo feedback in Settings.

In the desktop app, **Settings → Daily research** can run research once a day at a chosen local time. Waypoint must remain open or minimized. It sends an operating-system notification only when a new stable opportunity ID appears; it never applies or contacts anyone.

## Data and source handling

- Data lives in Electrobun's application-scoped `userData` directory (`state.json`). Browser preview uses `.local-data/` or `WAYPOINT_DATA_DIR`.
- The app stores profile/research data as local JSON with atomic replacement and restrictive file modes where supported. **Profile data is not application-encrypted.** Device disk encryption is recommended for sensitive CVs.
- Research runs are single-flight. Profile/AI-setting changes are blocked during a run to keep results tied to a stable input revision.
- Results must satisfy a schema. Every imported role needs a public HTTPS source and non-empty evidence excerpt. Closed roles are excluded; duplicate company/title/location combinations are removed; inconsistent salary ranges reject the report.
- URL and schema checks do not independently prove the vacancy or quotation. The UI explicitly calls this agent-checked evidence; human confirmation remains necessary. Inaccessible sources should produce unknowns or no result, not fictional vacancies.
- Salary amounts preserve currency and pay period. Annual salary filtering/sorting only compares the user's currency; the app does not invent exchange rates or annualise hourly contracts.
- Unknown salary, work arrangement, exclusions, and uncertain Jev fit remain visible as separate checks. Remote is not assumed to mean worldwide.
- Saved/application roles absent from a new run are retained and marked uncertain. Stable IDs preserve notes when the same role returns.
- The opportunity workspace holds at most 50 roles. Newer research replaces the oldest roles and removes their associated shortlist, application, and feedback records.
- Export your workspace or shortlist from Settings/Shortlist. Workspace export contains personal data but no stored API key. To restore a backup, quit the app, preserve the existing `state.json`, replace it with a compatible exported file, and relaunch. There is no in-app restore UI yet.
- “Start fresh” requires a confirmation in the app and clears candidate data; connection settings are retained.

## Development and verification

```sh
npm run build       # strict TypeScript checks + browser-preview frontend bundle
npm test            # service, schema, ranking, Jev contract, CLI subprocess, HTTP, CV extraction
npx playwright install chromium
npm run test:ui     # real-browser workflow tests, simulated AI provider
```

The UI suite uses an isolated temporary workspace and deletes it afterwards. It exercises navigation, filters, evidence, saved roles, application notes, feedback undo, local CV import, profile steps, research progress, source links, and narrow-screen layout. Screenshots go to `test-artifacts/`. `CHROMIUM_PATH` and `SCREENSHOT_DIR` are optional test-runner overrides.

The Codex subprocess test uses a controlled executable; the Jev test uses simulated HTTP responses. **No authenticated live Codex or Jev call is made by the automated suite.** Electrobun builds must run on a native supported runner; the release workflow covers macOS ARM64, Windows x64, and Linux x64.

## Packaging

```sh
npm run package    # stable Electrobun bundle and installer for this platform
npm run dist       # alias for the stable package build
```

Electrobun produces a DMG on macOS ARM64, a Setup ZIP on Windows x64, and a self-extracting installer tarball on Linux. Release metadata points to GitHub Releases for updates. Signing and notarisation remain disabled until platform credentials are configured; verify each installed build with your actual CLI login and TypeSafe account before distribution.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/app.ts`, `src/style.css` | Candidate workspace and responsive visual design |
| `src/types.ts`, `src/ranking.ts` | Shared types, preference weighting, constraint checks |
| `src/demo.ts` | Clearly fictional first-launch sample |
| `server/service.ts` | Persistence, CV parsing, application state, run lifecycle |
| `server/codex.ts`, `server/schema.ts` | Codex subprocess, prompt, structured output validation |
| `server/jev.ts` | TypeSafe typed questions and confidence gate |
| `server/preview.ts` | Loopback-only development service and Vite preview |
| `desktop/main.ts`, `src/electrobun-entry.ts` | Electrobun shell, typed RPC, notifications, and scheduled research |
| `electrobun.config.ts`, `hutch.config.ts` | Native packaging, runtime pin, and build tasks |
| `tests/`, `scripts/verify-ui.mjs` | Core tests, fixtures, and browser workflow checks |

## Current boundaries

This is a working first implementation, not a fully hardened employment-data platform. It has no job-board login automation, LinkedIn scraping, scheduling while the desktop process is not running, automatic application submission, CV rewriting into a new DOCX, OCR, cloud sync, or multi-user accounts. Source discovery depends on the installed Codex version, web-search access, account permissions, and vacancy accessibility. It does not bypass paywalls or access restrictions. Model judgments can be wrong even when the returned data is schema-valid.

The next production gates are authenticated end-to-end research evaluation, provider-specific search/source coverage testing, native packaging on the target OS, document-parser isolation and resource-limit hardening, accessibility auditing, and a labelled evaluation set for Jev thresholds and candidate-fit quality.

## API references checked

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode): CLI invocation, JSON events, output schemas, ephemeral sessions, existing authentication.
- [TypeSafe introduction](https://docs.typesafe.ai/introduction): Jev's typed decision model and atomic questions.
- [TypeSafe quick start](https://docs.typesafe.ai/introduction/quickstart): endpoint, authentication, request/response shape, `jev-latest`.
- [Electrobun documentation](https://framework.blackboard.sh/electrobun/): system webviews, typed RPC, application paths, packaging, and updates.
