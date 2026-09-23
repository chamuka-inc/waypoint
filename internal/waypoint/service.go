package waypoint

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/zalando/go-keyring"
)

const MaxOpportunities = 50

var (
	schedulePattern = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
	modelPattern    = regexp.MustCompile(`^jev-[a-zA-Z0-9._-]{1,80}$`)
)

type Researcher func(context.Context, State, func(string, *ResearchSourceActivity)) (ResearchResult, error)

type Service struct {
	mu                sync.RWMutex
	directory         string
	repository        WorkspaceRepository
	state             State
	activeCancel      context.CancelFunc
	activeDraftCancel context.CancelFunc
	researcher        Researcher
	drafter           Drafter
	sessionKey        string
	wg                sync.WaitGroup
	persistHook       func() error
}

func NewService(directory string) *Service {
	return NewServiceWithRepository(directory, NewSQLiteRepository(directory))
}

func NewServiceWithRepository(directory string, repository WorkspaceRepository) *Service {
	return &Service{directory: directory, repository: repository, state: InitialState(true), researcher: RunCodex, drafter: RunCodexDraft}
}

func NewServiceWithResearcher(directory string, researcher Researcher) *Service {
	service := NewService(directory)
	service.researcher = researcher
	return service
}

func (s *Service) Init() error {
	if err := s.repository.Init(); err != nil {
		return fmt.Errorf("could not open your saved workspace. The existing database has been preserved: %w", err)
	}
	loaded, found, err := s.repository.Load()
	if err != nil {
		_ = s.repository.Close()
		return errors.New("could not read your saved workspace. The existing database has been preserved. Restore a compatible workspace backup to continue")
	}
	if !found {
		loaded, found, err = s.loadLegacyState()
		if err != nil {
			_ = s.repository.Close()
			return err
		}
		if !found {
			loaded = InitialState(true)
		}
	}
	if err := prepareLoadedState(&loaded); err != nil {
		_ = s.repository.Close()
		return errors.New("could not read your saved workspace. The existing data has been preserved. Restore a compatible workspace backup to continue")
	}
	s.state = loaded
	s.capOpportunitiesLocked()
	if key, err := keyring.Get("Waypoint", "typesafe-api-key"); err == nil {
		s.sessionKey = key
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.persistLocked(); err != nil {
		_ = s.repository.Close()
		return err
	}
	return nil
}

func (s *Service) loadLegacyState() (State, bool, error) {
	path := filepath.Join(s.directory, "state.json")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return State{}, false, nil
	}
	if err != nil {
		return State{}, false, errors.New("could not read your saved workspace. The existing state.json has been preserved")
	}
	var loaded State
	if json.Unmarshal(data, &loaded) != nil {
		return State{}, false, errors.New("could not read your saved workspace. The existing state.json has been preserved")
	}
	return loaded, true, nil
}

func prepareLoadedState(loaded *State) error {
	if loaded.Version != 1 || loaded.Roles == nil || loaded.Families == nil || loaded.Saved == nil || loaded.Applications == nil || loaded.Feedback == nil || loaded.Runs == nil || loaded.Questions == nil || validateProfile(loaded.Profile) != nil {
		return errors.New("invalid workspace")
	}
	defaults := InitialState(false).Settings
	if loaded.Settings.JevModel == "" {
		loaded.Settings.JevModel = defaults.JevModel
	}
	if loaded.Drafts == nil {
		loaded.Drafts = []ApplicationDraft{}
	}
	for index := range loaded.Drafts {
		if loaded.Drafts[index].Status == "running" {
			loaded.Drafts[index].Status = "failed"
			loaded.Drafts[index].Error = "The application closed before drafting finished."
		}
	}
	if !schedulePattern.MatchString(loaded.Settings.ResearchSchedule.Time) {
		loaded.Settings.ResearchSchedule.Time = defaults.ResearchSchedule.Time
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for index := range loaded.Runs {
		if loaded.Runs[index].Status == "running" {
			loaded.Runs[index].Status = "failed"
			loaded.Runs[index].Error = "The application closed before research finished."
			loaded.Runs[index].FinishedAt = now
		}
	}
	return nil
}

func (s *Service) State() State {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneState(s.state)
}

func (s *Service) ActiveResearch() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.activeCancel != nil || s.activeDraftCancel != nil
}

func (s *Service) WorkspaceID() (string, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.repository.WorkspaceID()
}

func (s *Service) SetWorkspaceID(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.repository.SetWorkspaceID(id)
}

func (s *Service) ImportState(state State) (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeCancel != nil || s.activeDraftCancel != nil {
		return State{}, errors.New("cancel active research before importing a workspace")
	}
	if err := validateImportedState(state); err != nil {
		return State{}, errors.New("the workspace backup is invalid or incompatible")
	}
	if err := prepareLoadedState(&state); err != nil {
		return State{}, errors.New("the workspace backup is invalid or incompatible")
	}
	previous := s.state
	s.state = cloneState(state)
	s.capOpportunitiesLocked()
	if err := s.persistLocked(); err != nil {
		s.state = previous
		return State{}, err
	}
	return cloneState(s.state), nil
}

func validateImportedState(state State) error {
	if state.Version != 1 || state.Roles == nil || state.Families == nil || state.Saved == nil || state.Applications == nil || state.Feedback == nil || state.Runs == nil || state.Questions == nil || state.Profile.Skills == nil || state.Profile.WorkModes == nil {
		return errors.New("invalid workspace")
	}
	if len(state.Roles) > MaxOpportunities || len(state.Drafts) > MaxOpportunities || len(state.Families) > 12 || len(state.Saved) > MaxOpportunities || len(state.Runs) > 30 || !validText(state.Summary, 12000) || !validStrings(state.Questions, 40) || state.ProfileRevision < 0 || state.ResearchRevision < 0 {
		return errors.New("invalid workspace")
	}
	if err := validateProfile(state.Profile); err != nil || !modelPattern.MatchString(state.Settings.JevModel) || !schedulePattern.MatchString(state.Settings.ResearchSchedule.Time) {
		return errors.New("invalid workspace")
	}
	if value := state.Settings.ResearchSchedule.LastRunAt; value != "" {
		if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
			return errors.New("invalid workspace")
		}
	}
	if err := validateWorkspaceFamilies(state.Families); err != nil {
		return err
	}

	roleIDs := map[string]bool{}
	for _, role := range state.Roles {
		if role.ID == "" || roleIDs[role.ID] || role.Responsibilities == nil || role.Evidence == nil || role.Gaps == nil || role.NonBlockers == nil || role.Questions == nil || role.Strategy == nil || role.Interview == nil || role.Skills == nil || role.Sources == nil {
			return errors.New("invalid workspace")
		}
		roleIDs[role.ID] = true
		candidate := role
		if candidate.Demo && len(candidate.Sources) == 0 {
			candidate.Sources = []Source{{}}
		}
		if err := validateResearchStructure(ResearchResult{Summary: "Workspace import", Roles: []Opportunity{candidate}, Families: []RoleFamily{}, Questions: []string{}}); err != nil {
			return errors.New("invalid workspace")
		}
		if role.Demo != state.Demo || (!role.Demo && len(role.Sources) == 0) || (role.SalaryMin != nil && role.SalaryMax != nil && *role.SalaryMin > *role.SalaryMax) {
			return errors.New("invalid workspace")
		}
		for _, source := range role.Sources {
			if SafeURL(source.URL) == "" || strings.TrimSpace(source.Excerpt) == "" {
				return errors.New("invalid workspace")
			}
		}
		if role.Jev != nil && (!validFit(role.Jev.Fit) || !probability(role.Jev.Confidence) || !probability(role.Jev.Supported) || !probability(role.Jev.Growth)) {
			return errors.New("invalid workspace")
		}
	}

	seenSaved := map[string]bool{}
	for _, id := range state.Saved {
		if !roleIDs[id] || seenSaved[id] {
			return errors.New("invalid workspace")
		}
		seenSaved[id] = true
	}
	seenApplications := map[string]bool{}
	for _, item := range state.Applications {
		if !roleIDs[item.RoleID] || seenApplications[item.RoleID] || !oneOf(item.Stage, "Saved", "Preparing", "Applied", "Interview", "Offer") || !validText(item.Notes, 20000) || !validText(item.UpdatedAt, 12000) {
			return errors.New("invalid workspace")
		}
		seenApplications[item.RoleID] = true
	}
	seenDrafts := map[string]bool{}
	for _, draft := range state.Drafts {
		if !roleIDs[draft.RoleID] || seenDrafts[draft.RoleID] || draft.Revision < 1 || draft.ProfileRevision < 0 || !oneOf(draft.Status, "running", "ready", "failed", "cancelled") || !validText(draft.Company, 12000) || !validText(draft.Title, 12000) || !validText(draft.Error, 12000) || (draft.SourceURL != "" && SafeURL(draft.SourceURL) == "") || !validDraftContent(draft.Generated) || !validDraftContent(draft.Edited) || (draft.Pending != nil && !validDraftContent(*draft.Pending)) {
			return errors.New("invalid workspace")
		}
		seenDrafts[draft.RoleID] = true
	}
	seenFeedback := map[string]bool{}
	for _, item := range state.Feedback {
		if item.ID == "" || seenFeedback[item.ID] || !roleIDs[item.RoleID] || item.Skills == nil || !oneOf(item.Kind, "more", "too-technical", "too-junior", "salary-low", "no-industry", "not-interested") || !validText(item.Company, 12000) || !validText(item.Title, 12000) || !validText(item.Industry, 12000) || !validStrings(item.Skills, 40) || !validText(item.CreatedAt, 12000) {
			return errors.New("invalid workspace")
		}
		seenFeedback[item.ID] = true
	}
	seenRuns := map[string]bool{}
	for _, run := range state.Runs {
		if run.ID == "" || seenRuns[run.ID] || run.Events == nil || run.Count < 0 || !oneOf(run.Status, "running", "completed", "failed", "cancelled") || !validText(run.StartedAt, 12000) || !validText(run.FinishedAt, 12000) || !validText(run.Error, 12000) || !validStrings(run.Events, 60) || len(run.Sources) > 60 {
			return errors.New("invalid workspace")
		}
		seenRuns[run.ID] = true
		for _, source := range run.Sources {
			if SafeURL(source.URL) == "" || !oneOf(source.Status, "found", "reviewing", "reviewed") || !validText(source.Title, 12000) || !validText(source.SeenAt, 12000) {
				return errors.New("invalid workspace")
			}
		}
	}
	return nil
}

func validateWorkspaceFamilies(families []RoleFamily) error {
	for _, family := range families {
		if family.Skills == nil || family.Gaps == nil || family.SearchTerms == nil || family.Title == "" || !validText(family.Title, 12000) || !validText(family.Why, 12000) || !oneOf(family.Fit, "direct", "adjacent", "stretch") || !validStrings(family.Skills, 40) || !validStrings(family.Gaps, 40) || !validStrings(family.SearchTerms, 40) {
			return errors.New("invalid workspace")
		}
	}
	return nil
}

func (s *Service) persistLocked() error {
	if s.persistHook != nil {
		return s.persistHook()
	}
	return s.repository.Save(s.state)
}

func (s *Service) SaveProfile(profile Profile) (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeCancel != nil || s.activeDraftCancel != nil {
		return State{}, errors.New("finish or cancel the current research before changing your profile")
	}
	if err := validateProfile(profile); err != nil {
		return State{}, err
	}
	if s.state.Demo {
		settings := s.state.Settings
		s.state = InitialState(false)
		s.state.Settings = settings
	}
	s.state.Profile = profile
	s.state.ProfileRevision++
	if err := s.persistLocked(); err != nil {
		return State{}, err
	}
	return cloneState(s.state), nil
}

func (s *Service) Reset() (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeCancel != nil || s.activeDraftCancel != nil {
		return State{}, errors.New("cancel the active research before starting a new profile")
	}
	settings := s.state.Settings
	s.state = InitialState(false)
	s.state.Settings = settings
	if err := s.persistLocked(); err != nil {
		return State{}, err
	}
	return cloneState(s.state), nil
}

func (s *Service) roleLocked(id string) (*Opportunity, error) {
	for index := range s.state.Roles {
		if s.state.Roles[index].ID == id {
			return &s.state.Roles[index], nil
		}
	}
	return nil, errors.New("this opportunity is no longer available")
}

func (s *Service) removeRoleDataLocked(ids map[string]bool) {
	roles := s.state.Roles[:0]
	for _, role := range s.state.Roles {
		if !ids[role.ID] {
			roles = append(roles, role)
		}
	}
	s.state.Roles = roles
	saved := s.state.Saved[:0]
	for _, id := range s.state.Saved {
		if !ids[id] {
			saved = append(saved, id)
		}
	}
	s.state.Saved = saved
	applications := s.state.Applications[:0]
	for _, item := range s.state.Applications {
		if !ids[item.RoleID] {
			applications = append(applications, item)
		}
	}
	s.state.Applications = applications
	drafts := s.state.Drafts[:0]
	for _, item := range s.state.Drafts {
		if !ids[item.RoleID] {
			drafts = append(drafts, item)
		}
	}
	s.state.Drafts = drafts
	feedback := s.state.Feedback[:0]
	for _, item := range s.state.Feedback {
		if !ids[item.RoleID] {
			feedback = append(feedback, item)
		}
	}
	s.state.Feedback = feedback
}

func (s *Service) capOpportunitiesLocked() {
	sort.SliceStable(s.state.Roles, func(left, right int) bool {
		return parseTime(s.state.Roles[left].DiscoveredAt).After(parseTime(s.state.Roles[right].DiscoveredAt))
	})
	if len(s.state.Roles) <= MaxOpportunities {
		return
	}
	removed := map[string]bool{}
	protected := map[string]bool{}
	for _, draft := range s.state.Drafts {
		protected[draft.RoleID] = true
	}
	toRemove := len(s.state.Roles) - MaxOpportunities
	for index := len(s.state.Roles) - 1; index >= 0 && toRemove > 0; index-- {
		if !protected[s.state.Roles[index].ID] {
			removed[s.state.Roles[index].ID] = true
			toRemove--
		}
	}
	s.removeRoleDataLocked(removed)
}

func (s *Service) RemoveRoles(ids []string) (State, error) {
	if len(ids) < 1 || len(ids) > MaxOpportunities {
		return State{}, errors.New("choose between 1 and 50 opportunities to remove")
	}
	set := map[string]bool{}
	for _, id := range ids {
		if id == "" {
			return State{}, errors.New("choose between 1 and 50 opportunities to remove")
		}
		set[id] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeDraftCancel != nil {
		return State{}, errors.New("cancel draft generation before removing opportunities")
	}
	s.removeRoleDataLocked(set)
	if err := s.persistLocked(); err != nil {
		return State{}, err
	}
	return cloneState(s.state), nil
}

func (s *Service) ToggleSave(id string) (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.roleLocked(id); err != nil {
		return State{}, err
	}
	for index, saved := range s.state.Saved {
		if saved == id {
			s.state.Saved = append(s.state.Saved[:index], s.state.Saved[index+1:]...)
			if err := s.persistLocked(); err != nil {
				return State{}, err
			}
			return cloneState(s.state), nil
		}
	}
	s.state.Saved = append(s.state.Saved, id)
	if err := s.persistLocked(); err != nil {
		return State{}, err
	}
	return cloneState(s.state), nil
}

func (s *Service) Feedback(id, kind string) (State, error) {
	valid := map[string]bool{"more": true, "too-technical": true, "too-junior": true, "salary-low": true, "no-industry": true, "not-interested": true}
	if !valid[kind] {
		return State{}, errors.New("unknown feedback type")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	role, err := s.roleLocked(id)
	if err != nil {
		return State{}, err
	}
	items := s.state.Feedback[:0]
	for _, item := range s.state.Feedback {
		if item.RoleID != id || item.Kind != kind {
			items = append(items, item)
		}
	}
	s.state.Feedback = append(items, Feedback{ID: uuid.NewString(), RoleID: id, Kind: kind, Company: role.Company, Title: role.Title, Industry: role.Industry, Skills: append([]string{}, role.Skills...), CreatedAt: nowISO()})
	if err := s.persistLocked(); err != nil {
		return State{}, err
	}
	return cloneState(s.state), nil
}

func (s *Service) UndoFeedback(id string) (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := s.state.Feedback[:0]
	for _, item := range s.state.Feedback {
		if item.ID != id {
			items = append(items, item)
		}
	}
	s.state.Feedback = items
	if err := s.persistLocked(); err != nil {
		return State{}, err
	}
	return cloneState(s.state), nil
}

func (s *Service) SetApplication(id, stage, notes string) (State, error) {
	valid := map[string]bool{"Saved": true, "Preparing": true, "Applied": true, "Interview": true, "Offer": true}
	if !valid[stage] || len(notes) > 20000 {
		return State{}, errors.New("invalid application details")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.roleLocked(id); err != nil {
		return State{}, err
	}
	item := Application{RoleID: id, Stage: stage, Notes: notes, UpdatedAt: nowISO()}
	found := false
	for index := range s.state.Applications {
		if s.state.Applications[index].RoleID == id {
			s.state.Applications[index] = item
			found = true
		}
	}
	if !found {
		s.state.Applications = append(s.state.Applications, item)
	}
	if !contains(s.state.Saved, id) {
		s.state.Saved = append(s.state.Saved, id)
	}
	if err := s.persistLocked(); err != nil {
		return State{}, err
	}
	return cloneState(s.state), nil
}

func (s *Service) UpdateSettings(settings Settings, key *string) (State, error) {
	if !modelPattern.MatchString(settings.JevModel) {
		return State{}, errors.New("enter a valid Jev model identifier")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeCancel != nil || s.activeDraftCancel != nil {
		return State{}, errors.New("finish research before changing AI settings")
	}
	if key != nil {
		trimmed := strings.TrimSpace(*key)
		if len(trimmed) > 2000 {
			return State{}, errors.New("invalid API key")
		}
		s.sessionKey = trimmed
		if trimmed == "" {
			_ = keyring.Delete("Waypoint", "typesafe-api-key")
		} else {
			_ = keyring.Set("Waypoint", "typesafe-api-key", trimmed)
		}
	}
	if settings.JevEnabled && s.getKeyLocked() == "" {
		return State{}, errors.New("add a TypeSafe API key before enabling Jev")
	}
	settings.ResearchSchedule = s.state.Settings.ResearchSchedule
	s.state.Settings = settings
	if err := s.persistLocked(); err != nil {
		return State{}, err
	}
	return cloneState(s.state), nil
}

func (s *Service) SetSchedule(schedule ResearchSchedule) (State, error) {
	if !schedulePattern.MatchString(schedule.Time) {
		return State{}, errors.New("choose a valid research schedule")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if schedule.Enabled && s.state.Demo {
		return State{}, errors.New("create your profile before enabling scheduled research")
	}
	if schedule.Enabled && !s.state.Settings.ResearchSchedule.Enabled {
		schedule.LastRunAt = nowISO()
	} else {
		schedule.LastRunAt = s.state.Settings.ResearchSchedule.LastRunAt
	}
	s.state.Settings.ResearchSchedule = schedule
	if err := s.persistLocked(); err != nil {
		return State{}, err
	}
	return cloneState(s.state), nil
}

func ScheduleDue(schedule ResearchSchedule, now time.Time) bool {
	if !schedule.Enabled || !schedulePattern.MatchString(schedule.Time) {
		return false
	}
	parts := strings.Split(schedule.Time, ":")
	hour, minute := 0, 0
	_, _ = fmt.Sscanf(parts[0], "%d", &hour)
	_, _ = fmt.Sscanf(parts[1], "%d", &minute)
	slot := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, now.Location())
	if slot.After(now) {
		slot = slot.AddDate(0, 0, -1)
	}
	last := parseTime(schedule.LastRunAt)
	return schedule.LastRunAt == "" || last.Before(slot)
}

func (s *Service) StartScheduledResearch(now time.Time) (bool, error) {
	s.mu.RLock()
	due := ScheduleDue(s.state.Settings.ResearchSchedule, now) && s.activeCancel == nil
	s.mu.RUnlock()
	if !due {
		return false, nil
	}
	if _, err := s.StartResearch(); err != nil {
		return false, err
	}
	s.mu.Lock()
	s.state.Settings.ResearchSchedule.LastRunAt = now.UTC().Format(time.RFC3339Nano)
	err := s.persistLocked()
	s.mu.Unlock()
	return err == nil, err
}

func (s *Service) Status() RuntimeStatus {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	binary, err := resolveCodexBinary()
	var output []byte
	if err == nil {
		command := exec.CommandContext(ctx, binary, "--version")
		command.Env = codexCommandEnvironment(os.Environ(), binary)
		output, err = command.Output()
	}
	s.mu.RLock()
	configured := s.getKeyLocked() != ""
	s.mu.RUnlock()
	version := ""
	if err == nil {
		version = strings.TrimSpace(string(output))
		if len(version) > 120 {
			version = version[:120]
		}
	}
	return RuntimeStatus{Desktop: true, Codex: err == nil, CodexVersion: version, JevConfigured: configured, Storage: "SQLite device workspace"}
}

func (s *Service) getKeyLocked() string {
	if s.sessionKey != "" {
		return s.sessionKey
	}
	return os.Getenv("TYPESAFE_API_KEY")
}

func (s *Service) Shutdown() {
	s.mu.Lock()
	if s.activeCancel != nil {
		s.activeCancel()
	}
	if s.activeDraftCancel != nil {
		s.activeDraftCancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
	_ = s.repository.Close()
}

func (s *Service) Dispatch(method string, args []any) (any, error) {
	if len(args) > 3 {
		return nil, errors.New("unknown action")
	}
	switch method {
	case "getState":
		return s.State(), nil
	case "saveProfile":
		var value Profile
		if err := decodeArg(args, 0, &value); err != nil {
			return nil, err
		}
		return s.SaveProfile(value)
	case "reset":
		return s.Reset()
	case "toggleSave":
		var id string
		if err := decodeArg(args, 0, &id); err != nil {
			return nil, err
		}
		return s.ToggleSave(id)
	case "removeRoles":
		var ids []string
		if err := decodeArg(args, 0, &ids); err != nil {
			return nil, err
		}
		return s.RemoveRoles(ids)
	case "feedback":
		var id, kind string
		if err := decodeArg(args, 0, &id); err != nil {
			return nil, err
		}
		if err := decodeArg(args, 1, &kind); err != nil {
			return nil, err
		}
		return s.Feedback(id, kind)
	case "undoFeedback":
		var id string
		if err := decodeArg(args, 0, &id); err != nil {
			return nil, err
		}
		return s.UndoFeedback(id)
	case "setApplication":
		var id, stage, notes string
		if err := decodeArg(args, 0, &id); err != nil {
			return nil, err
		}
		if err := decodeArg(args, 1, &stage); err != nil {
			return nil, err
		}
		if err := decodeArg(args, 2, &notes); err != nil {
			return nil, err
		}
		return s.SetApplication(id, stage, notes)
	case "startDraft":
		var id, focus, description string
		if err := decodeArg(args, 0, &id); err != nil {
			return nil, err
		}
		if err := decodeArg(args, 1, &focus); err != nil {
			return nil, err
		}
		if err := decodeArg(args, 2, &description); err != nil {
			return nil, err
		}
		return s.StartDraft(id, focus, description)
	case "cancelDraft":
		return s.CancelDraft()
	case "saveDraft":
		var input struct {
			ID          string `json:"id"`
			Revision    int    `json:"revision"`
			Application string `json:"application"`
			Resume      string `json:"resume"`
		}
		if err := decodeArg(args, 0, &input); err != nil {
			return nil, err
		}
		return s.SaveDraft(input.ID, input.Revision, input.Application, input.Resume)
	case "reviewDraft":
		var id, kind string
		var revision int
		if err := decodeArg(args, 0, &id); err != nil {
			return nil, err
		}
		if err := decodeArg(args, 1, &revision); err != nil {
			return nil, err
		}
		if err := decodeArg(args, 2, &kind); err != nil {
			return nil, err
		}
		return s.ReviewDraft(id, revision, kind)
	case "acceptDraft":
		var id string
		var revision int
		if err := decodeArg(args, 0, &id); err != nil {
			return nil, err
		}
		if err := decodeArg(args, 1, &revision); err != nil {
			return nil, err
		}
		return s.AcceptDraft(id, revision)
	case "startResearch":
		return s.StartResearch()
	case "cancelResearch":
		return s.CancelResearch()
	case "status":
		return s.Status(), nil
	case "settings":
		var settings Settings
		if err := decodeArg(args, 0, &settings); err != nil {
			return nil, err
		}
		var key *string
		if len(args) > 1 && args[1] != nil {
			var value string
			if err := decodeArg(args, 1, &value); err != nil {
				return nil, err
			}
			key = &value
		}
		return s.UpdateSettings(settings, key)
	case "schedule":
		var schedule ResearchSchedule
		if err := decodeArg(args, 0, &schedule); err != nil {
			return nil, err
		}
		return s.SetSchedule(schedule)
	case "importCV":
		var name, data string
		if err := decodeArg(args, 0, &name); err != nil {
			return nil, err
		}
		if err := decodeArg(args, 1, &data); err != nil {
			return nil, err
		}
		return ImportCV(name, data)
	default:
		return nil, errors.New("unknown action")
	}
}

func validateProfile(profile Profile) error {
	fields := []string{profile.Name, profile.Headline, profile.Location, profile.Projects, profile.Qualifications, profile.Ambitions, profile.WorkAuthorization, profile.Locations, profile.Industries, profile.ExcludedIndustries, profile.Seniority, profile.Commute}
	for _, value := range fields {
		if len(value) > 12000 {
			return errors.New("profile fields are missing or invalid. Check your salary, currency, and preferences")
		}
	}
	if profile.SalaryMin < 0 || profile.SalaryMin > 100000000 || !regexp.MustCompile(`^[A-Z]{3}$`).MatchString(profile.Currency) || len(profile.Background) > 60000 || len(profile.Skills) > 40 || len(profile.WorkModes) > 4 {
		return errors.New("profile fields are missing or invalid. Check your salary, currency, and preferences")
	}
	seenModes := map[string]bool{}
	for _, mode := range profile.WorkModes {
		if !oneOf(mode, "Remote", "Hybrid", "On-site", "Unknown") || seenModes[mode] {
			return errors.New("profile fields are missing or invalid. Check your salary, currency, and preferences")
		}
		seenModes[mode] = true
	}
	for _, skill := range profile.Skills {
		if len(skill) > 12000 {
			return errors.New("profile fields are missing or invalid. Check your salary, currency, and preferences")
		}
	}
	values := []float64{profile.Priorities.Compensation, profile.Priorities.Flexibility, profile.Priorities.Growth, profile.Priorities.Fit}
	total := 0.0
	for _, value := range values {
		if value < 0 || value > 5 {
			return errors.New("profile fields are missing or invalid. Check your salary, currency, and preferences")
		}
		total += value
	}
	if total == 0 {
		return errors.New("set at least one priority above zero")
	}
	return nil
}

func decodeArg(args []any, index int, target any) error {
	if index >= len(args) {
		return errors.New("unknown action")
	}
	data, err := json.Marshal(args[index])
	if err != nil || json.Unmarshal(data, target) != nil {
		return errors.New("invalid action parameters")
	}
	return nil
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func oneOf(value string, values ...string) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func parseTime(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	return parsed
}

func nowISO() string { return time.Now().UTC().Format(time.RFC3339Nano) }
