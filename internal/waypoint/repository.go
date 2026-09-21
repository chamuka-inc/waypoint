package waypoint

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

const databaseFilename = "waypoint.db"

// WorkspaceRepository keeps persistence behind a narrow boundary so the
// application service remains independent of the local database and a future
// optional sync adapter can be added without changing renderer actions.
type WorkspaceRepository interface {
	Init() error
	Load() (State, bool, error)
	Save(State) error
	WorkspaceID() (string, bool, error)
	SetWorkspaceID(string) error
	Close() error
}

type SQLiteRepository struct {
	directory string
	db        *sql.DB
}

func NewSQLiteRepository(directory string) *SQLiteRepository {
	return &SQLiteRepository{directory: directory}
}

func (r *SQLiteRepository) Init() error {
	if err := os.MkdirAll(r.directory, 0o700); err != nil {
		return fmt.Errorf("create workspace: %w", err)
	}
	if err := os.Chmod(r.directory, 0o700); err != nil {
		return fmt.Errorf("protect workspace directory: %w", err)
	}
	path := filepath.Join(r.directory, databaseFilename)
	databaseURL := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	query := databaseURL.Query()
	query.Add("_pragma", "foreign_keys(1)")
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "synchronous(FULL)")
	databaseURL.RawQuery = query.Encode()
	dsn := databaseURL.String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return fmt.Errorf("open workspace database: %w", err)
	}
	// Waypoint is a single-process desktop application. One connection makes
	// transaction ordering deterministic while WAL still makes future read-only
	// sync/export connections possible.
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return fmt.Errorf("open workspace database: %w", err)
	}
	r.db = db
	if err := r.migrate(); err != nil {
		_ = db.Close()
		r.db = nil
		return fmt.Errorf("migrate workspace database: %w", err)
	}
	if err := r.protectFiles(); err != nil {
		_ = db.Close()
		r.db = nil
		return err
	}
	return nil
}

func (r *SQLiteRepository) migrate() error {
	if r.db == nil {
		return errors.New("database is not open")
	}
	var version int
	if err := r.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > 2 {
		return fmt.Errorf("database schema %d is newer than this application supports", version)
	}
	if version == 2 {
		return nil
	}
	if version == 0 {
		if err := r.migrateInitialSchema(); err != nil {
			return err
		}
	}
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`CREATE TABLE workspace_identity (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		workspace_id TEXT NOT NULL UNIQUE
	) STRICT`)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(`PRAGMA user_version = 2`); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *SQLiteRepository) migrateInitialSchema() error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	statements := []string{
		`CREATE TABLE workspace (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			version INTEGER NOT NULL,
			demo INTEGER NOT NULL CHECK (demo IN (0, 1)),
			profile_json TEXT NOT NULL,
			summary TEXT NOT NULL,
			questions_json TEXT NOT NULL,
			profile_revision INTEGER NOT NULL,
			research_revision INTEGER NOT NULL,
			settings_json TEXT NOT NULL
		) STRICT`,
		`CREATE TABLE opportunities (
			id TEXT PRIMARY KEY,
			position INTEGER NOT NULL UNIQUE,
			company TEXT NOT NULL,
			title TEXT NOT NULL,
			location TEXT NOT NULL,
			discovered_at TEXT NOT NULL,
			payload_json TEXT NOT NULL
		) STRICT`,
		`CREATE INDEX opportunities_company_title ON opportunities(company, title)`,
		`CREATE INDEX opportunities_discovered_at ON opportunities(discovered_at)`,
		`CREATE TABLE role_families (
			position INTEGER PRIMARY KEY,
			payload_json TEXT NOT NULL
		) STRICT`,
		`CREATE TABLE saved_opportunities (
			role_id TEXT PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
			position INTEGER NOT NULL UNIQUE
		) STRICT`,
		`CREATE TABLE applications (
			role_id TEXT PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
			stage TEXT NOT NULL CHECK (stage IN ('Saved', 'Preparing', 'Applied', 'Interview', 'Offer')),
			notes TEXT NOT NULL,
			updated_at TEXT NOT NULL
		) STRICT`,
		`CREATE TABLE feedback (
			id TEXT PRIMARY KEY,
			role_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
			kind TEXT NOT NULL CHECK (kind IN ('more', 'too-technical', 'too-junior', 'salary-low', 'no-industry', 'not-interested')),
			company TEXT NOT NULL,
			title TEXT NOT NULL,
			industry TEXT NOT NULL,
			skills_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		) STRICT`,
		`CREATE INDEX feedback_role_id ON feedback(role_id)`,
		`CREATE TABLE research_runs (
			id TEXT PRIMARY KEY,
			position INTEGER NOT NULL UNIQUE,
			started_at TEXT NOT NULL,
			finished_at TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
			count INTEGER NOT NULL,
			error TEXT NOT NULL
		) STRICT`,
		`CREATE TABLE research_run_events (
			run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
			position INTEGER NOT NULL,
			message TEXT NOT NULL,
			PRIMARY KEY (run_id, position)
		) STRICT`,
		`CREATE TABLE research_run_sources (
			run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
			position INTEGER NOT NULL,
			url TEXT NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('found', 'reviewing', 'reviewed')),
			seen_at TEXT NOT NULL,
			PRIMARY KEY (run_id, position),
			UNIQUE (run_id, url)
		) STRICT`,
		`PRAGMA user_version = 1`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (r *SQLiteRepository) WorkspaceID() (string, bool, error) {
	if r.db == nil {
		return "", false, errors.New("database is not open")
	}
	var id string
	err := r.db.QueryRow(`SELECT workspace_id FROM workspace_identity WHERE id = 1`).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return id, err == nil, err
}

func (r *SQLiteRepository) SetWorkspaceID(id string) error {
	if r.db == nil {
		return errors.New("database is not open")
	}
	if id == "" {
		return errors.New("workspace ID is required")
	}
	_, err := r.db.Exec(`INSERT INTO workspace_identity (id, workspace_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id`, id)
	return err
}

func (r *SQLiteRepository) Load() (State, bool, error) {
	if r.db == nil {
		return State{}, false, errors.New("database is not open")
	}
	var state State
	var demo int
	var profileJSON, questionsJSON, settingsJSON string
	err := r.db.QueryRow(`SELECT version, demo, profile_json, summary, questions_json, profile_revision, research_revision, settings_json FROM workspace WHERE id = 1`).Scan(
		&state.Version, &demo, &profileJSON, &state.Summary, &questionsJSON, &state.ProfileRevision, &state.ResearchRevision, &settingsJSON,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return State{}, false, nil
	}
	if err != nil {
		return State{}, false, err
	}
	state.Demo = demo == 1
	state.Roles = []Opportunity{}
	state.Families = []RoleFamily{}
	state.Saved = []string{}
	state.Applications = []Application{}
	state.Feedback = []Feedback{}
	state.Runs = []ResearchRun{}
	state.Questions = []string{}
	if err := decodeJSONColumns(
		jsonColumn{profileJSON, &state.Profile},
		jsonColumn{questionsJSON, &state.Questions},
		jsonColumn{settingsJSON, &state.Settings},
	); err != nil {
		return State{}, false, err
	}

	rows, err := r.db.Query(`SELECT id, payload_json FROM opportunities ORDER BY position`)
	if err != nil {
		return State{}, false, err
	}
	for rows.Next() {
		var id, payload string
		var role Opportunity
		if err := rows.Scan(&id, &payload); err != nil {
			rows.Close()
			return State{}, false, err
		}
		if json.Unmarshal([]byte(payload), &role) != nil || role.ID != id {
			rows.Close()
			return State{}, false, errors.New("invalid opportunity data")
		}
		state.Roles = append(state.Roles, role)
	}
	if err := rows.Close(); err != nil {
		return State{}, false, err
	}

	rows, err = r.db.Query(`SELECT payload_json FROM role_families ORDER BY position`)
	if err != nil {
		return State{}, false, err
	}
	for rows.Next() {
		var payload string
		var family RoleFamily
		if err := rows.Scan(&payload); err != nil || json.Unmarshal([]byte(payload), &family) != nil {
			rows.Close()
			return State{}, false, errors.New("invalid role family data")
		}
		state.Families = append(state.Families, family)
	}
	if err := rows.Close(); err != nil {
		return State{}, false, err
	}

	rows, err = r.db.Query(`SELECT role_id FROM saved_opportunities ORDER BY position`)
	if err != nil {
		return State{}, false, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return State{}, false, err
		}
		state.Saved = append(state.Saved, id)
	}
	if err := rows.Close(); err != nil {
		return State{}, false, err
	}

	rows, err = r.db.Query(`SELECT role_id, stage, notes, updated_at FROM applications ORDER BY rowid`)
	if err != nil {
		return State{}, false, err
	}
	for rows.Next() {
		var item Application
		if err := rows.Scan(&item.RoleID, &item.Stage, &item.Notes, &item.UpdatedAt); err != nil {
			rows.Close()
			return State{}, false, err
		}
		state.Applications = append(state.Applications, item)
	}
	if err := rows.Close(); err != nil {
		return State{}, false, err
	}

	rows, err = r.db.Query(`SELECT id, role_id, kind, company, title, industry, skills_json, created_at FROM feedback ORDER BY rowid`)
	if err != nil {
		return State{}, false, err
	}
	for rows.Next() {
		var item Feedback
		var skillsJSON string
		if err := rows.Scan(&item.ID, &item.RoleID, &item.Kind, &item.Company, &item.Title, &item.Industry, &skillsJSON, &item.CreatedAt); err != nil || json.Unmarshal([]byte(skillsJSON), &item.Skills) != nil {
			rows.Close()
			return State{}, false, errors.New("invalid feedback data")
		}
		state.Feedback = append(state.Feedback, item)
	}
	if err := rows.Close(); err != nil {
		return State{}, false, err
	}

	rows, err = r.db.Query(`SELECT id, started_at, finished_at, status, count, error FROM research_runs ORDER BY position`)
	if err != nil {
		return State{}, false, err
	}
	for rows.Next() {
		var run ResearchRun
		if err := rows.Scan(&run.ID, &run.StartedAt, &run.FinishedAt, &run.Status, &run.Count, &run.Error); err != nil {
			rows.Close()
			return State{}, false, err
		}
		state.Runs = append(state.Runs, run)
	}
	if err := rows.Close(); err != nil {
		return State{}, false, err
	}
	for index := range state.Runs {
		if err := r.loadRunDetails(&state.Runs[index]); err != nil {
			return State{}, false, err
		}
	}
	return state, true, nil
}

func (r *SQLiteRepository) loadRunDetails(run *ResearchRun) error {
	rows, err := r.db.Query(`SELECT message FROM research_run_events WHERE run_id = ? ORDER BY position`, run.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var message string
		if err := rows.Scan(&message); err != nil {
			rows.Close()
			return err
		}
		run.Events = append(run.Events, message)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	rows, err = r.db.Query(`SELECT url, title, status, seen_at FROM research_run_sources WHERE run_id = ? ORDER BY position`, run.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var source ResearchSourceActivity
		if err := rows.Scan(&source.URL, &source.Title, &source.Status, &source.SeenAt); err != nil {
			rows.Close()
			return err
		}
		run.Sources = append(run.Sources, source)
	}
	return rows.Close()
}

func (r *SQLiteRepository) Save(state State) error {
	if r.db == nil {
		return errors.New("database is not open")
	}
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := r.protectFiles(); err != nil {
		return err
	}
	profileJSON, err := marshalJSON(state.Profile)
	if err != nil {
		return err
	}
	questionsJSON, err := marshalJSON(state.Questions)
	if err != nil {
		return err
	}
	settingsJSON, err := marshalJSON(state.Settings)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO workspace (id, version, demo, profile_json, summary, questions_json, profile_revision, research_revision, settings_json)
		VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET version=excluded.version, demo=excluded.demo, profile_json=excluded.profile_json, summary=excluded.summary,
		questions_json=excluded.questions_json, profile_revision=excluded.profile_revision, research_revision=excluded.research_revision, settings_json=excluded.settings_json`,
		state.Version, boolInt(state.Demo), profileJSON, state.Summary, questionsJSON, state.ProfileRevision, state.ResearchRevision, settingsJSON)
	if err != nil {
		return err
	}
	for _, table := range []string{"opportunities", "role_families", "research_runs"} {
		if _, err := tx.Exec("DELETE FROM " + table); err != nil {
			return err
		}
	}
	for position, role := range state.Roles {
		payload, err := marshalJSON(role)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO opportunities (id, position, company, title, location, discovered_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`, role.ID, position, role.Company, role.Title, role.Location, role.DiscoveredAt, payload); err != nil {
			return err
		}
	}
	for position, family := range state.Families {
		payload, err := marshalJSON(family)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO role_families (position, payload_json) VALUES (?, ?)`, position, payload); err != nil {
			return err
		}
	}
	for position, id := range state.Saved {
		if _, err := tx.Exec(`INSERT INTO saved_opportunities (role_id, position) VALUES (?, ?)`, id, position); err != nil {
			return err
		}
	}
	for _, item := range state.Applications {
		if _, err := tx.Exec(`INSERT INTO applications (role_id, stage, notes, updated_at) VALUES (?, ?, ?, ?)`, item.RoleID, item.Stage, item.Notes, item.UpdatedAt); err != nil {
			return err
		}
	}
	for _, item := range state.Feedback {
		skillsJSON, err := marshalJSON(item.Skills)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO feedback (id, role_id, kind, company, title, industry, skills_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, item.ID, item.RoleID, item.Kind, item.Company, item.Title, item.Industry, skillsJSON, item.CreatedAt); err != nil {
			return err
		}
	}
	for position, run := range state.Runs {
		if _, err := tx.Exec(`INSERT INTO research_runs (id, position, started_at, finished_at, status, count, error) VALUES (?, ?, ?, ?, ?, ?, ?)`, run.ID, position, run.StartedAt, run.FinishedAt, run.Status, run.Count, run.Error); err != nil {
			return err
		}
		for eventPosition, message := range run.Events {
			if _, err := tx.Exec(`INSERT INTO research_run_events (run_id, position, message) VALUES (?, ?, ?)`, run.ID, eventPosition, message); err != nil {
				return err
			}
		}
		for sourcePosition, source := range run.Sources {
			if _, err := tx.Exec(`INSERT INTO research_run_sources (run_id, position, url, title, status, seen_at) VALUES (?, ?, ?, ?, ?, ?)`, run.ID, sourcePosition, source.URL, source.Title, source.Status, source.SeenAt); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func (r *SQLiteRepository) Close() error {
	if r.db == nil {
		return nil
	}
	err := r.db.Close()
	r.db = nil
	return err
}

func (r *SQLiteRepository) protectFiles() error {
	for _, suffix := range []string{"", "-wal", "-shm"} {
		path := databasePath(r.directory) + suffix
		if err := os.Chmod(path, 0o600); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("protect workspace database files: %w", err)
		}
	}
	return nil
}

type jsonColumn struct {
	value  string
	target any
}

func decodeJSONColumns(columns ...jsonColumn) error {
	for _, column := range columns {
		if json.Unmarshal([]byte(column.value), column.target) != nil {
			return errors.New("invalid JSON data in workspace database")
		}
	}
	return nil
}

func marshalJSON(value any) (string, error) {
	data, err := json.Marshal(value)
	return string(data), err
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func databasePath(directory string) string { return filepath.Join(directory, databaseFilename) }
