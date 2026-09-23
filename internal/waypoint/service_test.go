package waypoint

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func testResult() ResearchResult {
	state := InitialState(true)
	role := state.Roles[0]
	role.ID = "role-test"
	role.Demo = false
	role.Status = "open"
	role.Sources = []Source{{URL: "https://careers.example.org/jobs/1", Title: "Role", Excerpt: "Lead product delivery."}}
	return ResearchResult{Summary: "Sourced research", Roles: []Opportunity{role}, Families: state.Families[:1], Questions: []string{"What scope do you prefer?"}}
}

func waitForResearch(t *testing.T, service *Service) State {
	t.Helper()
	for range 200 {
		state := service.State()
		if len(state.Runs) > 0 && state.Runs[0].Status != "running" {
			return state
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("research did not settle")
	return State{}
}

func TestServicePersistsDesktopActions(t *testing.T) {
	directory := t.TempDir()
	service := NewServiceWithResearcher(directory, func(_ context.Context, _ State, _ func(string, *ResearchSourceActivity)) (ResearchResult, error) {
		return testResult(), nil
	})
	if err := service.Init(); err != nil {
		t.Fatal(err)
	}
	profile := InitialState(true).Profile
	if _, err := service.SaveProfile(profile); err != nil {
		t.Fatal(err)
	}
	if _, err := service.StartResearch(); err != nil {
		t.Fatal(err)
	}
	state := waitForResearch(t, service)
	if state.Runs[0].Status != "completed" || len(state.Roles) != 1 {
		t.Fatalf("unexpected research state: %#v", state.Runs[0])
	}
	id := state.Roles[0].ID
	if _, err := service.ToggleSave(id); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Feedback(id, "more"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetApplication(id, "Preparing", "Prepare the activation story."); err != nil {
		t.Fatal(err)
	}
	service.Shutdown()
	restored := NewService(directory)
	if err := restored.Init(); err != nil {
		t.Fatal(err)
	}
	state = restored.State()
	if !contains(state.Saved, id) || state.Applications[0].Notes != "Prepare the activation story." || state.Feedback[0].Kind != "more" {
		t.Fatalf("workspace was not restored: %#v", state)
	}
	if _, err := restored.Dispatch("constructor", nil); err == nil {
		t.Fatal("unknown dispatch action was accepted")
	}
}

func TestSafeURLAndResearchValidation(t *testing.T) {
	for _, address := range []string{"javascript:alert(1)", "https://127.0.0.1/a", "https://company.internal/jobs"} {
		if SafeURL(address) != "" {
			t.Fatalf("unsafe URL accepted: %s", address)
		}
	}
	clean := SafeURL("https://careers.example.org/jobs/1?utm_source=test#apply")
	if clean != "https://careers.example.org/jobs/1" {
		t.Fatalf("unexpected clean URL: %s", clean)
	}
	result := testResult()
	result.Roles = append(result.Roles, result.Roles[0])
	data, _ := jsonMarshal(result)
	parsed, err := ParseResearch(data, time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC))
	if err != nil || len(parsed.Roles) != 1 || !strings.HasPrefix(parsed.Roles[0].ID, "role-") {
		t.Fatalf("unexpected parsed result: %#v %v", parsed, err)
	}
	negative := -1.0
	result = testResult()
	result.Roles[0].SalaryMin = &negative
	data, _ = jsonMarshal(result)
	if _, err := ParseResearch(data, time.Now()); err == nil {
		t.Fatal("negative salary was accepted")
	}
	result = testResult()
	result.Families[0].Why = strings.Repeat("x", 12001)
	data, _ = jsonMarshal(result)
	if _, err := ParseResearch(data, time.Now()); err == nil {
		t.Fatal("oversized family explanation was accepted")
	}
}

func TestCodexDiscoveryWorksWithoutTheShellPath(t *testing.T) {
	home := t.TempDir()
	candidates := codexCandidatePaths(home, "darwin")
	if !contains(candidates, "/usr/local/bin/codex") || !contains(candidates, "/opt/homebrew/bin/codex") {
		t.Fatalf("macOS Homebrew paths are missing: %#v", candidates)
	}
	binary := filepath.Join(home, ".local", "bin", "codex")
	if err := os.MkdirAll(filepath.Dir(binary), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	missing := func(string) (string, error) { return "", errors.New("not on PATH") }
	resolved, err := resolveCodexBinaryWith("", missing, home, "darwin")
	if err != nil || resolved != binary {
		t.Fatalf("packaged app did not discover Codex outside PATH: %q %v", resolved, err)
	}

	environment := codexCommandEnvironment([]string{"PATH=/usr/bin:/bin", "TYPESAFE_API_KEY=secret", "SAFE=value"}, binary)
	pathValue := environmentValue(environment, "PATH")
	if !strings.HasPrefix(pathValue, filepath.Dir(binary)+string(os.PathListSeparator)) {
		t.Fatalf("Codex directory was not prepended to PATH: %s", pathValue)
	}
	if environmentValue(environment, "TYPESAFE_API_KEY") != "" || environmentValue(environment, "SAFE") != "value" {
		t.Fatalf("Codex environment was not filtered safely: %#v", environment)
	}
}

func TestCodexDiscoveryHonoursExplicitOverride(t *testing.T) {
	wanted := filepath.Join(t.TempDir(), "custom-codex")
	lookup := func(name string) (string, error) {
		if name == wanted {
			return wanted, nil
		}
		return "", errors.New("not found")
	}
	resolved, err := resolveCodexBinaryWith(wanted, lookup, "", "darwin")
	if err != nil || resolved != wanted {
		t.Fatalf("CODEX_BIN override was not honoured: %q %v", resolved, err)
	}
	if _, err := resolveCodexBinaryWith("missing-codex", lookup, "", "darwin"); err == nil {
		t.Fatal("invalid CODEX_BIN override was accepted")
	}
}

func TestStatusFindsCodexOutsideGUIPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test uses a Unix shell executable")
	}
	home := t.TempDir()
	binary := filepath.Join(home, ".local", "bin", "codex")
	if err := os.MkdirAll(filepath.Dir(binary), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf 'codex-cli 0.0-test\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("CODEX_BIN", "")
	status := NewService(t.TempDir()).Status()
	if !status.Codex || status.CodexVersion != "codex-cli 0.0-test" {
		t.Fatalf("Codex was not detected outside the GUI path: %#v", status)
	}
}

func TestResearchSaveFailureIsReported(t *testing.T) {
	release := make(chan struct{})
	directory := t.TempDir()
	service := NewServiceWithResearcher(directory, func(_ context.Context, _ State, _ func(string, *ResearchSourceActivity)) (ResearchResult, error) {
		<-release
		return testResult(), nil
	})
	if err := service.Init(); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SaveProfile(InitialState(true).Profile); err != nil {
		t.Fatal(err)
	}
	if _, err := service.StartResearch(); err != nil {
		t.Fatal(err)
	}
	service.mu.Lock()
	service.persistHook = func() error { return errors.New("disk full") }
	service.mu.Unlock()
	close(release)
	state := waitForResearch(t, service)
	if state.Runs[0].Status != "failed" || !strings.Contains(state.Runs[0].Error, "could not be saved") {
		t.Fatalf("save failure was not surfaced: %#v", state.Runs[0])
	}
	service.mu.Lock()
	service.persistHook = nil
	service.mu.Unlock()
	service.Shutdown()
}

func TestScheduleDueOncePerLocalSlot(t *testing.T) {
	location := time.FixedZone("test", 3600)
	last := time.Date(2026, 8, 20, 12, 0, 0, 0, location)
	schedule := ResearchSchedule{Enabled: true, Time: "09:00", LastRunAt: last.Format(time.RFC3339Nano)}
	if ScheduleDue(schedule, time.Date(2026, 8, 21, 8, 59, 0, 0, location)) {
		t.Fatal("schedule became due early")
	}
	if !ScheduleDue(schedule, time.Date(2026, 8, 21, 9, 0, 0, 0, location)) {
		t.Fatal("schedule was not due")
	}
	schedule.LastRunAt = time.Date(2026, 8, 21, 9, 0, 0, 0, location).Format(time.RFC3339Nano)
	if ScheduleDue(schedule, time.Date(2026, 8, 21, 12, 0, 0, 0, location)) {
		t.Fatal("schedule ran twice")
	}
}

func TestDocumentImports(t *testing.T) {
	for _, name := range []string{"resume.pdf", "resume.docx"} {
		data, err := os.ReadFile(filepath.Join("..", "..", "tests", "fixtures", name))
		if err != nil {
			t.Fatal(err)
		}
		text, err := ImportCV(name, base64.StdEncoding.EncodeToString(data))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !strings.Contains(strings.ToLower(text), "product discovery") || !strings.Contains(strings.ToLower(text), "customer research") {
			t.Fatalf("%s text was incomplete: %q", name, text)
		}
	}
}

func TestCorruptWorkspaceIsPreserved(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "state.json")
	if err := os.WriteFile(path, []byte("not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := NewService(directory).Init(); err == nil {
		t.Fatal("corrupt state was accepted")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "not-json" {
		t.Fatal("corrupt state was overwritten")
	}
}

func TestLegacyJSONWorkspaceMigratesToSQLiteAndRemainsAsBackup(t *testing.T) {
	directory := t.TempDir()
	legacy := InitialState(false)
	legacy.Profile = InitialState(true).Profile
	legacy.Profile.Name = "Migrated Candidate"
	data, err := json.MarshalIndent(legacy, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	legacyPath := filepath.Join(directory, "state.json")
	if err := os.WriteFile(legacyPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	service := NewService(directory)
	if err := service.Init(); err != nil {
		t.Fatal(err)
	}
	if service.State().Profile.Name != "Migrated Candidate" {
		t.Fatal("legacy profile was not imported")
	}
	service.Shutdown()
	if _, err := os.Stat(databasePath(directory)); err != nil {
		t.Fatalf("SQLite database was not created: %v", err)
	}
	preserved, err := os.ReadFile(legacyPath)
	if err != nil || string(preserved) != string(data) {
		t.Fatal("legacy state.json was not preserved byte-for-byte")
	}
	legacy.Profile.Name = "Stale Legacy Candidate"
	stale, _ := json.Marshal(legacy)
	if err := os.WriteFile(legacyPath, stale, 0o600); err != nil {
		t.Fatal(err)
	}
	restored := NewService(directory)
	if err := restored.Init(); err != nil {
		t.Fatal(err)
	}
	defer restored.Shutdown()
	if restored.State().Profile.Name != "Migrated Candidate" {
		t.Fatal("database did not take precedence after migration")
	}
}

func TestSQLiteSaveIsTransactional(t *testing.T) {
	directory := t.TempDir()
	repository := NewSQLiteRepository(directory)
	if err := repository.Init(); err != nil {
		t.Fatal(err)
	}
	defer repository.Close()
	original := InitialState(true)
	if err := repository.Save(original); err != nil {
		t.Fatal(err)
	}
	invalid := cloneState(original)
	invalid.Profile.Name = "Should Roll Back"
	invalid.Saved = append(invalid.Saved, "missing-role")
	if err := repository.Save(invalid); err == nil {
		t.Fatal("invalid foreign-key reference was accepted")
	}
	loaded, found, err := repository.Load()
	if err != nil || !found {
		t.Fatalf("could not reload prior transaction: %v", err)
	}
	if loaded.Profile.Name != original.Profile.Name || contains(loaded.Saved, "missing-role") {
		t.Fatal("failed transaction changed the stored workspace")
	}
}

func TestSQLiteWorkspaceUsesRestrictedFilePermissions(t *testing.T) {
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	repository := NewSQLiteRepository(directory)
	if err := repository.Init(); err != nil {
		t.Fatal(err)
	}
	defer repository.Close()
	for _, suffix := range []string{"", "-wal", "-shm"} {
		info, err := os.Stat(databasePath(directory) + suffix)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("workspace database file %q permissions are too broad: %o", suffix, info.Mode().Perm())
		}
	}
	directoryInfo, err := os.Stat(directory)
	if err != nil {
		t.Fatal(err)
	}
	if directoryInfo.Mode().Perm()&0o077 != 0 {
		t.Fatalf("workspace directory permissions are too broad: %o", directoryInfo.Mode().Perm())
	}
}

func jsonMarshal(value any) ([]byte, error) {
	return json.Marshal(value)
}
