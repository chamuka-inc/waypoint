package waypoint

import (
	_ "embed"
	"encoding/json"
)

type Priorities struct {
	Compensation float64 `json:"compensation"`
	Flexibility  float64 `json:"flexibility"`
	Growth       float64 `json:"growth"`
	Fit          float64 `json:"fit"`
}

type Profile struct {
	Name               string     `json:"name"`
	Headline           string     `json:"headline"`
	Location           string     `json:"location"`
	Background         string     `json:"background"`
	Skills             []string   `json:"skills"`
	Projects           string     `json:"projects"`
	Qualifications     string     `json:"qualifications"`
	Ambitions          string     `json:"ambitions"`
	WorkAuthorization  string     `json:"workAuthorization"`
	SalaryMin          float64    `json:"salaryMin"`
	Currency           string     `json:"currency"`
	WorkModes          []string   `json:"workModes"`
	Locations          string     `json:"locations"`
	Industries         string     `json:"industries"`
	ExcludedIndustries string     `json:"excludedIndustries"`
	Seniority          string     `json:"seniority"`
	Commute            string     `json:"commute"`
	Priorities         Priorities `json:"priorities"`
}

type Evidence struct {
	Requirement       string `json:"requirement"`
	Importance        string `json:"importance"`
	Assessment        string `json:"assessment"`
	CandidateEvidence string `json:"candidateEvidence"`
	Explanation       string `json:"explanation"`
}

type Source struct {
	URL       string `json:"url"`
	Title     string `json:"title"`
	Excerpt   string `json:"excerpt"`
	CheckedAt string `json:"checkedAt"`
}

type Scores struct {
	Fit          float64 `json:"fit"`
	Growth       float64 `json:"growth"`
	Flexibility  float64 `json:"flexibility"`
	Compensation float64 `json:"compensation"`
}

type JevAssessment struct {
	Fit        string  `json:"fit"`
	Confidence float64 `json:"confidence"`
	Supported  float64 `json:"supported"`
	Growth     float64 `json:"growth"`
	Review     bool    `json:"review"`
}

type Opportunity struct {
	ID                string         `json:"id"`
	Company           string         `json:"company"`
	Title             string         `json:"title"`
	Industry          string         `json:"industry"`
	Location          string         `json:"location"`
	WorkMode          string         `json:"workMode"`
	SalaryMin         *float64       `json:"salaryMin"`
	SalaryMax         *float64       `json:"salaryMax"`
	Currency          string         `json:"currency"`
	SalaryPeriod      string         `json:"salaryPeriod"`
	Seniority         string         `json:"seniority"`
	Fit               string         `json:"fit"`
	Summary           string         `json:"summary"`
	Responsibilities  []string       `json:"responsibilities"`
	Evidence          []Evidence     `json:"evidence"`
	Gaps              []string       `json:"gaps"`
	NonBlockers       []string       `json:"nonBlockers"`
	Questions         []string       `json:"questions"`
	Strategy          []string       `json:"strategy"`
	Interview         []string       `json:"interview"`
	Skills            []string       `json:"skills"`
	Scores            Scores         `json:"scores"`
	Sources           []Source       `json:"sources"`
	Status            string         `json:"status"`
	WorkAuthorization string         `json:"workAuthorization"`
	Demo              bool           `json:"demo"`
	DiscoveredAt      string         `json:"discoveredAt"`
	Jev               *JevAssessment `json:"jev,omitempty"`
}

type RoleFamily struct {
	Title       string   `json:"title"`
	Fit         string   `json:"fit"`
	Why         string   `json:"why"`
	Skills      []string `json:"skills"`
	Gaps        []string `json:"gaps"`
	SearchTerms []string `json:"searchTerms"`
}

type Feedback struct {
	ID        string   `json:"id"`
	RoleID    string   `json:"roleId"`
	Kind      string   `json:"kind"`
	Company   string   `json:"company"`
	Title     string   `json:"title"`
	Industry  string   `json:"industry"`
	Skills    []string `json:"skills"`
	CreatedAt string   `json:"createdAt"`
}

type Application struct {
	RoleID    string `json:"roleId"`
	Stage     string `json:"stage"`
	Notes     string `json:"notes"`
	UpdatedAt string `json:"updatedAt"`
}

type DraftEvidence struct {
	Claim       string `json:"claim"`
	Source      string `json:"source"`
	Requirement string `json:"requirement"`
}

type DraftContent struct {
	Application string          `json:"application"`
	Resume      string          `json:"resume"`
	Evidence    []DraftEvidence `json:"evidence"`
	Questions   []string        `json:"questions"`
}

type ApplicationDraft struct {
	RoleID              string        `json:"roleId"`
	Company             string        `json:"company"`
	Title               string        `json:"title"`
	SourceURL           string        `json:"sourceUrl"`
	SourceCheckedAt     string        `json:"sourceCheckedAt"`
	ProfileRevision     int           `json:"profileRevision"`
	RoleFingerprint     string        `json:"roleFingerprint"`
	Revision            int           `json:"revision"`
	Status              string        `json:"status"`
	Error               string        `json:"error"`
	Generated           DraftContent  `json:"generated"`
	Edited              DraftContent  `json:"edited"`
	Pending             *DraftContent `json:"pending,omitempty"`
	ApplicationReviewed bool          `json:"applicationReviewed"`
	ResumeReviewed      bool          `json:"resumeReviewed"`
	CreatedAt           string        `json:"createdAt"`
	UpdatedAt           string        `json:"updatedAt"`
}

type ResearchSourceActivity struct {
	URL    string `json:"url"`
	Title  string `json:"title"`
	Status string `json:"status"`
	SeenAt string `json:"seenAt"`
}

type ResearchRun struct {
	ID         string                   `json:"id"`
	StartedAt  string                   `json:"startedAt"`
	FinishedAt string                   `json:"finishedAt,omitempty"`
	Status     string                   `json:"status"`
	Events     []string                 `json:"events"`
	Sources    []ResearchSourceActivity `json:"sources,omitempty"`
	Count      int                      `json:"count"`
	Error      string                   `json:"error,omitempty"`
}

type ResearchSchedule struct {
	Enabled   bool   `json:"enabled"`
	Time      string `json:"time"`
	LastRunAt string `json:"lastRunAt"`
}

type Settings struct {
	JevEnabled       bool             `json:"jevEnabled"`
	JevModel         string           `json:"jevModel"`
	ResearchSchedule ResearchSchedule `json:"researchSchedule"`
}

type State struct {
	Version          int                `json:"version"`
	Demo             bool               `json:"demo"`
	Profile          Profile            `json:"profile"`
	Roles            []Opportunity      `json:"roles"`
	Families         []RoleFamily       `json:"families"`
	Saved            []string           `json:"saved"`
	Applications     []Application      `json:"applications"`
	Drafts           []ApplicationDraft `json:"drafts"`
	Feedback         []Feedback         `json:"feedback"`
	Runs             []ResearchRun      `json:"runs"`
	Summary          string             `json:"summary"`
	Questions        []string           `json:"questions"`
	ProfileRevision  int                `json:"profileRevision"`
	ResearchRevision int                `json:"researchRevision"`
	Settings         Settings           `json:"settings"`
}

type ResearchResult struct {
	Summary   string        `json:"summary"`
	Roles     []Opportunity `json:"roles"`
	Families  []RoleFamily  `json:"families"`
	Questions []string      `json:"questions"`
}

type RuntimeStatus struct {
	Desktop       bool   `json:"desktop"`
	Codex         bool   `json:"codex"`
	CodexVersion  string `json:"codexVersion"`
	JevConfigured bool   `json:"jevConfigured"`
	Storage       string `json:"storage"`
}

type WorkspaceSummary struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Current          bool   `json:"current"`
	Demo             bool   `json:"demo"`
	OpportunityCount int    `json:"opportunityCount"`
	SavedCount       int    `json:"savedCount"`
	ProfileComplete  bool   `json:"profileComplete"`
	ResearchRunning  bool   `json:"researchRunning"`
	CreatedAt        string `json:"createdAt"`
	UpdatedAt        string `json:"updatedAt"`
	LastOpenedAt     string `json:"lastOpenedAt"`
	ArchivedAt       string `json:"archivedAt,omitempty"`
	DeletedAt        string `json:"deletedAt,omitempty"`
	Unavailable      bool   `json:"unavailable"`
}

type WorkspaceBootstrap struct {
	Workspace  WorkspaceSummary   `json:"workspace"`
	Workspaces []WorkspaceSummary `json:"workspaces"`
	State      State              `json:"state"`
	Epoch      uint64             `json:"epoch"`
}

type CreateWorkspaceInput struct {
	Name  string `json:"name"`
	Mode  string `json:"mode"`
	State *State `json:"state,omitempty"`
}

//go:embed demo.json
var demoJSON []byte

func InitialState(demo bool) State {
	var state State
	if err := json.Unmarshal(demoJSON, &state); err != nil {
		panic("invalid embedded demo state: " + err.Error())
	}
	if demo {
		return state
	}
	return State{
		Version: 1,
		Profile: Profile{
			Currency:  "GBP",
			WorkModes: []string{"Remote", "Hybrid"},
			Skills:    []string{},
			Priorities: Priorities{
				Fit: 5, Compensation: 3, Flexibility: 4, Growth: 4,
			},
		},
		Roles: []Opportunity{}, Families: []RoleFamily{}, Saved: []string{},
		Applications: []Application{}, Drafts: []ApplicationDraft{}, Feedback: []Feedback{}, Runs: []ResearchRun{}, Questions: []string{},
		Settings: Settings{JevModel: "jev-latest", ResearchSchedule: ResearchSchedule{Time: "09:00"}},
	}
}

func cloneState(input State) State {
	data, _ := json.Marshal(input)
	var output State
	_ = json.Unmarshal(data, &output)
	return output
}
