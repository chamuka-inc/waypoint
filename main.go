package main

import (
	"embed"
	"fmt"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:dist
var assets embed.FS

func main() {
	app, err := NewApp()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Waypoint startup failed:", err)
		os.Exit(1)
	}
	err = wails.Run(&options.App{
		Title:            "Waypoint",
		Width:            1460,
		Height:           980,
		MinWidth:         1024,
		MinHeight:        700,
		// Match the startup view so the native window never flashes white while
		// its webview and frontend bundle are being initialised.
		BackgroundColour: options.NewRGB(36, 77, 65),
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind:             []any{app},
		Mac:              &mac.Options{DisableEscapeExitsFullscreen: true},
		SingleInstanceLock: &options.SingleInstanceLock{UniqueId: "app.waypoint.career", OnSecondInstanceLaunch: func(options.SecondInstanceData) {
			if app.ctx != nil {
				runtimeShow(app.ctx)
			}
		}},
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "Waypoint failed:", err)
		os.Exit(1)
	}
}
