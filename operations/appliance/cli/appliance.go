// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"filippo.io/age"
)

type Installation struct {
	Format            int      `json:"format"`
	Root              string   `json:"root"`
	ReleaseID         string   `json:"releaseId"`
	Sequence          int64    `json:"sequence"`
	Generation        int      `json:"generation"`
	Project           string   `json:"project"`
	Hostname          string   `json:"hostname"`
	Profile           string   `json:"profile"`
	OptionalServices  []string `json:"optionalServices,omitempty"`
	TLSMode           string   `json:"tlsMode"`
	RootSHA           string   `json:"rootSha256"`
	RecoveryRecipient string   `json:"recoveryRecipient"`
	InstalledAt       string   `json:"installedAt"`
	ManifestSHA       string   `json:"manifestSha256"`
	VerifiedAt        string   `json:"verifiedAt"`
}
type Journal struct {
	Operation            string        `json:"operation"`
	ID                   string        `json:"id"`
	Phase                string        `json:"phase"`
	Previous             *Installation `json:"previous,omitempty"`
	Candidate            *Installation `json:"candidate,omitempty"`
	Backup               string        `json:"backup,omitempty"`
	BackupSHA            string        `json:"backupSha256,omitempty"`
	BackupSize           int64         `json:"backupSize,omitempty"`
	ActivationID         string        `json:"activationId,omitempty"`
	ActivationGeneration int           `json:"activationGeneration,omitempty"`
	UpdatedAt            string        `json:"updatedAt"`
}
type Lifecycle struct {
	OK               bool   `json:"ok"`
	Mode             string `json:"mode"`
	Generation       int    `json:"generation"`
	ActiveRelease    string `json:"activeRelease"`
	SchemaVersion    int    `json:"schemaVersion"`
	ActiveOperations int    `json:"activeOperations"`
	ActiveLeases     struct {
		Total int `json:"total"`
	} `json:"activeLeases"`
	CanSeal bool `json:"canSeal"`
}
type Commander interface {
	Run(context.Context, io.Reader, io.Writer, string, ...string) ([]byte, error)
}
type systemCommands struct{}
type boundedBuffer struct {
	bytes.Buffer
	max int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := b.max - b.Len()
	if remaining > 0 {
		b.Buffer.Write(p[:min(n, remaining)])
	}
	return n, nil
}
func (systemCommands) Run(ctx context.Context, in io.Reader, out io.Writer, name string, args ...string) ([]byte, error) {
	allowed := map[string]bool{"docker": true, "apt-get": true, "dpkg-deb": true, "dpkg-query": true, "systemctl": true, "systemd-analyze": true, "getent": true, "systemd-sysusers": true}
	if !allowed[name] {
		return nil, fmt.Errorf("unsupported appliance command")
	}
	cmd := exec.CommandContext(ctx, "/usr/bin/"+name, args...)
	cmd.Stdin = in
	var stdout boundedBuffer
	stdout.max = 2 << 20
	var stderr boundedBuffer
	stderr.max = 64 << 10
	cmd.Stdout = &stdout
	if out != nil {
		cmd.Stdout = out
	}
	cmd.Stderr = &stderr
	cmd.Env = commandEnvironment()
	if e := cmd.Run(); e != nil {
		if name == "getent" {
			// A keyed NSS miss is safe to classify only when no partial
			// record was returned. This buffer is inspected privately and
			// never included in the error or account receipt.
			return stdout.Bytes(), fmt.Errorf("getent command failed (%w)", e)
		}
		return nil, fmt.Errorf("%s command failed (%w); inspect local service logs without sharing secrets", filepath.Base(name), e)
	}
	return stdout.Bytes(), nil
}

// Compose gives process environment precedence over --env-file. Never inherit
// arbitrary caller values (image references, hostname, model, paths, or ports).
func commandEnvironment() []string {
	return []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "LANG=C", "LC_ALL=C", "DEBIAN_FRONTEND=noninteractive", "DOCKER_HOST=unix:///var/run/docker.sock", "DOCKER_CONFIG=/var/empty/aster-docker", "COMPOSE_DISABLE_ENV_FILE=1"}
}

type Controller struct {
	Root     string
	Commands Commander
}

func (c Controller) statePath() string { return filepath.Join(c.Root, "installation.json") }
func (c Controller) load() (Installation, error) {
	var s Installation
	b, e := os.ReadFile(c.statePath())
	if e != nil {
		return s, e
	}
	e = decodeJSON(b, &s)
	if e == nil && (s.Format != 1 || s.Root != c.Root || !identifier.MatchString(s.ReleaseID) || !identifier.MatchString(s.Project) || s.Generation < 1) {
		e = fmt.Errorf("invalid installation state")
	}
	if e == nil {
		e = validateOptionalServices(s.Profile, s.OptionalServices)
	}
	return s, e
}
func (c Controller) journal(j *Journal, phase string) error {
	j.Phase = phase
	j.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	return writeJSON(filepath.Join(c.Root, "journal.json"), j)
}
func (c Controller) lock() (func(), error) {
	if !filepath.IsAbs(c.Root) || strings.ContainsAny(c.Root, "\r\n$:") {
		return nil, fmt.Errorf("installation root must be a safe absolute path")
	}
	if e := os.MkdirAll(c.Root, 0700); e != nil {
		return nil, e
	}
	st, e := os.Lstat(c.Root)
	if e != nil {
		return nil, e
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 || st.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("installation root must be a private directory (0700)")
	}
	// Ancestors may not be symlinks: mounts and secret paths must remain stable.
	resolved, e := filepath.EvalSymlinks(c.Root)
	if e != nil {
		return nil, e
	}
	if resolved != filepath.Clean(c.Root) {
		return nil, fmt.Errorf("installation root may not contain symlinks")
	}
	f, e := os.OpenFile(filepath.Join(c.Root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, fmt.Errorf("another appliance operation is running")
	}
	return func() { syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}
func (c Controller) release(s Installation) string {
	return filepath.Join(c.Root, "releases", s.ReleaseID)
}
func (c Controller) manifest(s Installation) (*Manifest, error) {
	b, e := os.ReadFile(filepath.Join(c.release(s), "release.json"))
	if e != nil {
		return nil, e
	}
	var m Manifest
	if e = decodeJSON(b, &m); e != nil {
		return nil, e
	}
	return &m, m.Validate()
}
func (c Controller) compose(ctx context.Context, s Installation, in io.Reader, out io.Writer, args ...string) ([]byte, error) {
	if e := validateOptionalServices(s.Profile, s.OptionalServices); e != nil {
		return nil, e
	}
	m, e := c.manifest(s)
	if e != nil {
		return nil, e
	}
	file := m.Compose.Offline
	if s.Profile == "connected" {
		file = m.Compose.Connected
	}
	base := []string{"compose", "--project-name", s.Project, "--env-file", filepath.Join(c.Root, "config", s.ReleaseID+".env"), "--file", filepath.Join(c.release(s), file)}
	for _, service := range s.OptionalServices {
		base = append(base, "--profile", service)
	}
	start, stop := ingressComposeAction(args)
	var ingress ingressManager
	var binary string
	if m.Ingress == unixIngress && (start || stop) {
		ingress, e = c.ingressManager()
		if e != nil {
			return nil, e
		}
		binary = filepath.Join(c.release(s), "payload/bin/asterctl")
		if start {
			binary, e = c.verifiedIngressBinary(s, m)
			if e != nil {
				return nil, e
			}
			// systemd requires an actual static account even for numeric User=.
			// Provision before Docker sees the socket directory; continuation
			// revalidates the exact locked identity instead of adopting another UID.
			if _, e = ensureIngressAccount(ctx, c.Commands); e != nil {
				return nil, e
			}
			if e = ingress.prepare(); e != nil {
				return nil, e
			}
		}
		if stop {
			if e = ingress.stop(ctx, binary); e != nil {
				return nil, e
			}
		}
	}
	result, e := c.Commands.Run(ctx, in, out, "docker", append(base, args...)...)
	if e != nil {
		return result, e
	}
	if m.Ingress == unixIngress && start {
		if e = ingress.start(ctx, binary); e != nil {
			return result, e
		}
	}
	return result, nil
}
func (c Controller) writeEnv(s Installation, m *Manifest) error {
	if e := validateOptionalServices(s.Profile, s.OptionalServices); e != nil {
		return e
	}
	vars := map[string]string{"ASTER_PROJECT_NAME": s.Project, "ASTER_DATA_ROOT": filepath.Join(c.Root, "data"), "ASTER_RELEASE_ROOT": c.release(s), "ASTER_RELEASE_ID": s.ReleaseID, "ASTER_WRITER_GENERATION": strconv.Itoa(s.Generation), "ASTER_SCHEMA_MIN": strconv.Itoa(m.Schema.Min), "ASTER_SCHEMA_MAX": strconv.Itoa(m.Schema.Max), "ASTER_DOMAIN": s.Hostname, "BETTER_AUTH_URL": "https://" + s.Hostname, "ASTER_TLS_MODE": s.TLSMode, "OLLAMA_MODEL": m.Model.Name}
	vars["EMAIL_DELIVERY_ENABLED"] = strconv.FormatBool(s.hasOptionalService("delivery"))
	if m.Ingress == unixIngress {
		vars["ASTER_INGRESS_ROOT"] = filepath.Join(c.Root, "run", "ingress-sockets")
	}
	vars["MAILBOX_OAUTH_TRANSPORT"] = "disabled"
	if s.hasOptionalService("mailbox") {
		vars["MAILBOX_OAUTH_TRANSPORT"] = "broker"
	}
	names := map[string]string{"app": "ASTER_IMAGE", "processor": "PROCESSOR_IMAGE", "postgres": "POSTGRES_IMAGE", "ollama": "OLLAMA_IMAGE", "caddy": "CADDY_IMAGE"}
	for _, im := range m.Images {
		vars[names[im.Service]] = im.Reference
	}
	var keys []string
	for key := range vars {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		v := vars[key]
		if strings.ContainsAny(v, "\r\n$'\\") {
			return fmt.Errorf("invalid environment value: %s", key)
		}
		fmt.Fprintf(&b, "%s='%s'\n", key, v)
	}
	if e := c.ensureMailboxBrokerSecret(s); e != nil {
		return e
	}
	return atomicWrite(filepath.Join(c.Root, "config", s.ReleaseID+".env"), []byte(b.String()), 0600)
}
func (c Controller) lifecycle(ctx context.Context, s Installation, action string, args ...string) (Lifecycle, error) {
	var result Lifecycle
	b, e := c.compose(ctx, s, nil, nil, append([]string{"run", "--rm", "--no-deps", "-T", "migrate", "node", "dist-ops/lifecycle.js", action}, args...)...)
	if e != nil {
		return result, e
	}
	// Operational command emits one JSON object. Unexpected output fails closed.
	if e = json.Unmarshal(bytes.TrimSpace(b), &result); e != nil {
		return result, fmt.Errorf("invalid lifecycle response: %w", e)
	}
	if !result.OK || result.Generation < 1 {
		return result, fmt.Errorf("lifecycle operation refused")
	}
	return result, nil
}
func (c Controller) seal(ctx context.Context, s Installation, j *Journal) (Lifecycle, error) {
	state, e := c.lifecycle(ctx, s, "status")
	if e != nil {
		return state, e
	}
	if state.Mode == "maintenance" {
		return state, nil
	}
	if e = c.journal(j, "drain-requested"); e != nil {
		return state, e
	}
	state, e = c.lifecycle(ctx, s, "drain", "--expected-generation", strconv.Itoa(state.Generation), "--request-id", j.ID)
	if e != nil {
		return state, e
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for !state.CanSeal {
		select {
		case <-ctx.Done():
			return state, fmt.Errorf("drain timed out; installation remains read only: %w", ctx.Err())
		case <-ticker.C:
		}
		state, e = c.lifecycle(ctx, s, "status")
		if e != nil {
			return state, e
		}
	}
	state, e = c.lifecycle(ctx, s, "seal", "--expected-generation", strconv.Itoa(state.Generation))
	if e != nil {
		return state, e
	}
	return state, c.journal(j, "sealed")
}
func id() string {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func platformPreflight() error {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		return fmt.Errorf("installation requires qualified Linux amd64; verification and recovery inspection are portable")
	}
	if os.Geteuid() != 0 {
		return fmt.Errorf("installation needs root for private bind mounts and the local container runtime")
	}
	b, e := os.ReadFile("/etc/os-release")
	if e != nil {
		return e
	}
	fields := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok {
			fields[key] = strings.Trim(value, "\"")
		}
	}
	if fields["ID"] != "ubuntu" || fields["VERSION_ID"] != "24.04" {
		return fmt.Errorf("this bundle supports Ubuntu 24.04 amd64 only")
	}
	memory, e := os.ReadFile("/proc/meminfo")
	if e != nil {
		return e
	}
	var kib uint64
	for _, line := range strings.Split(string(memory), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				kib, _ = strconv.ParseUint(parts[1], 10, 64)
			}
		}
	}
	if kib*1024 < 31<<30 {
		return fmt.Errorf("this appliance profile requires a 32 GiB RAM host (at least 31 GiB visible); smaller model smoke tests are separate")
	}
	return nil
}
func freeSpace(p string, required uint64) error {
	var stat syscall.Statfs_t
	if e := syscall.Statfs(p, &stat); e != nil {
		return e
	}
	available := stat.Bavail * uint64(stat.Bsize)
	if available < required {
		return fmt.Errorf("insufficient disk: need %d GiB free, have %d GiB", required>>30, available>>30)
	}
	return nil
}
func (c Controller) runtime(ctx context.Context, m *Manifest, release string, install bool) error {
	var debs []string
	for _, p := range m.Runtime.Packages {
		deb := filepath.Join(release, p.Path)
		b, e := c.Commands.Run(ctx, nil, nil, "dpkg-deb", "--show", "--showformat=${Package}\t${Version}\t${Architecture}", deb)
		if e != nil {
			return e
		}
		if string(b) != p.Name+"\t"+p.Version+"\t"+p.Architecture {
			return fmt.Errorf("Debian package metadata differs from signed inventory: %s", p.Name)
		}
		debs = append(debs, deb)
	}
	if install {
		args := append([]string{"--simulate", "--no-download", "--no-remove", "--no-install-recommends", "install"}, debs...)
		if _, e := c.Commands.Run(ctx, nil, nil, "apt-get", args...); e != nil {
			return fmt.Errorf("offline runtime closure simulation failed: %w", e)
		}
		args = append([]string{"--assume-yes", "--no-download", "--no-remove", "--no-install-recommends", "install"}, debs...)
		if _, e := c.Commands.Run(ctx, nil, nil, "apt-get", args...); e != nil {
			return e
		}
	}
	for _, p := range m.Runtime.Packages {
		b, e := c.Commands.Run(ctx, nil, nil, "dpkg-query", "--show", "--showformat=${Version}\t${Architecture}", p.Name)
		if e != nil {
			return fmt.Errorf("missing runtime package %s; use --install-runtime on the dedicated server", p.Name)
		}
		if string(b) != p.Version+"\t"+p.Architecture {
			return fmt.Errorf("runtime version mismatch: %s", p.Name)
		}
	}
	if _, e := c.Commands.Run(ctx, nil, nil, "docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"); e != nil {
		return e
	}
	return nil
}
func (c Controller) loadImages(ctx context.Context, m *Manifest, release string) error {
	for _, im := range m.Images {
		if _, e := c.Commands.Run(ctx, nil, nil, "docker", "image", "load", "--input", filepath.Join(release, im.Path)); e != nil {
			return e
		}
		b, e := c.Commands.Run(ctx, nil, nil, "docker", "image", "inspect", "--format", "{{.Id}}", im.Reference)
		if e != nil {
			return e
		}
		if strings.TrimSpace(string(b)) != im.ImageID {
			return fmt.Errorf("loaded image identity mismatch: %s", im.Service)
		}
	}
	return nil
}
func (c Controller) stage(bundle, rootPath, rootSHA string) (*Manifest, error) {
	temp, e := os.MkdirTemp(c.Root, ".verification-")
	if e != nil {
		return nil, e
	}
	defer os.RemoveAll(temp)
	if e = cloneCache(filepath.Join(c.Root, "trust", "metadata"), filepath.Join(temp, "metadata")); e != nil {
		return nil, e
	}
	m, e := verifyBundle(bundle, rootPath, rootSHA, filepath.Join(temp, "metadata"))
	if e != nil {
		return nil, e
	}
	rootCopy := filepath.Join(temp, "initial-root.json")
	if e = atomicWrite(rootCopy, m.trustedRoot, 0600); e != nil {
		return nil, e
	}
	dest := filepath.Join(c.Root, "releases", m.ReleaseID)
	if st, err := os.Lstat(dest); err == nil {
		if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("existing release path is not a private directory")
		}
		r, err := os.OpenRoot(dest)
		if err != nil {
			return nil, err
		}
		stored, err := boundedRead(r, "release.json", 8<<20)
		r.Close()
		if err != nil {
			return nil, err
		}
		if fingerprint(stored) != fingerprint(m.raw) {
			return nil, fmt.Errorf("immutable release ID already contains a different manifest")
		}
		if _, err = verifyBundle(dest, rootCopy, rootSHA, filepath.Join(temp, "metadata")); err != nil {
			return nil, fmt.Errorf("existing release cannot be safely reused: %w", err)
		}
		if err = cloneCache(filepath.Join(temp, "metadata"), filepath.Join(c.Root, "trust", "metadata")); err != nil {
			return nil, err
		}
		return m, nil
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	var needed uint64 = 10 << 30
	for _, f := range m.Files {
		needed += uint64(f.Size) * 2
	}
	if e = freeSpace(c.Root, needed); e != nil {
		return nil, e
	}
	if e = os.MkdirAll(filepath.Dir(dest), 0700); e != nil {
		return nil, e
	}
	stage := filepath.Join(c.Root, "releases", ".stage-"+id())
	defer os.RemoveAll(stage)
	if e = copyVerified(bundle, stage, m); e != nil {
		return nil, e
	}
	// Preserve signed metadata and exact original manifest, not reserialized JSON.
	if e = atomicWrite(filepath.Join(stage, "release.json"), m.raw, 0644); e != nil {
		return nil, e
	}
	if e = cloneCache(filepath.Join(bundle, "metadata"), filepath.Join(stage, "metadata")); e != nil {
		return nil, e
	}
	recheck := filepath.Join(temp, "recheck-metadata")
	if e = cloneCache(filepath.Join(temp, "metadata"), recheck); e != nil {
		return nil, e
	}
	if _, e = verifyBundle(stage, rootCopy, rootSHA, recheck); e != nil {
		return nil, fmt.Errorf("staged release verification failed: %w", e)
	}
	if e = syncTreeDirectories(stage); e != nil {
		return nil, e
	}
	if e = os.Rename(stage, dest); e != nil {
		return nil, e
	}
	if e = syncDirectory(filepath.Dir(dest)); e != nil {
		return nil, e
	}
	if e = cloneCache(recheck, filepath.Join(c.Root, "trust", "metadata")); e != nil {
		return nil, e
	}
	return m, nil
}
func (c Controller) initData() error {
	for name, uid := range map[string]int{"postgres": 999, "archive": 1000, "intake": 1000, "ollama": 10001, "caddy/data": 10001, "caddy/config": 10001, "caddy/tls": 10001, "receipts": 1000, "health": 1000, "secrets": 0} {
		p := filepath.Join(c.Root, "data", name)
		if e := os.MkdirAll(p, 0700); e != nil {
			return e
		}
		if e := os.Chown(p, uid, uid); e != nil {
			return e
		}
	}
	for _, name := range []string{"postgres_password", "migration_password", "runtime_password", "better_auth_secret", "processor_token", "encryption_key", "encryption_keyring", "mailbox_providers", "smtp_settings"} {
		b := make([]byte, 32)
		if _, e := rand.Read(b); e != nil {
			return e
		}
		value := hex.EncodeToString(b)
		if name == "encryption_key" {
			value = base64.StdEncoding.EncodeToString(b)
		}
		if strings.HasSuffix(name, "_settings") || name == "encryption_keyring" || name == "mailbox_providers" {
			value = "{}"
		}
		p := filepath.Join(c.Root, "data", "secrets", name)
		if st, err := os.Lstat(p); err == nil {
			if !st.Mode().IsRegular() || st.Size() < 2 || st.Size() > 65536 {
				return fmt.Errorf("existing secret is invalid; never regenerate keys automatically: %s", name)
			}
			if err = os.Chmod(p, 0444); err != nil {
				return err
			}
			continue
		} else if !os.IsNotExist(err) {
			return err
		}
		f, e := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0444)
		if e != nil {
			return e
		}
		_, e = f.WriteString(value + "\n")
		if e == nil {
			e = f.Sync()
		}
		f.Close()
		if e != nil {
			return e
		}
	}
	return nil
}
func (c Controller) importModel(s Installation, m *Manifest) error {
	source, e := os.OpenRoot(c.release(s))
	if e != nil {
		return e
	}
	defer source.Close()
	destination, e := os.OpenRoot(filepath.Join(c.Root, "data", "ollama"))
	if e != nil {
		return e
	}
	defer destination.Close()
	for _, p := range m.Model.Files {
		relative := strings.TrimPrefix(p, "payload/models/ollama/")
		parent := filepath.Dir(relative)
		if e = destination.MkdirAll(parent, 0755); e != nil {
			return e
		}
		src, err := openRegular(source, p)
		if err != nil {
			return err
		}
		temporary := filepath.Join(parent, ".aster-model-"+id())
		out, err := destination.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err != nil {
			src.Close()
			return err
		}
		_, e = io.Copy(out, src)
		src.Close()
		if e == nil {
			e = out.Chown(10001, 10001)
		}
		if e == nil {
			e = out.Sync()
		}
		out.Close()
		if e != nil {
			return e
		}
		if e = destination.Rename(temporary, relative); e != nil {
			return e
		}
	}
	return syncTreeDirectories(filepath.Join(c.Root, "data", "ollama"))
}
func (c Controller) qualify(ctx context.Context, s Installation, m *Manifest) error {
	// Run from web's internal namespace: no host-exposed database or model API.
	script := `const r=await fetch('http://ollama:11434/api/tags');if(!r.ok)process.exit(2);const d=await r.json();if(!d.models.some(x=>x.name===process.argv[1]&&x.digest===process.argv[2]))process.exit(3);const h=await fetch('http://127.0.0.1:3000/api/health');if(!h.ok)process.exit(4);const v=await h.json();if(v.release!==process.argv[3]||v.writerGeneration!==Number(process.argv[4])||v.lifecycle.activeRelease!==process.argv[3]||v.lifecycle.generation!==Number(process.argv[4]))process.exit(5);`
	_, e := c.compose(ctx, s, nil, nil, "exec", "-T", "web", "node", "--input-type=module", "-e", script, m.Model.Name, strings.TrimPrefix(m.Model.Digest, "sha256:"), s.ReleaseID, strconv.Itoa(s.Generation))
	if e != nil {
		return e
	}
	return c.checkTLS(ctx, s)
}
func (c Controller) checkTLS(ctx context.Context, s Installation) error {
	p := filepath.Join(c.Root, "data/caddy/data/caddy/pki/authorities/local/root.crt")
	if s.TLSMode == "supplied" {
		p = filepath.Join(c.Root, "data/caddy/tls/server.crt")
	}
	b, e := os.ReadFile(p)
	if e != nil {
		return fmt.Errorf("local HTTPS trust material is unavailable: %w", e)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(b) {
		return fmt.Errorf("invalid HTTPS trust material")
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: s.Hostname}, Proxy: nil, DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, "127.0.0.1:443")
	}}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return fmt.Errorf("unexpected HTTPS redirect") }}
	request, e := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+s.Hostname+"/api/health", nil)
	if e != nil {
		return e
	}
	response, e := client.Do(request)
	if e != nil {
		return fmt.Errorf("HTTPS certificate/hostname/health check failed: %w", e)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("HTTPS health returned %d", response.StatusCode)
	}
	var health struct {
		Release    string    `json:"release"`
		Generation int       `json:"writerGeneration"`
		Lifecycle  Lifecycle `json:"lifecycle"`
	}
	if e = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&health); e != nil {
		return fmt.Errorf("invalid HTTPS health response")
	}
	if health.Release != s.ReleaseID || health.Generation != s.Generation || health.Lifecycle.ActiveRelease != s.ReleaseID || health.Lifecycle.Generation != s.Generation {
		return fmt.Errorf("HTTPS serves an unexpected application release or writer generation")
	}
	return nil
}
func (c Controller) Install(ctx context.Context, opt InstallOptions) error {
	if opt.Continue && len(opt.OptionalServices) != 0 {
		return fmt.Errorf("continue-install preserves the original optional services; they cannot be changed")
	}
	if !opt.Continue {
		if e := validateOptionalServices(opt.Profile, opt.OptionalServices); e != nil {
			return e
		}
	}
	if e := platformPreflight(); e != nil {
		return e
	}
	unlock, e := c.lock()
	if e != nil {
		return e
	}
	defer unlock()
	var s Installation
	var j Journal
	var m *Manifest
	if opt.Continue {
		b, err := os.ReadFile(filepath.Join(c.Root, "journal.json"))
		if err != nil {
			return err
		}
		if e = decodeJSON(b, &j); e != nil {
			return e
		}
		if j.Operation != "install" || j.Phase == "complete" || j.Candidate == nil {
			return fmt.Errorf("there is no interrupted installation to continue")
		}
		s = *j.Candidate
		if e = validateOptionalServices(s.Profile, s.OptionalServices); e != nil {
			return e
		}
		m, e = c.manifest(s)
		if e != nil {
			return e
		}
		initial, err := os.ReadFile(filepath.Join(c.Root, "trust", "initial-root.json"))
		if err != nil {
			return err
		}
		if e = verifyRecoveryRelease(c.release(s), initial, s); e != nil {
			return e
		}
	} else {
		if _, e = os.Stat(c.statePath()); !os.IsNotExist(e) {
			return fmt.Errorf("installation already exists or cannot be inspected")
		}
		if _, e = os.Stat(filepath.Join(c.Root, "journal.json")); !os.IsNotExist(e) {
			return fmt.Errorf("unfinished installation exists; inspect status and use continue-install")
		}
		if !validHostname(opt.Hostname) || (opt.Profile != "offline" && opt.Profile != "connected") || (opt.TLSMode != "internal" && opt.TLSMode != "supplied") {
			return fmt.Errorf("invalid hostname, profile, or TLS mode")
		}
		if _, e = age.ParseX25519Recipient(opt.Recipient); e != nil {
			return fmt.Errorf("a valid external recovery recipient is required")
		}
		m, e = c.stage(opt.Bundle, opt.TrustRoot, opt.TrustSHA)
		if e != nil {
			return e
		}
		s = Installation{Format: 1, Root: c.Root, ReleaseID: m.ReleaseID, Sequence: m.Sequence, Generation: 1, Project: "aster-" + id()[:8], Hostname: opt.Hostname, Profile: opt.Profile, TLSMode: opt.TLSMode, RootSHA: opt.TrustSHA, RecoveryRecipient: opt.Recipient, InstalledAt: time.Now().UTC().Format(time.RFC3339), ManifestSHA: fingerprint(m.raw), VerifiedAt: time.Now().UTC().Format(time.RFC3339)}
		s.OptionalServices = append([]string(nil), opt.OptionalServices...)
		if e = atomicWrite(filepath.Join(c.Root, "trust", "initial-root.json"), m.trustedRoot, 0644); e != nil {
			return e
		}
		j = Journal{Operation: "install", ID: id(), Candidate: &s}
		if e = c.journal(&j, "verified"); e != nil {
			return e
		}
	}
	j.Candidate = &s
	if e = c.runtime(ctx, m, c.release(s), opt.InstallRuntime); e != nil {
		return e
	}
	if e = c.ensureMailboxBrokerSecret(s); e != nil {
		return e
	}
	if opt.Continue && (j.Phase == "candidate-starting" || j.Phase == "resume-intent") {
		if _, e = c.compose(ctx, s, nil, nil, "up", "-d", "--wait", "--wait-timeout", "180", "postgres"); e != nil {
			return e
		}
		state, err := c.lifecycle(ctx, s, "status")
		if err != nil {
			return err
		}
		if state.ActiveRelease == s.ReleaseID && state.Mode == "open" {
			s.Generation = state.Generation
			j.Candidate = &s
			if e = c.writeEnv(s, m); e != nil {
				return e
			}
			if _, e = c.compose(ctx, s, nil, nil, "up", "-d", "--wait", "--wait-timeout", "300"); e != nil {
				return e
			}
			if e = c.qualify(ctx, s, m); e != nil {
				return e
			}
			if e = writeJSON(c.statePath(), s); e != nil {
				return e
			}
			return c.journal(&j, "complete")
		}
	}
	if e = c.initData(); e != nil {
		return e
	}
	if s.TLSMode == "supplied" {
		if _, err := os.Stat(filepath.Join(c.Root, "data/caddy/tls/server.key")); os.IsNotExist(err) {
			if e = c.installTLS(opt.CertFile, opt.KeyFile); e != nil {
				return e
			}
		} else if err != nil {
			return err
		}
	}
	if e = c.writeEnv(s, m); e != nil {
		return e
	}
	if e = c.loadImages(ctx, m, c.release(s)); e != nil {
		return e
	}
	if opt.Continue {
		if _, e = c.compose(ctx, s, nil, nil, "stop", "--timeout", "90", "caddy", "ollama"); e != nil {
			return e
		}
	}
	if e = c.importModel(s, m); e != nil {
		return e
	}
	if e = c.journal(&j, "assets-imported"); e != nil {
		return e
	}
	if _, e = c.compose(ctx, s, nil, nil, "up", "-d", "--wait", "--wait-timeout", "180", "postgres"); e != nil {
		return e
	}
	if _, e = c.compose(ctx, s, nil, nil, "run", "--rm", "--no-deps", "-T", "migrate"); e != nil {
		return e
	}
	state, e := c.seal(ctx, s, &j)
	if e != nil {
		return e
	}
	if state.ActiveRelease != s.ReleaseID {
		state, e = c.lifecycle(ctx, s, "activate", "--release", s.ReleaseID, "--expected-generation", strconv.Itoa(state.Generation))
		if e != nil {
			return e
		}
	}
	s.Generation = state.Generation
	if e = c.writeEnv(s, m); e != nil {
		return e
	}
	if e = writeJSON(c.statePath(), s); e != nil {
		return e
	}
	if e = c.journal(&j, "candidate-starting"); e != nil {
		return e
	}
	if _, e = c.compose(ctx, s, nil, nil, "up", "-d", "--wait", "--wait-timeout", "300"); e != nil {
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

type InstallOptions struct {
	Bundle, TrustRoot, TrustSHA, Hostname, Profile, TLSMode, Recipient, CertFile, KeyFile string
	OptionalServices                                                                      []string
	InstallRuntime, Continue                                                              bool
}

func validHostname(s string) bool {
	if len(s) == 0 || len(s) > 253 || strings.HasPrefix(s, "-") || strings.HasSuffix(s, ".") {
		return false
	}
	for _, part := range strings.Split(s, ".") {
		if len(part) == 0 || len(part) > 63 || strings.HasPrefix(part, "-") || strings.HasSuffix(part, "-") {
			return false
		}
		for _, r := range part {
			if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
				return false
			}
		}
	}
	return true
}
func (c Controller) installTLS(cert, key string) error {
	for name, src := range map[string]string{"server.crt": cert, "server.key": key} {
		if src == "" {
			return errors.New("supplied TLS requires --tls-cert and --tls-key")
		}
		b, e := os.ReadFile(src)
		if e != nil {
			return e
		}
		p := filepath.Join(c.Root, "data", "caddy", "tls", name)
		if e = atomicWrite(p, b, 0400); e != nil {
			return e
		}
		if e = os.Chown(p, 10001, 10001); e != nil {
			return e
		}
	}
	return nil
}
func fingerprint(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
