# Persistence architecture

Waypoint's installed desktop application uses a local SQLite database as its
source of truth. The renderer never opens the database: it calls the Go service,
which owns validation, state transitions, and persistence.

## Storage boundary

`WorkspaceRepository` is the boundary between the application service and the
storage implementation. `SQLiteRepository` is the default implementation. A
future optional synchronization implementation can satisfy the same boundary
without changing renderer actions or putting cloud credentials in the webview.

The workspace catalog is `Waypoint/catalog.db` inside the operating system user
configuration directory. The original workspace remains at
`Waypoint/waypoint.db`; each additional workspace is stored at
`Waypoint/workspaces/<workspace-id>/waypoint.db`. Catalog entries contain only
local names, lifecycle timestamps, IDs, and relative paths. Career data and
provider credentials never enter the catalog.

Each workspace database schema uses relational rows for opportunities,
shortlist membership, applications, feedback, research runs, events, and
sources. Complex nested opportunity evidence and profile/settings documents are
stored as JSON columns where relational queries do not yet add value.

Every workspace save is one SQLite transaction. Foreign keys prevent shortlist,
application, or feedback rows from referring to a missing opportunity. The
database uses schema versioning, a busy timeout, full synchronous commits, and
WAL journaling. The containing directory requests mode `0700` and the database
file mode `0600` on platforms that support Unix permissions.

## Switching, import, and recovery

Use the identity card at the bottom of the sidebar to switch or create a
workspace. Settings contains rename, export, archive, restore, recently-delete,
and permanent-delete controls. New workspaces can be blank, copy only the
current profile/preferences, or import a compatible JSON workspace export.
Profiles, opportunities, shortlists, notes, feedback, research history, and
schedules remain isolated per workspace.

The current workspace ID is committed in the catalog before the renderer adopts
the new state. Switching is blocked while research is running, and stale async
responses are ignored using the captured workspace ID and catalog epoch.
Scheduled desktop research checks every active workspace serially; archived and
recently deleted workspaces are skipped.

If the database has no workspace, startup looks for the former `state.json`,
validates it, writes it into SQLite, and leaves the JSON file byte-for-byte
unchanged as a recovery backup. After migration, the populated database takes
precedence over that file.

Workspace exports remain JSON and can be restored through **New workspace →
Import an export**. For lower-level database recovery:

1. Quit Waypoint completely.
2. Copy the entire `Waypoint` configuration directory somewhere safe.
3. Move `waypoint.db` and any `waypoint.db-wal` or `waypoint.db-shm` sidecars out
   of the configuration directory.
4. Put the compatible exported workspace at `Waypoint/state.json` only when
   recovering the original pre-catalog workspace.
5. Start Waypoint. It validates and imports the JSON into a new database. For a
   normal export, prefer the in-app import flow so the existing catalog remains
   intact.

Never replace or remove a live database while Waypoint is running.

## Turso direction

Cloud synchronization is intentionally not enabled yet. A Turso adapter should
remain opt-in and must preserve local/offline operation. Before adding it, the
schema needs per-record revisions, deletion tombstones, a device identifier, and
explicit conflict handling for profile text and application notes. Provider API
keys must remain in the operating system credential store and must never enter
the synchronized database.

Generated opportunity data can reasonably use deterministic last-write rules,
but hand-written profile and application content should surface conflicts rather
than silently choosing the latest device push. JSON export remains the
provider-independent escape hatch.
