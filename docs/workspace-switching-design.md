# Workspace switching design

Status: proposed for review. No application behaviour is implemented by this
document.

## Outcome

Waypoint should let one person keep distinct career contexts without mixing
profiles, preferences, research, shortlists, applications, notes, or feedback.
Switching must feel immediate, preserve the current workspace durably, and
never put one workspace's data into another workspace's UI or research prompt.

Examples include:

- product leadership versus consulting;
- a current search versus a longer-term career change;
- separate regional or work-authorisation strategies;
- an imported backup kept apart from the primary workspace.

## Recommended model

Use one SQLite database per workspace and a small device-local catalog.

```text
Waypoint/
├── catalog.db                         device-local workspace index
├── waypoint.db                        existing workspace, registered in place
├── state.json                         preserved legacy migration backup, if any
└── workspaces/
    ├── 9a4c.../
    │   └── waypoint.db                second workspace
    └── e128.../
        └── waypoint.db                third workspace
```

The existing root database remains in place and becomes the first catalog
entry. Avoiding a file move makes rollout crash-safe and keeps current backups
valid. New workspaces use generated UUID directories. The renderer receives
workspace IDs only; it can never supply a filesystem path.

Each workspace database remains independently exportable, recoverable, and
eligible for future opt-in Turso sync. The catalog is not career data and is not
synced: it records local presentation and routing metadata only.

### Options considered

| Model | Advantages | Problems | Decision |
| --- | --- | --- | --- |
| One database per workspace plus catalog | Strong isolation, independent recovery/export/sync, small corruption radius | Requires a catalog and lifecycle manager | Recommended |
| One database with `workspace_id` on every table | Simple file management and cross-workspace queries | Riskier migrations/deletes, all-or-nothing sync, easier data leakage | Reject |
| One JSON/SQLite file selected directly by the user | Minimal catalog | File pickers, path security, weak naming/recovery UX | Reject |

## Product vocabulary

- **Workspace:** one complete career context and its research history.
- **Current workspace:** the only workspace rendered and edited in the main UI.
- **Archived workspace:** retained locally but hidden from the everyday switcher.
- **Recently deleted workspace:** closed and hidden, but still recoverable until
  the user explicitly deletes it permanently.

“Profile” remains the candidate information inside a workspace. A workspace is
not an account and does not contain provider credentials.

## Primary interface

Reuse the existing identity card at the bottom of the sidebar as the workspace
switcher. It already shows initials, profile identity, and a switch chevron.
This is less disruptive than introducing another top-level navigation item.

### Closed state

```text
┌─────────────────────────┐
│ AM  Product leadership  │
│     Personal workspace ↕│
└─────────────────────────┘
```

- The first line is the workspace name, not the candidate name.
- The second line shows `Sample workspace`, `Personal workspace`, or a concise
  activity state such as `Research running`.
- The avatar uses workspace initials. A future version may add user-selected
  colours, but colour selection is not required for the first release.
- At the collapsed 74 px sidebar width, only the avatar is shown; its accessible
  name remains `Switch workspace. Current: Product leadership`.
- The top breadcrumb becomes `Product leadership › Discover` instead of
  `My workspace › Discover`.

### Open switcher

The menu opens upward from the sidebar card so it stays attached to the control
and does not cover the main workspace.

```text
┌────────────────────────────────┐
│ WORKSPACES                     │
│ ● Product leadership           │
│   6 opportunities · just now   │
│                                │
│ ○ Consulting direction         │
│   3 saved · yesterday          │
│                                │
│ ○ Climate transition           │
│   Profile in progress          │
├────────────────────────────────┤
│ ＋ New workspace                │
│ ⚙ Manage workspaces            │
└────────────────────────────────┘
```

- Order: current first, then most recently opened.
- Show at most six active workspaces before the list scrolls.
- Each row shows one useful secondary fact, never raw database paths.
- A running or completed-unseen research job receives a status dot and label.
- Selecting the already-current workspace closes the menu without reloading.
- `Escape` closes and restores focus. Arrow keys move across workspace rows;
  Enter switches. Commands remain normal buttons after the workspace list.
- Use a labelled popover/dialog rather than a mixed `listbox`, because the
  surface contains both selection rows and commands.

## Creating a workspace

`New workspace` opens a focused modal.

```text
┌──────────────────────────────────────┐
│ A new direction                     │
│ Keep this search separate.           │
│                                      │
│ Workspace name                       │
│ [ Consulting direction             ] │
│                                      │
│ ● Start with a blank profile         │
│ ○ Copy profile and preferences       │
│ ○ Import a Waypoint workspace        │
│                                      │
│                 [Cancel] [Create]    │
└──────────────────────────────────────┘
```

Rules:

- Name is required, trimmed, 1–80 characters, and unique case-insensitively
  among active and archived workspaces.
- **Blank profile** is the default. Additional workspaces do not replay the
  fictional first-launch demo.
- **Copy profile and preferences** copies candidate/profile fields and AI model
  preferences only. It does not copy roles, feedback, research history,
  shortlist entries, application stages, or notes.
- **Import** validates the complete JSON before creating or switching. A failed
  import leaves both the current workspace and catalog unchanged.
- Creation writes and validates the new database before the catalog points to
  it. If any step fails, the current workspace remains active.
- A successful create switches to the new workspace and opens `My profile` at
  the first incomplete step.

## Switching behaviour

Switching is a context boundary, not ordinary navigation.

1. If the profile contains unsaved edits, ask whether to stay or discard those
   edits. Never silently save a partial draft.
2. Close opportunity drawers, filters, confirmation modals, and transient
   selection state.
3. Preserve the current route only for stable overview routes (`Discover`,
   `Career paths`, `Shortlist`, `Applications`, `Research activity`,
   `Settings`). Otherwise land on `Discover`.
4. Open and validate the target workspace fully before changing the catalog's
   current pointer.
5. Atomically swap the backend's current service, then return one bootstrap
   payload containing the workspace list, current workspace metadata, and state.
6. Announce `Switched to Consulting direction` through the existing toast/live
   region and move focus to the page heading.

Switching is blocked while research is running in the current workspace. The
switcher explains `Stop research before switching`; it must not cancel research
implicitly. This keeps provider work and its final persistence tied to the
workspace that started it.

Every backend response includes its `workspaceId` and a monotonically increasing
local `workspaceEpoch`. The renderer discards a late response from a previous
workspace, preventing stale polling or slow calls from replacing the new UI.

## Workspace management

`Manage workspaces` opens a Settings section with active, archived, and recently
deleted groups.

Supported first-release actions:

- **Rename** — updates catalog display metadata only.
- **Export** — produces the existing portable JSON workspace export.
- **Archive** — hides a workspace from the normal switcher without touching its
  database. The current workspace cannot be archived.
- **Restore** — returns an archived or recently deleted workspace.
- **Move to recently deleted** — closes and hides the workspace but retains its
  database. It is unavailable for the current workspace and for the final
  remaining active workspace.
- **Delete permanently** — available only from Recently Deleted, requires the
  user to type the workspace name, closes all handles, and deletes only the
  backend-resolved workspace directory/database files. There is no automatic
  expiry in the first release.

The existing root workspace can follow the same catalog states even though its
database lives at the configuration root. Permanent deletion resolves an exact
allow-listed set (`waypoint.db`, `-wal`, and `-shm`) rather than deleting the
configuration directory.

## Persistence design

### Device-local catalog

Use a second SQLite database, `catalog.db`, with restrictive permissions and
the same schema-migration discipline as workspace databases.

```sql
CREATE TABLE catalog_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_workspace_id TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  relative_directory TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT
);
```

The catalog never stores profile content, research results, application notes,
provider keys, absolute paths, or Turso tokens. `relative_directory` values are
created internally and validated against the configured Waypoint root.

### Workspace identity

Upgrade each workspace database with a stable `workspace_id`. The ID is written
inside the workspace as well as the catalog so a lost catalog can be rebuilt by
scanning known database locations. It is included in full JSON exports as
metadata, but import creates a new local ID unless the user is reconnecting a
known synced workspace.

Workspace display name remains catalog-owned. If the catalog is rebuilt, a
friendly fallback name can be derived from the profile and confirmed by the
user.

### First-run migration

On the first workspace-aware launch:

1. Create and migrate `catalog.db` without changing the existing workspace.
2. Open the current root `waypoint.db` through the existing repository. If only
   legacy `state.json` exists, let the existing safe migration create it first.
3. Add a stable workspace ID to that database.
4. Register it in the catalog with `relative_directory = '.'` and the name
   `My workspace` (`Sample workspace` when demo data is active).
5. Commit the catalog pointer only after the workspace opens successfully.

If catalog creation fails, continue using the root workspace and present a
recoverable startup error; never overwrite the workspace. If a catalog exists
but its selected workspace is corrupt, keep the catalog and show a recovery
screen listing other healthy workspaces.

If the catalog itself is corrupt, preserve it and offer to rebuild it by
scanning only the root database and UUID-named directories under `workspaces/`.

## Backend structure

Introduce a `WorkspaceManager` above the existing `Service`:

```text
Wails App.Call
    │
    ▼
WorkspaceManager ───── CatalogRepository
    │
    ├── current workspace metadata
    └── current *waypoint.Service ── WorkspaceRepository ── waypoint.db
```

The manager owns the current service and serialises workspace lifecycle calls.
Ordinary domain actions are dispatched to the current service. Workspace
actions are handled by the manager:

- `bootstrap()`
- `listWorkspaces()`
- `createWorkspace(input)`
- `switchWorkspace(id, expectedCurrentId)`
- `renameWorkspace(id, name)`
- `archiveWorkspace(id)` / `restoreWorkspace(id)`
- `deleteWorkspace(id, confirmation)`

`bootstrap` replaces the renderer's separate initial `getState` and status/list
requests, avoiding a flash of the wrong workspace on launch.

The manager takes an exclusive lifecycle lock while creating, switching,
archiving, or deleting. Normal calls capture the current workspace ID before
dispatch. A target service is opened and validated before the catalog pointer
or renderer state changes. Failure therefore leaves the current service usable.

## Scheduled research

Recommended first release: schedules remain workspace-specific, and all active
workspaces can become due while Waypoint is open or minimised.

The manager owns one global research queue so only one Codex research process
runs at a time across all workspaces. It checks due schedules in active
workspace databases, queues them by due time, and includes the workspace name in
notifications. A workspace with background research running is temporarily
non-switchable until that run finishes or is cancelled from its activity view.

Archived and recently deleted workspaces never run scheduled research. Provider
credentials remain device-global in the OS credential store; per-workspace model
enablement and schedules remain in each workspace database.

## Turso compatibility

The catalog stays local. Each workspace is an independent future sync unit with
its own remote database identity and keychain token keyed by workspace ID.

Before enabling Turso for a workspace, add:

- per-record revisions and stable operation IDs;
- deletion tombstones;
- device identity;
- conflict presentation for profile text and application notes;
- an explicit local-only / synced state in workspace metadata.

The switcher can later replace `Local workspace` with `Local`, `Syncing`,
`Synced`, or `Needs attention`. Cloud state must never be inferred merely from a
successful local database open.

## Accessibility and failure states

- Switcher, modal, and management actions are fully keyboard operable.
- Focus returns to the invoking switcher on cancel or error.
- Workspace rows expose name, current state, and secondary summary as one
  accessible label; colour is never the only status signal.
- Switching announces completion. Loading uses `aria-busy` without blanking the
  current view until the target is ready.
- A corrupt target shows a workspace-specific error and preserves the current
  UI; it never produces a blank global startup screen when another workspace is
  healthy.
- Path validation, catalog constraints, and backend-generated IDs prevent path
  traversal or deleting arbitrary user files.

## First-release acceptance criteria

1. An existing installation becomes one current workspace without moving or
   losing its database or legacy backup.
2. Users can create blank, profile-copy, and JSON-import workspaces.
3. Switching survives application restart and never mixes state between
   workspaces.
4. Unsaved drafts and running research block an unsafe switch with clear copy.
5. Rename, export, archive, restore, recently delete, and permanent delete obey
   the lifecycle rules above.
6. A corrupt target or catalog failure preserves healthy workspace data and
   offers recovery.
7. Scheduled research is serialised across active workspaces and notifications
   identify the source workspace.
8. Desktop and browser-preview test services use isolated catalog roots.
9. Keyboard, focus, narrow-sidebar, and screen-reader behaviours are verified.
10. SQLite integrity, foreign keys, restricted permissions, legacy migration,
    and packaged-app restart are validated on supported platforms.

## Explicitly deferred

- Sharing a workspace with another person.
- Cross-workspace search, analytics, or merged opportunity feeds.
- Automatic merging of profiles or application notes.
- Turso/cloud sync itself.
- Custom icons, colours, or manual drag ordering.
- Automatically purging recently deleted workspaces.
