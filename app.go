package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/chamuka-inc/waypoint/internal/waypoint"
	"github.com/gen2brain/beeep"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx     context.Context
	service *waypoint.Service
	stop    chan struct{}
	once    sync.Once
}

func NewApp() (*App, error) {
	config, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	service := waypoint.NewService(filepath.Join(config, "Waypoint"))
	if err := service.Init(); err != nil {
		return nil, err
	}
	return &App{service: service, stop: make(chan struct{})}, nil
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	go a.scheduleLoop()
}

func (a *App) shutdown(context.Context) {
	a.once.Do(func() { close(a.stop) })
	a.service.Shutdown()
}

func (a *App) Call(method string, args []any) (any, error) {
	return a.service.Dispatch(method, args)
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
	before := map[string]bool{}
	for _, role := range a.service.State().Roles {
		before[role.ID] = true
	}
	started, err := a.service.StartScheduledResearch(time.Now())
	if err != nil || !started {
		return
	}
	for {
		select {
		case <-time.After(2 * time.Second):
			state := a.service.State()
			if len(state.Runs) == 0 || state.Runs[0].Status == "running" {
				continue
			}
			if state.Runs[0].Status == "completed" {
				count := 0
				for _, role := range state.Roles {
					if !before[role.ID] {
						count++
					}
				}
				if count > 0 {
					message := fmt.Sprintf("%d new opportunities match your profile.", count)
					if count == 1 {
						message = "1 new opportunity matches your profile."
					}
					_ = beeep.Notify("New Waypoint matches", message, "")
				}
			}
			return
		case <-a.stop:
			return
		}
	}
}
