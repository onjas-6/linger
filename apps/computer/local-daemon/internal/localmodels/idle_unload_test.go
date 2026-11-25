package localmodels

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func newTestClock(start time.Time) *testClock {
	return &testClock{now: start}
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func newIdleTestLibrary(t *testing.T, fake *fakeTool, record *recorder, clock *testClock, ttl time.Duration, interval time.Duration) *Library {
	t.Helper()
	library := New(Options{
		Tool:              &fake.tool,
		Environment:       map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "PATH": os.Getenv("PATH")},
		JobDirectory:      filepath.Join(t.TempDir(), "jobs"),
		Publish:           record.publish,
		RuntimeChanged:    record.runtimeChanged,
		ProgressInterval:  20 * time.Millisecond,
		IdleUnloadTTL:     &ttl,
		IdleSweepInterval: interval,
		Now:               clock.Now,
	})
	library.healthCheck = func(context.Context, string) bool { return true }
	t.Cleanup(library.Close)
	return library
}

func TestIdleSweeperUnloadsIdleModelAfterTTL(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	idleAfter, _ := json.Marshal(status(model(testModel, "idle")))
	fake.script("unload", fakeScript{
		Lines:       []fakeLine{{Line: resultLine(testModel)}},
		StatusAfter: idleAfter,
	})
	record := &recorder{}
	clock := newTestClock(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	library := newIdleTestLibrary(t, fake, record, clock, 15*time.Minute, 10*time.Millisecond)

	// Startup refresh initializes lastUsedAt so reconnects never immediately unload.
	snap := library.Refresh(context.Background())
	if row := modelState(snap, testModel); row == nil || row.State != "loaded" {
		t.Fatalf("initial state = %+v", row)
	}

	// Just before TTL: synchronous sweep must keep the model loaded.
	clock.Advance(14*time.Minute + 59*time.Second)
	library.sweepIdleModels()
	if calls := callsWithPrefix(fake, "unload "); len(calls) != 0 {
		t.Fatalf("unloaded before TTL: %v", calls)
	}

	// Past TTL: sweeper ticker unloads via library unload (keeping Bifrost alive) and notifies runtimeChanged.
	clock.Advance(2 * time.Second)
	waitFor(t, "idle unload", func() bool {
		return len(callsWithPrefix(fake, "unload ")) == 1 &&
			record.changes() > 0 &&
			modelState(record.last(), testModel) != nil &&
			modelState(record.last(), testModel).State == "idle"
	})
	if calls := callsWithPrefix(fake, "stack "); len(calls) != 0 {
		t.Fatalf("idle unload must keep Bifrost warm, but ran stack commands: %v", calls)
	}
}

func TestIdleSweeperRespectsActiveLeaseAndUpdatesLastUsedOnRelease(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	idleAfter, _ := json.Marshal(status(model(testModel, "idle")))
	fake.script("unload", fakeScript{
		Lines:       []fakeLine{{Line: resultLine(testModel)}},
		StatusAfter: idleAfter,
	})
	record := &recorder{}
	clock := newTestClock(time.Now())
	library := newIdleTestLibrary(t, fake, record, clock, 15*time.Minute, time.Hour)
	library.Refresh(context.Background())
	if err := library.awaitSettled(context.Background()); err != nil {
		t.Fatal(err)
	}

	release := library.AcquireUse(testPiModel)
	clock.Advance(30 * time.Minute)
	library.sweepIdleModels()
	if calls := callsWithPrefix(fake, "unload "); len(calls) != 0 {
		t.Fatalf("unloaded while active lease held: %v", calls)
	}

	// Releasing resets lastUsedAt to current time, granting a full fresh TTL window.
	release()
	// Calling release a second time is a safe no-op.
	release()
	clock.Advance(14 * time.Minute)
	library.sweepIdleModels()
	if calls := callsWithPrefix(fake, "unload "); len(calls) != 0 {
		t.Fatalf("unloaded before fresh TTL elapsed after lease release: %v", calls)
	}

	clock.Advance(2 * time.Minute)
	library.sweepIdleModels()
	if calls := callsWithPrefix(fake, "unload "); len(calls) != 1 {
		t.Fatalf("expected 1 unload after lease release + TTL, got %v", calls)
	}
}

func TestIdleSweeperDisabledWhenTTLIsZero(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	record := &recorder{}
	clock := newTestClock(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	library := newIdleTestLibrary(t, fake, record, clock, 0, time.Hour)
	library.Refresh(context.Background())

	clock.Advance(2 * time.Hour)
	library.sweepIdleModels()
	if calls := callsWithPrefix(fake, "unload "); len(calls) != 0 {
		t.Fatalf("disabled sweeper unloaded model: %v", calls)
	}
}

func TestIdleUnloadRaceEnsureLoadedWaitsAndReloads(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	idleAfter, _ := json.Marshal(status(model(testModel, "idle")))
	loadedAfter, _ := json.Marshal(status(model(testModel, "loaded")))
	unloadGate := filepath.Join(fake.state, "release-unload")
	fake.script("unload", fakeScript{
		Lines:       []fakeLine{{WaitFile: unloadGate, Line: resultLine(testModel)}},
		StatusAfter: idleAfter,
	})
	fake.script("load", fakeScript{
		Lines:       []fakeLine{{Line: resultLine(testModel)}},
		StatusAfter: loadedAfter,
	})
	record := &recorder{}
	clock := newTestClock(time.Now())
	library := newIdleTestLibrary(t, fake, record, clock, 15*time.Minute, time.Hour)
	library.Refresh(context.Background())
	if err := library.awaitSettled(context.Background()); err != nil {
		t.Fatal(err)
	}

	// Start an idle unload that blocks on unloadGate while l.current still shows "loaded".
	clock.Advance(20 * time.Minute)
	sweepDone := make(chan struct{})
	go func() {
		library.sweepIdleModels()
		close(sweepDone)
	}()
	waitFor(t, "unload in flight", func() bool {
		return len(callsWithPrefix(fake, "unload ")) == 1
	})

	// Mid-unload: IsLoadedHealthy must be false and IsStandbyModel must be true.
	if library.IsLoadedHealthy(context.Background(), testPiModel) {
		t.Fatal("IsLoadedHealthy returned true while idle unload was in flight")
	}
	if !library.IsStandbyModel(testPiModel) {
		t.Fatal("IsStandbyModel returned false while idle unload was in flight")
	}

	// EnsureLoaded must NOT take the cached-loaded fast path; it must wait for the unload and reload.
	ensureDone := make(chan error, 1)
	go func() {
		ensureDone <- library.EnsureLoaded(context.Background(), testPiModel)
	}()
	select {
	case err := <-ensureDone:
		t.Fatalf("EnsureLoaded returned early while unload was still running: %v", err)
	case <-time.After(80 * time.Millisecond):
	}

	if err := os.WriteFile(unloadGate, []byte("go"), 0o600); err != nil {
		t.Fatal(err)
	}
	<-sweepDone
	if err := <-ensureDone; err != nil {
		t.Fatalf("EnsureLoaded failed after unload finished: %v", err)
	}
	if calls := callsWithPrefix(fake, "load "); len(calls) != 1 {
		t.Fatalf("expected 1 reload after mid-unload EnsureLoaded, got %v", calls)
	}
}

func TestIdleSweeperSkipsWhenEnsureTurnIsHeld(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	record := &recorder{}
	clock := newTestClock(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	// Use a long interval and invoke sweepIdleModels directly to verify non-blocking behavior.
	library := newIdleTestLibrary(t, fake, record, clock, 15*time.Minute, time.Hour)
	library.Refresh(context.Background())

	// Simulate an incoming EnsureLoaded holding ensure.turn for testModel.
	library.mu.Lock()
	ensure := &ensureLoad{turn: make(chan struct{}, 1)}
	ensure.turn <- struct{}{}
	library.ensures[testModel] = ensure
	library.mu.Unlock()

	clock.Advance(20 * time.Minute)
	done := make(chan struct{})
	go func() {
		library.sweepIdleModels()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("sweepIdleModels blocked while ensure.turn was held")
	}
	if calls := callsWithPrefix(fake, "unload "); len(calls) != 0 {
		t.Fatalf("sweeper unloaded while ensure.turn was held: %v", calls)
	}
	<-ensure.turn
}

func TestStandbyAndLoadedHealthyChecksNeverWakeModel(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	record := &recorder{}
	clock := newTestClock(time.Now())
	library := newIdleTestLibrary(t, fake, record, clock, 15*time.Minute, time.Hour)
	library.Refresh(context.Background())
	if err := library.awaitSettled(context.Background()); err != nil {
		t.Fatal(err)
	}

	if !library.IsStandbyModel(testPiModel) {
		t.Fatal("idle model must be reported as standby")
	}
	if library.IsStandbyModel("openai/gpt-5") {
		t.Fatal("non-library model must not be reported as standby")
	}
	if library.IsLoadedHealthy(context.Background(), testPiModel) {
		t.Fatal("idle model must not be reported as loaded healthy")
	}
	if !library.IsLoadedHealthy(context.Background(), "openai/gpt-5") {
		t.Fatal("non-library model must not be blocked by IsLoadedHealthy")
	}
	if calls := callsWithPrefix(fake, "load "); len(calls) != 0 {
		t.Fatalf("standby/health checks started a load: %v", calls)
	}

	// Once loaded and healthy, IsStandbyModel is false and IsLoadedHealthy is true.
	fake.write("status.json", status(model(testModel, "loaded")))
	library.Refresh(context.Background())
	if library.IsStandbyModel(testPiModel) {
		t.Fatal("loaded model must not be reported as standby")
	}
	if !library.IsLoadedHealthy(context.Background(), testPiModel) {
		t.Fatal("loaded healthy model must return true")
	}
	// If loopback health probe fails, IsLoadedHealthy returns false without waking.
	library.healthCheck = func(context.Context, string) bool { return false }
	if library.IsLoadedHealthy(context.Background(), testPiModel) {
		t.Fatal("unhealthy loaded model must return false")
	}
}
