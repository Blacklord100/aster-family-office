// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const ingressAccountName = "aster-ingress"
const ingressAccountID = "10001"

// systemd 255 supports an explicit allocation pool and stdin-only configuration:
// https://github.com/systemd/systemd/blob/v255/man/sysusers.d.xml
// https://github.com/systemd/systemd/blob/v255/man/systemd-sysusers.xml
// A singleton pool is essential: a suggested numeric ID alone permits fallback
// allocation when it is occupied. No other sysusers configuration is selected.
const ingressAccountConfiguration = "r - 10001\ng aster-ingress 10001\nu aster-ingress 10001:10001 \"Aster ingress relay\" /nonexistent /usr/sbin/nologin\n"

type ingressAccountReceipt struct {
	Name         string `json:"name"`
	UID          int    `json:"uid"`
	GID          int    `json:"gid"`
	CreatedUser  bool   `json:"createdUser"`
	CreatedGroup bool   `json:"createdGroup"`
}

// The lookup seam is private and never accepts caller-selected databases or
// identities. It allows portable tests without reading or modifying host NSS.
type ingressAccountLookup func(context.Context, bool, string, string) (string, bool, error)

func ensureIngressAccount(ctx context.Context, commands Commander) (ingressAccountReceipt, error) {
	if runtime.GOOS != "linux" || os.Getuid() != 0 || os.Geteuid() != 0 {
		return ingressAccountReceipt{}, fmt.Errorf("ingress account provisioning requires the root Linux controller")
	}
	if commands == nil {
		return ingressAccountReceipt{}, fmt.Errorf("ingress account provisioning requires a command runner")
	}
	return ensureIngressAccountWithLookup(ctx, commands, ingressGetentLookup(commands))
}

func ingressGetentLookup(commands Commander) ingressAccountLookup {
	return func(ctx context.Context, local bool, database, key string) (string, bool, error) {
		args := []string{}
		if local {
			args = append(args, "--service", "files")
		}
		args = append(args, database)
		if key != "" {
			args = append(args, key)
		}
		data, err := commands.Run(ctx, nil, nil, "getent", args...)
		if err != nil {
			var exited interface{ ExitCode() int }
			// getent exit 2 means a keyed record is absent. Unsupported
			// enumeration, permission failures and interrupted lookups refuse.
			if key != "" && len(data) == 0 && errors.As(err, &exited) && exited.ExitCode() == 2 && ctx.Err() == nil {
				return "", false, nil
			}
			return "", false, fmt.Errorf("ingress account lookup failed; no account changes are authorized")
		}
		// systemCommands caps stdout at 2 MiB; reject a potentially truncated
		// enumeration. Never include passwd/shadow output in errors or receipts.
		if len(data) == 0 || len(data) >= 2<<20 || strings.ContainsAny(string(data), "\x00\r") || data[len(data)-1] != '\n' {
			return "", false, fmt.Errorf("ingress account lookup returned incomplete or invalid records")
		}
		if key != "" && (len(data) > 16384 || strings.Count(string(data), "\n") != 1) {
			return "", false, fmt.Errorf("ingress account lookup returned ambiguous records")
		}
		return strings.TrimSuffix(string(data), "\n"), true, nil
	}
}

func ensureIngressAccountWithLookup(ctx context.Context, commands Commander, lookup ingressAccountLookup) (ingressAccountReceipt, error) {
	if commands == nil || lookup == nil {
		return ingressAccountReceipt{}, fmt.Errorf("ingress account provisioning requires complete inspection")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	before, err := inspectIngressAccount(ctx, lookup)
	if err != nil {
		return ingressAccountReceipt{}, err
	}
	if before.user && before.group {
		return ingressAccountReceipt{Name: ingressAccountName, UID: 10001, GID: 10001}, nil
	}
	if err = ctx.Err(); err != nil {
		return ingressAccountReceipt{}, err
	}
	// sysusers locks its account databases, creates only missing entries and
	// does not rewrite an existing user. A complete group-only partial result
	// is safe to resume. Incomplete or foreign records fail the inspection.
	if _, err = commands.Run(ctx, strings.NewReader(ingressAccountConfiguration), nil, "systemd-sysusers", "-"); err != nil {
		return ingressAccountReceipt{}, fmt.Errorf("ingress account creation did not complete; rerun only after reviewing the local account state")
	}
	after, err := inspectIngressAccount(ctx, lookup)
	if err != nil || !after.user || !after.group {
		return ingressAccountReceipt{}, fmt.Errorf("ingress account creation failed independent identity validation; no service may start")
	}
	return ingressAccountReceipt{Name: ingressAccountName, UID: 10001, GID: 10001,
		CreatedUser: !before.user, CreatedGroup: !before.group}, nil
}

type ingressAccountState struct{ user, group bool }

func inspectIngressAccount(ctx context.Context, lookup ingressAccountLookup) (ingressAccountState, error) {
	state := ingressAccountState{}
	// Both numeric and named NSS records must agree with the local files.
	// A directory-service-only account is not adopted as a static local user.
	for _, entry := range []struct {
		database string
		fields   int
	}{{"passwd", 7}, {"group", 4}} {
		var expected string
		var present bool
		for index, query := range []struct {
			local bool
			key   string
		}{{false, ingressAccountName}, {false, ingressAccountID}, {true, ingressAccountName}, {true, ingressAccountID}} {
			value, found, err := lookup(ctx, query.local, entry.database, query.key)
			if err != nil {
				return state, err
			}
			if index == 0 {
				expected, present = value, found
			}
			if found != present || value != expected {
				return state, fmt.Errorf("ingress account name or numeric identity conflicts with an existing account")
			}
		}
		if present {
			parts := strings.Split(expected, ":")
			if len(parts) != entry.fields || parts[0] != ingressAccountName || parts[1] != "x" || parts[2] != ingressAccountID {
				return state, fmt.Errorf("ingress account identity differs from the reserved static account")
			}
			if entry.database == "passwd" && (parts[3] != ingressAccountID || parts[4] != "Aster ingress relay" || parts[5] != "/nonexistent" || parts[6] != "/usr/sbin/nologin") {
				return state, fmt.Errorf("ingress account must have the exact primary group, description, nonexistent home and nologin shell")
			}
			if entry.database == "group" && parts[3] != "" {
				return state, fmt.Errorf("ingress group must not grant access to member accounts")
			}
		}
		if entry.database == "passwd" {
			state.user = present
		} else {
			state.group = present
		}
	}
	if state.user && !state.group {
		return state, fmt.Errorf("ingress user exists without its reserved primary group")
	}
	for _, entry := range []struct {
		database string
		fields   int
		present  bool
	}{{"shadow", 9, state.user}, {"gshadow", 4, state.group}} {
		value, found, err := lookup(ctx, true, entry.database, ingressAccountName)
		if err != nil {
			return state, err
		}
		if found != entry.present {
			return state, fmt.Errorf("ingress account has an incomplete or orphaned credential record")
		}
		nssValue, nssFound, err := lookup(ctx, false, entry.database, ingressAccountName)
		if err != nil || nssFound != found || nssValue != value {
			return state, fmt.Errorf("ingress credentials differ between local and system account records")
		}
		if found {
			parts := strings.Split(value, ":")
			if len(parts) != entry.fields || parts[0] != ingressAccountName || !(strings.HasPrefix(parts[1], "!") || strings.HasPrefix(parts[1], "*")) {
				return state, fmt.Errorf("ingress credentials are not locked")
			}
			if entry.database == "gshadow" && (parts[2] != "" || parts[3] != "") {
				return state, fmt.Errorf("ingress group must not contain administrators or members")
			}
		}
	}
	// Enumerations catch duplicate local IDs, another user's primary GID and
	// memberships recorded before a missing user was created. The keyed
	// initgroups lookup below additionally covers NSS membership providers.
	for _, local := range []bool{true, false} {
		for _, database := range []string{"passwd", "group"} {
			value, found, err := lookup(ctx, local, database, "")
			if err != nil || !found {
				return state, fmt.Errorf("ingress account membership enumeration is unavailable")
			}
			if err = validateIngressAccountEnumeration(value, database, state); err != nil {
				return state, err
			}
		}
	}
	if state.user {
		value, found, err := lookup(ctx, false, "initgroups", ingressAccountName)
		parts := strings.Fields(value)
		if err != nil || !found || len(parts) < 2 || parts[0] != ingressAccountName {
			return state, fmt.Errorf("ingress supplementary group inspection failed")
		}
		for _, group := range parts[1:] {
			// glibc may list the primary GID twice; no other GID is allowed.
			if group != ingressAccountID {
				return state, fmt.Errorf("ingress account has supplementary group membership")
			}
		}
	}
	return state, ctx.Err()
}

func validateIngressAccountEnumeration(value, database string, state ingressAccountState) error {
	seen := 0
	for _, line := range strings.Split(value, "\n") {
		parts := strings.Split(line, ":")
		fields := 4
		if database == "passwd" {
			fields = 7
		}
		if len(parts) != fields || parts[0] == "" {
			return fmt.Errorf("ingress account enumeration is malformed")
		}
		id, err := strconv.ParseUint(parts[2], 10, 32)
		if err != nil {
			return fmt.Errorf("ingress account enumeration has an invalid numeric identity")
		}
		reserved := parts[0] == ingressAccountName || id == 10001
		if reserved {
			if parts[0] != ingressAccountName || parts[2] != ingressAccountID {
				return fmt.Errorf("reserved ingress name or numeric identity is already in use")
			}
			if parts[1] != "x" || (database == "passwd" && (parts[3] != ingressAccountID || parts[4] != "Aster ingress relay" || parts[5] != "/nonexistent" || parts[6] != "/usr/sbin/nologin")) {
				return fmt.Errorf("enumerated ingress account differs from its reserved identity")
			}
			seen++
		}
		if database == "passwd" {
			gid, err := strconv.ParseUint(parts[3], 10, 32)
			if err != nil || (gid == 10001 && parts[0] != ingressAccountName) {
				return fmt.Errorf("ingress primary group is shared with a foreign account")
			}
		} else if parts[3] != "" {
			for _, member := range strings.Split(parts[3], ",") {
				if member == ingressAccountName || reserved {
					return fmt.Errorf("ingress account or group has explicit membership grants")
				}
			}
		}
	}
	expected := 0
	if (database == "passwd" && state.user) || (database == "group" && state.group) {
		expected = 1
	}
	if seen != expected {
		return fmt.Errorf("ingress enumeration contains duplicate or inconsistent account identities")
	}
	return nil
}
