package computerconfig

import (
	"fmt"
	"path/filepath"
	"testing"
)

func TestLocalModelsConfigIsOptional(t *testing.T) {
	config, err := loadConfigFields(t, "")
	if err != nil {
		t.Fatal(err)
	}
	if config.LocalModels != nil {
		t.Fatalf("config without local_models has LocalModels = %+v", config.LocalModels)
	}
}

func TestLocalModelsConfigReadsToolLocation(t *testing.T) {
	root := t.TempDir()
	want := LocalModels{
		Python: filepath.Join(root, "kit", "python", "bin", "python3"), ModuleDirectory: filepath.Join(root, "kit"),
		StateDirectory: filepath.Join(root, "state"), BaseDirectory: filepath.Join(root, "models"),
	}
	config, err := loadConfigFields(t, fmt.Sprintf(`,"local_models":{"python":%q,"module_directory":%q,"state_directory":%q,"base_directory":%q}`, want.Python, want.ModuleDirectory, want.StateDirectory, want.BaseDirectory))
	if err != nil {
		t.Fatal(err)
	}
	if config.LocalModels == nil || *config.LocalModels != want {
		t.Fatalf("LocalModels = %+v", config.LocalModels)
	}
}

func TestLocalModelsConfigReadsIdleUnloadSeconds(t *testing.T) {
	root := t.TempDir()
	base := fmt.Sprintf(`"python":%q,"module_directory":%q,"state_directory":%q,"base_directory":%q`,
		filepath.Join(root, "kit", "python", "bin", "python3"), filepath.Join(root, "kit"),
		filepath.Join(root, "state"), filepath.Join(root, "models"))
	for _, want := range []int{0, 900, 1800} {
		config, err := loadConfigFields(t, fmt.Sprintf(`,"local_models":{%s,"idle_unload_seconds":%d}`, base, want))
		if err != nil {
			t.Fatalf("idle_unload_seconds=%d: %v", want, err)
		}
		if config.LocalModels == nil || config.LocalModels.IdleUnloadSeconds == nil || *config.LocalModels.IdleUnloadSeconds != want {
			t.Fatalf("IdleUnloadSeconds = %+v, want %d", config.LocalModels, want)
		}
	}
	if _, err := loadConfigFields(t, fmt.Sprintf(`,"local_models":{%s,"idle_unload_seconds":-1}`, base)); err == nil {
		t.Fatal("negative idle_unload_seconds was accepted")
	}
}

func TestLocalModelsConfigRejectsRelativeOrMissingPaths(t *testing.T) {
	for _, field := range []string{
		`,"local_models":{"python":"python3","module_directory":"/kit","state_directory":"/s","base_directory":"/b"}`,
		`,"local_models":{"python":"/kit/python3","module_directory":"/kit","state_directory":"/s"}`,
		`,"local_models":{"python":"/kit/python3","module_directory":"/kit","state_directory":"/s","base_directory":"/b","extra":"/x"}`,
	} {
		if _, err := loadConfigFields(t, field); err == nil {
			t.Fatalf("invalid local_models accepted: %s", field)
		}
	}
}
