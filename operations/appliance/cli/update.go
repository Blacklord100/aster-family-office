// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func ensureNoRetag(old, next *Manifest) error {
	for _, a := range old.Images {
		for _, b := range next.Images {
			if a.Reference == b.Reference && a.ImageID != b.ImageID {
				return fmt.Errorf("update would replace an existing release image tag: %s", a.Service)
			}
		}
	}
	return nil
}
func (c Controller) checkDatabaseCompatibility(ctx context.Context, old, next *Manifest) error {
	major := func(m *Manifest) (string, error) {
		for _, im := range m.Images {
			if im.Service == "postgres" {
				b, e := c.Commands.Run(ctx, nil, nil, "docker", "image", "inspect", "--format", "{{json .Config.Env}}", im.ImageID)
				if e != nil {
					return "", e
				}
				var env []string
				if e = json.Unmarshal(b, &env); e != nil {
					return "", e
				}
				for _, v := range env {
					if strings.HasPrefix(v, "PG_MAJOR=") {
						value := strings.TrimPrefix(v, "PG_MAJOR=")
						if n, e := strconv.Atoi(value); e == nil && n >= 17 {
							return value, nil
						}
					}
				}
				return "", fmt.Errorf("PostgreSQL image does not declare a supported major version")
			}
		}
		return "", fmt.Errorf("PostgreSQL image missing")
	}
	a, e := major(old)
	if e != nil {
		return e
	}
	b, e := major(next)
	if e != nil {
		return e
	}
	if a != b {
		return fmt.Errorf("PostgreSQL major upgrades require a separately qualified migration, not an in-place appliance update")
	}
	return nil
}

func (c Controller) Update(ctx context.Context, bundle, backup string, continuing bool) error {
	if e := platformPreflight(); e != nil {
		return e
	}
	unlock, e := c.lock()
	if e != nil {
		return e
	}
	defer unlock()
	var j Journal
	var m *Manifest
	if continuing {
		b, e := os.ReadFile(filepath.Join(c.Root, "journal.json"))
		if e != nil {
			return e
		}
		if e = decodeJSON(b, &j); e != nil {
			return e
		}
		if j.Operation != "update" || j.Phase == "complete" || j.Candidate == nil || j.Previous == nil {
			return fmt.Errorf("there is no interrupted update to continue")
		}
		if backup != "" {
			if j.BackupSHA != "" {
				return fmt.Errorf("cannot replace an update's pinned backup")
			}
			if e = backupPath(c.Root, backup); e != nil {
				return e
			}
			j.Backup = backup
		}
		m, e = c.manifest(*j.Candidate)
		if e != nil {
			return e
		}
		if e = verifyPayload(c.release(*j.Candidate), m); e != nil {
			return e
		}
	} else {
		if e = c.requireFinished(); e != nil {
			return e
		}
		old, e := c.load()
		if e != nil {
			return e
		}
		if e = backupPath(c.Root, backup); e != nil {
			return e
		}
		m, e = c.stage(bundle, filepath.Join(c.Root, "trust", "initial-root.json"), old.RootSHA)
		if e != nil {
			return e
		}
		if m.Sequence <= old.Sequence {
			return fmt.Errorf("release sequence must advance; downgrades are refused")
		}
		next := old
		next.ReleaseID = m.ReleaseID
		next.Sequence = m.Sequence
		next.ManifestSHA = fingerprint(m.raw)
		next.VerifiedAt = time.Now().UTC().Format(time.RFC3339)
		j = Journal{Operation: "update", ID: id(), Previous: &old, Candidate: &next, Backup: backup}
		if e = c.journal(&j, "verified"); e != nil {
			return e
		}
	}
	old, next := *j.Previous, *j.Candidate
	oldManifest, e := c.manifest(old)
	if e != nil {
		return e
	}
	if e = ensureNoRetag(oldManifest, m); e != nil {
		return e
	}
	if e = c.loadImages(ctx, oldManifest, c.release(old)); e != nil {
		return e
	}
	if e = c.loadImages(ctx, m, c.release(next)); e != nil {
		return e
	}
	if e = c.checkDatabaseCompatibility(ctx, oldManifest, m); e != nil {
		return e
	}
	postgresState := old
	if continuing {
		if _, err := os.Stat(filepath.Join(c.Root, "config", next.ReleaseID+".env")); err == nil {
			postgresState = next
		}
	}
	if _, e = c.compose(ctx, postgresState, nil, nil, "up", "-d", "--wait", "--wait-timeout", "180", "postgres"); e != nil {
		return e
	}
	// Inspect through the matching release after activation; old credentials keep
	// access only to the explicitly privileged lifecycle operator service.
	state, e := c.lifecycle(ctx, old, "status")
	if e != nil {
		return e
	}
	if state.Mode == "open" && state.ActiveRelease == next.ReleaseID {
		// A process died after resume. Writes may exist: never restore a snapshot.
		next.Generation = state.Generation
		if e = c.writeEnv(next, m); e != nil {
			return e
		}
		if _, e = c.compose(ctx, next, nil, nil, "up", "-d", "--wait", "--wait-timeout", "300"); e != nil {
			return e
		}
		if e = c.qualify(ctx, next, m); e != nil {
			return e
		}
		if e = writeJSON(c.statePath(), next); e != nil {
			return e
		}
		return c.journal(&j, "complete")
	}
	if state.ActiveRelease != old.ReleaseID && state.ActiveRelease != next.ReleaseID {
		return fmt.Errorf("database release is outside this update journal")
	}
	if state.SchemaVersion > m.Schema.Target || state.SchemaVersion > m.Schema.Max {
		return fmt.Errorf("candidate cannot open the existing database schema")
	}
	if e = c.runtime(ctx, m, c.release(next), false); e != nil {
		return e
	}
	if e = c.loadImages(ctx, m, c.release(next)); e != nil {
		return e
	}
	if state.Mode != "maintenance" {
		state, e = c.seal(ctx, old, &j)
		if e != nil {
			return e
		}
	}
	// A backup receipt is committed only after the encrypted artifact is synced.
	// Never replace an incomplete/existing artifact silently.
	if j.BackupSHA == "" {
		if state.ActiveRelease != old.ReleaseID {
			return fmt.Errorf("pre-update backup missing after activation; do not overwrite the database")
		}
		if e = c.backupSealed(ctx, old, j.Backup, state); e != nil {
			return e
		}
		f, err := os.Open(j.Backup)
		if err != nil {
			return err
		}
		j.BackupSHA, j.BackupSize, e = fileHash(f)
		f.Close()
		if e != nil {
			return e
		}
	}
	if e = verifyBackupReceipt(j.Backup, j.BackupSHA, j.BackupSize, old.ReleaseID); e != nil {
		return e
	}
	if e = c.journal(&j, "backup-complete"); e != nil {
		return e
	}
	// Stop the scoped old deployment before replacing shared model assets or
	// migrating. down deliberately omits --volumes and never removes user data.
	if _, e = c.compose(ctx, old, nil, nil, "down", "--timeout", "90"); e != nil {
		return e
	}
	if e = c.journal(&j, "old-fleet-stopped"); e != nil {
		return e
	}
	if e = c.importModel(next, m); e != nil {
		return e
	}
	next.Generation = state.Generation
	if e = c.writeEnv(next, m); e != nil {
		return e
	}
	if _, e = c.compose(ctx, next, nil, nil, "up", "-d", "--wait", "--wait-timeout", "180", "postgres"); e != nil {
		return e
	}
	if e = c.journal(&j, "migration-started"); e != nil {
		return e
	}
	if _, e = c.compose(ctx, next, nil, nil, "run", "--rm", "--no-deps", "-T", "migrate"); e != nil {
		return e
	}
	state, e = c.lifecycle(ctx, next, "status")
	if e != nil {
		return e
	}
	if state.Mode != "maintenance" || state.SchemaVersion != m.Schema.Target {
		return fmt.Errorf("candidate schema or maintenance barrier is not ready")
	}
	if state.ActiveRelease != next.ReleaseID {
		state, e = c.lifecycle(ctx, next, "activate", "--release", next.ReleaseID, "--expected-generation", strconv.Itoa(state.Generation))
		if e != nil {
			return e
		}
	}
	next.Generation = state.Generation
	j.Candidate = &next
	if e = c.writeEnv(next, m); e != nil {
		return e
	}
	if e = writeJSON(c.statePath(), next); e != nil {
		return e
	}
	if e = c.journal(&j, "candidate-starting"); e != nil {
		return e
	}
	if _, e = c.compose(ctx, next, nil, nil, "up", "-d", "--wait", "--wait-timeout", "300"); e != nil {
		return e
	}
	if e = c.qualify(ctx, next, m); e != nil {
		return e
	}
	// Persist this intent before the irreversible admission boundary. All failure
	// paths remain sealed, or explicitly acknowledge that writes may have resumed.
	if e = c.journal(&j, "resume-intent"); e != nil {
		return e
	}
	if _, e = c.lifecycle(ctx, next, "resume", "--release", next.ReleaseID, "--expected-generation", strconv.Itoa(next.Generation)); e != nil {
		return e
	}
	return c.journal(&j, "complete")
}

// Resume never rolls back data. It reconciles with the database's active release
// and generation, checks schema compatibility, and starts that exact release.
func (c Controller) Resume(ctx context.Context) error {
	if e := platformPreflight(); e != nil {
		return e
	}
	unlock, e := c.lock()
	if e != nil {
		return e
	}
	defer unlock()
	s, e := c.load()
	if e != nil {
		return e
	}
	installedManifest, e := c.manifest(s)
	if e != nil {
		return e
	}
	if e = c.loadImages(ctx, installedManifest, c.release(s)); e != nil {
		return e
	}
	if _, e = c.compose(ctx, s, nil, nil, "up", "-d", "--wait", "--wait-timeout", "180", "postgres"); e != nil {
		return e
	}
	state, e := c.lifecycle(ctx, s, "status")
	if e != nil {
		return e
	}
	var j Journal
	b, e := os.ReadFile(filepath.Join(c.Root, "journal.json"))
	if e != nil {
		return e
	}
	if e = decodeJSON(b, &j); e != nil {
		return e
	}
	if state.Mode == "draining" {
		state, e = c.seal(ctx, s, &j)
		if e != nil {
			return e
		}
	}
	if s.ReleaseID != state.ActiveRelease {
		var matching *Installation
		for _, candidate := range []*Installation{j.Candidate, j.Previous} {
			if candidate != nil && candidate.ReleaseID == state.ActiveRelease {
				copy := *candidate
				matching = &copy
				break
			}
		}
		if matching == nil {
			return fmt.Errorf("database active release has no matching trusted installation record")
		}
		s = *matching
	}
	s.Generation = state.Generation
	m, e := c.manifest(s)
	if e != nil {
		return e
	}
	s.Sequence = m.Sequence
	if state.SchemaVersion < m.Schema.Min || state.SchemaVersion > m.Schema.Max {
		return fmt.Errorf("active release cannot read this schema; finish the pending update")
	}
	if e = verifyPayload(c.release(s), m); e != nil {
		return e
	}
	if e = c.writeEnv(s, m); e != nil {
		return e
	}
	if _, e = c.compose(ctx, s, nil, nil, "up", "-d", "--wait", "--wait-timeout", "300"); e != nil {
		return e
	}
	if e = c.qualify(ctx, s, m); e != nil {
		return e
	}
	if state.Mode != "open" {
		if e = c.journal(&j, "resume-intent"); e != nil {
			return e
		}
		if _, e = c.lifecycle(ctx, s, "resume", "--release", s.ReleaseID, "--expected-generation", strconv.Itoa(s.Generation)); e != nil {
			return e
		}
	}
	if e = writeJSON(c.statePath(), s); e != nil {
		return e
	}
	return c.journal(&j, "complete")
}
