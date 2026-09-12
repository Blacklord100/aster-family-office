// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
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

type restoreProtocolCommander struct {
	state                  Lifecycle
	calls                  [][]string
	root                   string
	failImport             bool
	loseActivationResponse bool
	activationRequest      string
	activationGeneration   int
	activationCalls        int
	revocationIDs          []string
}

func (f *restoreProtocolCommander) Run(_ context.Context, in io.Reader, _ io.Writer, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
	command := strings.Join(args, " ")
	if strings.Contains(command, "pg_restore") {
		if f.failImport {
			return nil, fmt.Errorf("synthetic database import failed")
		}
		return nil, nil // Deliberately leave the authentication tail unread.
	}
	if strings.Contains(command, "dist-ops/lifecycle.js status") {
		return json.Marshal(f.state)
	}
	if strings.Contains(command, "dist-ops/recovery-sessions.js") {
		f.revocationIDs = append(f.revocationIDs, args[len(args)-1])
		return []byte(`{"ok":true,"revokedSessions":4}`), nil
	}
	if strings.Contains(command, "dist-ops/lifecycle.js activate") {
		f.activationCalls++
		request := args[len(args)-1]
		generation, err := strconv.Atoi(args[len(args)-3])
		if err != nil {
			return nil, err
		}
		var j Journal
		b, err := os.ReadFile(filepath.Join(f.root, "journal.json"))
		if err != nil {
			return nil, err
		}
		if err = decodeJSON(b, &j); err != nil {
			return nil, err
		}
		if j.ActivationID != request || j.ActivationGeneration != generation || j.ID == request {
			return nil, fmt.Errorf("activation identity was not durably reserved before invocation")
		}
		if f.activationRequest == "" {
			f.activationRequest, f.activationGeneration = request, generation
			if f.state.Generation != generation {
				return nil, fmt.Errorf("generation conflict")
			}
			f.state.Generation++
		} else if f.activationRequest != request || f.activationGeneration != generation {
			return nil, fmt.Errorf("activation replay identity changed")
		}
		if f.loseActivationResponse {
			f.loseActivationResponse = false
			return nil, fmt.Errorf("synthetic connection loss after activation commit")
		}
		return json.Marshal(f.state)
	}
	if strings.Contains(command, "exec -T web node") {
		return nil, fmt.Errorf("synthetic qualification stop") // No real network/Docker.
	}
	if strings.Contains(command, "dist-ops/lifecycle.js resume") {
		return nil, fmt.Errorf("unqualified candidate must not resume")
	}
	return nil, nil
}

func restoreProtocolFixture(t *testing.T) (Controller, *Journal, *Manifest, *restoreProtocolCommander) {
	t.Helper()
	c, s, _ := protocolReviewFixture(t, "")
	s.Project = "aster-recovery-fixture"
	s.Hostname = "aster.example.test"
	s.TLSMode = "internal"
	m, err := c.manifest(s)
	if err != nil {
		t.Fatal(err)
	}
	j := &Journal{Operation: "restore", ID: id(), Phase: "database-restored", Candidate: &s}
	fake := &restoreProtocolCommander{root: c.Root, state: Lifecycle{OK: true, Mode: "maintenance", Generation: s.Generation, ActiveRelease: s.ReleaseID, SchemaVersion: m.Schema.Target, CanSeal: true}}
	c.Commands = fake
	if err = c.journal(j, j.Phase); err != nil {
		t.Fatal(err)
	}
	return c, j, m, fake
}

type failedRestoreTail struct{}

func (failedRestoreTail) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestProtocolReviewDatabaseCompletionRequiresImportAndAuthenticatedEOF(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		failImport, failTail bool
	}{
		{"import fails", true, false}, {"inner authentication fails", false, true}, {"successful import and EOF", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, j, _, fake := restoreProtocolFixture(t)
			fake.failImport = tc.failImport
			if err := c.journal(j, "restore-database"); err != nil {
				t.Fatal(err)
			}
			var reader io.Reader = strings.NewReader("remaining authenticated plaintext")
			if tc.failTail {
				reader = failedRestoreTail{}
			}
			err := c.restoreDatabase(context.Background(), *j.Candidate, j, reader)
			if (err != nil) != (tc.failImport || tc.failTail) {
				t.Fatalf("unexpected import result: %v", err)
			}
			var stored Journal
			b, readErr := os.ReadFile(filepath.Join(c.Root, "journal.json"))
			if readErr != nil {
				t.Fatal(readErr)
			}
			if readErr = decodeJSON(b, &stored); readErr != nil {
				t.Fatal(readErr)
			}
			want := "database-restored"
			if tc.failImport || tc.failTail {
				want = "restore-database"
			}
			if stored.Phase != want {
				t.Fatalf("durable boundary = %s; want %s", stored.Phase, want)
			}
			if stored.Candidate.Root != c.Root || stored.Candidate.Project != "aster-recovery-fixture" {
				t.Fatal("lost isolated restore destination")
			}
		})
	}
}

func TestProtocolReviewAmbiguousRestoreNeverInvokesRuntime(t *testing.T) {
	c, j, m, fake := restoreProtocolFixture(t)
	j.Phase = "restore-database"
	if err := c.finishRestore(context.Background(), j, m); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous import accepted: %v", err)
	}
	if len(fake.calls) != 0 {
		t.Fatal("ambiguous continuation invoked runtime")
	}
}

func TestProtocolReviewRestoreStartsIsolatedDatabaseBeforeStatusAndPersistsActivation(t *testing.T) {
	c, j, m, fake := restoreProtocolFixture(t)
	err := c.finishRestore(context.Background(), j, m)
	if err == nil || !strings.Contains(err.Error(), "synthetic qualification stop") {
		t.Fatalf("unexpected forward result: %v", err)
	}
	if len(fake.calls) < 2 || !strings.Contains(strings.Join(fake.calls[0], " "), "up -d --wait --wait-timeout 180 postgres") || !strings.Contains(strings.Join(fake.calls[1], " "), "dist-ops/lifecycle.js status") {
		t.Fatal("must start isolated postgres before status")
	}
	for _, call := range fake.calls {
		joined := strings.Join(call, " ")
		if !strings.Contains(joined, "--project-name aster-recovery-fixture") || !strings.Contains(joined, c.Root) {
			t.Fatal("runtime command escaped recovered project/root")
		}
		if strings.Contains(joined, "pg_restore") || strings.Contains(joined, "lifecycle.js resume") {
			t.Fatal("continuation imported data or resumed before qualification")
		}
	}
	if j.Candidate.Generation != 3 || j.ActivationGeneration != 2 || j.Phase != "candidate-starting" || j.ActivationID == j.ID || fake.activationCalls != 1 {
		t.Fatalf("incorrect durable activation: %+v", j)
	}
	if len(fake.revocationIDs) != 1 || fake.revocationIDs[0] != j.ID {
		t.Fatal("session revocation must use its own stable request identity")
	}
	stored, err := c.load()
	if err != nil {
		t.Fatal(err)
	}
	if stored.Generation != 3 || stored.Project != j.Candidate.Project || stored.Root != c.Root {
		t.Fatal("wrong restored installation published")
	}
}

func TestProtocolReviewLostRestoreActivationReplaysExactReservedIdentity(t *testing.T) {
	c, j, m, fake := restoreProtocolFixture(t)
	fake.loseActivationResponse = true
	err := c.finishRestore(context.Background(), j, m)
	if err == nil || !strings.Contains(err.Error(), "connection loss") {
		t.Fatalf("missing simulated interruption: %v", err)
	}
	if fake.state.Generation != 3 || j.Phase != "restore-activation-intent" {
		t.Fatal("activation intent was not durable before its lost response")
	}
	b, err := os.ReadFile(filepath.Join(c.Root, "journal.json"))
	if err != nil {
		t.Fatal(err)
	}
	var resumed Journal
	if err = decodeJSON(b, &resumed); err != nil {
		t.Fatal(err)
	}
	err = c.finishRestore(context.Background(), &resumed, m)
	if err == nil || !strings.Contains(err.Error(), "qualification stop") {
		t.Fatalf("resume did not reach candidate qualification: %v", err)
	}
	if fake.activationCalls != 2 || fake.state.Generation != 3 || resumed.ActivationID != j.ActivationID || resumed.ActivationGeneration != 2 || resumed.Candidate.Generation != 3 {
		t.Fatal("lost activation response advanced the writer twice or changed replay identity")
	}
	for _, call := range fake.calls {
		if strings.Contains(strings.Join(call, " "), "pg_restore") {
			t.Fatal("forward recovery replayed database import")
		}
	}
}

func TestProtocolReviewOpenRestoreNeverReplaysMutations(t *testing.T) {
	c, j, m, fake := restoreProtocolFixture(t)
	j.ActivationID = id()
	j.ActivationGeneration = 2
	j.Candidate.Generation = 3
	j.Phase = "resume-intent"
	fake.state.Generation = 3
	fake.state.Mode = "open"
	fake.state.ActiveOperations = 5
	fake.state.ActiveLeases.Total = 2
	err := c.finishRestore(context.Background(), j, m)
	if err == nil || !strings.Contains(err.Error(), "qualification stop") {
		t.Fatalf("open restore did not reconcile availability: %v", err)
	}
	for _, call := range fake.calls {
		joined := strings.Join(call, " ")
		if strings.Contains(joined, "pg_restore") || strings.HasSuffix(joined, "-T migrate") || strings.Contains(joined, "recovery-sessions.js") || strings.Contains(joined, "lifecycle.js activate") || strings.Contains(joined, "lifecycle.js resume") {
			t.Fatalf("post-resume writes were exposed to a recovery mutation: %s", joined)
		}
	}
}

func TestProtocolReviewRestoreStateRejectsWrongReleaseGenerationAndLiveWork(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Journal, *Lifecycle)
	}{
		{"unexpected open", func(j *Journal, s *Lifecycle) { s.Mode = "open" }},
		{"wrong release", func(j *Journal, s *Lifecycle) { s.ActiveRelease = "another-release" }},
		{"wrong schema", func(j *Journal, s *Lifecycle) { s.SchemaVersion++ }},
		{"wrong generation", func(j *Journal, s *Lifecycle) { s.Generation++ }},
		{"still draining", func(j *Journal, s *Lifecycle) { s.Mode = "draining" }},
		{"active operation", func(j *Journal, s *Lifecycle) { s.ActiveOperations = 1 }},
		{"active lease", func(j *Journal, s *Lifecycle) { s.ActiveLeases.Total = 1 }},
		{"later open generation", func(j *Journal, s *Lifecycle) {
			j.Phase = "resume-intent"
			j.ActivationID = id()
			j.ActivationGeneration = 2
			j.Candidate.Generation = 3
			s.Mode = "open"
			s.Generation = 4
		}},
		{"another root", func(j *Journal, s *Lifecycle) { j.Candidate.Root = "/different-root" }},
		{"reused revocation identity", func(j *Journal, s *Lifecycle) {
			j.Phase = "restore-activation-intent"
			j.ActivationID = j.ID
			j.ActivationGeneration = 2
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, j, m, fake := restoreProtocolFixture(t)
			tc.change(j, &fake.state)
			if err := c.finishRestore(context.Background(), j, m); err == nil {
				t.Fatal("unsafe restore boundary accepted")
			}
			for _, call := range fake.calls {
				joined := strings.Join(call, " ")
				if strings.Contains(joined, "pg_restore") || strings.HasSuffix(joined, "-T migrate") || strings.Contains(joined, "recovery-sessions.js") || strings.Contains(joined, "lifecycle.js activate") {
					t.Fatal("state rejection followed a mutation")
				}
			}
		})
	}
}

func TestProtocolReviewContinueRestoreRequiresExternalBackupAndPublisherTrust(t *testing.T) {
	c, j, _, fake := restoreProtocolFixture(t)
	_, trustedRoot, trustedSHA := trustFixture(t, c.release(*j.Candidate), 1)
	manifest, err := os.ReadFile(filepath.Join(c.release(*j.Candidate), "release.json"))
	if err != nil {
		t.Fatal(err)
	}
	j.Candidate.RootSHA = trustedSHA
	j.Candidate.ManifestSHA = fingerprint(manifest)
	j.Candidate.VerifiedAt = time.Now().UTC().Format(time.RFC3339)
	j.Candidate.Sequence = 1
	input := filepath.Join(t.TempDir(), "verified-backup.age")
	ciphertext := []byte("independently pinned encrypted artifact fixture")
	if err = os.WriteFile(input, ciphertext, 0600); err != nil {
		t.Fatal(err)
	}
	j.Backup = input
	j.BackupSHA = fingerprint(ciphertext)
	j.BackupSize = int64(len(ciphertext))
	if err = c.journal(j, j.Phase); err != nil {
		t.Fatal(err)
	}
	if _, _, err = c.verifyRestoreContinuation(input, j.BackupSHA, trustedRoot, trustedSHA); err != nil {
		t.Fatalf("valid independent trust rejected: %v", err)
	}
	if _, _, err = c.verifyRestoreContinuation(input, strings.Repeat("0", 64), trustedRoot, trustedSHA); err == nil {
		t.Fatal("replacement backup digest accepted")
	}
	if _, _, err = c.verifyRestoreContinuation(input, j.BackupSHA, trustedRoot, strings.Repeat("0", 64)); err == nil {
		t.Fatal("replacement publisher root accepted")
	}
	if err = os.WriteFile(input, []byte("tampered artifact"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = c.verifyRestoreContinuation(input, j.BackupSHA, trustedRoot, trustedSHA); err == nil {
		t.Fatal("tampered backup accepted")
	}
	if err = os.WriteFile(input, ciphertext, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(c.release(*j.Candidate), "payload/images/app.tar"), []byte("tampered image"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, _, err = c.verifyRestoreContinuation(input, j.BackupSHA, trustedRoot, trustedSHA); err == nil {
		t.Fatal("tampered retained release accepted")
	}
	if len(fake.calls) != 0 {
		t.Fatal("trust validation invoked a runtime command")
	}
}
