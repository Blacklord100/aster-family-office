// SPDX-License-Identifier: Apache-2.0
package main

import (
	"crypto"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/config"
	"github.com/theupdateframework/go-tuf/v2/metadata/trustedmetadata"
	"github.com/theupdateframework/go-tuf/v2/metadata/updater"
)

const metadataURL = "https://offline.aster.invalid/metadata/"

var metadataName = regexp.MustCompile(`^(?:[1-9][0-9]*\.(?:root|snapshot|targets)|timestamp)\.json$`)

type localFetcher struct{ root *os.Root }

func (f localFetcher) DownloadFile(raw string, max int64, _ time.Duration) ([]byte, error) {
	u, e := url.Parse(raw)
	if e != nil {
		return nil, e
	}
	if u.Scheme != "https" || u.Host != "offline.aster.invalid" || u.RawQuery != "" || u.Fragment != "" || u.User != nil || !strings.HasPrefix(u.Path, "/metadata/") {
		return nil, fmt.Errorf("network fetching is disabled")
	}
	name := strings.TrimPrefix(u.Path, "/metadata/")
	if !metadataName.MatchString(name) {
		return nil, fmt.Errorf("unsupported metadata path")
	}
	b, e := boundedRead(f.root, "metadata/"+name, max)
	if os.IsNotExist(e) {
		return nil, &metadata.ErrDownloadHTTP{StatusCode: 404, URL: raw}
	}
	return b, e
}

// Disaster recovery authenticates the already-installed release at its original
// verification time. This is reachable only AFTER the backup's independent
// trusted digest is checked. New installations and updates always use real time.
func verifyRecoveryRelease(bundle string, initialRoot []byte, s Installation) error {
	if fingerprint(initialRoot) != s.RootSHA || !digest.MatchString(s.ManifestSHA) {
		return fmt.Errorf("recovery release has no independently bound trust record")
	}
	verified, e := time.Parse(time.RFC3339, s.VerifiedAt)
	if e != nil || verified.After(time.Now().Add(5*time.Minute)) {
		return fmt.Errorf("invalid original release verification time")
	}
	root, e := os.OpenRoot(bundle)
	if e != nil {
		return e
	}
	defer root.Close()
	data, e := boundedRead(root, "release.json", 8<<20)
	if e != nil {
		return e
	}
	if fingerprint(data) != s.ManifestSHA {
		return fmt.Errorf("recovery release differs from originally installed manifest")
	}
	trusted, e := trustedmetadata.New(initialRoot)
	if e != nil {
		return e
	}
	trusted.RefTime = verified
	for count := 0; count < 32; count++ {
		p := fmt.Sprintf("metadata/%d.root.json", trusted.Root.Signed.Version+1)
		b, e := boundedRead(root, p, 512000)
		if os.IsNotExist(e) {
			break
		}
		if e != nil {
			return e
		}
		if _, e = trusted.UpdateRoot(b); e != nil {
			return e
		}
		if count == 31 {
			return fmt.Errorf("excess root rotations")
		}
	}
	timestamp, e := boundedRead(root, "metadata/timestamp.json", 16384)
	if e != nil {
		return e
	}
	ts, e := trusted.UpdateTimestamp(timestamp)
	if e != nil {
		return e
	}
	snapshot, e := boundedRead(root, fmt.Sprintf("metadata/%d.snapshot.json", ts.Signed.Meta["snapshot.json"].Version), 2<<20)
	if e != nil {
		return e
	}
	snap, e := trusted.UpdateSnapshot(snapshot, false)
	if e != nil {
		return e
	}
	targetMeta, ok := snap.Signed.Meta["targets.json"]
	if !ok {
		return fmt.Errorf("recovery targets metadata missing")
	}
	targets, e := boundedRead(root, fmt.Sprintf("metadata/%d.targets.json", targetMeta.Version), 5<<20)
	if e != nil {
		return e
	}
	target, e := trusted.UpdateTargets(targets)
	if e != nil {
		return e
	}
	entry, ok := target.Signed.Targets["release.json"]
	if !ok {
		return fmt.Errorf("recovery release target missing")
	}
	if e = entry.VerifyLengthHashes(data); e != nil {
		return e
	}
	var m Manifest
	if e = decodeJSON(data, &m); e != nil {
		return e
	}
	if e = m.Validate(); e != nil {
		return e
	}
	if m.ReleaseID != s.ReleaseID || m.Sequence != s.Sequence {
		return fmt.Errorf("recovery release identity mismatch")
	}
	return verifyPayload(bundle, &m)
}

// The initial root hash must arrive through the operator's trusted channel, not
// from a text file beside an untrusted bundle. TUF handles root rotation and
// persisted version checks; this fetcher cannot make network requests.
func verifyBundle(bundle, rootPath, rootSHA, cache string) (*Manifest, error) {
	if !digest.MatchString(rootSHA) {
		return nil, fmt.Errorf("trusted root SHA-256 is required")
	}
	b, e := os.ReadFile(rootPath)
	if e != nil {
		return nil, e
	}
	hash := sha256.Sum256(b)
	if hex.EncodeToString(hash[:]) != rootSHA {
		return nil, fmt.Errorf("trusted root fingerprint mismatch")
	}
	br, e := os.OpenRoot(bundle)
	if e != nil {
		return nil, e
	}
	defer br.Close()
	cfg, e := config.New(metadataURL, b)
	if e != nil {
		return nil, e
	}
	cfg.Fetcher = localFetcher{br}
	cfg.LocalMetadataDir = cache
	cfg.LocalTargetsDir = filepath.Join(cache, "targets")
	cfg.MaxRootRotations = 32
	cfg.MaxDelegations = 0
	if e = cfg.EnsurePathsExist(); e != nil {
		return nil, e
	}
	client, e := updater.New(cfg)
	if e != nil {
		return nil, e
	}
	if e = client.Refresh(); e != nil {
		return nil, fmt.Errorf("release trust verification failed: %w", e)
	}
	target, e := client.GetTargetInfo("release.json")
	if e != nil {
		return nil, e
	}
	data, e := boundedRead(br, "release.json", 8<<20)
	if e != nil {
		return nil, e
	}
	if e = target.VerifyLengthHashes(data); e != nil {
		return nil, fmt.Errorf("release manifest integrity: %w", e)
	}
	var m Manifest
	if e = decodeJSON(data, &m); e != nil {
		return nil, e
	}
	if e = m.Validate(); e != nil {
		return nil, e
	}
	if e = verifyPayload(bundle, &m); e != nil {
		return nil, e
	}
	m.raw = append([]byte(nil), data...)
	m.trustedRoot = append([]byte(nil), b...)
	return &m, nil
}

func loadSigner(p string) (signature.Signer, error) {
	st, e := os.Lstat(p)
	if e != nil {
		return nil, e
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("signing key must be a private regular file (0600): %s", p)
	}
	b, e := os.ReadFile(p)
	if e != nil {
		return nil, e
	}
	block, rest := pem.Decode(b)
	if block == nil || len(rest) != 0 {
		return nil, fmt.Errorf("invalid private key PEM")
	}
	key, e := x509.ParsePKCS8PrivateKey(block.Bytes)
	if e != nil {
		return nil, e
	}
	private, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("only Ed25519 signing keys are supported")
	}
	return signature.LoadSigner(private, crypto.Hash(0))
}
func initTrust(dir string, now time.Time) error {
	if e := os.Mkdir(dir, 0700); e != nil {
		return fmt.Errorf("keys directory must not exist: %w", e)
	}
	root := metadata.Root(now.AddDate(1, 0, 0))
	root.Signed.Roles["root"].Threshold = 2
	for _, name := range []string{"root-1", "root-2", "targets", "snapshot", "timestamp"} {
		public, private, e := ed25519.GenerateKey(nil)
		if e != nil {
			return e
		}
		key, e := metadata.KeyFromPublicKey(public)
		if e != nil {
			return e
		}
		role := name
		if strings.HasPrefix(name, "root-") {
			role = "root"
		}
		if e = root.Signed.AddKey(key, role); e != nil {
			return e
		}
		der, e := x509.MarshalPKCS8PrivateKey(private)
		if e != nil {
			return e
		}
		if e = atomicWrite(filepath.Join(dir, name+".pem"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0600); e != nil {
			return e
		}
	}
	for _, name := range []string{"root-1", "root-2"} {
		s, e := loadSigner(filepath.Join(dir, name+".pem"))
		if e != nil {
			return e
		}
		if _, e = root.Sign(s); e != nil {
			return e
		}
	}
	data, e := root.ToBytes(true)
	if e != nil {
		return e
	}
	if e = atomicWrite(filepath.Join(dir, "root.json"), data, 0644); e != nil {
		return e
	}
	h := sha256.Sum256(data)
	return atomicWrite(filepath.Join(dir, "root.sha256"), []byte(hex.EncodeToString(h[:])+"\n"), 0644)
}
func metaInfo(version int64, b []byte) *metadata.MetaFiles {
	h := sha256.Sum256(b)
	return &metadata.MetaFiles{Version: version, Length: int64(len(b)), Hashes: metadata.Hashes{"sha256": h[:]}}
}

// Release signing never needs the root private keys. Metadata versions come
// from a monotonic operator/CI sequence, never from the application version.
func signBundle(bundle, keys string, version int64, expiry time.Time) error {
	return signBundleAt(bundle, keys, version, expiry, time.Now())
}
func signBundleAt(bundle, keys string, version int64, expiry, now time.Time) error {
	if version < 1 || !expiry.After(now) || expiry.After(now.Add(90*24*time.Hour)) {
		return fmt.Errorf("metadata requires a positive sequence and expiry within 90 days")
	}
	root, e := os.OpenRoot(bundle)
	if e != nil {
		return e
	}
	defer root.Close()
	b, e := boundedRead(root, "release.json", 8<<20)
	if e != nil {
		return e
	}
	var m Manifest
	if e = decodeJSON(b, &m); e != nil {
		return e
	}
	if e = m.Validate(); e != nil {
		return e
	}
	if e = verifyPayload(bundle, &m); e != nil {
		return e
	}
	targets := metadata.Targets(expiry)
	targets.Signed.Version = version
	h := sha256.Sum256(b)
	targets.Signed.Targets["release.json"] = &metadata.TargetFiles{Length: int64(len(b)), Hashes: metadata.Hashes{"sha256": h[:]}}
	s, e := loadSigner(filepath.Join(keys, "targets.pem"))
	if e != nil {
		return e
	}
	if _, e = targets.Sign(s); e != nil {
		return e
	}
	tb, e := targets.ToBytes(true)
	if e != nil {
		return e
	}
	snapshot := metadata.Snapshot(expiry)
	snapshot.Signed.Version = version
	snapshot.Signed.Meta["targets.json"] = metaInfo(version, tb)
	s, e = loadSigner(filepath.Join(keys, "snapshot.pem"))
	if e != nil {
		return e
	}
	if _, e = snapshot.Sign(s); e != nil {
		return e
	}
	sb, e := snapshot.ToBytes(true)
	if e != nil {
		return e
	}
	timestamp := metadata.Timestamp(expiry)
	timestamp.Signed.Version = version
	timestamp.Signed.Meta["snapshot.json"] = metaInfo(version, sb)
	s, e = loadSigner(filepath.Join(keys, "timestamp.pem"))
	if e != nil {
		return e
	}
	if _, e = timestamp.Sign(s); e != nil {
		return e
	}
	tsb, e := timestamp.ToBytes(true)
	if e != nil {
		return e
	}
	for name, data := range map[string][]byte{strconv.FormatInt(version, 10) + ".targets.json": tb, strconv.FormatInt(version, 10) + ".snapshot.json": sb, "timestamp.json": tsb} {
		if e = atomicWrite(filepath.Join(bundle, "metadata", name), data, 0644); e != nil {
			return e
		}
	}
	// A rotated release carries every intermediate root. The updater verifies
	// each old-and-new threshold; the bundle cannot replace the initial pin.
	if _, err := os.Stat(filepath.Join(keys, "roots")); err == nil {
		entries, err := os.ReadDir(filepath.Join(keys, "roots"))
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if entry.IsDir() || !regexp.MustCompile(`^[1-9][0-9]*\.root\.json$`).MatchString(entry.Name()) {
				return fmt.Errorf("invalid root chain entry")
			}
			data, err := os.ReadFile(filepath.Join(keys, "roots", entry.Name()))
			if err != nil {
				return err
			}
			if err = atomicWrite(filepath.Join(bundle, "metadata", entry.Name()), data, 0644); err != nil {
				return err
			}
		}
	}
	return nil
}

func rotateTrust(previousRoot string, oldRootKeys []string, newKeys string) error {
	if len(oldRootKeys) != 2 {
		return fmt.Errorf("this root ceremony requires both existing root key files")
	}
	b, e := os.ReadFile(previousRoot)
	if e != nil {
		return e
	}
	previous, e := metadata.Root().FromBytes(b)
	if e != nil {
		return e
	}
	if e = previous.VerifyDelegate("root", previous); e != nil {
		return e
	}
	b, e = os.ReadFile(filepath.Join(newKeys, "root.json"))
	if e != nil {
		return e
	}
	next, e := metadata.Root().FromBytes(b)
	if e != nil {
		return e
	}
	if next.Signed.Version != 1 || len(next.Signed.Roles["root"].KeyIDs) != 2 || next.Signed.Roles["root"].Threshold != 2 {
		return fmt.Errorf("new keys must come from a fresh two-key root ceremony")
	}
	next.Signed.Version = previous.Signed.Version + 1
	next.Signatures = nil
	for _, p := range append(oldRootKeys, filepath.Join(newKeys, "root-1.pem"), filepath.Join(newKeys, "root-2.pem")) {
		signer, e := loadSigner(p)
		if e != nil {
			return e
		}
		if _, e = next.Sign(signer); e != nil {
			return e
		}
	}
	if e = previous.VerifyDelegate("root", next); e != nil {
		return e
	}
	if e = next.VerifyDelegate("root", next); e != nil {
		return e
	}
	data, e := next.ToBytes(true)
	if e != nil {
		return e
	}
	chain := filepath.Join(newKeys, "roots")
	if e = os.MkdirAll(chain, 0700); e != nil {
		return e
	}
	// Preserve the existing public chain from the previous root's directory.
	oldChain := filepath.Join(filepath.Dir(previousRoot), "roots")
	if _, e = os.Stat(oldChain); e == nil {
		if e = cloneCache(oldChain, chain); e != nil {
			return e
		}
	}
	if e = atomicWrite(filepath.Join(chain, fmt.Sprintf("%d.root.json", next.Signed.Version)), data, 0644); e != nil {
		return e
	}
	if e = atomicWrite(filepath.Join(newKeys, "root.json"), data, 0644); e != nil {
		return e
	}
	return atomicWrite(filepath.Join(newKeys, "root.sha256"), []byte(fingerprint(data)+"\n"), 0644)
}
func cloneCache(src, dst string) error {
	if e := os.MkdirAll(dst, 0700); e != nil {
		return e
	}
	if _, e := os.Stat(src); os.IsNotExist(e) {
		return nil
	}
	root, e := os.OpenRoot(src)
	if e != nil {
		return e
	}
	defer root.Close()
	return fs.WalkDir(root.FS(), ".", func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(dst, p), 0700)
		}
		b, e := boundedRead(root, p, 8<<20)
		if e != nil {
			return e
		}
		return atomicWrite(filepath.Join(dst, p), b, 0600)
	})
}
