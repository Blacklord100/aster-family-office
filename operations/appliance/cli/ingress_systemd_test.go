// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type ingressCommands struct {
	calls      [][]string
	failEnable bool
}

func (fake *ingressCommands) Run(_ context.Context, _ io.Reader, _ io.Writer, name string, args ...string) ([]byte, error) {
	fake.calls = append(fake.calls, append([]string{name}, args...))
	if fake.failEnable && len(args) > 0 && args[0] == "enable" {
		return nil, fmt.Errorf("synthetic socket collision")
	}
	return nil, nil
}

func ingressFixture(t *testing.T) (ingressManager, string, *ingressCommands) {
	t.Helper()
	// macOS canonical /private/tmp also exercises a real root path without
	// changing /etc/systemd/system, service accounts, Docker or the live app.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	units := filepath.Join(root, "synthetic-units")
	if err = os.Mkdir(units, 0755); err != nil {
		t.Fatal(err)
	}
	fake := &ingressCommands{}
	manager := ingressManager{root: root, units: units, owner: os.Geteuid(), group: os.Getegid(), serviceOwner: os.Geteuid(), serviceGroup: os.Getegid(), commands: fake}
	return manager, root + "/releases/first/payload/bin/asterctl", fake
}

func TestIngressUnitTemplatesConfineTheRelayAndRejectInjectedPaths(t *testing.T) {
	root := "/var/lib/aster"
	units, err := renderIngressUnits(root, root+"/releases/1.0/payload/bin/asterctl")
	if err != nil || len(units) != 4 {
		t.Fatalf("unit render: %v", err)
	}
	for name, content := range units {
		body := string(content)
		if strings.Contains(body, "@") || strings.Contains(body, "docker.sock") {
			t.Fatal("unresolved template or Docker authority")
		}
		if strings.HasSuffix(name, ".service") {
			for _, required := range []string{"User=10001\n", "Group=10001\n", "PrivateNetwork=true\n", "RestrictAddressFamilies=AF_UNIX\n", "RootDirectory=/var/lib/aster/run/ingress-jail\n", "CapabilityBoundingSet=\n", "NoNewPrivileges=true\n", "BindReadOnlyPaths=", "MemoryMax=128M\n"} {
				if !strings.Contains(body, required) {
					t.Fatalf("missing sandbox restriction %q", required)
				}
			}
		}
	}
	for _, bad := range []string{"/var/lib/../aster", "/var/lib/a b", "/var/lib/a\nExecStart=bad", "/var/lib/%n", "/var/lib/a:bad", "relative", "/"} {
		if _, err = renderIngressUnits(bad, bad+"/releases/first/payload/bin/asterctl"); err == nil {
			t.Fatalf("unsafe root accepted: %q", bad)
		}
	}
	if _, err = renderIngressUnits(root, "/usr/bin/asterctl"); err == nil {
		t.Fatal("accepted unbound executable")
	}
}

func TestIngressUnitUpdatePreservesOwnershipAndSurvivesPartialPublication(t *testing.T) {
	manager, first, fake := ingressFixture(t)
	ctx := context.Background()
	if err := manager.start(ctx, first); err != nil {
		t.Fatal(err)
	}
	base := ingressUnitBase(manager.root)
	if got := fake.calls[len(fake.calls)-1]; !reflect.DeepEqual(got, []string{"systemctl", "enable", "--now", base + "-http.socket", base + "-https.socket"}) {
		t.Fatalf("unexpected activation: %v", got)
	}
	second := strings.Replace(first, "/first/", "/second/", 1)
	next, err := renderIngressUnits(manager.root, second)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate interruption after one new unit has reached disk but before its
	// receipt is replaced. Remaining files still match the prior trusted receipt.
	if err = atomicWrite(filepath.Join(manager.units, base+"-http.service"), next[base+"-http.service"], 0644); err != nil {
		t.Fatal(err)
	}
	fake.calls = nil
	if err = manager.start(ctx, second); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(fake.calls[0][:3], []string{"systemctl", "disable", "--now"}) || fake.calls[1][1] != "stop" {
		t.Fatalf("old listeners were not stopped first: %v", fake.calls)
	}
	for name, expected := range next {
		actual, err := os.ReadFile(filepath.Join(manager.units, name))
		if err != nil || !bytes.Equal(expected, actual) {
			t.Fatalf("candidate unit differs: %s %v", name, err)
		}
	}
	previous, err := manager.previous()
	if err != nil || previous[base+"-http.service"] != fingerprint(next[base+"-http.service"]) {
		t.Fatalf("new receipt not committed: %v", err)
	}
	fake.calls = nil
	if err = manager.stop(ctx, second); err != nil {
		t.Fatal(err)
	}
	if len(fake.calls) != 2 || fake.calls[0][1] != "disable" || fake.calls[1][1] != "stop" {
		t.Fatalf("stop did not fence socket activation: %v", fake.calls)
	}
}

func TestIngressRefusesModifiedUnitsBeforeAnySystemCommand(t *testing.T) {
	manager, binary, fake := ingressFixture(t)
	if err := manager.start(context.Background(), binary); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(manager.units, ingressUnitBase(manager.root)+"-https.service")
	if err := os.WriteFile(path, []byte("[Service]\nExecStart=/UNREVIEWED\n"), 0644); err != nil {
		t.Fatal(err)
	}
	fake.calls = nil
	if err := manager.start(context.Background(), binary); err == nil {
		t.Fatal("replaced modified service")
	}
	if len(fake.calls) != 0 {
		t.Fatalf("mutated systemd before validation: %v", fake.calls)
	}
}

func TestIngressStopsReceiptedSocketsEvenWhenTheirFilesAreMissing(t *testing.T) {
	manager, binary, fake := ingressFixture(t)
	if err := manager.start(context.Background(), binary); err != nil {
		t.Fatal(err)
	}
	name := ingressUnitBase(manager.root) + "-https.socket"
	if err := os.Remove(filepath.Join(manager.units, name)); err != nil {
		t.Fatal(err)
	}
	fake.calls = nil
	if err := manager.stop(context.Background(), binary); err != nil {
		t.Fatal(err)
	}
	if len(fake.calls) != 2 || !strings.Contains(strings.Join(fake.calls[0], " "), name) {
		t.Fatalf("forgot a potentially loaded socket when its unit file disappeared: %v", fake.calls)
	}
}

func TestIngressRefusesDirectoryLinksAndForeignUnitLinks(t *testing.T) {
	manager, binary, fake := ingressFixture(t)
	if err := manager.prepare(); err != nil {
		t.Fatal(err)
	}
	sockets := filepath.Join(manager.root, "run/ingress-sockets")
	if err := os.Remove(sockets); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(manager.units, sockets); err != nil {
		t.Fatal(err)
	}
	if err := manager.start(context.Background(), binary); err == nil {
		t.Fatal("accepted symlink socket directory")
	}
	if len(fake.calls) != 0 {
		t.Fatal("mutated systemd for unsafe socket directory")
	}
	if err := os.Remove(sockets); err != nil {
		t.Fatal(err)
	}
	if err := manager.prepare(); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(manager.root, "foreign-unit")
	if err := os.WriteFile(target, []byte("SYNTHETIC FOREIGN FILE"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(target, filepath.Join(manager.units, ingressUnitBase(manager.root)+"-http.socket")); err != nil {
		t.Fatal(err)
	}
	if err := manager.start(context.Background(), binary); err == nil {
		t.Fatal("accepted hard-linked service unit")
	}
}

func TestIngressActivationFailureDisablesOnlyOwnedSockets(t *testing.T) {
	manager, binary, fake := ingressFixture(t)
	fake.failEnable = true
	if err := manager.start(context.Background(), binary); err == nil {
		t.Fatal("socket activation failure was ignored")
	}
	if len(fake.calls) != 4 || fake.calls[2][1] != "disable" || fake.calls[3][1] != "stop" {
		t.Fatalf("partial activation cleanup missing: %v", fake.calls)
	}
	for _, call := range fake.calls {
		for _, arg := range call[2:] {
			if strings.HasSuffix(arg, ".socket") || strings.HasSuffix(arg, ".service") {
				if !strings.HasPrefix(arg, ingressUnitBase(manager.root)+"-") {
					t.Fatalf("touched foreign unit: %s", arg)
				}
			}
		}
	}
}

func TestIngressComposeOnlyTracksFleetAndCaddyLifecycle(t *testing.T) {
	for _, test := range []struct {
		args        []string
		start, stop bool
	}{
		{[]string{"up", "-d", "--wait", "--wait-timeout", "300"}, true, false},
		{[]string{"up", "-d", "--wait", "--wait-timeout", "180", "postgres"}, false, false},
		{[]string{"up", "-d", "caddy"}, true, false},
		{[]string{"down", "--timeout", "90"}, false, true},
		{[]string{"stop", "--timeout", "90", "caddy", "ollama"}, false, true},
		{[]string{"stop", "worker"}, false, false},
		{[]string{"run", "--rm", "migrate"}, false, false},
		{[]string{"exec", "web", "node"}, false, false},
	} {
		start, stop := ingressComposeAction(test.args)
		if start != test.start || stop != test.stop {
			t.Fatalf("wrong lifecycle for %v", test.args)
		}
	}
}

func TestUnixIngressManifestRequiresSupportedInventoriedExecutable(t *testing.T) {
	_, manifest := fixture(t)
	manifest.Ingress = "unexpected-network-policy"
	if err := manifest.Validate(); err == nil {
		t.Fatal("unknown ingress accepted")
	}
	manifest.Ingress = unixIngress
	if err := manifest.Validate(); err == nil {
		t.Fatal("missing ingress executable accepted")
	}
	manifest.Files = append(manifest.Files, FileEntry{Path: "payload/bin/asterctl", SHA256: strings.Repeat("a", 64), Size: 128, Mode: 0755})
	if err := manifest.Validate(); err != nil {
		t.Fatal(err)
	}
	manifest.Files[len(manifest.Files)-1].Mode = 0644
	if err := manifest.Validate(); err == nil {
		t.Fatal("nonexecutable relay accepted")
	}
}
