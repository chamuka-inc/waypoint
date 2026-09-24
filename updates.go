package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

//go:embed package.json
var packageJSON []byte

const latestReleasePage = "https://github.com/chamuka-inc/waypoint/releases/latest"
const releasePageBase = "https://github.com/chamuka-inc/waypoint/releases/tag/"
const releaseTagPath = "/chamuka-inc/waypoint/releases/tag/"

var releaseVersionPattern = regexp.MustCompile(`^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$`)

type UpdateInfo struct {
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	ReleaseURL     string `json:"releaseUrl"`
	Available      bool   `json:"available"`
}

func currentVersion() (string, error) {
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(packageJSON, &pkg); err != nil {
		return "", err
	}
	if !releaseVersionPattern.MatchString(pkg.Version) {
		return "", errors.New("application version is invalid")
	}
	return pkg.Version, nil
}

func compareVersions(left, right string) (int, error) {
	a, b := releaseVersionPattern.FindStringSubmatch(left), releaseVersionPattern.FindStringSubmatch(right)
	if a == nil || b == nil {
		return 0, errors.New("invalid release version")
	}
	for i := 1; i <= 3; i++ {
		if len(a[i]) > len(b[i]) {
			return 1, nil
		}
		if len(a[i]) < len(b[i]) {
			return -1, nil
		}
		if a[i] > b[i] {
			return 1, nil
		}
		if a[i] < b[i] {
			return -1, nil
		}
	}
	if a[4] == b[4] {
		return 0, nil
	}
	if a[4] == "" {
		return 1, nil
	}
	if b[4] == "" {
		return -1, nil
	}
	// Published stable releases are used by the latest-release endpoint. A
	// prerelease build of the same version should still see the stable release.
	return strings.Compare(a[4], b[4]), nil
}

func fetchUpdate(ctx context.Context, client *http.Client, endpoint, current string) (UpdateInfo, error) {
	info := UpdateInfo{CurrentVersion: current}
	source, err := url.Parse(endpoint)
	if err != nil {
		return info, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, endpoint, nil)
	if err != nil {
		return info, err
	}
	req.Header.Set("User-Agent", "Waypoint/"+current)
	response, err := client.Do(req)
	if err != nil {
		return info, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return info, fmt.Errorf("release check returned HTTP %d", response.StatusCode)
	}
	final := response.Request.URL
	if final.Scheme != source.Scheme || final.Host != source.Host || !strings.HasPrefix(final.Path, releaseTagPath) || final.RawQuery != "" || final.Fragment != "" {
		return info, errors.New("latest release did not resolve to a Waypoint release page")
	}
	tag := strings.TrimPrefix(final.Path, releaseTagPath)
	comparison, err := compareVersions(tag, current)
	if err != nil {
		return info, err
	}
	info.LatestVersion = strings.TrimPrefix(tag, "v")
	info.Available = comparison > 0
	if info.Available {
		info.ReleaseURL = releasePageBase + tag
	}
	return info, nil
}

func (a *App) CheckForUpdates() (UpdateInfo, error) {
	current, err := currentVersion()
	if err != nil {
		return UpdateInfo{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 8 * time.Second}
	return fetchUpdate(ctx, client, latestReleasePage, current)
}
