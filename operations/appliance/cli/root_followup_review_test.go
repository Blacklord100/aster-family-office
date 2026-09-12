// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"filippo.io/age"
)

func TestRootFollowupJSONRejectsDuplicateKeysAtEveryDepth(t *testing.T) {
	for _, tc := range []struct{ name, input string }{
		{"root", `{"releaseId":"first","releaseId":"second"}`},
		{"nested", `{"schema":{"min":16,"min":17}}`},
		{"array object", `{"files":[{"path":"a","path":"b"}]}`},
		{"escaped spelling", `{"releaseId":"first","release\u0049d":"second"}`},
		{"case folded struct alias", `{"releaseId":"first","ReleaseId":"second"}`},
		{"Unicode folded struct alias", `{"sequence":1,"ſequence":2}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var m Manifest
			if err := decodeJSON([]byte(tc.input), &m); err == nil {
				t.Fatalf("ambiguous manifest accepted: releaseId=%q", m.ReleaseID)
			}
		})
	}
	var m Manifest
	if err := decodeJSON([]byte(`{"releaseId":"unambiguous","schema":{"min":16,"max":16,"target":16}}`), &m); err != nil {
		t.Fatalf("ordinary structured JSON rejected: %v", err)
	}
}

func TestRootFollowupReleaseIDMatchesBackendLengthBoundary(t *testing.T) {
	_, m := fixture(t)
	m.ReleaseID = strings.Repeat("a", 80)
	if err := m.Validate(); err != nil {
		t.Fatalf("backend-valid 80-character identifier rejected: %v", err)
	}
	m.ReleaseID += "a"
	if err := m.Validate(); err == nil {
		t.Fatal("81-character identifier would fail only after database migration")
	}
}

func orphanStageFixture(t *testing.T) (Controller, string, string, string, string) {
	t.Helper()
	incoming, m := fixture(t)
	_, trustRoot, trustSHA := trustFixture(t, incoming, 1)
	c := Controller{Root: t.TempDir(), Commands: &protocolReviewCommander{}}
	existing := filepath.Join(c.Root, "releases", m.ReleaseID)
	if err := os.MkdirAll(filepath.Dir(existing), 0700); err != nil {
		t.Fatal(err)
	}
	if err := copyVerified(incoming, existing, m); err != nil {
		t.Fatal(err)
	}
	manifest, err := os.ReadFile(filepath.Join(incoming, "release.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = atomicWrite(filepath.Join(existing, "release.json"), manifest, 0644); err != nil {
		t.Fatal(err)
	}
	if err = cloneCache(filepath.Join(incoming, "metadata"), filepath.Join(existing, "metadata")); err != nil {
		t.Fatal(err)
	}
	return c, incoming, existing, trustRoot, trustSHA
}

func TestRootFollowupOrphanStageReuseReverifiesWithoutOverwriting(t *testing.T) {
	c, incoming, existing, trustRoot, trustSHA := orphanStageFixture(t)
	original, err := os.Stat(filepath.Join(existing, "payload/images/app.tar"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := c.stage(incoming, trustRoot, trustSHA)
	if err != nil {
		t.Fatalf("verified orphan cannot be resumed: %v", err)
	}
	after, err := os.Stat(filepath.Join(existing, "payload/images/app.tar"))
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(original, after) || original.ModTime() != after.ModTime() {
		t.Fatal("orphan reuse replaced immutable payload")
	}
	if m.ReleaseID != "1.0.0" || len(m.raw) == 0 || fingerprint(m.trustedRoot) != trustSHA {
		t.Fatal("orphan reuse lost trusted manifest identity")
	}
	if _, err = os.Stat(filepath.Join(c.Root, "trust/metadata/timestamp.json")); err != nil {
		t.Fatalf("reused release did not persist TUF rollback state: %v", err)
	}
	if len(c.Commands.(*protocolReviewCommander).calls) != 0 {
		t.Fatal("staging must not invoke runtime commands")
	}
}

func TestRootFollowupOrphanStageRejectsChangedManifestPayloadAndLinks(t *testing.T) {
	for _, tc := range []struct {
		name  string
		alter func(string) error
	}{
		{"payload", func(dir string) error {
			return os.WriteFile(filepath.Join(dir, "payload/images/app.tar"), []byte("changed app image"), 0644)
		}},
		{"manifest", func(dir string) error { return os.WriteFile(filepath.Join(dir, "release.json"), []byte("{}"), 0644) }},
		{"payload symlink", func(dir string) error {
			p := filepath.Join(dir, "payload/images/app.tar")
			if err := os.Remove(p); err != nil {
				return err
			}
			return os.Symlink("processor.tar", p)
		}},
		{"unlisted payload", func(dir string) error {
			return os.WriteFile(filepath.Join(dir, "payload/extra.sh"), []byte("unexpected"), 0644)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, incoming, existing, trustRoot, trustSHA := orphanStageFixture(t)
			if err := tc.alter(existing); err != nil {
				t.Fatal(err)
			}
			if _, err := c.stage(incoming, trustRoot, trustSHA); err == nil {
				t.Fatal("unsafe existing release was reused")
			}
			if len(c.Commands.(*protocolReviewCommander).calls) != 0 {
				t.Fatal("unsafe staging invoked runtime")
			}
		})
	}
	t.Run("release directory symlink", func(t *testing.T) {
		c, incoming, existing, trustRoot, trustSHA := orphanStageFixture(t)
		moved := filepath.Join(t.TempDir(), "outside-release")
		if err := os.Rename(existing, moved); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(moved, existing); err != nil {
			t.Fatal(err)
		}
		if _, err := c.stage(incoming, trustRoot, trustSHA); err == nil {
			t.Fatal("symlinked immutable release reused")
		}
	})
}

func TestRootFollowupValidReencryptedBackupCannotReplacePinnedCiphertext(t *testing.T) {
	input, key := encryptedFixture(t, nil)
	originalSHA := fixtureSHA(t, input)
	ids, err := readIdentities(key)
	if err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := age.Decrypt(bytes.NewReader(original), ids...)
	if err != nil {
		t.Fatal(err)
	}
	contents, err := io.ReadAll(plain)
	if err != nil {
		t.Fatal(err)
	}
	var replacement bytes.Buffer
	writer, err := age.Encrypt(&replacement, ids[0].(*age.X25519Identity).Recipient())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = writer.Write(contents); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	if fingerprint(replacement.Bytes()) == originalSHA {
		t.Fatal("fixture did not produce distinct authenticated ciphertext")
	}
	if err = os.WriteFile(input, replacement.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	if err = verifyArtifact(input, originalSHA, 0); err == nil {
		t.Fatal("preflight accepted replacement artifact")
	}
	// Passing the current digest proves the replacement is a valid age archive;
	// the original independently pinned digest must still fail after consumption.
	if _, err = unpackBackup(input, key, filepath.Join(t.TempDir(), "valid-reencrypted"), 1<<20, fixtureSHA(t, input)); err != nil {
		t.Fatalf("replacement fixture is not a valid authenticated backup: %v", err)
	}
	if _, err = unpackBackup(input, key, filepath.Join(t.TempDir(), "wrong-ciphertext"), 1<<20, originalSHA); err == nil || !strings.Contains(err.Error(), "ciphertext consumed") {
		t.Fatalf("authenticated replacement bypassed exact consumed-ciphertext pin: %v", err)
	}
}

func TestRootFollowupDatabaseCompatibilityRequiresPinnedMatchingMajor(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		wantError  bool
	}{
		{"supported same major", `["PG_MAJOR=17"]`, false},
		{"missing declaration", `["LANG=C"]`, true},
		{"unsupported old major", `["PG_MAJOR=16"]`, true},
		{"invalid declaration", `["PG_MAJOR=seventeen"]`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, a := fixture(t)
			_, b := fixture(t)
			fake := &protocolReviewCommander{body: []byte(tc.body)}
			c := Controller{Commands: fake}
			err := c.checkDatabaseCompatibility(context.Background(), a, b)
			if (err != nil) != tc.wantError {
				t.Fatalf("unexpected PostgreSQL compatibility result: %v", err)
			}
			for _, call := range fake.calls {
				if !strings.Contains(strings.Join(call, " "), "image inspect --format {{json .Config.Env}} sha256:") {
					t.Fatal("database compatibility did not inspect pinned image identity")
				}
			}
		})
	}
}

type followupPGCommander struct {
	answers []string
	calls   [][]string
}

func (f *followupPGCommander) Run(_ context.Context, _ io.Reader, _ io.Writer, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
	if len(f.answers) == 0 {
		return nil, fmt.Errorf("unexpected command")
	}
	answer := f.answers[0]
	f.answers = f.answers[1:]
	return []byte(answer), nil
}
func TestRootFollowupDatabaseMajorChangeIsRejectedBeforeStartup(t *testing.T) {
	_, old := fixture(t)
	_, next := fixture(t)
	fake := &followupPGCommander{answers: []string{`["PG_MAJOR=17"]`, `["PG_MAJOR=18"]`}}
	c := Controller{Commands: fake}
	if err := c.checkDatabaseCompatibility(context.Background(), old, next); err == nil || !strings.Contains(err.Error(), "major upgrades") {
		t.Fatalf("unqualified database-major change accepted: %v", err)
	}
	if len(fake.calls) != 2 {
		t.Fatal("both image majors must be inspected")
	}
	for _, call := range fake.calls {
		if len(call) < 3 || call[1] != "image" || call[2] != "inspect" {
			t.Fatal("database-major refusal invoked runtime startup")
		}
	}
}
