// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestOptionalServicesRequireExplicitConnectedSelection(t *testing.T) {
	for _, profile := range []string{"offline", "connected"} {
		services, err := parseOptionalServices(profile, "")
		if err != nil || len(services) != 0 {
			t.Fatalf("empty selection must remain disabled: %v %v", services, err)
		}
	}
	services, err := parseOptionalServices("connected", "mailbox,delivery")
	if err != nil || !reflect.DeepEqual(services, []string{"delivery", "mailbox"}) {
		t.Fatalf("explicit selection did not normalize: %v %v", services, err)
	}
	for _, tc := range []struct{ profile, value string }{
		{"offline", "mailbox"}, {"offline", "delivery"}, {"connected", "cloud"},
		{"connected", "mailbox,mailbox"}, {"connected", "mailbox,"},
		{"connected", " mailbox"}, {"connected", "*"}, {"", ""},
	} {
		if _, err = parseOptionalServices(tc.profile, tc.value); err == nil {
			t.Fatalf("unsafe optional service selection accepted: %+v", tc)
		}
	}
}

func TestOptionalServicesCannotBeChangedByContinuationOrUnrelatedCommand(t *testing.T) {
	for _, command := range []string{"continue-install", "continue-update", "restore", "continue-restore", "resume", "status"} {
		var output bytes.Buffer
		err := run(context.Background(), []string{command, "--optional-services", "mailbox"}, &output)
		if err == nil || !strings.Contains(err.Error(), "initial-install choice") {
			t.Fatalf("%s accepted a new service selection: %v", command, err)
		}
	}
	err := (Controller{}).Install(context.Background(), InstallOptions{Continue: true, OptionalServices: []string{"mailbox"}})
	if err == nil || !strings.Contains(err.Error(), "preserves the original") {
		t.Fatalf("direct continuation bypassed the service guard: %v", err)
	}
}

func TestOptionalServicesPersistIntoEveryScopedLifecycleCommand(t *testing.T) {
	c, s, fake := protocolReviewFixture(t, "")
	s.Profile, s.OptionalServices = "connected", []string{"delivery", "mailbox"}
	if err := writeJSON(c.statePath(), s); err != nil {
		t.Fatal(err)
	}
	stored, err := c.load()
	if err != nil {
		t.Fatal(err)
	}
	m, err := c.manifest(stored)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.writeEnv(stored, m); err != nil {
		t.Fatal(err)
	}
	for _, action := range [][]string{{"up", "-d"}, {"down", "--timeout", "90"}, {"stop", "caddy", "ollama"}, {"run", "--rm", "--no-deps", "migrate"}} {
		if _, err = c.compose(context.Background(), stored, nil, nil, action...); err != nil {
			t.Fatal(err)
		}
	}
	for _, call := range fake.calls {
		joined := strings.Join(call, " ")
		if !strings.Contains(joined, "--profile delivery --profile mailbox") || !strings.Contains(joined, m.Compose.Connected) {
			t.Fatalf("lifecycle lost its explicit connected service selection: %s", joined)
		}
	}
	env, err := os.ReadFile(filepath.Join(c.Root, "config", s.ReleaseID+".env"))
	if err != nil || !strings.Contains(string(env), "EMAIL_DELIVERY_ENABLED='true'\n") {
		t.Fatalf("selected delivery did not reach web configuration: %v", err)
	}
}

func TestOptionalServicesDefaultsNeverEnableDeliveryOrAmbientProfiles(t *testing.T) {
	for _, profile := range []string{"offline", "connected"} {
		c, s, fake := protocolReviewFixture(t, "")
		s.Profile = profile
		t.Setenv("COMPOSE_PROFILES", "mailbox,delivery")
		t.Setenv("EMAIL_DELIVERY_ENABLED", "true")
		m, err := c.manifest(s)
		if err != nil {
			t.Fatal(err)
		}
		if err = c.writeEnv(s, m); err != nil {
			t.Fatal(err)
		}
		if _, err = c.compose(context.Background(), s, nil, nil, "up", "-d"); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(strings.Join(fake.calls[0], " "), "--profile") {
			t.Fatal("an unselected profile was activated")
		}
		env, err := os.ReadFile(filepath.Join(c.Root, "config", s.ReleaseID+".env"))
		if err != nil || !strings.Contains(string(env), "EMAIL_DELIVERY_ENABLED='false'\n") {
			t.Fatalf("delivery default was not explicitly disabled: %v", err)
		}
		for _, value := range commandEnvironment() {
			if strings.HasPrefix(value, "COMPOSE_PROFILES=") || strings.HasPrefix(value, "EMAIL_DELIVERY_ENABLED=") {
				t.Fatal("ambient service choice could override persisted configuration")
			}
		}
	}
}

func TestOptionalServicesOldFleetAndCandidateUseTheirOwnSelection(t *testing.T) {
	c, previous, fake := protocolReviewFixture(t, "")
	previous.Profile, previous.OptionalServices = "connected", []string{"mailbox"}
	candidate := previous
	candidate.OptionalServices = []string{"delivery"}
	for _, step := range []struct {
		installation Installation
		action       string
	}{{previous, "down"}, {candidate, "up"}} {
		if _, err := c.compose(context.Background(), step.installation, nil, nil, step.action); err != nil {
			t.Fatal(err)
		}
	}
	oldCommand, newCommand := strings.Join(fake.calls[0], " "), strings.Join(fake.calls[1], " ")
	if !strings.Contains(oldCommand, "--profile mailbox down") || strings.Contains(oldCommand, "--profile delivery") {
		t.Fatalf("old fleet shutdown used candidate service options: %s", oldCommand)
	}
	if !strings.Contains(newCommand, "--profile delivery up") || strings.Contains(newCommand, "--profile mailbox") {
		t.Fatalf("candidate startup used previous service options: %s", newCommand)
	}
}

func TestOptionalServicesMalformedPersistedStateNeverStartsOrWritesEnvironment(t *testing.T) {
	for _, tc := range []struct {
		profile  string
		services []string
	}{
		{"offline", []string{"mailbox"}}, {"connected", []string{"cloud"}},
		{"connected", []string{"delivery", "delivery"}}, {"unexpected", nil},
	} {
		c, s, fake := protocolReviewFixture(t, "")
		s.Profile, s.OptionalServices = tc.profile, tc.services
		m, err := c.manifest(s)
		if err != nil {
			t.Fatal(err)
		}
		if err = writeJSON(c.statePath(), s); err != nil {
			t.Fatal(err)
		}
		if _, err = c.load(); err == nil {
			t.Fatal("malformed service configuration was loaded")
		}
		if err = c.writeEnv(s, m); err == nil {
			t.Fatal("malformed service configuration wrote generated environment")
		}
		if _, err = c.compose(context.Background(), s, nil, nil, "up", "-d"); err == nil || len(fake.calls) != 0 {
			t.Fatal("malformed journal/backup service configuration invoked Docker")
		}
	}
}

func TestOptionalServicesRestoreRetainsSelectionThroughActivationAndInterruption(t *testing.T) {
	c, j, m, fake := restoreProtocolFixture(t)
	j.Candidate.Profile = "connected"
	j.Candidate.OptionalServices = []string{"mailbox", "delivery"}
	// The encrypted inventory embeds Installation. Exercise its JSON contract,
	// then the real restore continuation through the durable activation boundary.
	encoded, err := json.Marshal(BackupInventory{Format: 1, Installation: *j.Candidate})
	if err != nil {
		t.Fatal(err)
	}
	var restored BackupInventory
	if err = decodeJSON(encoded, &restored); err != nil {
		t.Fatal(err)
	}
	j.Candidate = &restored.Installation
	err = c.finishRestore(context.Background(), j, m)
	if err == nil || !strings.Contains(err.Error(), "synthetic qualification stop") {
		t.Fatalf("unexpected restore continuation result: %v", err)
	}
	for _, call := range fake.calls {
		if !strings.Contains(strings.Join(call, " "), "--profile mailbox --profile delivery") {
			t.Fatalf("restore command lost original optional services: %v", call)
		}
	}
	stored, err := c.load()
	if err != nil || !reflect.DeepEqual(stored.OptionalServices, []string{"mailbox", "delivery"}) || stored.Generation != 3 {
		t.Fatalf("restored activation did not preserve service configuration: %+v %v", stored, err)
	}
	if j.Phase != "candidate-starting" {
		t.Fatal("unqualified restore must remain behind its recorded resume boundary")
	}
}

func TestOptionalServicesOfflineRestoreJournalCannotActivateCollectors(t *testing.T) {
	c, j, m, fake := restoreProtocolFixture(t)
	j.Candidate.OptionalServices = []string{"mailbox"}
	if err := c.finishRestore(context.Background(), j, m); err == nil || !strings.Contains(err.Error(), "offline") {
		t.Fatalf("offline restore service injection accepted: %v", err)
	}
	if len(fake.calls) != 0 {
		t.Fatal("invalid restore journal invoked runtime before service validation")
	}
}

type optionalUpdateCommander struct {
	state  Lifecycle
	images map[string]string
	calls  [][]string
}

func (f *optionalUpdateCommander) Run(_ context.Context, _ io.Reader, _ io.Writer, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
	command := strings.Join(args, " ")
	if name == "dpkg-deb" {
		return []byte("docker-ce\t1:1.0\tamd64"), nil
	}
	if name == "dpkg-query" {
		return []byte("1:1.0\tamd64"), nil
	}
	if strings.Contains(command, "{{json .Config.Env}}") {
		return []byte(`["PG_MAJOR=17"]`), nil
	}
	if strings.HasPrefix(command, "image inspect ") {
		return []byte(f.images[args[len(args)-1]]), nil
	}
	if strings.Contains(command, "dist-ops/lifecycle.js status") {
		return json.Marshal(f.state)
	}
	if strings.Contains(command, "down --timeout 90") {
		return nil, fmt.Errorf("synthetic old fleet stop boundary")
	}
	if strings.Contains(command, "exec -T web node") {
		return nil, fmt.Errorf("synthetic candidate qualification boundary")
	}
	return nil, nil
}

func optionalUpdateFixture(t *testing.T, activated bool) (Controller, *Journal, *optionalUpdateCommander) {
	t.Helper()
	c, previous, _ := protocolReviewFixture(t, "")
	previous.Profile, previous.OptionalServices = "connected", []string{"mailbox", "delivery"}
	nextSource, nextManifest := fixture(t)
	nextManifest.ReleaseID, nextManifest.Sequence = "2.0.0", 2
	saveManifest(t, nextSource, nextManifest)
	if err := os.Rename(nextSource, filepath.Join(c.Root, "releases", nextManifest.ReleaseID)); err != nil {
		t.Fatal(err)
	}
	candidate := previous
	candidate.ReleaseID, candidate.Sequence = nextManifest.ReleaseID, nextManifest.Sequence
	backup := filepath.Join(t.TempDir(), "SYNTHETIC-backup.age")
	data := []byte("SYNTHETIC authenticated prior recovery receipt")
	if err := os.WriteFile(backup, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(backup+".receipt.json", BackupReceipt{Format: 1, Status: "verified-export", Path: backup,
		SHA256: fingerprint(data), Size: int64(len(data)), ReleaseID: previous.ReleaseID, SchemaVersion: nextManifest.Schema.Target}); err != nil {
		t.Fatal(err)
	}
	j := &Journal{Operation: "update", ID: id(), Phase: "backup-complete", Previous: &previous, Candidate: &candidate,
		Backup: backup, BackupSHA: fingerprint(data), BackupSize: int64(len(data))}
	fake := &optionalUpdateCommander{state: Lifecycle{OK: true, Mode: "maintenance", Generation: previous.Generation,
		ActiveRelease: previous.ReleaseID, SchemaVersion: nextManifest.Schema.Target}, images: map[string]string{}}
	for _, image := range nextManifest.Images {
		fake.images[image.Reference] = image.ImageID
	}
	if activated {
		j.Phase = "resume-intent"
		fake.state.Mode, fake.state.ActiveRelease, fake.state.Generation = "open", candidate.ReleaseID, candidate.Generation+1
		if err := c.writeEnv(candidate, nextManifest); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.journal(j, j.Phase); err != nil {
		t.Fatal(err)
	}
	c.Commands = fake
	return c, j, fake
}

func TestOptionalServicesActualUpdateContinuationKeepsBothFleetSelections(t *testing.T) {
	for _, activated := range []bool{false, true} {
		c, _, fake := optionalUpdateFixture(t, activated)
		err := c.updateOperation(context.Background(), "", "", true)
		boundary := "synthetic old fleet stop boundary"
		if activated {
			boundary = "synthetic candidate qualification boundary"
		}
		if err == nil || !strings.Contains(err.Error(), boundary) {
			t.Fatalf("update did not reach its expected inert boundary: %v", err)
		}
		found := false
		for _, call := range fake.calls {
			command := strings.Join(call, " ")
			if !strings.HasPrefix(command, "docker compose ") {
				continue
			}
			if !strings.Contains(command, "--profile mailbox --profile delivery") {
				t.Fatalf("actual update lost persisted services: %s", command)
			}
			if !activated && strings.Contains(command, "down --timeout 90") {
				found = strings.Contains(command, "/releases/1.0.0/")
			}
			if activated && strings.HasSuffix(command, "up -d --wait --wait-timeout 300") {
				found = strings.Contains(command, "/releases/2.0.0/")
			}
		}
		if !found {
			t.Fatal("actual update did not select its old/candidate release at the required fleet boundary")
		}
	}
}

func TestOptionalServicesUpdateJournalCannotChangeNetworkPolicy(t *testing.T) {
	for _, change := range []func(*Installation){
		func(s *Installation) { s.OptionalServices = []string{"mailbox"} },
		func(s *Installation) { s.Profile, s.OptionalServices = "offline", nil },
	} {
		c, j, fake := optionalUpdateFixture(t, false)
		change(j.Candidate)
		if err := c.journal(j, j.Phase); err != nil {
			t.Fatal(err)
		}
		if err := c.updateOperation(context.Background(), "", "", true); err == nil || !strings.Contains(err.Error(), "cannot change") {
			t.Fatalf("update journal changed installed network policy: %v", err)
		}
		if len(fake.calls) != 0 {
			t.Fatal("policy-changing journal invoked runtime commands")
		}
	}
}
