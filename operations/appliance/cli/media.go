// SPDX-License-Identifier: Apache-2.0
package main

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const mediaMaxParts = 4096
const mediaMaxPartBytes int64 = 1900 << 20
const mediaMaxExpandedBytes int64 = 4 << 40

type MediaPart struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// This unsigned inventory checks transport integrity only. Trust comes from the
// separately supplied publisher root, verified after the entire stream is read.
type MediaInventory struct {
	SchemaVersion int         `json:"schemaVersion"`
	ReleaseID     string      `json:"releaseId"`
	Format        string      `json:"format"`
	Bytes         int64       `json:"bytes"`
	SHA256        string      `json:"sha256"`
	Parts         []MediaPart `json:"parts"`
	Trust         string      `json:"trust"`
}

func (m MediaInventory) validate(maxBytes int64) error {
	if maxBytes < 1 || maxBytes > mediaMaxExpandedBytes {
		return fmt.Errorf("unpack byte limit must be between 1 byte and 4 TiB")
	}
	// Gzip may be slightly larger than incompressible input. Both transport and
	// expanded bytes are bounded; the extra allowance never increases extraction.
	maxTransport := maxBytes + maxBytes/100 + 1<<20
	if m.SchemaVersion != 1 || !identifier.MatchString(m.ReleaseID) || m.Format != "tar+gzip" ||
		m.Bytes < 1 || m.Bytes > maxTransport || !digest.MatchString(m.SHA256) ||
		len(m.Parts) < 1 || len(m.Parts) > mediaMaxParts || len(m.Trust) > 512 {
		return fmt.Errorf("invalid or oversized release transport inventory")
	}
	var total int64
	for i, part := range m.Parts {
		expected := fmt.Sprintf("%s.tar.gz.part%04d", m.ReleaseID, i)
		if part.Path != expected || !safePath(part.Path) || part.Size < 1 || part.Size > mediaMaxPartBytes ||
			!digest.MatchString(part.SHA256) || (i < len(m.Parts)-1 && part.Size != m.Parts[0].Size) ||
			(i == len(m.Parts)-1 && part.Size > m.Parts[0].Size) || total > maxTransport-part.Size {
			return fmt.Errorf("invalid release media part at index %d", i)
		}
		total += part.Size
	}
	if total != m.Bytes {
		return fmt.Errorf("release media part sizes do not match the transport total")
	}
	return nil
}

type mediaPartReader struct {
	ctx       context.Context
	root      *os.Root
	inventory MediaInventory
	index     int
	file      *os.File
	partHash  hash.Hash
	fullHash  hash.Hash
	partBytes int64
	total     int64
	verified  bool
}

func (r *mediaPartReader) Close() error {
	if r.file != nil {
		return r.file.Close()
	}
	return nil
}

func (r *mediaPartReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for {
		if e := r.ctx.Err(); e != nil {
			return 0, e
		}
		if r.index == len(r.inventory.Parts) {
			if r.total != r.inventory.Bytes || hex.EncodeToString(r.fullHash.Sum(nil)) != r.inventory.SHA256 {
				return 0, fmt.Errorf("consumed media stream SHA-256 differs from transport inventory")
			}
			r.verified = true
			return 0, io.EOF
		}
		part := r.inventory.Parts[r.index]
		if r.file == nil {
			f, e := openRegular(r.root, part.Path)
			if e != nil {
				return 0, e
			}
			st, e := f.Stat()
			if e != nil || st.Size() != part.Size {
				f.Close()
				return 0, fmt.Errorf("media part length differs from inventory: %s", part.Path)
			}
			r.file, r.partHash, r.partBytes = f, sha256.New(), 0
		}
		remaining := part.Size - r.partBytes
		if remaining == 0 {
			var extra [1]byte
			n, e := r.file.Read(extra[:])
			if n != 0 || e != io.EOF || hex.EncodeToString(r.partHash.Sum(nil)) != part.SHA256 {
				return 0, fmt.Errorf("consumed media part integrity failed: %s", part.Path)
			}
			if e = r.file.Close(); e != nil {
				return 0, e
			}
			r.file = nil
			r.index++
			continue
		}
		if int64(len(p)) > remaining {
			p = p[:int(remaining)]
		}
		n, e := r.file.Read(p)
		if n > 0 {
			r.partHash.Write(p[:n])
			r.fullHash.Write(p[:n])
			r.partBytes += int64(n)
			r.total += int64(n)
		}
		if e == io.EOF {
			e = io.ErrUnexpectedEOF
		}
		if n == 0 && e == nil {
			e = io.ErrNoProgress
		}
		return n, e
	}
}

type mediaExpansionReader struct {
	ctx   context.Context
	input io.Reader
	limit int64
	read  int64
}

func (r *mediaExpansionReader) Read(p []byte) (int, error) {
	if e := r.ctx.Err(); e != nil {
		return 0, e
	}
	if len(p) == 0 {
		return 0, nil
	}
	remaining := r.limit - r.read
	if remaining < 0 {
		return 0, fmt.Errorf("release archive exceeds the expanded byte limit")
	}
	if int64(len(p)) > remaining+1 {
		p = p[:int(remaining+1)]
	}
	n, e := r.input.Read(p)
	r.read += int64(n)
	if r.read > r.limit {
		return 0, fmt.Errorf("release archive exceeds the expanded byte limit")
	}
	return n, e
}

func mediaHeader(h *tar.Header, maxBytes int64) error {
	if h.Typeflag != tar.TypeReg || !safePath(h.Name) || h.Linkname != "" || h.Size < 0 || h.Size > maxBytes {
		return fmt.Errorf("unsafe or nonregular release archive entry")
	}
	for key := range h.PAXRecords {
		if key != "path" && key != "size" {
			return fmt.Errorf("unsupported release archive extension")
		}
	}
	if strings.HasPrefix(h.Name, "payload/") {
		if h.Mode != 0644 && h.Mode != 0755 {
			return fmt.Errorf("unsafe payload permissions")
		}
		return nil
	}
	if h.Name == "release.json" || (strings.HasPrefix(h.Name, "metadata/") &&
		(metadataName.MatchString(strings.TrimPrefix(h.Name, "metadata/")) ||
			h.Name == "metadata/root.json" || h.Name == "metadata/targets.json" || h.Name == "metadata/snapshot.json")) {
		if (h.Mode != 0600 && h.Mode != 0644) || h.Size > 8<<20 {
			return fmt.Errorf("unsafe or oversized release metadata")
		}
		return nil
	}
	return fmt.Errorf("archive file is outside the release, metadata and payload protocol")
}

func mediaReadIndependentFile(name string, limit int64) ([]byte, error) {
	abs, e := filepath.Abs(name)
	if e != nil {
		return nil, e
	}
	root, e := os.OpenRoot(filepath.Dir(abs))
	if e != nil {
		return nil, e
	}
	defer root.Close()
	return boundedRead(root, filepath.Base(abs), limit)
}

// UnpackMedia never starts a process, uses a model, installs anything, or fetches
// a URL. It publishes only a complete release authenticated by the independent
// root. Transport checks alone never authorize the contents of downloaded media.
func UnpackMedia(ctx context.Context, partsJSON, output, trustedRoot, trustedSHA string, maxBytes int64) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	if !digest.MatchString(trustedSHA) {
		return fmt.Errorf("independently trusted publisher root SHA-256 is required")
	}
	trusted, e := mediaReadIndependentFile(trustedRoot, 8<<20)
	if e != nil {
		return e
	}
	if fingerprint(trusted) != trustedSHA {
		return fmt.Errorf("independent publisher root fingerprint mismatch")
	}
	partsPath, e := filepath.Abs(partsJSON)
	if e != nil {
		return e
	}
	partsRoot, e := os.OpenRoot(filepath.Dir(partsPath))
	if e != nil {
		return e
	}
	defer partsRoot.Close()
	b, e := boundedRead(partsRoot, filepath.Base(partsPath), 2<<20)
	if e != nil {
		return e
	}
	var inventory MediaInventory
	if e = decodeJSON(b, &inventory); e != nil {
		return e
	}
	if e = inventory.validate(maxBytes); e != nil {
		return e
	}
	absOutput, e := filepath.Abs(output)
	if e != nil {
		return e
	}
	outputName := filepath.Base(absOutput)
	if outputName == "." || outputName == string(filepath.Separator) || !safePath(outputName) {
		return fmt.Errorf("unpack output must name a new directory")
	}
	parentPath, e := filepath.EvalSymlinks(filepath.Dir(absOutput))
	if e != nil {
		return e
	}
	parent, e := os.OpenRoot(parentPath)
	if e != nil {
		return e
	}
	defer parent.Close()
	if _, e = parent.Lstat(outputName); !os.IsNotExist(e) {
		return fmt.Errorf("unpack output already exists or cannot be safely inspected")
	}
	// Both directories are new siblings of the destination, on the same volume.
	// All writes are confined with os.Root; only our private staging is cleaned.
	stageName := ".aster-unpack-" + id()
	if e = parent.Mkdir(stageName, 0700); e != nil {
		return e
	}
	defer parent.RemoveAll(stageName)
	stage, e := parent.OpenRoot(stageName)
	if e != nil {
		return e
	}
	defer stage.Close()
	cacheName := ".aster-unpack-trust-" + id()
	if e = parent.Mkdir(cacheName, 0700); e != nil {
		return e
	}
	defer parent.RemoveAll(cacheName)
	cache, e := parent.OpenRoot(cacheName)
	if e != nil {
		return e
	}
	defer cache.Close()
	if e = cache.WriteFile("initial-root.json", trusted, 0600); e != nil {
		return e
	}
	reader := &mediaPartReader{ctx: ctx, root: partsRoot, inventory: inventory, fullHash: sha256.New()}
	defer reader.Close()
	compressed := bufio.NewReaderSize(reader, 64<<10)
	gz, e := gzip.NewReader(compressed)
	if e != nil {
		return fmt.Errorf("invalid compressed release media: %w", e)
	}
	defer gz.Close()
	// One gzip member is the packer's protocol. Require true EOF afterward so
	// concatenated members or hidden compressed trailing data cannot be ignored.
	gz.Multistream(false)
	expanded := &mediaExpansionReader{ctx: ctx, input: gz, limit: maxBytes}
	archive := tar.NewReader(expanded)
	seen := map[string]bool{}
	var payloadBytes, metadataBytes int64
	for {
		h, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if e = mediaHeader(h, maxBytes); e != nil {
			return e
		}
		if len(seen) >= 100129 || seen[h.Name] {
			return fmt.Errorf("duplicate or excessive release archive entries")
		}
		seen[h.Name] = true
		if strings.HasPrefix(h.Name, "payload/") {
			if payloadBytes > maxBytes-h.Size {
				return fmt.Errorf("payload exceeds unpack byte limit")
			}
			payloadBytes += h.Size
		} else {
			metadataBytes += h.Size
			if metadataBytes > 64<<20 {
				return fmt.Errorf("release metadata exceeds unpack limit")
			}
		}
		if e = stage.MkdirAll(filepath.Dir(h.Name), 0700); e != nil {
			return e
		}
		file, err := stage.OpenFile(h.Name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		n, err := io.Copy(file, archive)
		if err == nil && n != h.Size {
			err = io.ErrUnexpectedEOF
		}
		if err == nil {
			err = file.Chmod(os.FileMode(h.Mode))
		}
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	// tar EOF precedes gzip's authenticated CRC/size trailer. Read to the actual
	// end, permitting only bounded zero padding used by Python's tar writer.
	tail, e := io.ReadAll(io.LimitReader(expanded, (1<<20)+1))
	if e != nil {
		return e
	}
	if len(tail) > 1<<20 {
		return fmt.Errorf("excessive release tar padding")
	}
	for _, value := range tail {
		if value != 0 {
			return fmt.Errorf("nonzero data after release tar terminator")
		}
	}
	if _, e = compressed.ReadByte(); e != io.EOF {
		if e == nil {
			return fmt.Errorf("trailing gzip members or data are not allowed")
		}
		return e
	}
	if !reader.verified || !seen["release.json"] {
		return fmt.Errorf("release transport was not fully consumed and verified")
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	stagePath := filepath.Join(parentPath, stageName)
	cachePath := filepath.Join(parentPath, cacheName)
	m, e := verifyBundle(stagePath, filepath.Join(cachePath, "initial-root.json"), trustedSHA, filepath.Join(cachePath, "metadata"))
	if e != nil {
		return fmt.Errorf("unpacked release verification failed: %w", e)
	}
	if m.ReleaseID != inventory.ReleaseID {
		return fmt.Errorf("transport label differs from authenticated release identity")
	}
	// verifyBundle validates all payload hashes and membership. Also enforce the
	// signed executable modes rather than trusting unsigned tar permissions.
	for _, file := range m.Files {
		st, err := stage.Lstat(file.Path)
		if err != nil || uint32(st.Mode().Perm()) != file.Mode {
			return fmt.Errorf("extracted payload mode differs from signed manifest")
		}
	}
	if e = syncTreeDirectories(stagePath); e != nil {
		return e
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	parentFile, e := parent.Open(".")
	if e != nil {
		return e
	}
	defer parentFile.Close()
	if e = mediaPublishNoReplace(parentFile, stageName, outputName); e != nil {
		return fmt.Errorf("verified release could not be published without overwriting: %w", e)
	}
	if e = parentFile.Sync(); e != nil {
		return fmt.Errorf("verified release was published but directory durability could not be confirmed: %w", e)
	}
	return nil
}
