// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"debug/elf"
	"embed"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

//go:embed ingress_templates/*.unit
var ingressTemplates embed.FS

const unixIngress = "systemd-unix-v1"

var ingressHostPath = regexp.MustCompile(`^/[A-Za-z0-9._/-]+$`)

type ingressUnitReceipt struct {
	Format int               `json:"format"`
	Root   string            `json:"root"`
	Files  map[string]string `json:"files"`
}

// The injectable filesystem roots and owners are private test seams. Production
// always uses root-owned /etc/systemd/system and the fixed confined service UID.
type ingressManager struct {
	root, units                              string
	owner, group, serviceOwner, serviceGroup int
	commands                                 Commander
}

func (c Controller) ingressManager() (ingressManager, error) {
	if os.Geteuid() != 0 {
		return ingressManager{}, fmt.Errorf("appliance ingress configuration requires the root controller")
	}
	return ingressManager{root: c.Root, units: "/etc/systemd/system", owner: 0, group: 0, serviceOwner: 10001, serviceGroup: 10001, commands: c.Commands}, nil
}

func ingressUnitBase(root string) string { return "aster-ingress-" + fingerprint([]byte(root))[:16] }

func renderIngressUnits(root, binary string) (map[string][]byte, error) {
	for _, p := range []string{root, binary} {
		if !ingressHostPath.MatchString(p) || filepath.Clean(p) != p || p == "/" || len(p) > 4096 {
			return nil, fmt.Errorf("ingress requires canonical absolute paths containing only letters, numbers, slash, dot, dash and underscore")
		}
	}
	if !strings.HasPrefix(binary, root+"/releases/") || !strings.HasSuffix(binary, "/payload/bin/asterctl") {
		return nil, fmt.Errorf("ingress must execute the verified release controller")
	}
	base := ingressUnitBase(root)
	units := map[string][]byte{}
	for _, protocol := range []string{"http", "https"} {
		port := "80"
		if protocol == "https" {
			port = "443"
		}
		replace := strings.NewReplacer("@UNIT_BASE@", base, "@JAIL@", root+"/run/ingress-jail", "@BINARY@", binary,
			"@SOCKETS@", root+"/run/ingress-sockets", "@PROTOCOL@", protocol, "@PORT@", port)
		for _, kind := range []string{"socket", "service"} {
			original, err := ingressTemplates.ReadFile("ingress_templates/" + kind + ".unit")
			if err != nil {
				return nil, err
			}
			body := replace.Replace(string(original))
			if strings.Contains(body, "@") {
				return nil, fmt.Errorf("unresolved ingress unit template")
			}
			units[base+"-"+protocol+"."+kind] = []byte(body)
		}
	}
	return units, nil
}

func ownedIngressDirectory(path string, owner, group int, mode os.FileMode, create bool) error {
	created := false
	if create {
		if _, err := os.Lstat(path); os.IsNotExist(err) {
			// Publish ownership and permissions together. A crash between a
			// final mkdir and chown would otherwise strand an unusable socket
			// directory that continuation correctly refuses to adopt.
			temporary, err := os.MkdirTemp(filepath.Dir(path), ".ingress-directory-")
			if err != nil {
				return err
			}
			defer os.Remove(temporary)
			if err = os.Chmod(temporary, mode); err != nil {
				return err
			}
			if err = os.Chown(temporary, owner, group); err != nil {
				return err
			}
			if err = syncDirectory(temporary); err != nil {
				return err
			}
			parent, err := os.Open(filepath.Dir(path))
			if err != nil {
				return err
			}
			err = mediaPublishNoReplace(parent, filepath.Base(temporary), filepath.Base(path))
			_ = parent.Close()
			created = err == nil
			if err != nil && !os.IsExist(err) {
				return err
			}
		} else if err != nil {
			return err
		}
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode()&(os.ModeSymlink|os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 || info.Mode().Perm() != mode || !ok || stat.Uid != uint32(owner) || stat.Gid != uint32(group) {
		return fmt.Errorf("ingress directory has unexpected ownership, permissions or type: %s", path)
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path {
		return fmt.Errorf("ingress directories must not contain symlinks")
	}
	if created {
		return syncDirectory(filepath.Dir(path))
	}
	return nil
}

func (manager ingressManager) prepare() error {
	if _, err := renderIngressUnits(manager.root, manager.root+"/releases/validation/payload/bin/asterctl"); err != nil {
		return err
	}
	if err := ownedIngressDirectory(manager.root, manager.owner, manager.group, 0700, false); err != nil {
		return err
	}
	for _, entry := range []struct {
		name         string
		owner, group int
		mode         os.FileMode
	}{
		{"run", manager.owner, manager.group, 0700}, {"run/ingress-sockets", manager.serviceOwner, manager.serviceGroup, 0700}, {"run/ingress-jail", manager.owner, manager.group, 0755},
	} {
		if err := ownedIngressDirectory(filepath.Join(manager.root, entry.name), entry.owner, entry.group, entry.mode, true); err != nil {
			return err
		}
	}
	return nil
}

func readOwnedIngressFile(root, name string, owner int, mode os.FileMode, maximum int64) ([]byte, error) {
	directory, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	file, err := openRegular(directory, name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if info.Size() <= 0 || info.Size() > maximum || info.Mode().Perm() != mode || !ok || stat.Uid != uint32(owner) {
		return nil, fmt.Errorf("ingress file has unexpected ownership, permissions or size: %s", name)
	}
	return io.ReadAll(io.LimitReader(file, maximum+1))
}

func (manager ingressManager) previous() (map[string]string, error) {
	value, err := readOwnedIngressFile(manager.root, "run/ingress-units.json", manager.owner, 0600, 8192)
	if os.IsNotExist(err) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var receipt ingressUnitReceipt
	if err = decodeJSON(value, &receipt); err != nil {
		return nil, err
	}
	expected, err := renderIngressUnits(manager.root, manager.root+"/releases/validation/payload/bin/asterctl")
	if err != nil {
		return nil, err
	}
	if receipt.Format != 1 || receipt.Root != manager.root || len(receipt.Files) != len(expected) {
		return nil, fmt.Errorf("ingress unit receipt does not match this installation")
	}
	for name, sum := range receipt.Files {
		if _, ok := expected[name]; !ok || !digest.MatchString(sum) {
			return nil, fmt.Errorf("invalid scoped ingress unit receipt")
		}
	}
	return receipt.Files, nil
}

func (manager ingressManager) inspect(expected map[string][]byte) ([]string, bool, error) {
	if err := ownedIngressDirectory(manager.units, manager.owner, manager.group, 0755, false); err != nil {
		return nil, false, err
	}
	previous, err := manager.previous()
	if err != nil {
		return nil, false, err
	}
	var existing []string
	changed := false
	for name, desired := range expected {
		value, err := readOwnedIngressFile(manager.units, name, manager.owner, 0644, 16384)
		if os.IsNotExist(err) {
			changed = true
			// Removing a unit file does not unload its active socket from
			// systemd. Previously receipted names remain in the scoped stop set.
			if previous[name] != "" {
				existing = append(existing, name)
			}
			continue
		}
		if err != nil {
			return nil, false, err
		}
		if !bytes.Equal(value, desired) {
			if fingerprint(value) != previous[name] {
				return nil, false, fmt.Errorf("ingress unit was changed outside the controller; review %s", name)
			}
			changed = true
		}
		existing = append(existing, name)
	}
	sort.Strings(existing)
	return existing, changed, nil
}

func (manager ingressManager) stopUnits(ctx context.Context, names []string) error {
	var sockets, services []string
	for _, name := range names {
		if strings.HasSuffix(name, ".socket") {
			sockets = append(sockets, name)
		} else {
			services = append(services, name)
		}
	}
	// Disable listeners first so socket activation cannot restart a stopped relay.
	if len(sockets) > 0 {
		if _, err := manager.commands.Run(ctx, nil, nil, "systemctl", append([]string{"disable", "--now"}, sockets...)...); err != nil {
			return err
		}
	}
	if len(services) > 0 {
		if _, err := manager.commands.Run(ctx, nil, nil, "systemctl", append([]string{"stop"}, services...)...); err != nil {
			return err
		}
	}
	return nil
}

func (manager ingressManager) stop(ctx context.Context, binary string) error {
	expected, err := renderIngressUnits(manager.root, binary)
	if err != nil {
		return err
	}
	existing, _, err := manager.inspect(expected)
	if err != nil {
		return err
	}
	return manager.stopUnits(ctx, existing)
}

func (manager ingressManager) start(ctx context.Context, binary string) error {
	if err := manager.prepare(); err != nil {
		return err
	}
	expected, err := renderIngressUnits(manager.root, binary)
	if err != nil {
		return err
	}
	existing, changed, err := manager.inspect(expected)
	if err != nil {
		return err
	}
	if changed {
		if err = manager.stopUnits(ctx, existing); err != nil {
			return err
		}
	}
	names := make([]string, 0, len(expected))
	for name := range expected {
		names = append(names, name)
	}
	sort.Strings(names)
	receipt := ingressUnitReceipt{1, manager.root, map[string]string{}}
	for _, name := range names {
		if changed {
			if err = atomicWrite(filepath.Join(manager.units, name), expected[name], 0644); err != nil {
				return err
			}
		}
		receipt.Files[name] = fingerprint(expected[name])
	}
	if err = writeJSON(filepath.Join(manager.root, "run/ingress-units.json"), receipt); err != nil {
		return err
	}
	if _, err = manager.commands.Run(ctx, nil, nil, "systemctl", "daemon-reload"); err != nil {
		return err
	}
	var sockets []string
	for _, name := range names {
		if strings.HasSuffix(name, ".socket") {
			sockets = append(sockets, name)
		}
	}
	if _, err = manager.commands.Run(ctx, nil, nil, "systemctl", append([]string{"enable", "--now"}, sockets...)...); err != nil {
		// A partial two-socket activation must not hold one public port after a
		// failed startup. Only these already validated installation units stop.
		cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		cleanup := manager.stopUnits(cleanupContext, names)
		if cleanup != nil {
			return fmt.Errorf("ingress activation failed and scoped cleanup also failed: %w", err)
		}
		return err
	}
	return nil
}

func (c Controller) verifiedIngressBinary(s Installation, m *Manifest) (string, error) {
	entry := FileEntry{}
	for _, file := range m.Files {
		if file.Path == "payload/bin/asterctl" {
			entry = file
			break
		}
	}
	if entry.Mode != 0755 || entry.Size < 64 || entry.Size > 128<<20 {
		return "", fmt.Errorf("missing bounded ingress executable inventory")
	}
	root, err := os.OpenRoot(c.release(s))
	if err != nil {
		return "", err
	}
	defer root.Close()
	file, err := openRegular(root, entry.Path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm() != 0755 || info.Size() != entry.Size {
		return "", fmt.Errorf("ingress executable ownership, mode or size differs")
	}
	sum, size, err := fileHash(file)
	if err != nil || sum != entry.SHA256 || size != entry.Size {
		return "", fmt.Errorf("ingress executable differs from signed payload")
	}
	binary, err := elf.NewFile(file)
	if err != nil {
		return "", fmt.Errorf("ingress requires a static Linux executable: %w", err)
	}
	if binary.Class != elf.ELFCLASS64 || binary.Machine != elf.EM_X86_64 {
		return "", fmt.Errorf("ingress executable has the wrong architecture")
	}
	for _, program := range binary.Progs {
		if program.Type == elf.PT_INTERP {
			return "", fmt.Errorf("ingress executable requires an external dynamic loader")
		}
	}
	return filepath.Join(c.release(s), entry.Path), nil
}

// This deliberately recognizes the controller's existing Compose vocabulary.
// Maintenance `run` and a database-only `up` never change public listeners.
func ingressComposeAction(args []string) (start, stop bool) {
	if len(args) == 0 {
		return
	}
	if args[0] == "down" {
		return false, true
	}
	if args[0] != "up" && args[0] != "stop" {
		return
	}
	var services []string
	for index := 1; index < len(args); index++ {
		switch args[index] {
		case "--wait-timeout", "--timeout", "-t":
			index++
		case "-d", "--wait":
		default:
			services = append(services, args[index])
		}
	}
	wanted := len(services) == 0
	for _, service := range services {
		wanted = wanted || service == "caddy"
	}
	return args[0] == "up" && wanted, args[0] == "stop" && wanted
}
