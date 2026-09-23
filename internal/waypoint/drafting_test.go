package waypoint

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func waitForDraft(t *testing.T, service *Service, id string) ApplicationDraft {
	t.Helper()
	for range 200 {
		for _, draft := range service.State().Drafts {
			if draft.RoleID == id && draft.Status != "running" {
				return draft
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("draft did not settle")
	return ApplicationDraft{}
}

func TestDraftLifecyclePersistsAndProtectsOpportunity(t *testing.T) {
	dir := t.TempDir()
	service := NewServiceWithResearcher(dir, func(context.Context, State, func(string, *ResearchSourceActivity)) (ResearchResult, error) {
		return testResult(), nil
	})
	service.drafter = func(_ context.Context, input DraftInput) (DraftContent, error) {
		return DraftContent{Application: strings.Repeat("I led the onboarding redesign. ", 4), Resume: strings.Repeat("Senior Product Manager, onboarding redesign. ", 4), Evidence: []DraftEvidence{{Claim: "Onboarding redesign", Source: "Senior Product Manager", Requirement: "Product delivery"}}, Questions: []string{"Confirm the dates."}}, nil
	}
	if err := service.Init(); err != nil {
		t.Fatal(err)
	}
	defer service.Shutdown()
	if _, err := service.StartDraft("sample-1", "", ""); err == nil {
		t.Fatal("sample draft was allowed")
	}
	if _, err := service.SaveProfile(InitialState(true).Profile); err != nil {
		t.Fatal(err)
	}
	if _, err := service.StartResearch(); err != nil {
		t.Fatal(err)
	}
	state := waitForResearch(t, service)
	id := state.Roles[0].ID
	if _, err := service.StartDraft(id, "", ""); err != nil {
		t.Fatal(err)
	}
	draft := waitForDraft(t, service, id)
	if draft.Status != "ready" || !hasApplication(service.State().Applications, id) {
		t.Fatalf("draft was not prepared: %#v", draft)
	}
	if _, err := service.SaveDraft(id, draft.Revision-1, draft.Edited.Application, draft.Edited.Resume); err == nil {
		t.Fatal("stale edit was accepted")
	}
	state, err := service.SaveDraft(id, draft.Revision, draft.Edited.Application+" Edited.", draft.Edited.Resume)
	if err != nil {
		t.Fatal(err)
	}
	draft = state.Drafts[0]
	state, err = service.ReviewDraft(id, draft.Revision, "application")
	if err != nil || !state.Drafts[0].ApplicationReviewed {
		t.Fatalf("review failed: %v", err)
	}
	service.Shutdown()
	reopened := NewService(dir)
	if err := reopened.Init(); err != nil {
		t.Fatal(err)
	}
	defer reopened.Shutdown()
	draft = reopened.State().Drafts[0]
	if !strings.HasSuffix(draft.Edited.Application, " Edited.") || !draft.ApplicationReviewed {
		t.Fatal("draft was not persisted")
	}
	// The cap evicts an unprotected opportunity even when the protected draft is oldest.
	reopened.mu.Lock()
	for index := range 50 {
		role := reopened.state.Roles[0]
		role.ID = "extra-" + string(rune(65+index))
		role.DiscoveredAt = time.Now().UTC().Format(time.RFC3339Nano)
		reopened.state.Roles = append(reopened.state.Roles, role)
	}
	reopened.capOpportunitiesLocked()
	protected := reopened.draftLocked(id) != nil
	reopened.mu.Unlock()
	if !protected || len(reopened.State().Roles) != MaxOpportunities {
		t.Fatal("opportunity cap removed a drafted role")
	}
}

func TestDraftClaimEvidenceMustComeFromCandidate(t *testing.T) {
	input := DraftInput{Profile: InitialState(true).Profile}
	content := DraftContent{Application: strings.Repeat("Application text. ", 6), Resume: strings.Repeat("Resume text. ", 8), Evidence: []DraftEvidence{{Claim: "Managed 100 people", Source: "managed 100 people", Requirement: "Leadership"}}}
	if validateDraftContent(content, input) == nil {
		t.Fatal("unsupported evidence was accepted")
	}
}

func TestDraftCodexSubprocessUsesReadOnlySchemaAndStdin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell test fixture")
	}
	dir := t.TempDir()
	inputPath, argsPath := filepath.Join(dir, "input.txt"), filepath.Join(dir, "args.txt")
	binary := filepath.Join(dir, "codex")
	content := DraftContent{Application: strings.Repeat("I led onboarding work. ", 5), Resume: strings.Repeat("Senior Product Manager. ", 5), Evidence: []DraftEvidence{{Claim: "Product management", Source: "Senior Product Manager", Requirement: "Product delivery"}}, Questions: []string{}}
	data, _ := json.Marshal(content)
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$WAYPOINT_TEST_ARGS\"\ncat > \"$WAYPOINT_TEST_INPUT\"\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = '--output-last-message' ]; then shift; printf '%s' '" + string(data) + "' > \"$1\"; break; fi\n  shift\ndone\n"
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_BIN", binary)
	t.Setenv("WAYPOINT_TEST_INPUT", inputPath)
	t.Setenv("WAYPOINT_TEST_ARGS", argsPath)
	result, err := RunCodexDraft(context.Background(), DraftInput{Profile: InitialState(true).Profile, Role: testResult().Roles[0]})
	if err != nil || result.Application == "" {
		t.Fatalf("draft subprocess failed: %v", err)
	}
	args, _ := os.ReadFile(argsPath)
	prompt, _ := os.ReadFile(inputPath)
	if !strings.Contains(string(args), "read-only") || !strings.Contains(string(args), "--output-schema") || strings.Contains(string(args), "--search") || !strings.Contains(string(prompt), "Senior Product Manager") {
		t.Fatal("draft subprocess contract was not respected")
	}
}
