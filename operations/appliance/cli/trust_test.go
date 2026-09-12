// SPDX-License-Identifier: Apache-2.0
package main

import (
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func expiredTimestamp(bundle, keys string) error {
	ts := metadata.Timestamp(time.Now().Add(-time.Hour))
	s, e := loadSigner(filepath.Join(keys, "timestamp.pem"))
	if e != nil {
		return e
	}
	if _, e = ts.Sign(s); e != nil {
		return e
	}
	return ts.ToFile(filepath.Join(bundle, "metadata", "timestamp.json"), true)
}
func TestMetadataFetcherNeverUsesNetwork(t *testing.T) {
	dir := t.TempDir()
	root, e := os.OpenRoot(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer root.Close()
	f := localFetcher{root}
	for _, u := range []string{"https://attacker.invalid/metadata/timestamp.json", "file:///etc/passwd", "https://offline.aster.invalid/metadata/../../etc/passwd", "https://offline.aster.invalid/metadata/timestamp.json?redirect=1", "https://offline.aster.invalid/metadata/sub/timestamp.json"} {
		if _, e := f.DownloadFile(u, 1024, time.Second); e == nil {
			t.Fatalf("unsafe URL accepted: %s", u)
		}
	}
}
func TestTUFRootRotationRequiresOldAndNewThreshold(t *testing.T) {
	bundle, _ := fixture(t)
	old, root, hash := trustFixture(t, bundle, 1)
	next := filepath.Join(t.TempDir(), "next")
	if e := initTrust(next, time.Now()); e != nil {
		t.Fatal(e)
	}
	if e := rotateTrust(root, []string{filepath.Join(old, "root-1.pem"), filepath.Join(old, "root-2.pem")}, next); e != nil {
		t.Fatal(e)
	}
	if e := signBundle(bundle, next, 2, time.Now().Add(24*time.Hour)); e != nil {
		t.Fatal(e)
	}
	if _, e := verifyBundle(bundle, root, hash, t.TempDir()); e != nil {
		t.Fatal(e)
	}
	// Removing the rotation bridge must not allow the new targets key through.
	os.Remove(filepath.Join(bundle, "metadata", "2.root.json"))
	if _, e := verifyBundle(bundle, root, hash, t.TempDir()); e == nil {
		t.Fatal("new signer accepted without old root threshold")
	}
}
func TestRecoveryOfPinnedHistoricalReleaseDoesNotDisableUpdateExpiry(t *testing.T) {
	bundle, m := fixture(t)
	keys := filepath.Join(t.TempDir(), "keys")
	past := time.Now().Add(-72 * time.Hour)
	if e := initTrust(keys, past); e != nil {
		t.Fatal(e)
	}
	if e := signBundleAt(bundle, keys, 1, past.Add(24*time.Hour), past); e != nil {
		t.Fatal(e)
	}
	root, e := os.ReadFile(filepath.Join(keys, "root.json"))
	if e != nil {
		t.Fatal(e)
	}
	data, e := os.ReadFile(filepath.Join(bundle, "release.json"))
	if e != nil {
		t.Fatal(e)
	}
	s := Installation{ReleaseID: m.ReleaseID, Sequence: m.Sequence, RootSHA: fingerprint(root), ManifestSHA: fingerprint(data), VerifiedAt: past.Format(time.RFC3339)}
	if e := verifyRecoveryRelease(bundle, root, s); e != nil {
		t.Fatal(e)
	}
	if _, e := verifyBundle(bundle, filepath.Join(keys, "root.json"), s.RootSHA, t.TempDir()); e == nil {
		t.Fatal("normal verification bypassed current expiry")
	}
	s.ManifestSHA = fingerprint([]byte("another release"))
	if e := verifyRecoveryRelease(bundle, root, s); e == nil {
		t.Fatal("unpinned historical release accepted")
	}
}
