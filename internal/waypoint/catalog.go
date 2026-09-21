package waypoint

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const catalogFilename = "catalog.db"

type catalogEntry struct {
	ID                string
	Name              string
	RelativeDirectory string
	CreatedAt         string
	UpdatedAt         string
	LastOpenedAt      string
	ArchivedAt        string
	DeletedAt         string
}

type CatalogRepository struct {
	root string
	db   *sql.DB
}

func NewCatalogRepository(root string) *CatalogRepository { return &CatalogRepository{root: root} }

func (c *CatalogRepository) Init() error {
	if err := os.MkdirAll(c.root, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(c.root, 0o700); err != nil {
		return err
	}
	path := filepath.Join(c.root, catalogFilename)
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	query := u.Query()
	query.Add("_pragma", "foreign_keys(1)")
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "synchronous(FULL)")
	u.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return err
	}
	c.db = db
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS catalog_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		current_workspace_id TEXT NOT NULL
	) STRICT;
	CREATE TABLE IF NOT EXISTS workspaces (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL COLLATE NOCASE UNIQUE,
		relative_directory TEXT NOT NULL UNIQUE,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		last_opened_at TEXT NOT NULL,
		archived_at TEXT NOT NULL DEFAULT '',
		deleted_at TEXT NOT NULL DEFAULT ''
	) STRICT;`)
	if err != nil {
		_ = db.Close()
		c.db = nil
		return err
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Chmod(path+suffix, 0o600); err != nil && !errors.Is(err, os.ErrNotExist) {
			_ = db.Close()
			c.db = nil
			return err
		}
	}
	return nil
}

func (c *CatalogRepository) Close() error {
	if c.db == nil {
		return nil
	}
	err := c.db.Close()
	c.db = nil
	return err
}

func (c *CatalogRepository) Entries() ([]catalogEntry, error) {
	rows, err := c.db.Query(`SELECT id, name, relative_directory, created_at, updated_at, last_opened_at, archived_at, deleted_at FROM workspaces ORDER BY last_opened_at DESC, created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []catalogEntry{}
	for rows.Next() {
		var item catalogEntry
		if err := rows.Scan(&item.ID, &item.Name, &item.RelativeDirectory, &item.CreatedAt, &item.UpdatedAt, &item.LastOpenedAt, &item.ArchivedAt, &item.DeletedAt); err != nil {
			return nil, err
		}
		entries = append(entries, item)
	}
	return entries, rows.Err()
}

func (c *CatalogRepository) Entry(id string) (catalogEntry, error) {
	var item catalogEntry
	err := c.db.QueryRow(`SELECT id, name, relative_directory, created_at, updated_at, last_opened_at, archived_at, deleted_at FROM workspaces WHERE id = ?`, id).Scan(
		&item.ID, &item.Name, &item.RelativeDirectory, &item.CreatedAt, &item.UpdatedAt, &item.LastOpenedAt, &item.ArchivedAt, &item.DeletedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return catalogEntry{}, errors.New("workspace not found")
	}
	return item, err
}

func (c *CatalogRepository) CurrentID() (string, bool, error) {
	var id string
	err := c.db.QueryRow(`SELECT current_workspace_id FROM catalog_state WHERE id = 1`).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return id, err == nil, err
}

func (c *CatalogRepository) Add(entry catalogEntry, makeCurrent bool) error {
	tx, err := c.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`INSERT INTO workspaces (id, name, relative_directory, created_at, updated_at, last_opened_at, archived_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		entry.ID, entry.Name, entry.RelativeDirectory, entry.CreatedAt, entry.UpdatedAt, entry.LastOpenedAt, entry.ArchivedAt, entry.DeletedAt)
	if err != nil {
		return friendlyCatalogError(err)
	}
	if makeCurrent {
		if _, err := tx.Exec(`INSERT INTO catalog_state (id, current_workspace_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET current_workspace_id = excluded.current_workspace_id`, entry.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (c *CatalogRepository) SetCurrent(id string) error {
	now := nowISO()
	tx, err := c.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`UPDATE workspaces SET last_opened_at = ?, updated_at = ? WHERE id = ? AND archived_at = '' AND deleted_at = ''`, now, now, id)
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		return errors.New("workspace is not available")
	}
	if _, err := tx.Exec(`INSERT INTO catalog_state (id, current_workspace_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET current_workspace_id = excluded.current_workspace_id`, id); err != nil {
		return err
	}
	return tx.Commit()
}

func (c *CatalogRepository) Rename(id, name string) error {
	result, err := c.db.Exec(`UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ? AND deleted_at = ''`, name, nowISO(), id)
	if err != nil {
		return friendlyCatalogError(err)
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		return errors.New("workspace not found")
	}
	return nil
}

func (c *CatalogRepository) SetLifecycle(id, field, value string) error {
	if field != "archived_at" && field != "deleted_at" {
		return errors.New("invalid workspace lifecycle change")
	}
	query := fmt.Sprintf("UPDATE workspaces SET %s = ?, updated_at = ? WHERE id = ?", field)
	result, err := c.db.Exec(query, value, nowISO(), id)
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		return errors.New("workspace not found")
	}
	return nil
}

func (c *CatalogRepository) Restore(id string) error {
	result, err := c.db.Exec(`UPDATE workspaces SET archived_at = '', deleted_at = '', updated_at = ? WHERE id = ?`, nowISO(), id)
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		return errors.New("workspace not found")
	}
	return nil
}

func (c *CatalogRepository) Remove(id string) error {
	_, err := c.db.Exec(`DELETE FROM workspaces WHERE id = ? AND deleted_at != ''`, id)
	return err
}

func (c *CatalogRepository) ActiveCount() (int, error) {
	var count int
	err := c.db.QueryRow(`SELECT COUNT(*) FROM workspaces WHERE archived_at = '' AND deleted_at = ''`).Scan(&count)
	return count, err
}

func validateWorkspaceName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 80 {
		return "", errors.New("workspace name must be between 1 and 80 characters")
	}
	return name, nil
}

func friendlyCatalogError(err error) error {
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "unique") {
		return errors.New("a workspace with that name already exists")
	}
	return err
}
