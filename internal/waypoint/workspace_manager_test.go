package waypoint

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWorkspaceManagerCreatesIsolatedWorkspacesAndRestoresCurrent(t *testing.T) {
	root := t.TempDir()
	manager := NewWorkspaceManager(root)
	if err := manager.Init(); err != nil {
		t.Fatal(err)
	}
	initial, err := manager.Bootstrap()
	if err != nil {
		t.Fatal(err)
	}
	if initial.Workspace.Name != "Sample workspace" || len(initial.Workspaces) != 1 || initial.Epoch != 1 {
		t.Fatalf("unexpected initial catalog: %#v", initial)
	}
	profile := initial.State.Profile
	profile.Name = "Ada Candidate"
	if _, err := manager.service.SaveProfile(profile); err != nil {
		t.Fatal(err)
	}
	copied, err := manager.Create(CreateWorkspaceInput{Name: "Leadership search", Mode: "copy"})
	if err != nil {
		t.Fatal(err)
	}
	if copied.State.Profile.Name != "Ada Candidate" || copied.State.Demo || len(copied.State.Roles) != 0 || len(copied.Workspaces) != 2 {
		t.Fatalf("copy did not preserve only the profile and settings: %#v", copied.State)
	}
	firstID, secondID := initial.Workspace.ID, copied.Workspace.ID
	secondProfile := copied.State.Profile
	secondProfile.Name = "Second Candidate"
	if _, err := manager.service.SaveProfile(secondProfile); err != nil {
		t.Fatal(err)
	}
	first, err := manager.Switch(firstID)
	if err != nil {
		t.Fatal(err)
	}
	if first.State.Profile.Name != "Ada Candidate" || first.Epoch <= copied.Epoch {
		t.Fatal("switch did not restore the isolated original state or advance the epoch")
	}
	manager.Close()

	restored := NewWorkspaceManager(root)
	if err := restored.Init(); err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	boot, err := restored.Bootstrap()
	if err != nil {
		t.Fatal(err)
	}
	if boot.Workspace.ID != firstID || boot.State.Profile.Name != "Ada Candidate" {
		t.Fatal("current workspace was not restored after restart")
	}
	second, err := restored.Switch(secondID)
	if err != nil || second.State.Profile.Name != "Second Candidate" {
		t.Fatalf("second workspace was not persisted independently: %v %#v", err, second.State.Profile)
	}
	importedState := InitialState(false)
	importedState.Profile.Name = "Imported Candidate"
	imported, err := restored.Create(CreateWorkspaceInput{Name: "Imported backup", Mode: "import", State: &importedState})
	if err != nil || imported.State.Profile.Name != "Imported Candidate" {
		t.Fatalf("workspace import failed: %v %#v", err, imported.State.Profile)
	}
}

func TestWorkspaceLifecycleAndPermanentDeletion(t *testing.T) {
	root := t.TempDir()
	manager := NewWorkspaceManager(root)
	if err := manager.Init(); err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	original, _ := manager.Bootstrap()
	created, err := manager.Create(CreateWorkspaceInput{Name: "Alternate", Mode: "blank"})
	if err != nil {
		t.Fatal(err)
	}
	id := created.Workspace.ID
	directory := filepath.Join(root, "workspaces", id)
	if _, err := os.Stat(databasePath(directory)); err != nil {
		t.Fatalf("workspace database missing: %v", err)
	}
	if _, err := manager.Switch(original.Workspace.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Rename(id, original.Workspace.Name); err == nil {
		t.Fatal("case-insensitive duplicate name was accepted")
	}
	if _, err := manager.Rename(id, "Archived search"); err != nil {
		t.Fatal(err)
	}
	archived, err := manager.Archive(id)
	if err != nil || archived.Workspaces[1].ArchivedAt == "" {
		t.Fatalf("workspace was not archived: %v", err)
	}
	if _, err := manager.Switch(id); err == nil {
		t.Fatal("archived workspace was opened")
	}
	if _, err := manager.Restore(id); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Archive(id); err != nil {
		t.Fatal(err)
	}
	deleted, err := manager.MoveToDeleted(id)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, item := range deleted.Workspaces {
		if item.ID == id && item.DeletedAt != "" {
			found = true
		}
	}
	if !found {
		t.Fatal("workspace was not moved to recently deleted")
	}
	if _, err := manager.DeletePermanently(id, "wrong"); err == nil {
		t.Fatal("permanent deletion accepted an incorrect confirmation")
	}
	unexpected := filepath.Join(directory, "unexpected.txt")
	if err := os.WriteFile(unexpected, []byte("preserve me"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.DeletePermanently(id, "Archived search"); err == nil {
		t.Fatal("permanent deletion started despite an unexpected file")
	}
	if _, err := os.Stat(databasePath(directory)); err != nil {
		t.Fatalf("workspace database was removed after failed preflight: %v", err)
	}
	if _, err := manager.catalog.Entry(id); err != nil {
		t.Fatalf("catalog entry was removed after failed preflight: %v", err)
	}
	if err := os.Remove(unexpected); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.DeletePermanently(id, "Archived search"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("workspace directory remains after permanent deletion: %v", err)
	}
}

func TestWorkspaceImportRejectsIncompleteNestedDataWithoutChangingCatalog(t *testing.T) {
	manager := NewWorkspaceManager(t.TempDir())
	if err := manager.Init(); err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	before, _ := manager.Bootstrap()
	invalid := InitialState(true)
	invalid.Roles[0].Sources = nil
	if _, err := manager.Create(CreateWorkspaceInput{Name: "Broken import", Mode: "import", State: &invalid}); err == nil {
		t.Fatal("incomplete nested opportunity data was imported")
	}
	after, _ := manager.Bootstrap()
	if after.Workspace.ID != before.Workspace.ID || len(after.Workspaces) != len(before.Workspaces) {
		t.Fatal("failed import changed the current workspace or catalog")
	}
	unsafe := InitialState(false)
	result := testResult()
	unsafe.Roles = result.Roles
	unsafe.Families = result.Families
	unsafe.Roles[0].Sources[0].URL = "http://unsafe.example.org/jobs/1"
	if _, err := manager.Create(CreateWorkspaceInput{Name: "Unsafe import", Mode: "import", State: &unsafe}); err == nil {
		t.Fatal("workspace with an unsafe source URL was imported")
	}
}

func TestWorkspaceSwitchIsBlockedDuringResearchAndCorruptTargetIsSafe(t *testing.T) {
	root := t.TempDir()
	manager := NewWorkspaceManager(root)
	if err := manager.Init(); err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	original, _ := manager.Bootstrap()
	created, err := manager.Create(CreateWorkspaceInput{Name: "Target", Mode: "blank"})
	if err != nil {
		t.Fatal(err)
	}
	manager.service.mu.Lock()
	manager.service.activeCancel = func() {}
	manager.service.mu.Unlock()
	if _, err := manager.Switch(original.Workspace.ID); err == nil {
		t.Fatal("switch was allowed during active research")
	}
	manager.service.mu.Lock()
	manager.service.activeCancel = nil
	manager.service.mu.Unlock()
	if _, err := manager.Switch(original.Workspace.ID); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(databasePath(filepath.Join(root, "workspaces", created.Workspace.ID)), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Switch(created.Workspace.ID); err == nil {
		t.Fatal("corrupt workspace was opened")
	}
	after, _ := manager.Bootstrap()
	if after.Workspace.ID != original.Workspace.ID {
		t.Fatal("failed switch changed the current workspace")
	}
}

func TestRepositoryMigratesWorkspaceIdentity(t *testing.T) {
	directory := t.TempDir()
	repository := NewSQLiteRepository(directory)
	if err := repository.Init(); err != nil {
		t.Fatal(err)
	}
	defer repository.Close()
	if _, found, err := repository.WorkspaceID(); err != nil || found {
		t.Fatalf("unexpected initial identity: found=%v err=%v", found, err)
	}
	if err := repository.SetWorkspaceID("workspace-test"); err != nil {
		t.Fatal(err)
	}
	if id, found, err := repository.WorkspaceID(); err != nil || !found || id != "workspace-test" {
		t.Fatalf("workspace identity did not round trip: %q %v %v", id, found, err)
	}
	var version int
	if err := repository.db.QueryRowContext(context.Background(), `PRAGMA user_version`).Scan(&version); err != nil || version != 2 {
		t.Fatalf("unexpected schema version: %d %v", version, err)
	}
}

func TestScheduledResearchRunsAcrossActiveWorkspaces(t *testing.T) {
	root := t.TempDir()
	manager := NewWorkspaceManager(root)
	manager.newService = func(directory string) *Service {
		return NewServiceWithResearcher(directory, func(_ context.Context, _ State, _ func(string, *ResearchSourceActivity)) (ResearchResult, error) {
			return testResult(), nil
		})
	}
	if err := manager.Init(); err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.Local)
	dueState := func() State {
		state := InitialState(false)
		state.Profile = InitialState(true).Profile
		state.Settings.ResearchSchedule = ResearchSchedule{Enabled: true, Time: "11:00", LastRunAt: now.Add(-24 * time.Hour).Format(time.RFC3339Nano)}
		return state
	}
	if _, err := manager.service.ImportState(dueState()); err != nil {
		t.Fatal(err)
	}
	second, err := manager.Create(CreateWorkspaceInput{Name: "Scheduled second", Mode: "blank"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.service.ImportState(dueState()); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for range 2 {
		run, started, err := manager.StartNextScheduledResearch(now)
		if err != nil || !started {
			t.Fatalf("scheduled workspace did not start: %v", err)
		}
		seen[run.WorkspaceID] = true
		state := waitForResearch(t, run.Service)
		if state.Runs[0].Status != "completed" {
			t.Fatalf("scheduled research failed: %#v", state.Runs[0])
		}
		manager.FinishScheduledResearch(run.Service)
	}
	initialID := ""
	for _, item := range second.Workspaces {
		if item.ID != second.Workspace.ID {
			initialID = item.ID
		}
	}
	if !seen[second.Workspace.ID] || !seen[initialID] {
		t.Fatalf("not all active workspaces ran: %#v", seen)
	}
	if _, started, err := manager.StartNextScheduledResearch(now); err != nil || started {
		t.Fatalf("workspace ran twice in the same schedule slot: started=%v err=%v", started, err)
	}
}

func TestWorkspaceManagerSerializesManualAndScheduledResearch(t *testing.T) {
	root := t.TempDir()
	manager := NewWorkspaceManager(root)
	manager.newService = func(directory string) *Service {
		return NewServiceWithResearcher(directory, func(ctx context.Context, _ State, _ func(string, *ResearchSourceActivity)) (ResearchResult, error) {
			<-ctx.Done()
			return ResearchResult{}, ctx.Err()
		})
	}
	if err := manager.Init(); err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.Local)
	ready := InitialState(false)
	ready.Profile = InitialState(true).Profile
	if _, err := manager.service.ImportState(ready); err != nil {
		t.Fatal(err)
	}
	rootWorkspace, _ := manager.Bootstrap()
	second, err := manager.Create(CreateWorkspaceInput{Name: "Scheduled background", Mode: "blank"})
	if err != nil {
		t.Fatal(err)
	}
	due := cloneState(ready)
	due.Settings.ResearchSchedule = ResearchSchedule{Enabled: true, Time: "11:00", LastRunAt: now.Add(-24 * time.Hour).Format(time.RFC3339Nano)}
	if _, err := manager.service.ImportState(due); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Switch(rootWorkspace.Workspace.ID); err != nil {
		t.Fatal(err)
	}
	run, started, err := manager.StartNextScheduledResearch(now)
	if err != nil || !started || run.WorkspaceID != second.Workspace.ID {
		t.Fatalf("background research did not start in the due workspace: started=%v err=%v run=%#v", started, err, run)
	}
	if _, err := manager.Dispatch("startResearch", []any{}); err == nil {
		t.Fatal("manual research started while another workspace was researching")
	}
	if _, err := run.Service.CancelResearch(); err != nil {
		t.Fatal(err)
	}
	_ = waitForResearch(t, run.Service)
	manager.FinishScheduledResearch(run.Service)

	entry, err := manager.catalog.Entry(second.Workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	service, err := manager.openService(entry)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ImportState(due); err != nil {
		service.Shutdown()
		t.Fatal(err)
	}
	service.Shutdown()
	if _, err := manager.Dispatch("startResearch", []any{}); err != nil {
		t.Fatal(err)
	}
	if _, started, err := manager.StartNextScheduledResearch(now); err != nil || started {
		t.Fatalf("scheduled research started while manual research was active: started=%v err=%v", started, err)
	}
	if _, err := manager.service.CancelResearch(); err != nil {
		t.Fatal(err)
	}
	_ = waitForResearch(t, manager.service)
}
