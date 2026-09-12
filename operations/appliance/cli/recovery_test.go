// SPDX-License-Identifier: Apache-2.0
package main

import (
	"archive/tar"
	"encoding/json"
	"filippo.io/age"
	"os"
	"path/filepath"
	"testing"
)

func encryptedFixture(t *testing.T, alter func(*BackupInventory, []*tar.Header)) (input, identity string) {
	t.Helper()
	dir := t.TempDir()
	identity = filepath.Join(dir, "identity")
	if e := recoveryKey(identity); e != nil {
		t.Fatal(e)
	}
	ids, e := readIdentities(identity)
	if e != nil {
		t.Fatal(e)
	}
	recipient := ids[0].(*age.X25519Identity).Recipient()
	inv := BackupInventory{Format: 1, DatabaseSchema: 16}
	content := []string{"encrypted database fixture", "{}"}
	names := []string{"database.age", "installation.json"}
	var headers []*tar.Header
	for i, p := range names {
		headers = append(headers, &tar.Header{Name: p, Typeflag: tar.TypeReg, Mode: 0600, Size: int64(len(content[i]))})
		inv.Entries = append(inv.Entries, FileEntry{Path: p, SHA256: fingerprint([]byte(content[i])), Size: int64(len(content[i])), Mode: 0600})
	}
	if alter != nil {
		alter(&inv, headers)
	}
	input = filepath.Join(dir, "backup.age")
	f, e := os.Create(input)
	if e != nil {
		t.Fatal(e)
	}
	w, e := age.Encrypt(f, recipient)
	if e != nil {
		t.Fatal(e)
	}
	tw := tar.NewWriter(w)
	for i, h := range headers {
		if e = tw.WriteHeader(h); e != nil {
			t.Fatal(e)
		}
		if h.Typeflag == tar.TypeReg {
			if _, e = tw.Write([]byte(content[i])); e != nil {
				t.Fatal(e)
			}
		}
	}
	b, e := json.Marshal(inv)
	if e != nil {
		t.Fatal(e)
	}
	if e = tw.WriteHeader(&tar.Header{Name: "backup-inventory.json", Typeflag: tar.TypeReg, Mode: 0600, Size: int64(len(b))}); e != nil {
		t.Fatal(e)
	}
	tw.Write(b)
	if e = tw.Close(); e != nil {
		t.Fatal(e)
	}
	if e = w.Close(); e != nil {
		t.Fatal(e)
	}
	f.Close()
	return input, identity
}
func TestRecoveryAuthenticatedRoundTrip(t *testing.T) {
	input, key := encryptedFixture(t, nil)
	dest := filepath.Join(t.TempDir(), "recovery")
	inv, e := unpackBackup(input, key, dest, 1<<20, fixtureSHA(t, input))
	if e != nil {
		t.Fatal(e)
	}
	if len(inv.Entries) != 2 {
		t.Fatal("missing entries")
	}
	st, e := os.Stat(dest)
	if e != nil || st.Mode().Perm() != 0700 {
		t.Fatal("recovery directory must be private")
	}
}
func TestRecoveryRejectsTraversalLinksDuplicatesAndCorruption(t *testing.T) {
	cases := map[string]func(*BackupInventory, []*tar.Header){"traversal": func(_ *BackupInventory, h []*tar.Header) { h[0].Name = "../escape" }, "absolute": func(_ *BackupInventory, h []*tar.Header) { h[0].Name = "/etc/escape" }, "symlink": func(_ *BackupInventory, h []*tar.Header) {
		h[0].Typeflag = tar.TypeSymlink
		h[0].Linkname = "/tmp/escape"
		h[0].Size = 0
	}, "duplicate": func(_ *BackupInventory, h []*tar.Header) { h[1].Name = h[0].Name }, "hash mismatch": func(inv *BackupInventory, _ []*tar.Header) { inv.Entries[0].SHA256 = fingerprint([]byte("tamper")) }, "missing inventory": func(inv *BackupInventory, _ []*tar.Header) { inv.Entries = inv.Entries[:1] }}
	for name, alter := range cases {
		t.Run(name, func(t *testing.T) {
			input, key := encryptedFixture(t, alter)
			if _, e := unpackBackup(input, key, filepath.Join(t.TempDir(), "recovery"), 1<<20, fixtureSHA(t, input)); e == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
}
func TestRecoveryRejectsWrongKeyTruncationAndExistingDestination(t *testing.T) {
	input, key := encryptedFixture(t, nil)
	wrong := filepath.Join(t.TempDir(), "wrong")
	recoveryKey(wrong)
	if _, e := unpackBackup(input, wrong, filepath.Join(t.TempDir(), "wrong-key"), 1<<20, fixtureSHA(t, input)); e == nil {
		t.Fatal("wrong key accepted")
	}
	if _, e := unpackBackup(input, key, t.TempDir(), 1<<20, fixtureSHA(t, input)); e == nil {
		t.Fatal("existing destination accepted")
	}
	if _, e := unpackBackup(input, key, filepath.Join(t.TempDir(), "bounded"), 4, fixtureSHA(t, input)); e == nil {
		t.Fatal("size bound ignored")
	}
	b, e := os.ReadFile(input)
	if e != nil {
		t.Fatal(e)
	}
	os.WriteFile(input, b[:len(b)-8], 0600)
	if _, e := unpackBackup(input, key, filepath.Join(t.TempDir(), "truncated"), 1<<20, fixtureSHA(t, input)); e == nil {
		t.Fatal("truncated ciphertext accepted")
	}
}
func TestBackupRefusesRecursiveDestination(t *testing.T) {
	root := t.TempDir()
	if e := backupPath(root, filepath.Join(root, "backup.age")); e == nil {
		t.Fatal("recursive backup accepted")
	}
}
func TestUpdateBackupRequiresArtifactAndPinnedReceipt(t *testing.T) {
	p := filepath.Join(t.TempDir(), "backup.age")
	data := []byte("synthetic encrypted artifact")
	os.WriteFile(p, data, 0600)
	receipt := BackupReceipt{Format: 1, Status: "verified-export", Path: p, SHA256: fingerprint(data), Size: int64(len(data)), ReleaseID: "1.0.0", SchemaVersion: 16}
	if e := writeJSON(p+".receipt.json", receipt); e != nil {
		t.Fatal(e)
	}
	if e := verifyBackupReceipt(p, receipt.SHA256, receipt.Size, receipt.ReleaseID); e != nil {
		t.Fatal(e)
	}
	os.WriteFile(p, []byte("corrupted"), 0600)
	if e := verifyBackupReceipt(p, receipt.SHA256, receipt.Size, receipt.ReleaseID); e == nil {
		t.Fatal("receipt concealed a damaged backup")
	}
	os.Remove(p)
	if e := verifyBackupReceipt(p, receipt.SHA256, receipt.Size, receipt.ReleaseID); e == nil {
		t.Fatal("receipt concealed a missing backup")
	}
	if e := verifyBackupReceipt(p, "", 0, receipt.ReleaseID); e == nil {
		t.Fatal("unbound receipt accepted")
	}
}

func fixtureSHA(t *testing.T, p string) string {
	t.Helper()
	b, e := os.ReadFile(p)
	if e != nil {
		t.Fatal(e)
	}
	return fingerprint(b)
}
