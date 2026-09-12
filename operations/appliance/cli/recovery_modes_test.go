// SPDX-License-Identifier: Apache-2.0
package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRecoveryQuarantineModesAreRestoredBeforeSignedVerification(t *testing.T) {
	for _, tampered := range []bool{false, true} {
		t.Run(map[bool]string{false: "authentic", true: "tampered"}[tampered], func(t *testing.T) {
			bundle, m := fixture(t)
			m.Files[0].Mode = 0755
			if e := os.Chmod(filepath.Join(bundle, m.Files[0].Path), 0755); e != nil {
				t.Fatal(e)
			}
			if e := writeJSON(filepath.Join(bundle, "release.json"), m); e != nil {
				t.Fatal(e)
			}
			_, rootPath, rootSHA := trustFixture(t, bundle, 1)
			root, e := os.ReadFile(rootPath)
			if e != nil {
				t.Fatal(e)
			}
			manifest, e := os.ReadFile(filepath.Join(bundle, "release.json"))
			if e != nil {
				t.Fatal(e)
			}
			s := Installation{ReleaseID: m.ReleaseID, Sequence: m.Sequence, RootSHA: rootSHA,
				ManifestSHA: fingerprint(manifest), VerifiedAt: time.Now().UTC().Format(time.RFC3339)}
			for _, entry := range m.Files {
				if e := os.Chmod(filepath.Join(bundle, entry.Path), 0600); e != nil {
					t.Fatal(e)
				}
			}
			if e := verifyRecoveryRelease(bundle, root, s); e == nil {
				t.Fatal("quarantined permissions should not pass the normal release verifier")
			}
			if tampered {
				if e := os.WriteFile(filepath.Join(bundle, m.Files[0].Path), []byte("corrupted"), 0600); e != nil {
					t.Fatal(e)
				}
			}
			e = prepareRecoveryRelease(bundle, root, s, m)
			if (e != nil) != tampered {
				t.Fatalf("recovery proof mismatch: %v", e)
			}
		})
	}
}

func TestArchivedModesCannotOverrideVerifiedReleasePermissions(t *testing.T) {
	c, s, _ := protocolReviewFixture(t, "")
	bundle := c.release(s)
	m, e := c.manifest(s)
	if e != nil {
		t.Fatal(e)
	}
	m.Files[0].Mode = 0755
	if e = os.Chmod(filepath.Join(bundle, m.Files[0].Path), 0755); e != nil {
		t.Fatal(e)
	}
	if e = writeJSON(filepath.Join(bundle, "release.json"), m); e != nil {
		t.Fatal(e)
	}
	_, rootPath, rootSHA := trustFixture(t, bundle, 1)
	root, e := os.ReadFile(rootPath)
	if e != nil {
		t.Fatal(e)
	}
	manifest, e := os.ReadFile(filepath.Join(bundle, "release.json"))
	if e != nil {
		t.Fatal(e)
	}
	s.RootSHA, s.Sequence, s.ManifestSHA, s.VerifiedAt = rootSHA, m.Sequence, fingerprint(manifest), time.Now().UTC().Format(time.RFC3339)
	for _, entry := range m.Files {
		if e = os.Chmod(filepath.Join(bundle, entry.Path), 0600); e != nil {
			t.Fatal(e)
		}
	}
	if e = prepareRecoveryRelease(bundle, root, s, m); e != nil {
		t.Fatal(e)
	}
	for _, entry := range m.Files {
		archived := entry
		archived.Path = "releases/" + s.ReleaseID + "/" + entry.Path
		archived.Mode = 0777 // Incidental backup permissions are not publisher authority.
		if e = c.restoreArchiveEntryPermissions(archived); e != nil {
			t.Fatal(e)
		}
	}
	if e = verifyRecoveryRelease(bundle, root, s); e != nil {
		t.Fatal(e)
	}
}
