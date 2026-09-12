// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"
)

const accountPasswd = "aster-ingress:x:10001:10001:Aster ingress relay:/nonexistent:/usr/sbin/nologin"
const accountGroup = "aster-ingress:x:10001:"
const accountShadow = "aster-ingress:!*:20000::::::"
const accountGshadow = "aster-ingress:!*::"

type ingressAccountAnswer struct {
	value string
	found bool
	err   error
}

type ingressAccountFixture struct {
	users, groups   []string
	shadow, gshadow string
	overrides       map[string]ingressAccountAnswer
	mutations       int
	mutate          func(*ingressAccountFixture) error
}

func newIngressAccountFixture(user, group bool) *ingressAccountFixture {
	f := &ingressAccountFixture{users: []string{"root:x:0:0:root:/root:/bin/bash"},
		groups: []string{"root:x:0:"}, overrides: map[string]ingressAccountAnswer{}}
	if group {
		f.groups = append(f.groups, accountGroup)
		f.gshadow = accountGshadow
	}
	if user {
		f.users = append(f.users, accountPasswd)
		f.shadow = accountShadow
	}
	return f
}

func (f *ingressAccountFixture) lookup(ctx context.Context, local bool, database, key string) (string, bool, error) {
	if err := ctx.Err(); err != nil {
		return "", false, err
	}
	if answer, ok := f.overrides[fmt.Sprintf("%t/%s/%s", local, database, key)]; ok {
		return answer.value, answer.found, answer.err
	}
	switch database {
	case "shadow":
		return f.shadow, f.shadow != "", nil
	case "gshadow":
		return f.gshadow, f.gshadow != "", nil
	case "initgroups":
		return ingressAccountName + " 10001 10001", true, nil
	}
	rows := f.users
	if database == "group" {
		rows = f.groups
	}
	if key == "" {
		return strings.Join(rows, "\n"), true, nil
	}
	for _, row := range rows {
		parts := strings.Split(row, ":")
		if parts[0] == key || parts[2] == key {
			return row, true, nil
		}
	}
	return "", false, nil
}

func (f *ingressAccountFixture) Run(_ context.Context, in io.Reader, out io.Writer, name string, args ...string) ([]byte, error) {
	if name != "systemd-sysusers" || !reflect.DeepEqual(args, []string{"-"}) || in == nil || out != nil {
		return nil, fmt.Errorf("unexpected mutation authority")
	}
	data, err := io.ReadAll(in)
	if err != nil || string(data) != ingressAccountConfiguration {
		return nil, fmt.Errorf("unexpected sysusers input")
	}
	f.mutations++
	if f.mutate != nil {
		return nil, f.mutate(f)
	}
	if f.gshadow == "" {
		f.groups = append(f.groups, accountGroup)
		f.gshadow = accountGshadow
	}
	if f.shadow == "" {
		f.users = append(f.users, accountPasswd)
		f.shadow = accountShadow
	}
	return nil, nil
}

func TestIngressAccountProvisioningAndIdempotence(t *testing.T) {
	for _, entry := range []struct {
		name                      string
		user, group               bool
		createdUser, createdGroup bool
	}{
		{"new", false, false, true, true}, {"existing", true, true, false, false}, {"group-only-continuation", false, true, true, false},
	} {
		t.Run(entry.name, func(t *testing.T) {
			f := newIngressAccountFixture(entry.user, entry.group)
			receipt, err := ensureIngressAccountWithLookup(context.Background(), f, f.lookup)
			want := ingressAccountReceipt{Name: ingressAccountName, UID: 10001, GID: 10001, CreatedUser: entry.createdUser, CreatedGroup: entry.createdGroup}
			if err != nil || receipt != want {
				t.Fatalf("receipt=%+v error=%v", receipt, err)
			}
			mutations := f.mutations
			again, err := ensureIngressAccountWithLookup(context.Background(), f, f.lookup)
			if err != nil || again.CreatedUser || again.CreatedGroup || f.mutations != mutations {
				t.Fatalf("not idempotent: %+v %v", again, err)
			}
		})
	}
}

func TestIngressAccountRejectsConflictsBeforeMutation(t *testing.T) {
	tests := []struct {
		name   string
		modify func(*ingressAccountFixture)
	}{
		{"foreign-uid", func(f *ingressAccountFixture) {
			f.users = append(f.users, "foreign:x:10001:999:Foreign:/home/foreign:/bin/bash")
		}},
		{"foreign-gid", func(f *ingressAccountFixture) { f.groups = append(f.groups, "foreign:x:10001:") }},
		{"foreign-user-name", func(f *ingressAccountFixture) {
			f.users = append(f.users, "aster-ingress:x:10002:10002:Foreign:/home/foreign:/bin/bash")
		}},
		{"foreign-group-name", func(f *ingressAccountFixture) { f.groups = append(f.groups, "aster-ingress:x:10002:") }},
		{"orphan-shadow", func(f *ingressAccountFixture) { f.shadow = accountShadow }},
		{"orphan-gshadow", func(f *ingressAccountFixture) { f.gshadow = accountGshadow }},
		{"reserved-primary-group-shared", func(f *ingressAccountFixture) {
			f.users = append(f.users, "foreign:x:20000:10001:Foreign:/home/foreign:/bin/bash")
		}},
		{"membership-before-user-exists", func(f *ingressAccountFixture) { f.groups = append(f.groups, "docker:x:999:aster-ingress") }},
		{"nss-user-only", func(f *ingressAccountFixture) {
			for _, key := range []string{ingressAccountName, ingressAccountID} {
				f.overrides["false/passwd/"+key] = ingressAccountAnswer{value: accountPasswd, found: true}
			}
		}},
		{"lookup-unavailable", func(f *ingressAccountFixture) {
			f.overrides["false/passwd/aster-ingress"] = ingressAccountAnswer{err: errors.New("lookup failed")}
		}},
		{"local-enumeration-unavailable", func(f *ingressAccountFixture) {
			f.overrides["true/group/"] = ingressAccountAnswer{err: errors.New("enumeration failed")}
		}},
		{"nss-hidden-numeric-conflict", func(f *ingressAccountFixture) {
			f.overrides["false/passwd/"] = ingressAccountAnswer{value: strings.Join(f.users, "\n") + "\nforeign:x:10001:2:Foreign:/tmp:/bin/bash", found: true}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			f := newIngressAccountFixture(false, false)
			test.modify(f)
			if _, err := ensureIngressAccountWithLookup(context.Background(), f, f.lookup); err == nil {
				t.Fatal("conflict accepted")
			}
			if f.mutations != 0 {
				t.Fatal("mutated accounts after failed preflight")
			}
		})
	}
}

func TestIngressAccountRejectsUnsafeExistingAccount(t *testing.T) {
	tests := []struct {
		name   string
		modify func(*ingressAccountFixture)
	}{
		{"login-shell", func(f *ingressAccountFixture) {
			f.users[1] = strings.Replace(accountPasswd, "/usr/sbin/nologin", "/bin/bash", 1)
		}},
		{"home-directory", func(f *ingressAccountFixture) {
			f.users[1] = strings.Replace(accountPasswd, "/nonexistent", "/home/aster", 1)
		}},
		{"foreign-description", func(f *ingressAccountFixture) {
			f.users[1] = strings.Replace(accountPasswd, "Aster ingress relay", "Foreign", 1)
		}},
		{"unlocked-shadow", func(f *ingressAccountFixture) { f.shadow = "aster-ingress:$6$SENSITIVE-DATA:20000::::::" }},
		{"empty-shadow", func(f *ingressAccountFixture) { f.shadow = "aster-ingress::20000::::::" }},
		{"missing-shadow", func(f *ingressAccountFixture) { f.shadow = "" }},
		{"different-nss-shadow", func(f *ingressAccountFixture) {
			f.overrides["false/shadow/aster-ingress"] = ingressAccountAnswer{value: "aster-ingress:$6$SENSITIVE-DATA:20000::::::", found: true}
		}},
		{"different-nss-group-credentials", func(f *ingressAccountFixture) {
			f.overrides["false/gshadow/aster-ingress"] = ingressAccountAnswer{value: "aster-ingress:::foreign", found: true}
		}},
		{"unlocked-group", func(f *ingressAccountFixture) { f.gshadow = "aster-ingress:::" }},
		{"group-administrator", func(f *ingressAccountFixture) { f.gshadow = "aster-ingress:!*:foreign:" }},
		{"group-members", func(f *ingressAccountFixture) { f.groups[1] = accountGroup + "foreign" }},
		{"nss-supplementary-group", func(f *ingressAccountFixture) {
			f.overrides["false/initgroups/aster-ingress"] = ingressAccountAnswer{value: "aster-ingress 10001 999", found: true}
		}},
		{"supplementary-lookup-missing", func(f *ingressAccountFixture) { f.overrides["false/initgroups/aster-ingress"] = ingressAccountAnswer{} }},
		{"duplicate-uid", func(f *ingressAccountFixture) { f.users = append(f.users, accountPasswd) }},
		{"duplicate-gid", func(f *ingressAccountFixture) { f.groups = append(f.groups, accountGroup) }},
		{"inconsistent-enumerated-shell", func(f *ingressAccountFixture) {
			f.overrides["false/passwd/"] = ingressAccountAnswer{value: strings.Replace(strings.Join(f.users, "\n"), "/usr/sbin/nologin", "/bin/bash", 1), found: true}
		}},
		{"user-without-group", func(f *ingressAccountFixture) { f.groups = f.groups[:1]; f.gshadow = "" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			f := newIngressAccountFixture(true, true)
			test.modify(f)
			_, err := ensureIngressAccountWithLookup(context.Background(), f, f.lookup)
			if err == nil {
				t.Fatal("unsafe existing identity accepted")
			}
			if strings.Contains(err.Error(), "SENSITIVE-DATA") {
				t.Fatal("credential material in error")
			}
			if f.mutations != 0 {
				t.Fatal("attempted to repair a foreign or unsafe identity")
			}
		})
	}
}

func TestIngressAccountInterruptedCreationResumesOnlySafeGroup(t *testing.T) {
	f := newIngressAccountFixture(false, false)
	f.mutate = func(f *ingressAccountFixture) error {
		f.groups = append(f.groups, accountGroup)
		f.gshadow = accountGshadow
		return errors.New("interrupted after group creation")
	}
	if _, err := ensureIngressAccountWithLookup(context.Background(), f, f.lookup); err == nil {
		t.Fatal("interrupted mutation succeeded")
	}
	f.mutate = nil
	receipt, err := ensureIngressAccountWithLookup(context.Background(), f, f.lookup)
	if err != nil || !receipt.CreatedUser || receipt.CreatedGroup || f.mutations != 2 {
		t.Fatalf("unsafe continuation: %+v %v", receipt, err)
	}
}

func TestIngressAccountRejectsPostCreationDriftAndFalseSuccess(t *testing.T) {
	for _, entry := range []struct {
		name  string
		after func(*ingressAccountFixture)
	}{
		{"nothing-created", func(*ingressAccountFixture) {}},
		{"wrong-fallback-id", func(f *ingressAccountFixture) {
			f.users = append(f.users, strings.ReplaceAll(accountPasswd, "10001", "999"))
			f.shadow = accountShadow
			f.groups = append(f.groups, "aster-ingress:x:999:")
			f.gshadow = accountGshadow
		}},
		{"group-only-success", func(f *ingressAccountFixture) { f.groups = append(f.groups, accountGroup); f.gshadow = accountGshadow }},
		{"new-supplementary-membership", func(f *ingressAccountFixture) {
			f.users = append(f.users, accountPasswd)
			f.shadow = accountShadow
			f.groups = append(f.groups, accountGroup, "docker:x:999:aster-ingress")
			f.gshadow = accountGshadow
		}},
	} {
		t.Run(entry.name, func(t *testing.T) {
			f := newIngressAccountFixture(false, false)
			f.mutate = func(f *ingressAccountFixture) error { entry.after(f); return nil }
			receipt, err := ensureIngressAccountWithLookup(context.Background(), f, f.lookup)
			if err == nil || receipt.Name != "" || f.mutations != 1 {
				t.Fatalf("false receipt: %+v %v", receipt, err)
			}
		})
	}
}

type accountLookupExit int

func (e accountLookupExit) Error() string { return "private diagnostic must not escape" }
func (e accountLookupExit) ExitCode() int { return int(e) }

type accountLookupCommand struct {
	data  []byte
	err   error
	calls [][]string
}

func (c *accountLookupCommand) Run(_ context.Context, in io.Reader, out io.Writer, name string, args ...string) ([]byte, error) {
	c.calls = append(c.calls, append([]string{name}, args...))
	if in != nil || out != nil {
		return nil, errors.New("unexpected stream")
	}
	return c.data, c.err
}

func TestIngressGetentMissingIsOnlyEmptyKeyedExitTwo(t *testing.T) {
	for _, entry := range []struct {
		name, key string
		data      []byte
		err       error
		absent    bool
	}{
		{"missing", ingressAccountName, nil, fmt.Errorf("wrapped: %w", accountLookupExit(2)), true},
		{"permission", ingressAccountName, nil, accountLookupExit(1), false},
		{"unsupported-enumeration", "", nil, accountLookupExit(3), false},
		{"enum-exit-two", "", nil, accountLookupExit(2), false},
		{"exit-two-with-output", ingressAccountName, []byte("partial"), accountLookupExit(2), false},
		{"empty-success", ingressAccountName, nil, nil, false},
		{"unterminated", ingressAccountName, []byte(accountPasswd), nil, false},
		{"ambiguous", ingressAccountName, []byte(accountPasswd + "\n" + accountPasswd + "\n"), nil, false},
		{"truncated-enumeration", "", []byte(strings.Repeat("a", 2<<20)), nil, false},
	} {
		t.Run(entry.name, func(t *testing.T) {
			c := &accountLookupCommand{data: entry.data, err: entry.err}
			_, found, err := ingressGetentLookup(c)(context.Background(), true, "passwd", entry.key)
			if entry.absent {
				if found || err != nil {
					t.Fatal("missing not recognized")
				}
			} else if err == nil {
				t.Fatal("unsafe lookup accepted")
			}
			if err != nil && strings.Contains(err.Error(), "private diagnostic") {
				t.Fatal("command diagnostics leaked")
			}
		})
	}
	c := &accountLookupCommand{data: []byte(accountPasswd + "\n")}
	value, found, err := ingressGetentLookup(c)(context.Background(), true, "passwd", ingressAccountName)
	if err != nil || !found || value != accountPasswd || !reflect.DeepEqual(c.calls, [][]string{{"getent", "--service", "files", "passwd", "aster-ingress"}}) {
		t.Fatalf("valid bounded lookup failed: %v", err)
	}
}

func TestIngressAccountCancellationRefusesMutation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f := newIngressAccountFixture(false, false)
	if _, err := ensureIngressAccountWithLookup(ctx, f, f.lookup); err == nil || f.mutations != 0 {
		t.Fatal("cancelled account creation proceeded")
	}
}
