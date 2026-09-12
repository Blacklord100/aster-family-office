// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T) (string, *Manifest) {
	t.Helper()
	dir := t.TempDir()
	m := &Manifest{SchemaVersion: 1, ReleaseID: "1.0.0", ProductVersion: "1.0.0", Sequence: 1, Channel: "preview"}
	m.Platform.OS = "linux"
	m.Platform.Arch = "amd64"
	m.Schema.Min = 16
	m.Schema.Max = 16
	m.Schema.Target = 16
	add := func(p, contents string) {
		t.Helper()
		if e := os.MkdirAll(filepath.Dir(filepath.Join(dir, p)), 0755); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(filepath.Join(dir, p), []byte(contents), 0644); e != nil {
			t.Fatal(e)
		}
		m.Files = append(m.Files, FileEntry{Path: p, SHA256: fingerprint([]byte(contents)), Size: int64(len(contents)), Mode: 0644})
	}
	m.Compose.Offline = "payload/config/offline.yaml"
	m.Compose.Connected = "payload/config/connected.yaml"
	add(m.Compose.Offline, "services: {}\n")
	add(m.Compose.Connected, "services: {}\n")
	m.Model.Name = "gemma4:fixture"
	m.Model.Digest = fingerprint([]byte("model"))
	m.Model.Modelfile = "payload/models/Modelfile"
	m.Model.Files = []string{"payload/models/ollama/blobs/sha256-" + m.Model.Digest}
	add(m.Model.Modelfile, "FROM fixture\n")
	add(m.Model.Files[0], "model")
	m.Runtime.Kind = "ubuntu-deb"
	m.Runtime.OS = "ubuntu"
	m.Runtime.Version = "24.04"
	m.Runtime.Arch = "amd64"
	p := "payload/runtime/docker.deb"
	add(p, "fake package")
	m.Runtime.Packages = []RuntimePackage{{Name: "docker-ce", Version: "1:1.0", Architecture: "amd64", Path: p, SHA256: fingerprint([]byte("fake package"))}}
	for _, service := range []string{"app", "processor", "postgres", "ollama", "caddy"} {
		p := "payload/images/" + service + ".tar"
		add(p, service)
		m.Images = append(m.Images, ImageEntry{Service: service, Path: p, Reference: "aster/" + service + ":fixture", ImageID: "sha256:" + fingerprint([]byte(service))})
	}
	saveManifest(t, dir, m)
	return dir, m
}
func saveManifest(t *testing.T, dir string, m *Manifest) {
	t.Helper()
	if e := writeJSON(filepath.Join(dir, "release.json"), m); e != nil {
		t.Fatal(e)
	}
}
func trustFixture(t *testing.T, bundle string, version int64) (keys, root, hash string) {
	t.Helper()
	keys = filepath.Join(t.TempDir(), "keys")
	if e := initTrust(keys, time.Now()); e != nil {
		t.Fatal(e)
	}
	if e := signBundle(bundle, keys, version, time.Now().Add(24*time.Hour)); e != nil {
		t.Fatal(e)
	}
	root = filepath.Join(keys, "root.json")
	b, e := os.ReadFile(root)
	if e != nil {
		t.Fatal(e)
	}
	return keys, root, fingerprint(b)
}
func TestManifestAcceptsCompletePinnedInventory(t *testing.T) {
	dir, m := fixture(t)
	if e := m.Validate(); e != nil {
		t.Fatal(e)
	}
	if e := verifyPayload(dir, m); e != nil {
		t.Fatal(e)
	}
}
func TestManifestRejectsAmbiguity(t *testing.T) {
	tests := map[string]func(*Manifest){"absolute": func(m *Manifest) { m.Files[0].Path = "/etc/passwd" }, "traversal": func(m *Manifest) { m.Files[0].Path = "payload/../../escape" }, "backslash": func(m *Manifest) { m.Files[0].Path = "payload\\escape" }, "duplicate": func(m *Manifest) { m.Files = append(m.Files, m.Files[0]) }, "mutable image": func(m *Manifest) { m.Images[0].Reference = "aster/app:latest" }, "schema": func(m *Manifest) { m.Schema.Target = 17 }, "missing vision assets": func(m *Manifest) { m.Model.Files = nil }, "unsupported runtime": func(m *Manifest) { m.Runtime.OS = "debian" }, "package hash": func(m *Manifest) { m.Runtime.Packages[0].SHA256 = strings.Repeat("0", 64) }, "executable secret mode": func(m *Manifest) { m.Files[0].Mode = 04755 }}
	for name, change := range tests {
		t.Run(name, func(t *testing.T) {
			_, m := fixture(t)
			change(m)
			if e := m.Validate(); e == nil {
				t.Fatal("invalid manifest accepted")
			}
		})
	}
}
func TestPayloadRejectsTamperAndLinks(t *testing.T) {
	for _, kind := range []string{"modified", "missing", "unlisted", "symlink", "hardlink"} {
		t.Run(kind, func(t *testing.T) {
			dir, m := fixture(t)
			target := filepath.Join(dir, m.Files[0].Path)
			switch kind {
			case "modified":
				os.WriteFile(target, []byte("tampered"), 0644)
			case "missing":
				os.Remove(target)
			case "unlisted":
				os.WriteFile(filepath.Join(dir, "payload", "unexpected"), []byte("x"), 0644)
			case "symlink":
				os.Remove(target)
				os.Symlink(filepath.Join(dir, m.Files[1].Path), target)
			case "hardlink":
				os.Link(target, filepath.Join(t.TempDir(), "alias"))
			}
			if e := verifyPayload(dir, m); e == nil {
				t.Fatal("unsafe payload accepted")
			}
		})
	}
}
func TestSignedBundleAndWrongRoot(t *testing.T) {
	bundle, _ := fixture(t)
	_, root, hash := trustFixture(t, bundle, 1)
	if _, e := verifyBundle(bundle, root, hash, t.TempDir()); e != nil {
		t.Fatal(e)
	}
	if _, e := verifyBundle(bundle, root, strings.Repeat("0", 64), t.TempDir()); e == nil {
		t.Fatal("wrong trust fingerprint accepted")
	}
	_, otherRoot, otherHash := trustFixture(t, fixtureBundle(t), 1)
	if _, e := verifyBundle(bundle, otherRoot, otherHash, t.TempDir()); e == nil {
		t.Fatal("untrusted publisher accepted")
	}
}
func fixtureBundle(t *testing.T) string { b, _ := fixture(t); return b }
func TestSignedManifestTamper(t *testing.T) {
	bundle, m := fixture(t)
	_, root, hash := trustFixture(t, bundle, 1)
	m.Sequence = 99
	saveManifest(t, bundle, m)
	if _, e := verifyBundle(bundle, root, hash, t.TempDir()); e == nil {
		t.Fatal("tampered manifest accepted")
	}
}
func TestTUFRejectsRollbackWithPersistentCache(t *testing.T) {
	bundle, m := fixture(t)
	keys, root, hash := trustFixture(t, bundle, 2)
	cache := t.TempDir()
	if _, e := verifyBundle(bundle, root, hash, cache); e != nil {
		t.Fatal(e)
	}
	m.Sequence = 1
	saveManifest(t, bundle, m)
	if e := signBundle(bundle, keys, 1, time.Now().Add(24*time.Hour)); e != nil {
		t.Fatal(e)
	}
	if _, e := verifyBundle(bundle, root, hash, cache); e == nil {
		t.Fatal("metadata rollback accepted")
	}
}
func TestTUFRejectsExpiredMetadata(t *testing.T) {
	bundle, _ := fixture(t)
	keys, root, hash := trustFixture(t, bundle, 1)
	// Re-sign with an expired timestamp using the maintained metadata API helper.
	if e := expiredTimestamp(bundle, keys); e != nil {
		t.Fatal(e)
	}
	if _, e := verifyBundle(bundle, root, hash, t.TempDir()); e == nil {
		t.Fatal("expired timestamp accepted")
	}
}
func TestJSONRejectsUnknownOrTrailingData(t *testing.T) {
	for _, b := range []string{`{"unrecognized":true}`, `{"schemaVersion":1} {}`} {
		var m Manifest
		if e := decodeJSON([]byte(b), &m); e == nil {
			t.Fatal("ambiguous input accepted")
		}
	}
}
func TestCopiedPayloadDetectsSourceMutation(t *testing.T) {
	dir, m := fixture(t)
	os.WriteFile(filepath.Join(dir, m.Files[0].Path), []byte("changed"), 0644)
	if e := copyVerified(dir, filepath.Join(t.TempDir(), "release"), m); e == nil {
		t.Fatal("changed source staged")
	}
}
func TestInitialRootRequiresTwoSignatures(t *testing.T) {
	dir, _ := fixture(t)
	_, root, _ := trustFixture(t, dir, 1)
	b, e := os.ReadFile(root)
	if e != nil {
		t.Fatal(e)
	}
	var decoded map[string]any
	if e = json.Unmarshal(b, &decoded); e != nil {
		t.Fatal(e)
	}
	if len(decoded["signatures"].([]any)) != 2 {
		t.Fatal("root requires two distinct signatures")
	}
	roles := decoded["signed"].(map[string]any)["roles"].(map[string]any)
	if roles["root"].(map[string]any)["threshold"].(float64) != 2 {
		t.Fatal("root threshold is not two")
	}
}
