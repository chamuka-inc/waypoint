package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/chamuka-inc/waypoint/internal/waypoint"
	"github.com/gen2brain/beeep"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx     context.Context
	manager *waypoint.WorkspaceManager
	stop    chan struct{}
	once    sync.Once
}

func NewApp() (*App, error) {
	directory := strings.TrimSpace(os.Getenv("WAYPOINT_DATA_DIR"))
	if directory == "" {
		config, err := os.UserConfigDir()
		if err != nil {
			return nil, err
		}
		directory = filepath.Join(config, "Waypoint")
	} else if !filepath.IsAbs(directory) {
		return nil, errors.New("WAYPOINT_DATA_DIR must be an absolute path")
	}
	manager := waypoint.NewWorkspaceManager(directory)
	if err := manager.Init(); err != nil {
		return nil, err
	}
	return &App{manager: manager, stop: make(chan struct{})}, nil
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	go a.scheduleLoop()
}

func (a *App) shutdown(context.Context) {
	a.once.Do(func() { close(a.stop) })
	a.manager.Close()
}

func (a *App) Call(method string, args []any) (any, error) {
	return a.manager.Dispatch(method, args)
}

func (a *App) OpenExternal(address string) error {
	safe := waypoint.SafeURL(address)
	if safe == "" {
		return errors.New("only public HTTPS links can be opened")
	}
	runtime.BrowserOpenURL(a.ctx, safe)
	return nil
}

func (a *App) Ready(title string) {
	fmt.Println("WAYPOINT_WAILS_READY", title)
}

func (a *App) scheduleLoop() {
	timer := time.NewTimer(1500 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-timer.C:
		a.checkSchedule()
	case <-a.stop:
		return
	}
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			a.checkSchedule()
		case <-a.stop:
			return
		}
	}
}

func (a *App) checkSchedule() {
	for {
		run, started, err := a.manager.StartNextScheduledResearch(time.Now())
		if err != nil || !started {
			return
		}
		finished := false
		for !finished {
			select {
			case <-time.After(2 * time.Second):
				state := run.Service.State()
				if len(state.Runs) == 0 || state.Runs[0].Status == "running" {
					continue
				}
				if state.Runs[0].Status == "completed" {
					count := 0
					for _, role := range state.Roles {
						if !run.Before[role.ID] {
							count++
						}
					}
					if count > 0 {
						message := fmt.Sprintf("%d new opportunities in %s.", count, run.WorkspaceName)
						if count == 1 {
							message = fmt.Sprintf("1 new opportunity in %s.", run.WorkspaceName)
						}
						_ = beeep.Notify("New Waypoint matches", message, "")
					}
				}
				finished = true
			case <-a.stop:
				a.manager.FinishScheduledResearch(run.Service)
				return
			}
		}
		a.manager.FinishScheduledResearch(run.Service)
	}
}
