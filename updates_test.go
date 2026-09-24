package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	tests := []struct {
		latest, current string
		want            int
	}{
		{"v0.3.2", "0.3.1", 1},
		{"v0.3.1", "0.3.1", 0},
		{"v0.3.0", "0.3.1", -1},
		{"v0.10.0", "0.9.9", 1},
		{"v1.0.0", "1.0.0-beta.1", 1},
	}
	for _, test := range tests {
		got, err := compareVersions(test.latest, test.current)
		if err != nil || got != test.want {
			t.Errorf("compareVersions(%q, %q) = %d, %v; want %d", test.latest, test.current, got, err, test.want)
		}
	}
	if _, err := compareVersions("not-a-version", "0.3.1"); err == nil {
		t.Fatal("invalid tags must be rejected")
	}
}

func TestFetchUpdate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead || r.Header.Get("Authorization") != "" {
			t.Error("release check must be a public HEAD request without credentials")
		}
		if r.URL.Path == "/chamuka-inc/waypoint/releases/latest" {
			http.Redirect(w, r, "/chamuka-inc/waypoint/releases/tag/v0.4.0", http.StatusFound)
		}
	}))
	defer server.Close()
	info, err := fetchUpdate(context.Background(), server.Client(), server.URL+"/chamuka-inc/waypoint/releases/latest", "0.3.1")
	if err != nil {
		t.Fatal(err)
	}
	if !info.Available || info.LatestVersion != "0.4.0" || info.ReleaseURL != releasePageBase+"v0.4.0" {
		t.Fatalf("unexpected update: %#v", info)
	}
}

func TestFetchUpdateRejectsInvalidRelease(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/chamuka-inc/waypoint/releases/latest" {
			http.Redirect(w, r, "/chamuka-inc/elsewhere/releases/tag/v0.4.0", http.StatusFound)
		}
	}))
	defer server.Close()
	if _, err := fetchUpdate(context.Background(), server.Client(), server.URL+"/chamuka-inc/waypoint/releases/latest", "0.3.1"); err == nil {
		t.Fatal("unrelated release page must be rejected")
	}
}
