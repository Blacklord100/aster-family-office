// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

var version = "development"

const usage = `asterctl — local Aster appliance operations

  verify           Verify an offline bundle against independently trusted TUF root
  unpack           Safely unpack and verify downloaded split release media
  install          Install a verified bundle on a dedicated Ubuntu 24.04 amd64 host
  continue-install Continue a journaled installation after interruption
  bootstrap        Create the first owner from a private password file
  status           Read installation, operation journal, and database lifecycle
  doctor           Check payload integrity, runtime, model identity, and app health
  backup           Drain writes and create a coordinated encrypted recovery artifact
  restore          Verify recovery into a NEW destination; requires source fencing
  continue-restore Continue a verified restore after its database import committed
  update           Verify, back up, migrate, qualify, and resume a newer release
  continue-update  Continue a journaled update after interruption
  resume           Resume the database's active compatible release; never restore data
  stop             Stop only this installation's fleet, retaining all data
  recovery-key     Generate a customer-controlled age recovery identity
  init-trust       Generate publisher root and separate release signing keys
  rotate-trust     Cross-sign new publisher root with the existing root threshold
  sign             Sign release.json with release keys (root private keys not used)
  schedule-backups Install a systemd backup timer on the appliance host

Use a command with --help for its options. No cloud or telemetry endpoint is used.
`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if e := run(ctx, os.Args[1:], os.Stdout); e != nil {
		fmt.Fprintln(os.Stderr, "asterctl:", e)
		os.Exit(1)
	}
}
func run(ctx context.Context, args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		fmt.Fprint(out, usage)
		return nil
	}
	if args[0] == "version" {
		fmt.Fprintln(out, version)
		return nil
	}
	name := args[0]
	// Socket-activated ingress is a long-lived confined process. It must not
	// inherit the administrative command flags, root path or operation timeout.
	if name == "ingress" {
		return runIngress(ctx, args[1:], out)
	}
	f := flag.NewFlagSet(name, flag.ContinueOnError)
	f.SetOutput(out)
	root := f.String("root", "/var/lib/aster", "private appliance installation root")
	bundle := f.String("bundle", "", "unpacked release bundle directory")
	trustRoot := f.String("trust-root", "", "independently obtained initial TUF root JSON")
	trustSHA := f.String("trust-root-sha256", "", "independently authenticated root SHA-256 fingerprint")
	output := f.String("output", "", "output path (must not already exist)")
	backupSHA := f.String("backup-sha256", "", "encrypted backup SHA-256 from independently trusted backup catalog")
	identity := f.String("identity", "", "private age recovery identity file (0600)")
	hostname := f.String("hostname", "", "DNS hostname, without scheme or port")
	profile := f.String("profile", "offline", "offline or connected; inference stays local in both")
	optionalServices := f.String("optional-services", "", "initial connected install only: mailbox, delivery, or mailbox,delivery; omitted disables both")
	tlsMode := f.String("tls-mode", "internal", "internal private CA or supplied certificate")
	cert := f.String("tls-cert", "", "supplied TLS certificate chain PEM")
	key := f.String("tls-key", "", "supplied TLS private key PEM")
	recipient := f.String("recovery-recipient", "", "customer's public age1 recovery recipient")
	installRuntime := f.Bool("install-runtime", false, "install the signed offline .deb runtime closure on this dedicated host")
	input := f.String("input", "", "encrypted backup path, or parts.json for unpack")
	unpackLimit := f.Int64("max-unpack-gib", 64, "maximum expanded release media size in GiB")
	fenced := f.Bool("source-fenced", false, "confirm the original host is isolated before bringing up recovery")
	limit := f.Int64("max-restore-gib", 256, "maximum recovery size and required free capacity in GiB")
	keys := f.String("keys", "", "publisher signing keys directory")
	previousRoot := f.String("previous-root", "", "existing publisher root JSON for rotation")
	oldRootKeys := f.String("old-root-keys", "", "two existing root key file paths, comma separated, for offline rotation ceremony")
	sequence := f.Int64("sequence", 0, "monotonically increasing TUF metadata version")
	expires := f.String("expires", "", "metadata expiry RFC3339 (at most 90 days)")
	email := f.String("email", "", "first owner's email")
	owner := f.String("name", "", "first owner's name")
	organization := f.String("organization", "", "initial family office name")
	password := f.String("password-file", "", "private first-owner password file (0600)")
	calendar := f.String("calendar", "*-*-* 02:00:00", "systemd OnCalendar schedule")
	timeout := f.Duration("timeout", 30*time.Minute, "operation deadline; interruption leaves a durable journal")
	if e := f.Parse(args[1:]); e != nil {
		if e == flag.ErrHelp {
			return nil
		}
		return e
	}
	if len(f.Args()) != 0 {
		return fmt.Errorf("unexpected positional arguments")
	}
	optionalServicesSet := false
	f.Visit(func(value *flag.Flag) {
		if value.Name == "optional-services" {
			optionalServicesSet = true
		}
	})
	if optionalServicesSet && name != "install" {
		return fmt.Errorf("--optional-services is an initial-install choice; other operations preserve the installed setting")
	}
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	absolute, e := filepath.Abs(*root)
	if e != nil {
		return e
	}
	c := Controller{Root: filepath.Clean(absolute), Commands: systemCommands{}}
	switch name {
	case "unpack":
		if *unpackLimit < 1 || *unpackLimit > 4096 {
			return fmt.Errorf("max-unpack-gib must be between 1 and 4096")
		}
		if e = UnpackMedia(ctx, *input, *output, *trustRoot, *trustSHA, *unpackLimit<<30); e != nil {
			return e
		}
		fmt.Fprintln(out, "Release media unpacked and verified. Use install or update with the verified output directory.")
		return nil
	case "verify":
		if *bundle == "" {
			return fmt.Errorf("--bundle is required")
		}
		cache, e := os.MkdirTemp("", "aster-verify-")
		if e != nil {
			return e
		}
		defer os.RemoveAll(cache)
		m, e := verifyBundle(*bundle, *trustRoot, *trustSHA, cache)
		if e != nil {
			return e
		}
		return json.NewEncoder(out).Encode(map[string]any{"ok": true, "releaseId": m.ReleaseID, "sequence": m.Sequence, "files": len(m.Files), "note": "Standalone verification has no installation rollback cache; install/update additionally enforce persisted trust and release sequence."})
	case "init-trust":
		if *keys == "" {
			return fmt.Errorf("--keys must be a new offline directory")
		}
		if e = initTrust(*keys, time.Now().UTC()); e != nil {
			return e
		}
		b, e := os.ReadFile(filepath.Join(*keys, "root.sha256"))
		if e != nil {
			return e
		}
		fmt.Fprintf(out, "Initial root SHA-256: %sKeep root-1 and root-2 under separate offline custody before production use. Release signing uses only targets, snapshot, and timestamp keys.\n", b)
		return nil
	case "sign":
		expiry, e := time.Parse(time.RFC3339, *expires)
		if e != nil {
			return e
		}
		return signBundle(*bundle, *keys, *sequence, expiry)
	case "rotate-trust":
		return rotateTrust(*previousRoot, strings.Split(*oldRootKeys, ","), *keys)
	case "recovery-key":
		if *output == "" {
			return fmt.Errorf("--output is required; store the private identity outside the appliance")
		}
		if e = recoveryKey(*output); e != nil {
			return e
		}
		recipient, e := publicRecoveryRecipient(*output)
		if e != nil {
			return e
		}
		fmt.Fprintln(out, recipient)
		return nil
	case "install", "continue-install":
		services, err := parseOptionalServices(*profile, *optionalServices)
		if err != nil {
			return err
		}
		if *tlsMode == "supplied" {
			if _, e = tls.LoadX509KeyPair(*cert, *key); e != nil {
				return fmt.Errorf("supplied certificate/key pair is invalid: %w", e)
			}
		}
		e = c.Install(ctx, InstallOptions{Bundle: *bundle, TrustRoot: *trustRoot, TrustSHA: *trustSHA, Hostname: *hostname, Profile: *profile, OptionalServices: services, TLSMode: *tlsMode, Recipient: *recipient, CertFile: *cert, KeyFile: *key, InstallRuntime: *installRuntime, Continue: name == "continue-install"})
		if e == nil {
			installed, err := c.load()
			if err != nil {
				return fmt.Errorf("installation completed but its saved configuration cannot be read: %w", err)
			}
			fmt.Fprintf(out, "Installed at https://%s. Create the first owner with asterctl bootstrap; MFA enrollment is required. For internal TLS, distribute only the public CA certificate from data/caddy/data/caddy/pki/authorities/local/root.crt.\n", installed.Hostname)
		}
		return e
	case "bootstrap":
		return c.Bootstrap(ctx, *email, *owner, *organization, *password)
	case "status":
		s, e := c.load()
		if e != nil {
			b, err := os.ReadFile(filepath.Join(c.Root, "journal.json"))
			if err != nil {
				return e
			}
			var pending Journal
			if err = decodeJSON(b, &pending); err != nil {
				return err
			}
			next := "inspect the operation journal and failing local service; do not delete data"
			switch pending.Operation {
			case "install":
				next = "continue-install; retain existing data and secrets"
			case "update":
				next = "continue-update; retain the journaled backup"
			case "restore":
				next = "continue-restore with independently trusted backup digest and publisher root; an ambiguous database import requires stop and recovery into a different destination"
			}
			return json.NewEncoder(out).Encode(map[string]any{"installed": false, "operation": pending, "next": next})
		}
		j := json.RawMessage("null")
		if b, err := os.ReadFile(filepath.Join(c.Root, "journal.json")); err == nil {
			j = b
		}
		state, err := c.lifecycle(ctx, s, "status")
		result := map[string]any{"installation": s, "operation": j, "database": state, "databaseAvailable": err == nil}
		if err != nil {
			result["databaseError"] = err.Error()
		}
		return json.NewEncoder(out).Encode(result)
	case "doctor":
		s, e := c.load()
		if e != nil {
			return e
		}
		m, e := c.manifest(s)
		if e != nil {
			return e
		}
		if e = verifyPayload(c.release(s), m); e != nil {
			return e
		}
		if e = c.runtime(ctx, m, c.release(s), false); e != nil {
			return e
		}
		if e = c.qualify(ctx, s, m); e != nil {
			return e
		}
		fmt.Fprintln(out, "Payload, runtime, model identity, and application health checks passed. This is not a restore drill or performance qualification.")
		return nil
	case "backup":
		return c.Backup(ctx, *output)
	case "restore":
		if *limit < 1 || *limit > 16384 {
			return fmt.Errorf("max-restore-gib must be between 1 and 16384")
		}
		return c.Restore(ctx, *input, *identity, *backupSHA, *trustRoot, *trustSHA, *limit<<30, *fenced, *installRuntime)
	case "continue-restore":
		return c.ContinueRestore(ctx, *input, *backupSHA, *trustRoot, *trustSHA)
	case "update":
		return c.Update(ctx, *bundle, *output, false)
	case "continue-update":
		return c.Update(ctx, "", *output, true)
	case "resume":
		return c.Resume(ctx)
	case "stop":
		unlock, e := c.lock()
		if e != nil {
			return e
		}
		defer unlock()
		s, e := c.load()
		if e != nil {
			b, err := os.ReadFile(filepath.Join(c.Root, "journal.json"))
			if err != nil {
				return e
			}
			var j Journal
			if err = decodeJSON(b, &j); err != nil {
				return err
			}
			if j.Candidate == nil || j.Candidate.Root != c.Root || !identifier.MatchString(j.Candidate.Project) {
				return fmt.Errorf("no valid scoped installation to stop")
			}
			s = *j.Candidate
		}
		_, e = c.compose(ctx, s, nil, nil, "down", "--timeout", "90")
		return e
	case "schedule-backups":
		return c.Schedule(ctx, *output, *calendar)
	default:
		return fmt.Errorf("unknown command %q", name)
	}
}
func (c Controller) Bootstrap(ctx context.Context, email, name, org, password string) error {
	unlock, e := c.lock()
	if e != nil {
		return e
	}
	defer unlock()
	s, e := c.load()
	if e != nil {
		return e
	}
	st, e := os.Lstat(password)
	if e != nil {
		return e
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 1024 {
		return fmt.Errorf("password must be a private regular file (0600), at most 1024 bytes")
	}
	b, e := os.ReadFile(password)
	if e != nil {
		return e
	}
	dir, e := os.MkdirTemp(c.Root, ".bootstrap-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(dir)
	p := filepath.Join(dir, "password")
	if e = atomicWrite(p, b, 0600); e != nil {
		return e
	}
	if e = os.Chown(p, 1000, 1000); e != nil {
		return e
	}
	_, e = c.compose(ctx, s, nil, nil, "run", "--rm", "--no-deps", "-T", "--volume", p+":/run/bootstrap:ro", "--env", "BOOTSTRAP_PASSWORD_FILE=/run/bootstrap", "migrate", "node", "dist-ops/bootstrap.js", "--email", email, "--name", name, "--organization", org)
	return e
}
func (c Controller) Schedule(ctx context.Context, dest, calendar string) error {
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
	_ = s
	if !filepath.IsAbs(dest) || strings.ContainsAny(dest, "\n\r%\"' ") || strings.ContainsAny(c.Root, "\n\r%\"' ") || strings.ContainsAny(calendar, "\n\r") {
		return fmt.Errorf("schedule requires simple absolute paths and a single-line calendar")
	}
	if e = os.MkdirAll(dest, 0700); e != nil {
		return e
	}
	if e = backupPath(c.Root, filepath.Join(dest, "future-backup.age")); e != nil {
		return e
	}
	if _, e = c.Commands.Run(ctx, nil, nil, "systemd-analyze", "calendar", calendar); e != nil {
		return e
	}
	executable, e := os.Executable()
	if e != nil {
		return e
	}
	if strings.ContainsAny(executable, "\n\r%\"' ") {
		return fmt.Errorf("place asterctl at a simple absolute path before scheduling")
	}
	// A tiny root-owned script supplies the timestamp. It contains only validated
	// paths and no secrets. No retention deletion is installed automatically.
	script := fmt.Sprintf("#!/bin/sh\nset -eu\numask 077\nexec '%s' backup --timeout 2h --root '%s' --output '%s/aster-'\"$(date -u +%%Y%%m%%dT%%H%%M%%SZ)\"'.age'\n", executable, c.Root, dest)
	p := filepath.Join(c.Root, "scheduled-backup.sh")
	if e = atomicWrite(p, []byte(script), 0700); e != nil {
		return e
	}
	service := fmt.Sprintf("[Unit]\nDescription=Aster coordinated encrypted backup\nAfter=docker.service\nRequires=docker.service\n[Service]\nType=oneshot\nExecStart=%s\nTimeoutStartSec=7200\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n", p)
	timer := fmt.Sprintf("[Unit]\nDescription=Aster backup schedule\n[Timer]\nOnCalendar=%s\nPersistent=true\nRandomizedDelaySec=300\n[Install]\nWantedBy=timers.target\n", calendar)
	for name, b := range map[string]string{"aster-backup.service": service, "aster-backup.timer": timer} {
		p := filepath.Join("/etc/systemd/system", name)
		if _, e = os.Stat(p); !os.IsNotExist(e) {
			return fmt.Errorf("unit already exists; review it instead of overwriting")
		}
		if e = atomicWrite(p, []byte(b), 0644); e != nil {
			return e
		}
	}
	if _, e = c.Commands.Run(ctx, nil, nil, "systemctl", "daemon-reload"); e != nil {
		return e
	}
	_, e = c.Commands.Run(ctx, nil, nil, "systemctl", "enable", "--now", "aster-backup.timer")
	return e
}
