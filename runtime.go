package main

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func runtimeShow(ctx context.Context) {
	runtime.WindowUnminimise(ctx)
	runtime.WindowShow(ctx)
}
