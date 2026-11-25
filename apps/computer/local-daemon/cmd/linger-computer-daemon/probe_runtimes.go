package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"maps"
	"path/filepath"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

const runtimeProbeSchema = "linger.daemon.runtime-probe/v1"

type runtimeProbeReport struct {
	Schema   string              `json:"schema"`
	Runtimes []runtimeProbeEntry `json:"runtimes"`
}

type runtimeProbeEntry struct {
	Type            string                    `json:"type"`
	Status          string                    `json:"status"`
	Installed       bool                      `json:"installed"`
	Authenticated   bool                      `json:"authenticated"`
	Version         string                    `json:"version,omitempty"`
	RequiredVersion string                    `json:"required_version,omitempty"`
	Executable      string                    `json:"executable,omitempty"`
	Error           *provider.DiagnosticError `json:"error,omitempty"`
}

type repeatedStringFlag []string

func (f *repeatedStringFlag) String() string { return strings.Join(*f, ",") }

func (f *repeatedStringFlag) Set(value string) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return errors.New("runtime must not be empty")
	}
	*f = append(*f, trimmed)
	return nil
}

// runProbeRuntimes runs a stateless, single-shot Runtime discovery and
// authentication check using the exact same provider.Discover pipeline as the
// resident daemon, so desktop setup and the installer never drift from runtime
// behavior.
func runProbeRuntimes(ctx context.Context, args []string, environment map[string]string, output io.Writer) error {
	flags := flag.NewFlagSet("probe-runtimes", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var asJSON bool
	var runtimes repeatedStringFlag
	var codexPath, claudePath, piPath, antigravityPath string
	var timeoutMs int
	flags.BoolVar(&asJSON, "json", true, "emit JSON output")
	flags.Var(&runtimes, "runtime", "runtime type to probe (repeatable)")
	flags.StringVar(&codexPath, "codex-path", "", "explicit codex executable path")
	flags.StringVar(&claudePath, "claude-path", "", "explicit claude executable path")
	flags.StringVar(&piPath, "pi-path", "", "explicit pi executable path")
	flags.StringVar(&antigravityPath, "antigravity-path", "", "explicit antigravity executable path")
	flags.IntVar(&timeoutMs, "timeout-ms", 0, "per-stage probe timeout in milliseconds")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("invalid probe-runtimes arguments: %w", err)
	}
	if flags.NArg() != 0 {
		return errors.New("probe-runtimes does not accept positional arguments")
	}
	if !asJSON {
		return errors.New("probe-runtimes only supports --json output")
	}
	if timeoutMs < 0 {
		return errors.New("timeout-ms must not be negative")
	}
	selected := []string(runtimes)
	if len(selected) == 0 {
		selected = []string{"codex", "claude", "pi"}
	}
	if err := provider.ValidateRuntimeSelection(selected); err != nil {
		return fmt.Errorf("probe-runtimes: %w", err)
	}

	env := maps.Clone(environment)
	if env == nil {
		env = map[string]string{}
	}
	configuredPaths := map[string]string{}
	for kind, envKey := range map[string]string{
		"codex":  "LINGER_CODEX_PATH",
		"claude": "LINGER_CLAUDE_PATH",
		"pi":     "LINGER_PI_PATH",
	} {
		if value := strings.TrimSpace(env[envKey]); value != "" && filepath.IsAbs(value) {
			configuredPaths[kind] = value
		}
	}
	for kind, explicit := range map[string]string{
		"codex":       strings.TrimSpace(codexPath),
		"claude":      strings.TrimSpace(claudePath),
		"pi":          strings.TrimSpace(piPath),
		"antigravity": strings.TrimSpace(antigravityPath),
	} {
		if explicit == "" {
			continue
		}
		if !filepath.IsAbs(explicit) {
			return fmt.Errorf("probe-runtimes: --%s-path must be absolute", kind)
		}
		configuredPaths[kind] = explicit
	}

	options := provider.DiscoveryOptions{
		ConfiguredPaths:  configuredPaths,
		Environment:      env,
		Runtimes:         selected,
		SkipModelCatalog: true,
	}
	if timeoutMs > 0 {
		options.Timeout = time.Duration(timeoutMs) * time.Millisecond
	}

	discovered, err := provider.Discover(ctx, options)
	if err != nil {
		return err
	}

	report := runtimeProbeReport{
		Schema:   runtimeProbeSchema,
		Runtimes: make([]runtimeProbeEntry, 0, len(discovered.Diagnostics)),
	}
	for _, diagnostic := range discovered.Diagnostics {
		executable := diagnostic.EntryPath
		if executable == "" {
			executable = diagnostic.ExecutablePath
		}
		entry := runtimeProbeEntry{
			Type:            diagnostic.Type,
			Status:          diagnostic.Status,
			Installed:       diagnostic.Status != "not_installed",
			Authenticated:   diagnostic.Status == "ready",
			Version:         sanitizeProbeVersion(diagnostic.Version),
			RequiredVersion: native.MinimumVersions[diagnostic.Type],
			Executable:      executable,
			Error:           diagnostic.Error,
		}
		report.Runtimes = append(report.Runtimes, entry)
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		return err
	}
	_, err = output.Write(append(encoded, '\n'))
	return err
}

func sanitizeProbeVersion(raw string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(raw), "\n")
	line, _, _ = strings.Cut(line, "\r")
	redacted := strings.TrimSpace(redact.Text(strings.TrimSpace(line)))
	runes := []rune(redacted)
	if len(runes) > 120 {
		return string(runes[:120])
	}
	return redacted
}
