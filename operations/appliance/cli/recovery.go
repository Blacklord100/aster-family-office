// SPDX-License-Identifier: Apache-2.0
package main

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"filippo.io/age"
)

type BackupInventory struct {
	Format         int          `json:"format"`
	CreatedAt      string       `json:"createdAt"`
	Installation   Installation `json:"installation"`
	DatabaseSchema int          `json:"databaseSchema"`
	Entries        []FileEntry  `json:"entries"`
}
type BackupReceipt struct {
	Format        int    `json:"format"`
	Status        string `json:"status"`
	Path          string `json:"path"`
	SHA256        string `json:"sha256"`
	Size          int64  `json:"size"`
	CreatedAt     string `json:"createdAt"`
	ReleaseID     string `json:"releaseId"`
	SchemaVersion int    `json:"schemaVersion"`
	RestoreTested bool   `json:"restoreTested"`
}

func verifyBackupReceipt(p, expectedHash string, expectedSize int64, release string) error {
	if !digest.MatchString(expectedHash) || expectedSize <= 0 {
		return fmt.Errorf("backup journal has no trusted artifact identity")
	}
	b, e := os.ReadFile(p + ".receipt.json")
	if e != nil {
		return e
	}
	var receipt BackupReceipt
	if e = decodeJSON(b, &receipt); e != nil {
		return e
	}
	if receipt.Format != 1 || receipt.Status != "verified-export" || receipt.Path != p || receipt.SHA256 != expectedHash || receipt.Size != expectedSize || receipt.ReleaseID != release || receipt.SchemaVersion < 1 {
		return fmt.Errorf("backup receipt differs from update journal")
	}
	return verifyArtifact(p, expectedHash, expectedSize)
}
func verifyArtifact(p, expectedHash string, expectedSize int64) error {
	if !digest.MatchString(expectedHash) {
		return fmt.Errorf("independently trusted backup SHA-256 is required")
	}
	st, e := os.Lstat(p)
	if e != nil {
		return e
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("backup must be a regular file")
	}
	f, e := os.Open(p)
	if e != nil {
		return e
	}
	defer f.Close()
	sum, n, e := fileHash(f)
	if e != nil {
		return e
	}
	if sum != expectedHash || (expectedSize > 0 && n != expectedSize) {
		return fmt.Errorf("encrypted backup integrity failed")
	}
	return nil
}

func recoveryKey(output string) error {
	key, e := age.GenerateX25519Identity()
	if e != nil {
		return e
	}
	f, e := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	_, e = fmt.Fprintf(f, "# Aster recovery identity. Keep offline, separate from the server and backups.\n# public recipient: %s\n%s\n", key.Recipient(), key)
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	return ce
}
func publicRecoveryRecipient(identity string) (string, error) {
	ids, e := readIdentities(identity)
	if e != nil {
		return "", e
	}
	if len(ids) != 1 {
		return "", fmt.Errorf("expected one recovery identity")
	}
	key, ok := ids[0].(*age.X25519Identity)
	if !ok {
		return "", fmt.Errorf("expected an age X25519 recovery identity")
	}
	return key.Recipient().String(), nil
}
func backupPath(root, output string) error {
	if !filepath.IsAbs(output) || strings.ContainsAny(output, "\r\n") {
		return fmt.Errorf("backup output must be an absolute path")
	}
	parent, e := filepath.EvalSymlinks(filepath.Dir(output))
	if e != nil {
		return e
	}
	canonicalRoot, e := filepath.EvalSymlinks(root)
	if e != nil {
		return e
	}
	rel, e := filepath.Rel(canonicalRoot, parent)
	if e != nil {
		return e
	}
	if rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..") {
		return fmt.Errorf("backup must be outside the installation root")
	}
	if _, e = os.Lstat(output); !os.IsNotExist(e) {
		return fmt.Errorf("backup output already exists or cannot be inspected")
	}
	return nil
}
func (c Controller) backupSealed(ctx context.Context, s Installation, output string, state Lifecycle) error {
	if state.Mode != "maintenance" || state.ActiveOperations != 0 || state.ActiveLeases.Total != 0 {
		return fmt.Errorf("backup requires a sealed installation with no active writers")
	}
	if e := backupPath(c.Root, output); e != nil {
		return e
	}
	// Freeze the remaining filesystem writers. The DB barrier has already
	// drained application workers; Caddy can otherwise renew certificate files
	// and Ollama can update its local cache independently of database writes.
	if _, e := c.compose(ctx, s, nil, nil, "stop", "--timeout", "90", "caddy", "ollama"); e != nil {
		return e
	}
	recipient, e := age.ParseX25519Recipient(s.RecoveryRecipient)
	if e != nil {
		return e
	}
	temp, e := os.MkdirTemp(filepath.Dir(output), ".aster-backup-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(temp)
	// pg_dump streams directly into age; database plaintext is never staged on disk.
	dbPath := filepath.Join(temp, "database.age")
	db, e := os.OpenFile(dbPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	enc, e := age.Encrypt(db, recipient)
	if e != nil {
		db.Close()
		return e
	}
	_, e = c.compose(ctx, s, nil, enc, "exec", "-T", "--user", "postgres", "postgres", "pg_dump", "--format=custom", "--no-owner", "--no-acl", "--username=postgres", "--dbname=aster")
	if e == nil {
		e = enc.Close()
	}
	if e == nil {
		e = db.Sync()
	}
	db.Close()
	if e != nil {
		return fmt.Errorf("encrypted database export failed: %w", e)
	}
	inv := BackupInventory{Format: 1, CreatedAt: time.Now().UTC().Format(time.RFC3339), Installation: s, DatabaseSchema: state.SchemaVersion}
	pending := filepath.Join(temp, "backup.age")
	file, e := os.OpenFile(pending, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	outer, e := age.Encrypt(file, recipient)
	if e != nil {
		file.Close()
		return e
	}
	tw := tar.NewWriter(outer)
	add := func(root *os.Root, source, name string) error {
		f, e := openRegular(root, source)
		if e != nil {
			return e
		}
		defer f.Close()
		st, e := f.Stat()
		if e != nil {
			return e
		}
		h, e := tar.FileInfoHeader(st, "")
		if e != nil {
			return e
		}
		h.Name = name
		h.Uname = ""
		h.Gname = ""
		h.Mode = int64(st.Mode().Perm() & 0777)
		if e = tw.WriteHeader(h); e != nil {
			return e
		}
		hash := sha256.New()
		n, e := io.Copy(io.MultiWriter(tw, hash), io.LimitReader(f, st.Size()+1))
		if e != nil {
			return e
		}
		if n != st.Size() {
			return fmt.Errorf("backup source changed: %s", name)
		}
		inv.Entries = append(inv.Entries, FileEntry{Path: name, SHA256: hex.EncodeToString(hash.Sum(nil)), Size: n, Mode: uint32(h.Mode)})
		return nil
	}
	tr, e := os.OpenRoot(temp)
	if e != nil {
		file.Close()
		return e
	}
	e = add(tr, "database.age", "database.age")
	tr.Close()
	source, e2 := os.OpenRoot(c.Root)
	if e == nil {
		e = e2
	}
	if e != nil {
		file.Close()
		return e
	}
	defer source.Close()
	paths := []string{"installation.json", "config", "trust", "releases/" + s.ReleaseID, "data/archive", "data/intake", "data/secrets", "data/caddy", "data/ollama", "data/receipts"}
	for _, base := range paths {
		if e != nil {
			break
		}
		e = fs.WalkDir(source.FS(), base, func(p string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if d.IsDir() {
				return nil
			}
			return add(source, p, p)
		})
	}
	if e == nil {
		b, err := json.Marshal(inv)
		e = err
		if e == nil {
			e = tw.WriteHeader(&tar.Header{Name: "backup-inventory.json", Mode: 0600, Size: int64(len(b)), Typeflag: tar.TypeReg})
		}
		if e == nil {
			_, e = tw.Write(b)
		}
	}
	if e == nil {
		e = tw.Close()
	}
	if e == nil {
		e = outer.Close()
	}
	if e == nil {
		e = file.Sync()
	}
	file.Close()
	if e != nil {
		return e
	}
	// Recheck the DB barrier before committing the coordinated artifact.
	final, e := c.lifecycle(ctx, s, "status")
	if e != nil {
		return e
	}
	if final.Mode != "maintenance" || final.Generation != state.Generation || final.ActiveRelease != state.ActiveRelease {
		return fmt.Errorf("maintenance state changed during backup")
	}
	if e = os.Link(pending, output); e != nil {
		return e
	}
	dir, e := os.Open(filepath.Dir(output))
	if e != nil {
		return e
	}
	e = dir.Sync()
	dir.Close()
	if e != nil {
		return e
	}
	f, e := os.Open(output)
	if e != nil {
		return e
	}
	sum, size, e := fileHash(f)
	f.Close()
	if e != nil {
		return e
	}
	receipt := map[string]any{"format": 1, "status": "verified-export", "path": output, "sha256": sum, "size": size, "createdAt": inv.CreatedAt, "releaseId": s.ReleaseID, "schemaVersion": state.SchemaVersion, "restoreTested": false}
	if e = writeJSON(output+".receipt.json", receipt); e != nil {
		return e
	}
	internal := map[string]any{"result": "passed", "kind": "coordinated_encrypted_backup", "at": inv.CreatedAt, "sha256": sum, "releaseId": s.ReleaseID, "schemaVersion": state.SchemaVersion, "restoreTested": false}
	p := filepath.Join(c.Root, "data", "receipts", "backup.json")
	if e = writeJSON(p, internal); e != nil {
		return e
	}
	return os.Chmod(p, 0444)
}
func (c Controller) Backup(ctx context.Context, output string) error {
	unlock, e := c.lock()
	if e != nil {
		return e
	}
	defer unlock()
	s, e := c.load()
	if e != nil {
		return e
	}
	if e = backupPath(c.Root, output); e != nil {
		return e
	}
	if e = c.requireFinished(); e != nil {
		return e
	}
	j := Journal{Operation: "backup", ID: id(), Previous: &s, Backup: output}
	state, e := c.seal(ctx, s, &j)
	if e != nil {
		return e
	}
	if e = c.backupSealed(ctx, s, output, state); e != nil {
		return e
	}
	if _, e = c.compose(ctx, s, nil, nil, "up", "-d", "--wait", "--wait-timeout", "300"); e != nil {
		return e
	}
	m, e := c.manifest(s)
	if e != nil {
		return e
	}
	if e = c.qualify(ctx, s, m); e != nil {
		return e
	}
	if e = c.journal(&j, "resume-intent"); e != nil {
		return e
	}
	if _, e = c.lifecycle(ctx, s, "resume", "--release", s.ReleaseID, "--expected-generation", strconv.Itoa(s.Generation)); e != nil {
		return e
	}
	return c.journal(&j, "complete")
}
func readIdentities(p string) ([]age.Identity, error) {
	st, e := os.Lstat(p)
	if e != nil {
		return nil, e
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 65536 {
		return nil, fmt.Errorf("recovery identity must be a private regular file (0600)")
	}
	f, e := os.Open(p)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	return age.ParseIdentities(f)
}

// Extraction is confined, bounded and authenticated. It never touches an
// existing installation. Nothing starts until the entire age stream and every
// inventory entry have been checked, including rejection of missing/extra files.
func unpackBackup(input, identity, dest string, maxBytes int64, expectedSHA string) (*BackupInventory, error) {
	if !digest.MatchString(expectedSHA) {
		return nil, fmt.Errorf("trusted ciphertext digest is required before extraction")
	}
	identities, e := readIdentities(identity)
	if e != nil {
		return nil, e
	}
	in, e := os.Open(input)
	if e != nil {
		return nil, e
	}
	defer in.Close()
	cipherHash := sha256.New()
	plain, e := age.Decrypt(io.TeeReader(in, cipherHash), identities...)
	if e != nil {
		return nil, e
	}
	if e = os.Mkdir(dest, 0700); e != nil {
		return nil, fmt.Errorf("recovery destination must not exist: %w", e)
	}
	root, e := os.OpenRoot(dest)
	if e != nil {
		return nil, e
	}
	defer root.Close()
	tr := tar.NewReader(plain)
	seen := map[string]FileEntry{}
	var total int64
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, e
		}
		if h.Typeflag != tar.TypeReg || !safePath(h.Name) || h.Size < 0 || h.Size > maxBytes || len(seen) >= 200000 || h.Mode&^0777 != 0 {
			return nil, fmt.Errorf("unsafe recovery archive entry")
		}
		if _, ok := seen[h.Name]; ok {
			return nil, fmt.Errorf("duplicate recovery entry")
		}
		total += h.Size
		if total > maxBytes {
			return nil, fmt.Errorf("recovery exceeds configured byte limit")
		}
		if e = root.MkdirAll(filepath.Dir(h.Name), 0700); e != nil {
			return nil, e
		}
		f, e := root.OpenFile(h.Name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return nil, e
		}
		hash := sha256.New()
		n, e := io.Copy(io.MultiWriter(f, hash), tr)
		if e == nil {
			e = f.Sync()
		}
		f.Close()
		if e != nil {
			return nil, e
		}
		if n != h.Size {
			return nil, io.ErrUnexpectedEOF
		}
		seen[h.Name] = FileEntry{Path: h.Name, SHA256: hex.EncodeToString(hash.Sum(nil)), Size: n, Mode: uint32(h.Mode)}
	}
	// tar EOF can precede the age authentication trailer. Consume and require only
	// tar's zero padding, bounded so appended payloads cannot be smuggled through.
	tail, e := io.ReadAll(io.LimitReader(plain, 1<<20))
	if e != nil {
		return nil, e
	}
	if len(tail) >= 1<<20 {
		return nil, fmt.Errorf("excess recovery trailer")
	}
	for _, b := range tail {
		if b != 0 {
			return nil, fmt.Errorf("unexpected recovery trailer")
		}
	}
	if hex.EncodeToString(cipherHash.Sum(nil)) != expectedSHA {
		return nil, fmt.Errorf("the ciphertext consumed during recovery differs from the trusted backup digest")
	}
	data, e := boundedRead(root, "backup-inventory.json", 32<<20)
	if e != nil {
		return nil, e
	}
	var inv BackupInventory
	if e = decodeJSON(data, &inv); e != nil {
		return nil, e
	}
	if inv.Format != 1 || inv.DatabaseSchema < 1 || len(inv.Entries)+1 != len(seen) {
		return nil, fmt.Errorf("recovery inventory mismatch")
	}
	checked := map[string]bool{}
	for _, entry := range inv.Entries {
		actual, ok := seen[entry.Path]
		if !ok || checked[entry.Path] || actual != entry {
			return nil, fmt.Errorf("recovery file integrity failed: %s", entry.Path)
		}
		checked[entry.Path] = true
	}
	if !checked["database.age"] || !checked["installation.json"] {
		return nil, fmt.Errorf("recovery is missing its database or configuration")
	}
	return &inv, nil
}
func (c Controller) Restore(ctx context.Context, input, identity, backupSHA, trustedRoot, trustedSHA string, maxBytes int64, fenced bool, installRuntime bool) error {
	if !fenced {
		return fmt.Errorf("recovery requires --source-fenced after isolating the old server; this prevents two hosts ingesting the same sources")
	}
	if e := platformPreflight(); e != nil {
		return e
	}
	if e := verifyArtifact(input, backupSHA, 0); e != nil {
		return e
	}
	rootBytes, e := os.ReadFile(trustedRoot)
	if e != nil {
		return e
	}
	if !digest.MatchString(trustedSHA) || fingerprint(rootBytes) != trustedSHA {
		return fmt.Errorf("independent recovery trust root mismatch")
	}
	if _, e := os.Lstat(c.Root); !os.IsNotExist(e) {
		return fmt.Errorf("restore destination must not exist")
	}
	if e := freeSpace(filepath.Dir(c.Root), uint64(maxBytes)); e != nil {
		return e
	}
	inv, e := unpackBackup(input, identity, c.Root, maxBytes, backupSHA)
	if e != nil {
		return e
	}
	unlock, e := c.lock()
	if e != nil {
		return e
	}
	defer unlock()
	s := inv.Installation
	s.Root = c.Root
	s.Project = "aster-recovery-" + id()[:8]
	if s.Format != 1 || !identifier.MatchString(s.ReleaseID) {
		return fmt.Errorf("invalid recovered installation")
	}
	if s.RootSHA != trustedSHA {
		return fmt.Errorf("recovery belongs to another publisher trust root")
	}
	m, e := c.manifest(s)
	if e != nil {
		return e
	}
	if m.Schema.Target != inv.DatabaseSchema {
		return fmt.Errorf("backup database and release schema do not match")
	}
	if e = verifyRecoveryRelease(c.release(s), rootBytes, s); e != nil {
		return e
	}
	if e = c.runtime(ctx, m, c.release(s), installRuntime); e != nil {
		return e
	}
	if e = c.loadImages(ctx, m, c.release(s)); e != nil {
		return e
	}
	if e = c.restorePermissions(inv); e != nil {
		return e
	}
	if e = c.writeEnv(s, m); e != nil {
		return e
	}
	backupInfo, e := os.Stat(input)
	if e != nil {
		return e
	}
	j := Journal{Operation: "restore", ID: id(), Candidate: &s, Backup: input, BackupSHA: backupSHA, BackupSize: backupInfo.Size()}
	if e = c.journal(&j, "restore-database"); e != nil {
		return e
	}
	if _, e = c.compose(ctx, s, nil, nil, "up", "-d", "--wait", "--wait-timeout", "180", "postgres"); e != nil {
		return e
	}
	identities, e := readIdentities(identity)
	if e != nil {
		return e
	}
	db, e := os.Open(filepath.Join(c.Root, "database.age"))
	if e != nil {
		return e
	}
	defer db.Close()
	plain, e := age.Decrypt(db, identities...)
	if e != nil {
		return e
	}
	if e = c.restoreDatabase(ctx, s, &j, plain); e != nil {
		return e
	}
	return c.finishRestore(ctx, &j, m)
}

func (c Controller) restorePermissions(inv *BackupInventory) error {
	for _, entry := range inv.Entries {
		p := filepath.Join(c.Root, entry.Path)
		mode := fs.FileMode(entry.Mode)
		uid := 0
		if strings.HasPrefix(entry.Path, "config/") || strings.HasPrefix(entry.Path, "trust/") {
			mode = 0600
		}
		if strings.HasPrefix(entry.Path, "data/secrets/") {
			mode = 0444
		}
		if strings.HasPrefix(entry.Path, "data/caddy/") {
			mode = 0600
		}
		switch {
		case strings.HasPrefix(entry.Path, "data/ollama/"), strings.HasPrefix(entry.Path, "data/caddy/"):
			uid = 10001
		case strings.HasPrefix(entry.Path, "data/archive/"), strings.HasPrefix(entry.Path, "data/intake/"), strings.HasPrefix(entry.Path, "data/receipts/"):
			uid = 1000
		}
		if e := os.Chmod(p, mode); e != nil {
			return e
		}
		if e := os.Chown(p, uid, uid); e != nil {
			return e
		}
	}
	// Parent directories are not tar entries. Restore service ownership as well.
	for name, uid := range map[string]int{"postgres": 999, "archive": 1000, "intake": 1000, "ollama": 10001, "caddy/data": 10001, "caddy/config": 10001, "caddy/tls": 10001, "receipts": 1000, "health": 1000, "secrets": 0} {
		p := filepath.Join(c.Root, "data", name)
		if e := os.MkdirAll(p, 0700); e != nil {
			return e
		}
		if e := filepath.WalkDir(p, func(path string, d fs.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if d.IsDir() {
				return os.Chown(path, uid, uid)
			}
			return nil
		}); e != nil {
			return e
		}
	}
	return nil
}
func (c Controller) requireFinished() error {
	b, e := os.ReadFile(filepath.Join(c.Root, "journal.json"))
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	var j Journal
	if e = decodeJSON(b, &j); e != nil {
		return e
	}
	if j.Phase != "complete" {
		return fmt.Errorf("unfinished %s operation at %s; inspect status and use the matching continue-install, continue-update, or continue-restore command", j.Operation, j.Phase)
	}
	return nil
}
