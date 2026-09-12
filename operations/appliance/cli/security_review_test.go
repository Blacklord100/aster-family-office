// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"strings"
	"testing"
)

func TestSecurityReviewComposeCannotInheritCandidateOverrides(t *testing.T) {
	// Compose's inherited environment wins over --env-file. These values must
	// never reach the child, even when the operator has an older shell profile.
	for _, key := range []string{"PROCESSOR_IMAGE", "POSTGRES_IMAGE", "OLLAMA_IMAGE", "CADDY_IMAGE", "OLLAMA_MODEL", "BETTER_AUTH_URL", "ASTER_DATA_ROOT", "COMPOSE_FILE", "COMPOSE_PROFILES", "DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_CONFIG", "LD_PRELOAD", "BASH_ENV", "PYTHONPATH", "NODE_OPTIONS", "PATH"} {
		t.Setenv(key, "synthetic-untrusted-override")
	}
	env := commandEnvironment()
	values := map[string]string{}
	for _, item := range env {
		key, value, ok := strings.Cut(item, "=")
		if !ok || value == "synthetic-untrusted-override" {
			t.Fatalf("unsafe child environment key %q", key)
		}
		values[key] = value
	}
	for _, key := range []string{"PROCESSOR_IMAGE", "POSTGRES_IMAGE", "OLLAMA_IMAGE", "CADDY_IMAGE", "OLLAMA_MODEL", "BETTER_AUTH_URL", "ASTER_DATA_ROOT", "COMPOSE_FILE", "COMPOSE_PROFILES", "DOCKER_CONTEXT", "LD_PRELOAD", "BASH_ENV", "PYTHONPATH", "NODE_OPTIONS"} {
		if _, exists := values[key]; exists {
			t.Fatalf("inherited setting %s could override verified configuration", key)
		}
	}
	if values["DOCKER_HOST"] != "unix:///var/run/docker.sock" || values["COMPOSE_DISABLE_ENV_FILE"] != "1" || values["PATH"] != "/usr/sbin:/usr/bin:/sbin:/bin" {
		t.Fatal("local daemon or fixed command environment was lost")
	}
}

func TestSecurityReviewArbitraryCommandIsRefusedBeforeExecution(t *testing.T) {
	for _, command := range []string{"sh", "/bin/sh", "../bin/docker", "curl", "docker --context remote"} {
		if _, err := (systemCommands{}).Run(context.Background(), nil, nil, command, "synthetic-noop"); err == nil || !strings.Contains(err.Error(), "unsupported appliance command") {
			t.Fatalf("unexpected command accepted: %q", command)
		}
	}
}
