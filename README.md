# Waypoint

A personal career research desktop app. Bring your experience, preferences, and ambitions; investigate direct-fit, adjacent, and sensible stretch opportunities with source evidence and actionable next steps.

[Website](https://chamuka-inc.github.io/waypoint/) · [Download the latest release](https://github.com/chamuka-inc/waypoint/releases/latest)

**Implemented stack:** Wails 2 + Go, SQLite, HTML/CSS/TypeScript, Vite, local Codex CLI, and TypeSafe Jev. Wails uses the operating system's webview, while the native service, persistence, scheduling, document parsing, and provider adapters run in a compiled Go binary. No Node runtime or bundled Chromium is included in the installed application.

## Run the desktop app

Use Go 1.25, Node.js 22.16 or later (Node 24 recommended), npm, and a desktop session on macOS, Windows, or Linux. The npm scripts run the pinned Wails 2.16 CLI through Go.

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

Jev receives skills, ambitions, seniority, opportunity responsibilities/evidence, selected preferences, and feedback. It does not receive the dedicated name field or raw CV, but free-text evidence can still contain personal information. Keys are kept out of the renderer and saved workspace. Desktop keys use the operating system credential store when available; if the credential service is unavailable they remain in memory for the current session. Preview-entered keys are session-only.

## Candidate workflow

1. **My profile:** Import a PDF, DOCX, TXT, or Markdown CV, or paste a LinkedIn-style profile. Extraction is local and reviewable. Add skills, projects, qualifications, outcomes, scope, and history. Scanned PDFs need OCR text supplied by the user.
2. **Your next move:** Set salary/currency, location, remote/hybrid/on-site preferences, commute, industries, exclusions, seniority, work authorisation, and ambitions.
3. **What matters most:** Weight experience fit, compensation, flexibility, and progression. Scores are preference ordering aids, not hiring probabilities.
4. **Research opportunities:** Codex identifies role families, searches live sources, investigates vacancies, and returns a structured report. The research activity view shows safe public source links as they are found and reviewed. Research continues while you use other views. It has a 12-minute limit and can be cancelled.
5. **Discover / Career paths:** Explore direct, adjacent, and stretch options. Filter and search; inspect evidence, responsibilities, salary, location, gaps, and source excerpts. Select and remove one or more opportunities when they are no longer useful. Vacancy status is reported by the research agent and should be checked before applying.
6. **Shortlist / Applications:** Save roles, prepare truthful CV/interview examples, add notes, export a Markdown brief, and move applications through Preparing, Applied, Interview, and Offer.
7. **Feedback:** “More like this”, “Too technical”, “Too junior”, salary/industry objections, and “Not for me” influence ordering and subsequent research. Undo feedback in Settings.
8. **Workspaces:** Use the identity card at the bottom of the sidebar to switch or create an isolated workspace. Create blank, copy profile/preferences only, or import a JSON export. Manage rename, archive, restore, recently deleted, and permanent deletion from Settings.

In the desktop app, **Settings → Daily research** can run research once a day at a chosen local time. Waypoint must remain open or minimized. Due research is serialised across all active workspaces; archived and recently deleted workspaces are skipped. Notifications name the workspace and appear only when a new stable opportunity ID appears. Waypoint never applies or contacts anyone.

## Data and source handling

- Desktop data lives in the operating system's user configuration directory. `Waypoint/catalog.db` tracks local workspace metadata, the original workspace remains at `Waypoint/waypoint.db`, and additional workspaces use `Waypoint/workspaces/<id>/waypoint.db`. Browser preview mirrors the architecture with `catalog.json` and isolated `state.json` files. Developers can set an absolute `WAYPOINT_DATA_DIR` to isolate either runtime.
- The desktop app stores profile and research data in a local SQLite database with transactional writes, foreign-key integrity, schema versioning, and restrictive file modes where supported. Nested evidence payloads remain JSON inside relational rows. **Profile data is not application-encrypted.** Device disk encryption is recommended for sensitive CVs.
- On the first SQLite launch, a compatible legacy `Waypoint/state.json` is imported automatically and left unchanged as a recovery backup. Once `waypoint.db` contains a workspace, it is the source of truth.
- Research runs are single-flight. Profile/AI-setting changes are blocked during a run to keep results tied to a stable input revision.
- Results must satisfy a schema. Every imported role needs a public HTTPS source and non-empty evidence excerpt. Closed roles are excluded; duplicate company/title/location combinations are removed; inconsistent salary ranges reject the report.
- URL and schema checks do not independently prove the vacancy or quotation. The UI explicitly calls this agent-checked evidence; human confirmation remains necessary. Inaccessible sources should produce unknowns or no result, not fictional vacancies.
- Salary amounts preserve currency and pay period. Annual salary filtering/sorting only compares the user's currency; the app does not invent exchange rates or annualise hourly contracts.
- Unknown salary, work arrangement, exclusions, and uncertain Jev fit remain visible as separate checks. Remote is not assumed to mean worldwide.
- Saved/application roles absent from a new run are retained and marked uncertain. Stable IDs preserve notes when the same role returns.
- The opportunity workspace holds at most 50 roles. Newer research replaces the oldest roles and removes their associated shortlist, application, and feedback records.
- Export your workspace or shortlist from Settings/Shortlist. Workspace exports remain portable JSON and contain personal data but no stored API key. Import an export when creating a workspace; see [`docs/persistence.md`](docs/persistence.md) for storage and lower-level recovery details.
- “Start fresh” requires a confirmation in the app and clears candidate data; connection settings are retained.

## Development and verification

```sh
npm run build       # strict TypeScript checks + frontend bundle
npm test            # service, schema, ranking, Jev contract, CLI subprocess, HTTP, CV extraction
npm run test:go     # Wails service, persistence, scheduling, validation, and document imports
npx playwright install chromium
npm run test:ui     # real-browser workflow tests, simulated AI provider
```

The UI suite uses an isolated temporary data directory and deletes it afterwards. It exercises navigation, filters, evidence, saved roles, application notes, feedback undo, local CV import, profile steps, research progress, source links, workspace creation/switching/lifecycle management, and narrow-screen layout. Screenshots go to `test-artifacts/`. `CHROMIUM_PATH` and `SCREENSHOT_DIR` are optional test-runner overrides.

The Codex subprocess test uses a controlled executable; the Jev test uses simulated HTTP responses. **No authenticated live Codex or Jev call is made by the automated suite.** Release automation builds a universal macOS application, a Windows x64 NSIS installer, and a Linux x64 Debian package. It launches the packaged Linux binary under a virtual display and verifies that the webview completes its call into the Go service.

## Packaging

```sh
npm run package    # native Wails application for this platform
npm run dist       # equivalent local production build
```

The GitHub Actions release workflow creates DMG, NSIS, and Debian artifacts on their native runners. Tagged builds attach them and a `SHA256SUMS.txt` file to the corresponding GitHub Release. The macOS build is currently unsigned and not notarised. After macOS blocks the first launch, open **System Settings → Privacy & Security**, scroll to Security, choose **Open Anyway**, and confirm **Open**. Compare the DMG's `shasum -a 256` output with `SHA256SUMS.txt` before overriding Gatekeeper. No automatic updater is configured.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/app.ts`, `src/style.css` | Candidate workspace and responsive visual design |
| `src/types.ts`, `src/ranking.ts` | Shared types, preference weighting, constraint checks |
| `src/demo.ts` | Clearly fictional first-launch sample |
| `internal/waypoint/` | Go SQLite repository, CV parsing, application state, Codex/Jev adapters, and run lifecycle |
| `app.go`, `main.go` | Wails bridge, native window, scheduling, notifications, and external-link handling |
| `server/` | Loopback-only browser preview and TypeScript reference service |
| `tests/`, `scripts/verify-ui.mjs` | Core tests, fixtures, and browser workflow checks |

## Current boundaries

This is a working first implementation, not a fully hardened employment-data platform. It has no job-board login automation, LinkedIn scraping, scheduling while the desktop process is not running, automatic application submission, CV rewriting into a new DOCX, OCR, cloud sync, or multi-user accounts. Source discovery depends on the installed Codex version, web-search access, account permissions, and vacancy accessibility. It does not bypass paywalls or access restrictions. Model judgments can be wrong even when the returned data is schema-valid.

The next production gates are authenticated end-to-end research evaluation, provider-specific search/source coverage testing, native packaging on the target OS, document-parser isolation and resource-limit hardening, accessibility auditing, and a labelled evaluation set for Jev thresholds and candidate-fit quality.

## API references checked

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode): CLI invocation, JSON events, output schemas, ephemeral sessions, existing authentication.
- [TypeSafe introduction](https://docs.typesafe.ai/introduction): Jev's typed decision model and atomic questions.
- [TypeSafe quick start](https://docs.typesafe.ai/introduction/quickstart): endpoint, authentication, request/response shape, `jev-latest`.
- [Wails documentation](https://wails.io/docs/introduction): native bindings, system webviews, platform builds, and runtime APIs.
