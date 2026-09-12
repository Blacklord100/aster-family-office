// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type protocolReviewCommander struct {
	body  []byte
	calls [][]string
}

func (f *protocolReviewCommander) Run(_ context.Context, _ io.Reader, _ io.Writer, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
	return f.body, nil
}
func protocolReviewFixture(t *testing.T, body string) (Controller, Installation, *protocolReviewCommander) {
	t.Helper()
	source, m := fixture(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "releases"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(source, filepath.Join(root, "releases", m.ReleaseID)); err != nil {
		t.Fatal(err)
	}
	commands := &protocolReviewCommander{body: []byte(body)}
	return Controller{Root: root, Commands: commands}, Installation{Format: 1, Root: root, ReleaseID: m.ReleaseID, Project: "aster-protocol", Profile: "offline", Generation: 2}, commands
}
func TestProtocolReviewAcceptsActualBackendStatusAndUsesPrivilegedNoDependencyService(t *testing.T) {
	body := `{"ok":true,"enabled":true,"mode":"maintenance","generation":2,"activeRelease":"1.0.0","schemaVersion":16,"activeOperations":0,"activeLeases":{"document":0,"mailbox":0,"folder":0,"archive":0,"reporting":0,"delivery":0,"total":0},"canSeal":true,"resumedAt":null,"updatedAt":"2026-09-12T00:00:00.000Z"}`
	c, s, fake := protocolReviewFixture(t, body)
	state, err := c.lifecycle(context.Background(), s, "status")
	if err != nil {
		t.Fatal(err)
	}
	if state.Mode != "maintenance" || state.Generation != 2 || state.SchemaVersion != 16 || !state.CanSeal {
		t.Fatalf("backend status fields lost: %+v", state)
	}
	command := strings.Join(fake.calls[0], " ")
	if !strings.Contains(command, "run --rm --no-deps -T migrate node dist-ops/lifecycle.js status") {
		t.Fatalf("wrong lifecycle execution boundary: %s", command)
	}
}
func TestProtocolReviewForwardsGenerationAndReplayIdentityWithoutShell(t *testing.T) {
	c, s, fake := protocolReviewFixture(t, `{"ok":true,"mode":"draining","generation":2,"activeRelease":"1.0.0","schemaVersion":16,"activeOperations":1,"activeLeases":{"total":1},"canSeal":false}`)
	request := "11111111-1111-4111-8111-111111111111"
	if _, err := c.lifecycle(context.Background(), s, "drain", "--expected-generation", "2", "--request-id", request); err != nil {
		t.Fatal(err)
	}
	call := fake.calls[0]
	tail := call[len(call)-5:]
	if strings.Join(tail, " ") != "drain --expected-generation 2 --request-id "+request {
		t.Fatalf("protocol flags changed: %v", tail)
	}
}
func TestProtocolReviewRejectsBackendRefusalAndMalformedOutput(t *testing.T) {
	for _, body := range []string{`{"ok":false,"error":"GENERATION_CONFLICT","message":"Changed"}`, `{"ok":true,"generation":0}`, `not-json`, `{} {}`} {
		c, s, _ := protocolReviewFixture(t, body)
		if _, err := c.lifecycle(context.Background(), s, "status"); err == nil {
			t.Fatalf("unsafe operational response accepted: %s", body)
		}
	}
}

// Resume must retain the candidate's trust binding if activate committed before
// installation.json was saved. An old manifest hash makes later recovery fail.
func TestProtocolReviewRecoveryRequiresCandidateManifestTrustBinding(t *testing.T) {
	bundle, m := fixture(t)
	_, root, hash := trustFixture(t, bundle, 1)
	bytes, err := os.ReadFile(root)
	if err != nil {
		t.Fatal(err)
	}
	s := Installation{ReleaseID: m.ReleaseID, Sequence: m.Sequence, RootSHA: hash, ManifestSHA: fingerprint([]byte("previous release manifest")), VerifiedAt: time.Now().UTC().Format(time.RFC3339)}
	if err := verifyRecoveryRelease(bundle, bytes, s); err == nil || !strings.Contains(err.Error(), "originally installed manifest") {
		t.Fatalf("previous release trust fields must never qualify candidate recovery: %v", err)
	}
}
