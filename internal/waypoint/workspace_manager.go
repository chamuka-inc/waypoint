package waypoint

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type WorkspaceManager struct {
	mu                sync.RWMutex
	root              string
	catalog           *CatalogRepository
	current           catalogEntry
	service           *Service
	epoch             uint64
	newService        func(string) *Service
	backgroundID      string
	backgroundService *Service
	backgroundOwned   bool
}

func NewWorkspaceManager(root string) *WorkspaceManager {
	return &WorkspaceManager{root: root, catalog: NewCatalogRepository(root), newService: NewService}
}

func (m *WorkspaceManager) Init() error {
	if err := m.catalog.Init(); err != nil {
		return err
	}
	currentID, found, err := m.catalog.CurrentID()
	if err != nil {
		_ = m.catalog.Close()
		return err
	}
	if !found {
		service := m.newService(m.root)
		if err := service.Init(); err != nil {
			_ = m.catalog.Close()
			return err
		}
		id, hasID, err := service.WorkspaceID()
		if err != nil {
			service.Shutdown()
			_ = m.catalog.Close()
			return err
		}
		if !hasID {
			id = uuid.NewString()
			if err := service.SetWorkspaceID(id); err != nil {
				service.Shutdown()
				_ = m.catalog.Close()
				return err
			}
		}
		now := nowISO()
		name := "My workspace"
		if service.State().Demo {
			name = "Sample workspace"
		}
		entry := catalogEntry{ID: id, Name: name, RelativeDirectory: ".", CreatedAt: now, UpdatedAt: now, LastOpenedAt: now}
		if err := m.catalog.Add(entry, true); err != nil {
			service.Shutdown()
			_ = m.catalog.Close()
			return err
		}
		m.current, m.service, m.epoch = entry, service, 1
		return nil
	}
	entry, err := m.catalog.Entry(currentID)
	if err != nil {
		_ = m.catalog.Close()
		return err
	}
	service, err := m.openService(entry)
	if err != nil {
		_ = m.catalog.Close()
		return errors.New("the selected workspace could not be opened; its files were preserved")
	}
	m.current, m.service, m.epoch = entry, service, 1
	return nil
}

func (m *WorkspaceManager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.service != nil {
		m.service.Shutdown()
		m.service = nil
	}
	if m.backgroundOwned && m.backgroundService != nil {
		m.backgroundService.Shutdown()
	}
	m.backgroundService = nil
	_ = m.catalog.Close()
}

func (m *WorkspaceManager) Dispatch(method string, args []any) (any, error) {
	switch method {
	case "bootstrap":
		m.mu.RLock()
		defer m.mu.RUnlock()
		return m.bootstrapLocked()
	case "createWorkspace":
		var input CreateWorkspaceInput
		if err := decodeArg(args, 0, &input); err != nil {
			return nil, err
		}
		return m.Create(input)
	case "switchWorkspace":
		var id string
		if err := decodeArg(args, 0, &id); err != nil {
			return nil, err
		}
		return m.Switch(id)
	case "renameWorkspace":
		var id, name string
		if err := decodeArg(args, 0, &id); err != nil {
			return nil, err
		}
		if err := decodeArg(args, 1, &name); err != nil {
			return nil, err
		}
		return m.Rename(id, name)
	case "archiveWorkspace":
		return m.lifecycleArg(args, "archive")
	case "restoreWorkspace":
		return m.lifecycleArg(args, "restore")
	case "deleteWorkspace":
		return m.lifecycleArg(args, "delete")
	case "deleteWorkspacePermanently":
		var id, confirmation string
		if err := decodeArg(args, 0, &id); err != nil {
			return nil, err
		}
		if err := decodeArg(args, 1, &confirmation); err != nil {
			return nil, err
		}
		return m.DeletePermanently(id, confirmation)
	case "exportWorkspace":
		var id string
		if err := decodeArg(args, 0, &id); err != nil {
			return nil, err
		}
		return m.Export(id)
	default:
		m.mu.RLock()
		defer m.mu.RUnlock()
		if m.service == nil {
			return nil, errors.New("workspace is not available")
		}
		if method == "startResearch" && m.backgroundService != nil && m.backgroundService != m.service {
			return nil, errors.New("wait for research in the other workspace to finish")
		}
		return m.service.Dispatch(method, args)
	}
}

func (m *WorkspaceManager) lifecycleArg(args []any, action string) (WorkspaceBootstrap, error) {
	var id string
	if err := decodeArg(args, 0, &id); err != nil {
		return WorkspaceBootstrap{}, err
	}
	switch action {
	case "archive":
		return m.Archive(id)
	case "restore":
		return m.Restore(id)
	default:
		return m.MoveToDeleted(id)
	}
}

func (m *WorkspaceManager) Bootstrap() (WorkspaceBootstrap, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.bootstrapLocked()
}

func (m *WorkspaceManager) bootstrapLocked() (WorkspaceBootstrap, error) {
	items, err := m.summariesLocked()
	if err != nil {
		return WorkspaceBootstrap{}, err
	}
	var current WorkspaceSummary
	for _, item := range items {
		if item.ID == m.current.ID {
			current = item
			break
		}
	}
	return WorkspaceBootstrap{Workspace: current, Workspaces: items, State: m.service.State(), Epoch: m.epoch}, nil
}

func (m *WorkspaceManager) Create(input CreateWorkspaceInput) (WorkspaceBootstrap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.service.ActiveResearch() || m.backgroundService != nil {
		return WorkspaceBootstrap{}, errors.New("stop research before creating or switching workspaces")
	}
	name, err := validateWorkspaceName(input.Name)
	if err != nil {
		return WorkspaceBootstrap{}, err
	}
	if input.Mode != "blank" && input.Mode != "copy" && input.Mode != "import" {
		return WorkspaceBootstrap{}, errors.New("choose how to start the workspace")
	}
	id := uuid.NewString()
	relative := filepath.Join("workspaces", id)
	entry := catalogEntry{ID: id, Name: name, RelativeDirectory: relative, CreatedAt: nowISO(), UpdatedAt: nowISO(), LastOpenedAt: nowISO()}
	directory := filepath.Join(m.root, relative)
	service := m.newService(directory)
	if err := service.Init(); err != nil {
		return WorkspaceBootstrap{}, err
	}
	ready := false
	defer func() {
		if !ready {
			service.Shutdown()
			for _, suffix := range []string{"", "-wal", "-shm"} {
				_ = os.Remove(filepath.Join(directory, databaseFilename) + suffix)
			}
			_ = os.Remove(directory)
		}
	}()
	switch input.Mode {
	case "blank":
		if _, err := service.Reset(); err != nil {
			return WorkspaceBootstrap{}, err
		}
	case "copy":
		state := InitialState(false)
		current := m.service.State()
		state.Profile = current.Profile
		state.ProfileRevision = 1
		state.Settings.JevEnabled = current.Settings.JevEnabled
		state.Settings.JevModel = current.Settings.JevModel
		if _, err := service.ImportState(state); err != nil {
			return WorkspaceBootstrap{}, err
		}
	case "import":
		if input.State == nil {
			return WorkspaceBootstrap{}, errors.New("choose a valid Waypoint workspace export")
		}
		if _, err := service.ImportState(*input.State); err != nil {
			return WorkspaceBootstrap{}, err
		}
	}
	if err := service.SetWorkspaceID(id); err != nil {
		return WorkspaceBootstrap{}, err
	}
	if err := m.catalog.Add(entry, true); err != nil {
		return WorkspaceBootstrap{}, err
	}
	old := m.service
	m.current, m.service = entry, service
	m.epoch++
	ready = true
	old.Shutdown()
	return m.bootstrapLocked()
}

func (m *WorkspaceManager) Switch(id string) (WorkspaceBootstrap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id == m.current.ID {
		return m.bootstrapLocked()
	}
	if m.service.ActiveResearch() || m.backgroundService != nil {
		return WorkspaceBootstrap{}, errors.New("stop research before switching workspaces")
	}
	entry, err := m.catalog.Entry(id)
	if err != nil {
		return WorkspaceBootstrap{}, err
	}
	if entry.ArchivedAt != "" || entry.DeletedAt != "" {
		return WorkspaceBootstrap{}, errors.New("restore this workspace before opening it")
	}
	service, err := m.openService(entry)
	if err != nil {
		return WorkspaceBootstrap{}, errors.New("the workspace could not be opened; the current workspace is unchanged")
	}
	if err := m.catalog.SetCurrent(id); err != nil {
		service.Shutdown()
		return WorkspaceBootstrap{}, err
	}
	entry, _ = m.catalog.Entry(id)
	old := m.service
	m.current, m.service = entry, service
	m.epoch++
	old.Shutdown()
	return m.bootstrapLocked()
}

func (m *WorkspaceManager) Rename(id, requested string) (WorkspaceBootstrap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	name, err := validateWorkspaceName(requested)
	if err != nil {
		return WorkspaceBootstrap{}, err
	}
	if err := m.catalog.Rename(id, name); err != nil {
		return WorkspaceBootstrap{}, err
	}
	if id == m.current.ID {
		m.current.Name = name
	}
	return m.bootstrapLocked()
}

func (m *WorkspaceManager) Archive(id string) (WorkspaceBootstrap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id == m.backgroundID {
		return WorkspaceBootstrap{}, errors.New("wait for scheduled research to finish before archiving this workspace")
	}
	if id == m.current.ID {
		return WorkspaceBootstrap{}, errors.New("switch workspaces before archiving the current one")
	}
	if err := m.catalog.SetLifecycle(id, "archived_at", nowISO()); err != nil {
		return WorkspaceBootstrap{}, err
	}
	return m.bootstrapLocked()
}

func (m *WorkspaceManager) Restore(id string) (WorkspaceBootstrap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.catalog.Restore(id); err != nil {
		return WorkspaceBootstrap{}, err
	}
	return m.bootstrapLocked()
}

func (m *WorkspaceManager) MoveToDeleted(id string) (WorkspaceBootstrap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id == m.backgroundID {
		return WorkspaceBootstrap{}, errors.New("wait for scheduled research to finish before deleting this workspace")
	}
	if id == m.current.ID {
		return WorkspaceBootstrap{}, errors.New("switch workspaces before deleting the current one")
	}
	entry, err := m.catalog.Entry(id)
	if err != nil {
		return WorkspaceBootstrap{}, err
	}
	count, err := m.catalog.ActiveCount()
	if err != nil {
		return WorkspaceBootstrap{}, err
	}
	if entry.ArchivedAt == "" && count <= 1 {
		return WorkspaceBootstrap{}, errors.New("keep at least one active workspace")
	}
	if err := m.catalog.SetLifecycle(id, "deleted_at", nowISO()); err != nil {
		return WorkspaceBootstrap{}, err
	}
	return m.bootstrapLocked()
}

func (m *WorkspaceManager) DeletePermanently(id, confirmation string) (WorkspaceBootstrap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id == m.backgroundID {
		return WorkspaceBootstrap{}, errors.New("wait for scheduled research to finish before deleting this workspace")
	}
	if id == m.current.ID {
		return WorkspaceBootstrap{}, errors.New("the current workspace cannot be deleted")
	}
	entry, err := m.catalog.Entry(id)
	if err != nil {
		return WorkspaceBootstrap{}, err
	}
	if entry.DeletedAt == "" || confirmation != entry.Name {
		return WorkspaceBootstrap{}, errors.New("type the workspace name exactly to delete it permanently")
	}
	directory, err := m.directoryFor(entry)
	if err != nil {
		return WorkspaceBootstrap{}, err
	}
	if entry.RelativeDirectory != "." {
		items, readErr := os.ReadDir(directory)
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			return WorkspaceBootstrap{}, readErr
		}
		allowed := map[string]bool{databaseFilename: true, databaseFilename + "-wal": true, databaseFilename + "-shm": true}
		for _, item := range items {
			if !allowed[item.Name()] {
				return WorkspaceBootstrap{}, errors.New("the workspace directory contains unexpected files; nothing was deleted")
			}
		}
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(filepath.Join(directory, databaseFilename) + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			return WorkspaceBootstrap{}, err
		}
	}
	if entry.RelativeDirectory != "." {
		if err := os.Remove(directory); err != nil && !errors.Is(err, os.ErrNotExist) {
			return WorkspaceBootstrap{}, err
		}
	}
	if err := m.catalog.Remove(id); err != nil {
		return WorkspaceBootstrap{}, err
	}
	return m.bootstrapLocked()
}

func (m *WorkspaceManager) Export(id string) (State, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if id == m.current.ID {
		return m.service.State(), nil
	}
	entry, err := m.catalog.Entry(id)
	if err != nil {
		return State{}, err
	}
	service, err := m.openService(entry)
	if err != nil {
		return State{}, err
	}
	defer service.Shutdown()
	return service.State(), nil
}

func (m *WorkspaceManager) CurrentService() *Service {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.service
}

type ScheduledWorkspaceRun struct {
	Service       *Service
	WorkspaceID   string
	WorkspaceName string
	Before        map[string]bool
}

// StartNextScheduledResearch starts at most one due run across active workspaces.
// The caller must call FinishScheduledResearch after the returned run settles.
func (m *WorkspaceManager) StartNextScheduledResearch(now time.Time) (ScheduledWorkspaceRun, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.backgroundService != nil || m.service == nil || m.service.ActiveResearch() {
		return ScheduledWorkspaceRun{}, false, nil
	}
	entries, err := m.catalog.Entries()
	if err != nil {
		return ScheduledWorkspaceRun{}, false, err
	}
	for _, entry := range entries {
		if entry.ArchivedAt != "" || entry.DeletedAt != "" {
			continue
		}
		service, owned := m.service, false
		if entry.ID != m.current.ID {
			service, err = m.openService(entry)
			if err != nil {
				continue
			}
			owned = true
		}
		before := map[string]bool{}
		for _, role := range service.State().Roles {
			before[role.ID] = true
		}
		started, startErr := service.StartScheduledResearch(now)
		if startErr != nil || !started {
			if owned {
				service.Shutdown()
			}
			if startErr != nil {
				return ScheduledWorkspaceRun{}, false, startErr
			}
			continue
		}
		m.backgroundID, m.backgroundService, m.backgroundOwned = entry.ID, service, owned
		return ScheduledWorkspaceRun{Service: service, WorkspaceID: entry.ID, WorkspaceName: entry.Name, Before: before}, true, nil
	}
	return ScheduledWorkspaceRun{}, false, nil
}

func (m *WorkspaceManager) FinishScheduledResearch(service *Service) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.backgroundService != service {
		return
	}
	if m.backgroundOwned {
		service.Shutdown()
	}
	m.backgroundID, m.backgroundService, m.backgroundOwned = "", nil, false
}

func (m *WorkspaceManager) summariesLocked() ([]WorkspaceSummary, error) {
	entries, err := m.catalog.Entries()
	if err != nil {
		return nil, err
	}
	items := make([]WorkspaceSummary, 0, len(entries))
	for _, entry := range entries {
		if entry.ID == m.current.ID {
			items = append(items, summaryFromState(entry, m.service.State(), true, m.service.ActiveResearch()))
			continue
		}
		if entry.ID == m.backgroundID && m.backgroundService != nil {
			items = append(items, summaryFromState(entry, m.backgroundService.State(), false, true))
			continue
		}
		directory, pathErr := m.directoryFor(entry)
		if pathErr != nil {
			items = append(items, unavailableSummary(entry))
			continue
		}
		if _, statErr := os.Stat(databasePath(directory)); statErr != nil {
			items = append(items, unavailableSummary(entry))
			continue
		}
		repository := NewSQLiteRepository(directory)
		if err := repository.Init(); err != nil {
			items = append(items, unavailableSummary(entry))
			continue
		}
		state, found, loadErr := repository.Load()
		_ = repository.Close()
		if loadErr != nil || !found {
			items = append(items, unavailableSummary(entry))
			continue
		}
		items = append(items, summaryFromState(entry, state, false, false))
	}
	return items, nil
}

func summaryFromState(entry catalogEntry, state State, current, running bool) WorkspaceSummary {
	return WorkspaceSummary{
		ID: entry.ID, Name: entry.Name, Current: current, Demo: state.Demo,
		OpportunityCount: len(state.Roles), SavedCount: len(state.Saved),
		ProfileComplete: strings.TrimSpace(state.Profile.Name) != "" && strings.TrimSpace(state.Profile.Background) != "",
		ResearchRunning: running, CreatedAt: entry.CreatedAt, UpdatedAt: entry.UpdatedAt,
		LastOpenedAt: entry.LastOpenedAt, ArchivedAt: entry.ArchivedAt, DeletedAt: entry.DeletedAt,
	}
}

func unavailableSummary(entry catalogEntry) WorkspaceSummary {
	return WorkspaceSummary{ID: entry.ID, Name: entry.Name, CreatedAt: entry.CreatedAt, UpdatedAt: entry.UpdatedAt, LastOpenedAt: entry.LastOpenedAt, ArchivedAt: entry.ArchivedAt, DeletedAt: entry.DeletedAt, Unavailable: true}
}

func (m *WorkspaceManager) openService(entry catalogEntry) (*Service, error) {
	directory, err := m.directoryFor(entry)
	if err != nil {
		return nil, err
	}
	service := m.newService(directory)
	if err := service.Init(); err != nil {
		return nil, err
	}
	id, found, err := service.WorkspaceID()
	if err != nil || !found || id != entry.ID {
		service.Shutdown()
		return nil, errors.New("workspace identity does not match its catalog entry")
	}
	return service, nil
}

func (m *WorkspaceManager) directoryFor(entry catalogEntry) (string, error) {
	if entry.RelativeDirectory == "." {
		return m.root, nil
	}
	parts := strings.Split(filepath.ToSlash(entry.RelativeDirectory), "/")
	if len(parts) != 2 || parts[0] != "workspaces" || parts[1] != entry.ID {
		return "", errors.New("workspace path is invalid")
	}
	if _, err := uuid.Parse(entry.ID); err != nil {
		return "", errors.New("workspace ID is invalid")
	}
	directory := filepath.Join(m.root, "workspaces", entry.ID)
	root := filepath.Clean(m.root) + string(os.PathSeparator)
	if !strings.HasPrefix(filepath.Clean(directory)+string(os.PathSeparator), root) {
		return "", errors.New("workspace path escapes the data directory")
	}
	return directory, nil
}
