// SPDX-License-Identifier: Apache-2.0
package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const mailboxBrokerSecret = "mailbox_broker_token"

// This is an additive internal-service credential, not a replacement for any
// provider, session or data-encryption key. Existing values are never rotated
// automatically. Public lifecycle operations hold the private host-root lock.
func (c Controller) ensureMailboxBrokerSecret(s Installation) error {
	if e := validateOptionalServices(s.Profile, s.OptionalServices); e != nil {
		return e
	}
	if s.Profile != "connected" {
		return nil
	}
	rootInfo, e := os.Lstat(c.Root)
	if e != nil {
		return e
	}
	if e = privateBrokerDirectory(rootInfo); e != nil {
		return e
	}
	root, e := os.OpenRoot(c.Root)
	if e != nil {
		return e
	}
	defer root.Close()
	for _, name := range []string{"data", "data/secrets"} {
		e = root.Mkdir(name, 0700)
		created := e == nil
		if e != nil && !os.IsExist(e) {
			return e
		}
		info, err := root.Lstat(name)
		if err != nil {
			return err
		}
		if err = privateBrokerDirectory(info); err != nil {
			return err
		}
		if created {
			if err = syncDirectory(filepath.Dir(filepath.Join(c.Root, name))); err != nil {
				return err
			}
		}
	}
	name := "data/secrets/" + mailboxBrokerSecret
	if e = verifyMailboxBrokerSecret(root, name); e == nil {
		return nil
	} else if !os.IsNotExist(e) {
		return e
	}
	var entropy [32]byte
	if _, e = rand.Read(entropy[:]); e != nil {
		return e
	}
	directory := filepath.Join(c.Root, "data", "secrets")
	file, e := os.CreateTemp(directory, ".mailbox-broker-*.pending")
	if e != nil {
		return e
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, e = file.WriteString(hex.EncodeToString(entropy[:]) + "\n"); e != nil {
		return e
	}
	if e = file.Chmod(0444); e != nil {
		return e
	}
	if e = file.Sync(); e != nil {
		return e
	}
	if e = file.Close(); e != nil {
		return e
	}
	parent, e := os.Open(directory)
	if e != nil {
		return e
	}
	defer parent.Close()
	// Reuse the atomic no-replace primitive: even a concurrent publication must
	// never overwrite an existing credential or leave a partially written key.
	if e = mediaPublishNoReplace(parent, filepath.Base(file.Name()), mailboxBrokerSecret); e != nil && !os.IsExist(e) {
		return e
	}
	if e = parent.Sync(); e != nil {
		return e
	}
	return verifyMailboxBrokerSecret(root, name)
}

func privateBrokerDirectory(info os.FileInfo) error {
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0700 ||
		info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 || !ok || owner.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("mailbox broker secret requires a private, owned directory: %s (mode %04o)", info.Name(), info.Mode().Perm())
	}
	return nil
}

func verifyMailboxBrokerSecret(root *os.Root, name string) error {
	file, e := openRegular(root, name)
	if e != nil {
		return e
	}
	defer file.Close()
	info, e := file.Stat()
	if e != nil {
		return e
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if info.Size() < 64 || info.Size() > 65 || info.Mode().Perm() != 0444 ||
		info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 || !ok || owner.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("existing mailbox broker credential is invalid; never regenerate it automatically")
	}
	value, e := io.ReadAll(io.LimitReader(file, 66))
	if e != nil {
		return e
	}
	decoded, e := hex.DecodeString(strings.TrimSuffix(string(value), "\n"))
	if e != nil || len(decoded) != 32 {
		return fmt.Errorf("existing mailbox broker credential is invalid; never regenerate it automatically")
	}
	return nil
}
