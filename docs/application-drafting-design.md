# Opportunity application drafting

Status: implemented. The current editor saves application and CV text with role-linked evidence, review status, regeneration, and TXT/DOCX/PDF export. The sections below preserve the original product design; implementation details are in the application and service code.

## Outcome

From one opportunity, a user can ask their configured Codex agent to create two editable, saved artifacts: an application draft and a tailored résumé (called a CV in Waypoint's UK interface). The user can inspect the evidence behind suggested claims, correct the text, and export it. Waypoint does not submit an application or contact an employer.

## Entry and flow

Add **Draft application and CV** to the opportunity drawer's **Your next steps** tab, beside the existing preparation notes and brief export. Show the same action on an Applications card after the opportunity has reached Preparing. Keep the existing **Prepare application** action: it continues to open the tab and does not silently start generation.

1. **Check the inputs.** A compact setup panel shows the opportunity title, employer, vacancy source and last checked date, plus the profile revision to be used. It asks for an optional focus (for example, an achievement to emphasise) and an optional pasted job description if the linked vacancy is inaccessible or incomplete. The pasted description is labelled user supplied, not independently verified. It shows any missing contact fields; these can be added in the editor later. The action is unavailable in the sample workspace and when Codex is not configured. A role with no credible vacancy source needs a pasted job description and a clear evidence warning.
2. **Generate.** Clicking **Create drafts with Codex** creates one job for this opportunity. The UI shows `Preparing context → Drafting → Checking claims → Ready`, with Cancel and a clear error/retry state. The user can leave the drawer and see progress on the Applications card. No draft is replaced until a new result passes validation and the user chooses to replace it.
3. **Review.** Open a dedicated editor from the drawer or Applications card. Two tabs, **Application draft** and **Tailored CV**, show editable content. A third **Evidence & questions** panel lists the profile passage or candidate supplied fact behind each substantive claim, role requirements being addressed, and anything Codex could not support. Unsupported suggestions are questions for the user, never inserted into exported text as facts. Mark generated text **Needs your review** until the user explicitly marks each artifact reviewed.
4. **Save and export.** Edits save locally, with visible saved/unsaved state and a timestamp. Export each artifact separately as a clean DOCX and PDF, plus plain text for application portals. The output contains only reviewed content and user entered contact details. Download names include the employer, role and date. The existing Markdown application brief remains a separate preparation aid.

### Editor sketch

```text
Acme · Product Manager                         Drafts saved 14:32
Vacancy checked 20 Sep · Profile changed since generation [Review]

[Application draft] [Tailored CV]        [Evidence & questions]

Application draft                         Evidence for selected paragraph
┌──────────────────────────────────────┐  ┌─────────────────────────────┐
│ Dear hiring team, ...                 │  │ Requirement: stakeholder... │
│                                      │  │ Profile: “Led ...”          │
│ [editable text]                      │  │ Check: missing metric       │
└──────────────────────────────────────┘  └─────────────────────────────┘

[Regenerate from current inputs]  [Mark reviewed]  [Export ▾]
```

On a narrow screen, stack the editor and evidence panel, keeping artifact tabs and save/export controls reachable without horizontal scrolling. Give generation status a text label and live announcement. Preserve focus when switching tabs, and warn before leaving with unsaved edits.

## Content contract

**Application draft** means a role specific cover letter or application statement, with an optional set of short, reusable answers for common application prompts. It references the employer and role, uses two or three supported examples, explains fit and motivation, and avoids assumed employer values, fabricated results, or promises of availability. It is editable prose, never a completed employer form.

**Tailored CV** keeps the candidate's actual employers, titles, dates, qualifications, and achievements. It may reorder relevant experience, rewrite summaries and bullets for clarity, and foreground matching skills. It must not silently fill missing dates, metrics, credentials, contact details, or work authorisation. A structured section model (header, summary, skills, experience, projects, education/qualifications) supports editing and stable DOCX/PDF rendering. If the imported CV is only flattened text, Codex proposes a structure and flags uncertain field boundaries for review.

Generation uses the saved profile, candidate approved focus text, an immutable snapshot of the chosen opportunity and its source excerpts, and the current application notes. It does not send the whole workspace, other opportunities, feedback history, or Jev key. Vacancy content and candidate text are treated as data, not agent instructions. Existing Codex authentication is reused; the setup panel states that this content goes to the configured Codex provider. No web search is required for drafting, so the run uses the existing read-only, ephemeral, schema constrained Codex pattern without `--search`. If the user chooses **Refresh vacancy first**, that is a separate sourced research step.

The structured response has `applicationDraft`, `tailoredCV`, `claimEvidence`, `openQuestions`, and `warnings`. Each claim reference identifies a profile passage or explicit user input and the role requirement it addresses. Validate lengths, section shape, required fields, and reference IDs before saving. A validator cannot establish that prose is true, so the editor asks the user to confirm it. Discard partial or invalid output and preserve the last good draft.

## Data and service design

Store a `DraftBundle` per opportunity and workspace, separate from the current `Application` stage/notes record. It contains stable bundle and role IDs; a small opportunity snapshot and source URLs; generated and edited versions of both artifacts; claim references and questions; status; creation/update timestamps; the profile revision, opportunity fingerprint and generation input hash. Keep the user's edited version distinct from generated output so regeneration can show a comparison and cannot overwrite edits. A regenerated result becomes a new revision only after the user accepts it. Mark a draft stale when the profile or opportunity changes, without changing existing text or review decisions.

Add `application_drafts` and `draft_runs` tables in a versioned SQLite migration, with bounded text sizes and workspace transaction semantics. Add draft data to workspace JSON export/import and schema validation. The renderer gets only service methods such as `startDraft(roleId, focus, suppliedDescription)`, `cancelDraft(runId)`, `saveDraft(bundleId, revision, edits)`, `acceptRegeneration(...)`, `markReviewed(...)`, and `getDraft(roleId)`. A revision check prevents an old editor tab from overwriting newer changes. Implement the same action contract in the Wails Go service and the local TypeScript preview service; production generation and validation live in Go, with a controlled provider stub for preview tests.

Only one draft generation runs per workspace at a time. Capture workspace ID, role snapshot, profile revision and job ID at start. A completion from an old workspace or cancelled job cannot update the active UI or another workspace. A crash marks the run interrupted and retains the last saved draft. Cancellation kills the Codex subprocess and keeps prior content. Limit run duration and output size similarly to research, with errors that let the user retry.

The current 50 opportunity cap and delete flow can remove application data. Change retention so a role with a draft bundle is protected from automatic research eviction. Evict the oldest unprotected role first; if all slots are protected, report that new roles could not be added and ask the user to archive or remove some. Explicit removal of a role with drafts must list the draft artifacts that will be deleted and require confirmation. Workspace deletion and reset include draft data in their existing destructive flows. Exporting a workspace must include drafts, while **copy profile and preferences** must not.

## Failure and trust states

- Missing profile history, uncertain employer details, or an inaccessible vacancy: explain which input is missing. Let the user supply text or continue with a clearly labelled limited draft only when there is enough role context to tailor it.
- Unsupported candidate claim: exclude it from generated artifact text and present a question in the evidence panel. User edits are visibly marked as user supplied, not agent verified.
- Profile or vacancy changes after generation: show **Source changed since this draft** and offer regeneration with a comparison. Existing edited text remains available.
- Provider failure, cancellation, timeout, malformed JSON, or app restart: retain the last saved bundle, show the run outcome, and allow retry.
- Sample opportunity: show the feature preview and explanation, but do not generate a seemingly real application for a fictional vacancy.
- Export: use the current saved, reviewed revision. If review is incomplete, prompt the user to finish review; never label generated content as verified by Waypoint.

## Acceptance scenarios

1. A real sourced opportunity and a complete profile produce both artifacts; the user edits, reviews, restarts Waypoint, and exports DOCX, PDF and plain text with the same content.
2. Missing metrics, dates, qualifications, and contact information appear as review questions or blank editable fields and never become invented claims in exported documents.
3. Regeneration after a profile change preserves prior edits until the user accepts a compared revision.
4. Cancellation, provider error, malformed response, timeout and restart leave the last good draft intact.
5. Research and the 50 role cap do not erase a draft. Explicit role deletion states exactly which drafts will be removed.
6. Switching, copying, exporting and importing workspaces preserve isolation and the intended draft data rules.
7. Desktop and preview exercise the same service contract; desktop verification includes a real visible Codex run when credentials are available, with provider unavailable cases reported separately.

## Initial release boundary

This feature drafts and exports user reviewed text. It does not log in to job sites, autofill forms, send email, or submit applications. Jev is not needed for draft generation. The user moves the application stage to **Applied** only after they have actually submitted it.
