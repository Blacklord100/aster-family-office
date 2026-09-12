// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
)

var restoreRequestID = regexp.MustCompile(`^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$`)

// restoreDatabase is the only restore path that runs pg_restore. Its durable
// completion boundary requires both the transaction's successful exit and the
// authenticated end of the inner age stream, which pg_restore may not consume.
func (c Controller) restoreDatabase(ctx context.Context, s Installation, j *Journal, plain io.Reader) error {
	if j.Phase != "restore-database" {
		return fmt.Errorf("database import is permitted only for a fresh restore")
	}
	if _, e := c.compose(ctx, s, plain, nil, "exec", "-T", "--user", "postgres", "postgres", "pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", "--role=aster_migrator", "--username=postgres", "--dbname=aster"); e != nil {
		return e
	}
	if _, e := io.Copy(io.Discard, plain); e != nil {
		return fmt.Errorf("database recovery stream did not authenticate completely: %w", e)
	}
	return c.journal(j, "database-restored")
}

// ContinueRestore never imports database contents. A crash before the durable
// database-restored marker is intentionally ambiguous: stop that isolated fleet
// and recover into a different empty destination with the recovery identity.
func (c Controller) ContinueRestore(ctx context.Context, input, backupSHA, trustedRoot, trustedSHA string) error {
	if e := platformPreflight(); e != nil {
		return e
	}
	unlock, e := c.lock()
	if e != nil {
		return e
	}
	defer unlock()
	j, m, e := c.verifyRestoreContinuation(input, backupSHA, trustedRoot, trustedSHA)
	if e != nil {
		return e
	}
	// Verify all retained signed payloads and the externally pinned backup before
	// invoking a runtime command, including package inspection or Docker startup.
	if e = c.runtime(ctx, m, c.release(*j.Candidate), false); e != nil {
		return e
	}
	if e = c.loadImages(ctx, m, c.release(*j.Candidate)); e != nil {
		return e
	}
	return c.finishRestore(ctx, j, m)
}

func validateRestoreJournal(root string, j *Journal) error {
	if j.Operation != "restore" || j.Candidate == nil || !restoreRequestID.MatchString(j.ID) {
		return fmt.Errorf("there is no valid restore journal to continue")
	}
	s := j.Candidate
	if s.Format != 1 || s.Root != root || !identifier.MatchString(s.ReleaseID) || !identifier.MatchString(s.Project) || s.Generation < 1 || (s.Profile != "offline" && s.Profile != "connected") {
		return fmt.Errorf("restore journal does not identify this isolated destination")
	}
	if err := validateOptionalServices(s.Profile, s.OptionalServices); err != nil {
		return err
	}
	switch j.Phase {
	case "database-restored":
		if j.ActivationID != "" || j.ActivationGeneration != 0 {
			return fmt.Errorf("restore journal has an inconsistent activation boundary")
		}
	case "restore-activation-intent", "candidate-starting", "resume-intent", "complete":
		if !restoreRequestID.MatchString(j.ActivationID) || j.ActivationID == j.ID || j.ActivationGeneration < 1 || j.ActivationGeneration >= int(^uint(0)>>1) || (s.Generation != j.ActivationGeneration && s.Generation != j.ActivationGeneration+1) {
			return fmt.Errorf("restore journal is missing its reserved activation identity")
		}
		if j.Phase != "restore-activation-intent" && s.Generation != j.ActivationGeneration+1 {
			return fmt.Errorf("restore journal has not recorded the activated generation")
		}
	case "restore-database":
		return fmt.Errorf("database restore completion is ambiguous; stop this isolated fleet and restore into a new destination; database import will not be replayed")
	default:
		return fmt.Errorf("restore phase %q cannot be continued safely", j.Phase)
	}
	return nil
}

func (c Controller) verifyRestoreContinuation(input, backupSHA, trustedRoot, trustedSHA string) (*Journal, *Manifest, error) {
	b, e := os.ReadFile(filepath.Join(c.Root, "journal.json"))
	if e != nil {
		return nil, nil, e
	}
	var j Journal
	if e = decodeJSON(b, &j); e != nil {
		return nil, nil, e
	}
	if e = validateRestoreJournal(c.Root, &j); e != nil {
		return nil, nil, e
	}
	if !digest.MatchString(j.BackupSHA) || backupSHA != j.BackupSHA || j.BackupSize <= 0 {
		return nil, nil, fmt.Errorf("independent backup digest must match the committed restore journal")
	}
	if e = verifyArtifact(input, backupSHA, j.BackupSize); e != nil {
		return nil, nil, e
	}
	rootBytes, e := os.ReadFile(trustedRoot)
	if e != nil {
		return nil, nil, e
	}
	if !digest.MatchString(trustedSHA) || fingerprint(rootBytes) != trustedSHA || j.Candidate.RootSHA != trustedSHA {
		return nil, nil, fmt.Errorf("independent recovery trust root mismatch")
	}
	if e = verifyRecoveryRelease(c.release(*j.Candidate), rootBytes, *j.Candidate); e != nil {
		return nil, nil, e
	}
	m, e := c.manifest(*j.Candidate)
	if e != nil {
		return nil, nil, e
	}
	return &j, m, nil
}

// validateRestoreState runs before migrations or session revocation, including
// when a previous command committed but its local journal write was interrupted.
func validateRestoreState(j *Journal, m *Manifest, state Lifecycle) error {
	s := j.Candidate
	if state.ActiveRelease != s.ReleaseID || state.SchemaVersion != m.Schema.Target {
		return fmt.Errorf("restored database release or schema differs from the retained release")
	}
	if state.Mode == "open" {
		if (j.Phase != "resume-intent" && j.Phase != "complete") || j.ActivationGeneration < 1 || state.Generation != j.ActivationGeneration+1 || s.Generation != state.Generation {
			return fmt.Errorf("open database is outside this restore's recorded resume boundary; existing writes will not be altered")
		}
		return nil
	}
	if j.Phase == "complete" || state.Mode != "maintenance" || state.ActiveOperations != 0 || state.ActiveLeases.Total != 0 {
		return fmt.Errorf("restored database must remain sealed and fully drained")
	}
	if j.ActivationID == "" {
		if state.Generation != s.Generation {
			return fmt.Errorf("restored database generation differs from the backup")
		}
	} else if state.Generation != j.ActivationGeneration && state.Generation != j.ActivationGeneration+1 {
		return fmt.Errorf("restored database generation is outside this restore's activation boundary")
	}
	if (j.Phase == "candidate-starting" || j.Phase == "resume-intent") && state.Generation != s.Generation {
		return fmt.Errorf("restored database lost its recorded activated generation")
	}
	return nil
}

func (c Controller) finishRestore(ctx context.Context, j *Journal, m *Manifest) error {
	if e := validateRestoreJournal(c.Root, j); e != nil {
		return e
	}
	s := *j.Candidate
	// A host restart may have stopped PostgreSQL. Start only the verified isolated
	// database before querying it; no intake or application worker starts here.
	if e := c.writeEnv(s, m); e != nil {
		return e
	}
	if _, e := c.compose(ctx, s, nil, nil, "up", "-d", "--wait", "--wait-timeout", "180", "postgres"); e != nil {
		return e
	}
	state, e := c.lifecycle(ctx, s, "status")
	if e != nil {
		return e
	}
	if e = validateRestoreState(j, m, state); e != nil {
		return e
	}
	if state.Mode == "open" {
		// Resume already committed. Reconcile availability and local state only;
		// never replay migrations, revoke new sessions, or activate another writer.
		if _, e = c.compose(ctx, s, nil, nil, "up", "-d", "--wait", "--wait-timeout", "300"); e != nil {
			return e
		}
		if e = c.qualify(ctx, s, m); e != nil {
			return e
		}
		if e = writeJSON(c.statePath(), s); e != nil {
			return e
		}
		return c.journal(j, "complete")
	}
	if _, e = c.compose(ctx, s, nil, nil, "run", "--rm", "--no-deps", "-T", "migrate"); e != nil {
		return e
	}
	b, e := c.compose(ctx, s, nil, nil, "run", "--rm", "--no-deps", "-T", "migrate", "node", "dist-ops/recovery-sessions.js", "--request-id", j.ID)
	if e != nil {
		return e
	}
	var revocation struct {
		OK              bool `json:"ok"`
		RevokedSessions *int `json:"revokedSessions"`
	}
	if e = json.Unmarshal(b, &revocation); e != nil || !revocation.OK || revocation.RevokedSessions == nil || *revocation.RevokedSessions < 0 {
		return fmt.Errorf("restored browser session revocation was not confirmed")
	}
	if j.ActivationID == "" {
		j.ActivationID = id()
		j.ActivationGeneration = state.Generation
		if e = c.journal(j, "restore-activation-intent"); e != nil {
			return e
		}
	}
	// This exact request identity is distinct from session revocation's j.ID.
	// Replaying it after a lost response returns the original generation receipt.
	state, e = c.lifecycle(ctx, s, "activate", "--release", s.ReleaseID, "--expected-generation", strconv.Itoa(j.ActivationGeneration), "--request-id", j.ActivationID)
	if e != nil {
		return e
	}
	if state.Mode != "maintenance" || state.ActiveRelease != s.ReleaseID || state.Generation != j.ActivationGeneration+1 || state.SchemaVersion != m.Schema.Target || state.ActiveOperations != 0 || state.ActiveLeases.Total != 0 {
		return fmt.Errorf("restore activation receipt does not match its reserved generation")
	}
	s.Generation = state.Generation
	j.Candidate = &s
	if e = c.journal(j, "candidate-starting"); e != nil {
		return e
	}
	if e = c.writeEnv(s, m); e != nil {
		return e
	}
	if e = writeJSON(c.statePath(), s); e != nil {
		return e
	}
	if _, e = c.compose(ctx, s, nil, nil, "up", "-d", "--wait", "--wait-timeout", "300"); e != nil {
		return e
	}
	if e = c.qualify(ctx, s, m); e != nil {
		return e
	}
	if e = c.journal(j, "resume-intent"); e != nil {
		return e
	}
	state, e = c.lifecycle(ctx, s, "resume", "--release", s.ReleaseID, "--expected-generation", strconv.Itoa(s.Generation))
	if e != nil {
		return e
	}
	if state.Mode != "open" || state.ActiveRelease != s.ReleaseID || state.Generation != s.Generation {
		return fmt.Errorf("restore resume receipt does not match its qualified generation")
	}
	return c.journal(j, "complete")
}
