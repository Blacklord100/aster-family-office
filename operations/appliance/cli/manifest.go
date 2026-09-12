// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
)

type FileEntry struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Mode   uint32 `json:"mode"`
}
type ImageEntry struct {
	Service   string `json:"service"`
	Path      string `json:"path"`
	Reference string `json:"reference"`
	ImageID   string `json:"imageId"`
}
type RuntimePackage struct {
	Name         string `json:"name"`
	Version      string `json:"version"`
	Architecture string `json:"architecture"`
	Path         string `json:"path"`
	SHA256       string `json:"sha256"`
}
type Manifest struct {
	raw            []byte
	trustedRoot    []byte
	SchemaVersion  int    `json:"schemaVersion"`
	ReleaseID      string `json:"releaseId"`
	ProductVersion string `json:"productVersion"`
	Sequence       int64  `json:"sequence"`
	Channel        string `json:"channel"`
	CreatedAt      string `json:"createdAt,omitempty"`
	Platform       struct {
		OS   string `json:"os"`
		Arch string `json:"arch"`
	} `json:"platform"`
	Schema struct {
		Min    int `json:"min"`
		Max    int `json:"max"`
		Target int `json:"target"`
	} `json:"schema"`
	Files  []FileEntry  `json:"files"`
	Images []ImageEntry `json:"images"`
	Model  struct {
		Name      string   `json:"name"`
		Digest    string   `json:"digest"`
		Files     []string `json:"files"`
		Modelfile string   `json:"modelfile"`
	} `json:"model"`
	Compose struct {
		Offline   string `json:"offline"`
		Connected string `json:"connected"`
	} `json:"compose"`
	Runtime struct {
		Kind     string           `json:"kind"`
		OS       string           `json:"os"`
		Version  string           `json:"version"`
		Arch     string           `json:"arch"`
		Packages []RuntimePackage `json:"packages"`
	} `json:"runtime"`
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)
var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func safePath(p string) bool {
	return p != "" && len(p) <= 512 && fs.ValidPath(p) && p != "." && !strings.ContainsAny(p, "\\\x00\r\n:") && strings.IndexFunc(p, func(r rune) bool { return r < 32 || r == 127 }) < 0
}
func decodeJSON(b []byte, v any) error {
	if e := uniqueJSON(json.NewDecoder(bytes.NewReader(b)), 0); e != nil {
		return e
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("trailing JSON content")
	}
	return nil
}

// Reject duplicate keys and excessive nesting before schema decoding. Signed
// manifests must have one interpretation for packager, verifier and operator.
func uniqueJSON(d *json.Decoder, depth int) error {
	if depth > 64 {
		return fmt.Errorf("JSON nesting limit exceeded")
	}
	token, e := d.Token()
	if e != nil {
		return e
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for d.More() {
			key, e := d.Token()
			if e != nil {
				return e
			}
			name, ok := key.(string)
			if !ok || seen[name] {
				return fmt.Errorf("duplicate or invalid JSON key")
			}
			seen[name] = true
			if e = uniqueJSON(d, depth+1); e != nil {
				return e
			}
		}
	case '[':
		for d.More() {
			if e = uniqueJSON(d, depth+1); e != nil {
				return e
			}
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter")
	}
	_, e = d.Token()
	return e
}
func (m *Manifest) Validate() error {
	if m.SchemaVersion != 1 || !identifier.MatchString(m.ReleaseID) || m.ProductVersion == "" || m.Sequence < 1 || (m.Channel != "stable" && m.Channel != "preview") {
		return fmt.Errorf("invalid release identity")
	}
	if m.Platform.OS != "linux" || m.Platform.Arch != "amd64" {
		return fmt.Errorf("unsupported release platform")
	}
	if m.Schema.Min < 1 || m.Schema.Max < m.Schema.Min || m.Schema.Target < m.Schema.Min || m.Schema.Target > m.Schema.Max {
		return fmt.Errorf("invalid schema compatibility range")
	}
	if len(m.Files) == 0 || len(m.Files) > 100000 {
		return fmt.Errorf("invalid payload inventory size")
	}
	inventory := map[string]FileEntry{}
	var total int64
	for _, f := range m.Files {
		if !safePath(f.Path) || !strings.HasPrefix(f.Path, "payload/") || !digest.MatchString(f.SHA256) || f.Size < 0 || f.Size > 1<<40 || (f.Mode != 0644 && f.Mode != 0755) {
			return fmt.Errorf("invalid payload entry: %q", f.Path)
		}
		if _, ok := inventory[f.Path]; ok {
			return fmt.Errorf("duplicate payload entry: %s", f.Path)
		}
		inventory[f.Path] = f
		total += f.Size
		if total > 4<<40 {
			return fmt.Errorf("payload exceeds 4 TiB bound")
		}
	}
	require := func(p string) error {
		if _, ok := inventory[p]; !ok {
			return fmt.Errorf("referenced file is not inventoried: %s", p)
		}
		return nil
	}
	for _, p := range []string{m.Compose.Offline, m.Compose.Connected, m.Model.Modelfile} {
		if err := require(p); err != nil {
			return err
		}
	}
	if m.Model.Name == "" || strings.ContainsAny(m.Model.Name, "\n\r\x00$") || !digest.MatchString(strings.TrimPrefix(m.Model.Digest, "sha256:")) || len(m.Model.Files) == 0 {
		return fmt.Errorf("invalid pinned model")
	}
	seenModels := map[string]bool{}
	for _, p := range m.Model.Files {
		if !strings.HasPrefix(p, "payload/models/ollama/") || seenModels[p] {
			return fmt.Errorf("invalid model cache path: %s", p)
		}
		seenModels[p] = true
		if err := require(p); err != nil {
			return err
		}
	}
	if m.Runtime.Kind != "ubuntu-deb" || m.Runtime.OS != "ubuntu" || m.Runtime.Version != "24.04" || m.Runtime.Arch != "amd64" || len(m.Runtime.Packages) == 0 {
		return fmt.Errorf("unsupported or empty runtime closure")
	}
	packages := map[string]bool{}
	for _, p := range m.Runtime.Packages {
		if !regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]+$`).MatchString(p.Name) || p.Version == "" || (p.Architecture != "amd64" && p.Architecture != "all") || packages[p.Name] || !strings.HasPrefix(p.Path, "payload/runtime/") {
			return fmt.Errorf("invalid runtime package: %s", p.Name)
		}
		if err := require(p.Path); err != nil {
			return err
		}
		if inventory[p.Path].SHA256 != p.SHA256 {
			return fmt.Errorf("runtime hash differs from inventory")
		}
		packages[p.Name] = true
	}
	if len(m.Images) != 5 {
		return fmt.Errorf("the exact five image services are required")
	}
	services := map[string]bool{}
	for _, im := range m.Images {
		if !identifier.MatchString(im.Service) || services[im.Service] || !strings.HasPrefix(im.Path, "payload/images/") || !digest.MatchString(strings.TrimPrefix(im.ImageID, "sha256:")) || strings.ContainsAny(im.Reference, "\r\n$\x00 ") || im.Reference == "" || strings.HasSuffix(im.Reference, ":latest") {
			return fmt.Errorf("invalid immutable image: %s", im.Service)
		}
		if err := require(im.Path); err != nil {
			return err
		}
		services[im.Service] = true
	}
	for _, s := range []string{"app", "processor", "postgres", "ollama", "caddy"} {
		if !services[s] {
			return fmt.Errorf("missing image: %s", s)
		}
	}
	return nil
}
func fileHash(r io.Reader) (string, int64, error) {
	h := sha256.New()
	n, e := io.Copy(h, r)
	return hex.EncodeToString(h.Sum(nil)), n, e
}
func boundedRead(root *os.Root, p string, limit int64) ([]byte, error) {
	f, e := openRegular(root, p)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return nil, e
	}
	if st.Size() > limit {
		return nil, fmt.Errorf("file too large: %s", p)
	}
	b, e := io.ReadAll(io.LimitReader(f, limit+1))
	if len(b) > int(limit) {
		return nil, fmt.Errorf("file too large: %s", p)
	}
	return b, e
}

// os.Root confines path resolution even if a source path changes concurrently.
// Links are additionally rejected, rather than silently accepting aliases.
func openRegular(root *os.Root, p string) (*os.File, error) {
	if !safePath(p) {
		return nil, fmt.Errorf("unsafe path: %q", p)
	}
	parts := strings.Split(p, "/")
	for i := range parts {
		st, e := root.Lstat(strings.Join(parts[:i+1], "/"))
		if e != nil {
			return nil, e
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("symbolic link refused: %s", p)
		}
	}
	f, e := root.Open(p)
	if e != nil {
		return nil, e
	}
	st, e := f.Stat()
	if e != nil {
		f.Close()
		return nil, e
	}
	if !st.Mode().IsRegular() {
		f.Close()
		return nil, fmt.Errorf("non-regular file refused: %s", p)
	}
	if stat, ok := st.Sys().(*syscall.Stat_t); ok && stat.Nlink != 1 {
		f.Close()
		return nil, fmt.Errorf("hard link refused: %s", p)
	}
	return f, nil
}
func verifyPayload(bundle string, m *Manifest) error {
	root, e := os.OpenRoot(bundle)
	if e != nil {
		return e
	}
	defer root.Close()
	inventory := map[string]bool{}
	for _, entry := range m.Files {
		f, e := openRegular(root, entry.Path)
		if e != nil {
			return e
		}
		hash, n, e := fileHash(f)
		f.Close()
		if e != nil {
			return e
		}
		if n != entry.Size || hash != entry.SHA256 {
			return fmt.Errorf("payload integrity failed: %s", entry.Path)
		}
		inventory[entry.Path] = true
	}
	return fs.WalkDir(root.FS(), "payload", func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.IsDir() {
			return nil
		}
		if !inventory[p] {
			return fmt.Errorf("unlisted payload file: %s", p)
		}
		return nil
	})
}
func atomicWrite(p string, b []byte, mode fs.FileMode) error {
	if e := os.MkdirAll(filepath.Dir(p), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(p), ".aster-write-")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if e = f.Chmod(mode); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(tmp, p); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(p))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func writeJSON(p string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	return atomicWrite(p, append(b, '\n'), 0600)
}
func syncDirectory(p string) error {
	d, e := os.Open(p)
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func syncTreeDirectories(root string) error {
	var dirs []string
	e := filepath.WalkDir(root, func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink refused while syncing release")
		}
		if d.IsDir() {
			dirs = append(dirs, p)
		}
		return nil
	})
	if e != nil {
		return e
	}
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) > len(dirs[j]) })
	for _, p := range dirs {
		if e = syncDirectory(p); e != nil {
			return e
		}
	}
	return nil
}
func copyVerified(bundle, dest string, m *Manifest) error {
	root, e := os.OpenRoot(bundle)
	if e != nil {
		return e
	}
	defer root.Close()
	if e = os.Mkdir(dest, 0700); e != nil {
		return e
	}
	for _, entry := range m.Files {
		src, e := openRegular(root, entry.Path)
		if e != nil {
			return e
		}
		p := filepath.Join(dest, filepath.FromSlash(entry.Path))
		if e = os.MkdirAll(filepath.Dir(p), 0755); e != nil {
			src.Close()
			return e
		}
		out, e := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fs.FileMode(entry.Mode))
		if e != nil {
			src.Close()
			return e
		}
		hash := sha256.New()
		n, e := io.Copy(io.MultiWriter(out, hash), io.LimitReader(src, entry.Size+1))
		src.Close()
		if e == nil {
			e = out.Sync()
		}
		ce := out.Close()
		if e == nil {
			e = ce
		}
		if e != nil {
			return e
		}
		if n != entry.Size || hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
			return fmt.Errorf("source changed during staging: %s", entry.Path)
		}
	}
	return writeJSON(path.Join(dest, "release.json"), m)
}
