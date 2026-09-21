package waypoint

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
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

func jsonMarshal(value any) ([]byte, error) {
	return json.Marshal(value)
}
