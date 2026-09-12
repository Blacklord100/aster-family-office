// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMailboxBrokerCredentialIsAdditiveAndNeverRotatedByConfiguration(t *testing.T) {
	c, s, _ := protocolReviewFixture(t, "")
	if e := c.ensureMailboxBrokerSecret(s); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(filepath.Join(c.Root, "data")); !os.IsNotExist(e) {
		t.Fatal("offline provisioning must not create a broker credential")
	}
	s.Profile = "connected"
	m, e := c.manifest(s)
	if e != nil {
		t.Fatal(e)
	}
	if e = c.writeEnv(s, m); e != nil {
		t.Fatal(e)
	}
	keyPath := filepath.Join(c.Root, "data/secrets", mailboxBrokerSecret)
	key, e := os.ReadFile(keyPath)
	if e != nil || len(key) != 65 {
		t.Fatal("dedicated random 32-byte broker credential was not created")
	}
	other := filepath.Join(c.Root, "data/secrets/encryption_key")
	existing := []byte("SYNTHETIC existing data key; this test must not change it\n")
	if e = os.WriteFile(other, existing, 0400); e != nil {
		t.Fatal(e)
	}
	for _, selection := range [][]string{nil, {"delivery"}, {"mailbox"}, {"mailbox", "delivery"}} {
		s.OptionalServices = selection
		if e = c.writeEnv(s, m); e != nil {
			t.Fatal(e)
		}
		after, e := os.ReadFile(keyPath)
		if e != nil || !bytes.Equal(key, after) {
			t.Fatal("configuration rewrote the existing broker credential")
		}
		old, e := os.ReadFile(other)
		if e != nil || !bytes.Equal(existing, old) {
			t.Fatal("additive provisioning changed an unrelated key")
		}
		env, e := os.ReadFile(filepath.Join(c.Root, "config", s.ReleaseID+".env"))
		transport := "disabled"
		if s.hasOptionalService("mailbox") {
			transport = "broker"
		}
		if e != nil || !strings.Contains(string(env), "MAILBOX_OAUTH_TRANSPORT='"+transport+"'\n") ||
			strings.Contains(string(env), strings.TrimSpace(string(key))) {
			t.Fatal("generated transport must preserve explicit selection without embedding the credential")
		}
	}
	entries, e := os.ReadDir(filepath.Dir(keyPath))
	if e != nil || len(entries) != 2 {
		t.Fatal("provisioning left unexpected temporary credentials")
	}
}

func TestMailboxBrokerExistingInvalidCredentialsAreNotReplaced(t *testing.T) {
	for _, invalid := range []struct {
		name string
		data string
		mode os.FileMode
	}{{"empty", "", 0444}, {"truncated", "SYNTHETIC", 0444},
		{"not-hex", strings.Repeat("g", 64), 0444},
		{"unreadable-to-service", strings.Repeat("a", 64), 0600},
		{"writable", strings.Repeat("a", 64), 0666}} {
		t.Run(invalid.name, func(t *testing.T) {
			c, s, _ := protocolReviewFixture(t, "")
			s.Profile = "connected"
			path := filepath.Join(c.Root, "data/secrets", mailboxBrokerSecret)
			if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
				t.Fatal(e)
			}
			if e := os.WriteFile(path, []byte(invalid.data), invalid.mode); e != nil {
				t.Fatal(e)
			}
			before, _ := os.Stat(path)
			if e := c.ensureMailboxBrokerSecret(s); e == nil {
				t.Fatal("invalid existing credential was accepted")
			}
			after, e := os.ReadFile(path)
			info, _ := os.Stat(path)
			if e != nil || string(after) != invalid.data || info.Mode() != before.Mode() {
				t.Fatal("refusal altered the existing credential")
			}
		})
	}
}

func TestMailboxBrokerCredentialRejectsLinkedOrNonprivatePaths(t *testing.T) {
	for _, kind := range []string{"directory-link", "credential-link", "credential-hardlink", "public-directory"} {
		t.Run(kind, func(t *testing.T) {
			c, s, _ := protocolReviewFixture(t, "")
			s.Profile = "connected"
			outside := t.TempDir()
			foreign := filepath.Join(outside, "SYNTHETIC-foreign-key")
			value := strings.Repeat("b", 64) + "\n"
			if e := os.WriteFile(foreign, []byte(value), 0444); e != nil {
				t.Fatal(e)
			}
			path := filepath.Join(c.Root, "data/secrets", mailboxBrokerSecret)
			if kind == "directory-link" {
				if e := os.Symlink(outside, filepath.Join(c.Root, "data")); e != nil {
					t.Fatal(e)
				}
			} else {
				if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
					t.Fatal(e)
				}
				switch kind {
				case "credential-link":
					if e := os.Symlink(foreign, path); e != nil {
						t.Fatal(e)
					}
				case "credential-hardlink":
					if e := os.Link(foreign, path); e != nil {
						t.Fatal(e)
					}
				case "public-directory":
					if e := os.Chmod(filepath.Dir(path), 0755); e != nil {
						t.Fatal(e)
					}
				}
			}
			if e := c.ensureMailboxBrokerSecret(s); e == nil {
				t.Fatal("unsafe broker credential path was accepted")
			}
			after, e := os.ReadFile(foreign)
			if e != nil || string(after) != value {
				t.Fatal("refused path changed an unrelated file")
			}
			if _, e := os.Stat(filepath.Join(outside, "secrets")); !os.IsNotExist(e) {
				t.Fatal("refusal created a directory outside the installation")
			}
		})
	}
}

type brokerCredentialCommander struct {
	t       *testing.T
	root    string
	next    Commander
	checked bool
}

func (c *brokerCredentialCommander) Run(ctx context.Context, in io.Reader, out io.Writer, name string, args ...string) ([]byte, error) {
	if name == "docker" && len(args) > 0 && args[0] == "compose" {
		root, e := os.OpenRoot(c.root)
		if e != nil {
			c.t.Fatal(e)
		}
		e = verifyMailboxBrokerSecret(root, "data/secrets/"+mailboxBrokerSecret)
		root.Close()
		if e != nil {
			c.t.Fatal("runtime was invoked before additive broker credential provisioning", e)
		}
		c.checked = true
	}
	return c.next.Run(ctx, in, out, name, args...)
}

func TestMailboxBrokerLegacyUpdateProvisionsBeforeItsFirstComposeCommand(t *testing.T) {
	c, _, fake := optionalUpdateFixture(t, true)
	// Model a previously written candidate environment from a controller that
	// did not know this new dedicated credential. Only this synthetic key is removed.
	if e := os.Remove(filepath.Join(c.Root, "data/secrets", mailboxBrokerSecret)); e != nil {
		t.Fatal(e)
	}
	commands := &brokerCredentialCommander{t: t, root: c.Root, next: fake}
	c.Commands = commands
	e := c.updateOperation(context.Background(), "", "", true)
	if e == nil || !strings.Contains(e.Error(), "synthetic candidate qualification boundary") || !commands.checked {
		t.Fatalf("legacy update did not provision before its actual continuation boundary: %v", e)
	}
}
