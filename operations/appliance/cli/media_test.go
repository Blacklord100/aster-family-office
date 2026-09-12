// SPDX-License-Identifier: Apache-2.0
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type mediaTestEntry struct {
	header tar.Header
	data   []byte
}

func mediaTestArchive(t *testing.T, bundle string, edit func([]mediaTestEntry) []mediaTestEntry, tail []byte) []byte {
	t.Helper()
	var entries []mediaTestEntry
	e := filepath.WalkDir(bundle, func(path string, item fs.DirEntry, err error) error {
		if err != nil || item.IsDir() {
			return err
		}
		info, err := item.Info()
		if err != nil {
			return err
		}
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name, err = filepath.Rel(bundle, path)
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(header.Name)
		header.Format = tar.FormatPAX
		header.Uid, header.Gid, header.Uname, header.Gname = 0, 0, "", ""
		header.ModTime = time.Unix(0, 0)
		header.AccessTime, header.ChangeTime = time.Time{}, time.Time{}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		entries = append(entries, mediaTestEntry{header: *header, data: data})
		return nil
	})
	if e != nil {
		t.Fatal(e)
	}
	if edit != nil {
		entries = edit(entries)
	}
	var data bytes.Buffer
	gz := gzip.NewWriter(&data)
	archive := tar.NewWriter(gz)
	for _, entry := range entries {
		if e := archive.WriteHeader(&entry.header); e != nil {
			t.Fatal(e)
		}
		if len(entry.data) > 0 {
			if _, e := archive.Write(entry.data); e != nil {
				t.Fatal(e)
			}
		}
	}
	if e := archive.Close(); e != nil {
		t.Fatal(e)
	}
	if _, e := gz.Write(tail); e != nil {
		t.Fatal(e)
	}
	if e := gz.Close(); e != nil {
		t.Fatal(e)
	}
	return data.Bytes()
}

func mediaTestParts(t *testing.T, data []byte, releaseID string, partSize int) (string, MediaInventory) {
	t.Helper()
	dir := t.TempDir()
	if partSize <= 0 {
		partSize = len(data)
	}
	inventory := MediaInventory{SchemaVersion: 1, ReleaseID: releaseID, Format: "tar+gzip", Bytes: int64(len(data)), SHA256: fingerprint(data), Trust: "Transport checks only; TUF verification remains mandatory"}
	for offset, index := 0, 0; offset < len(data); index++ {
		end := min(len(data), offset+partSize)
		block := data[offset:end]
		name := fmt.Sprintf("%s.tar.gz.part%04d", releaseID, index)
		if e := os.WriteFile(filepath.Join(dir, name), block, 0644); e != nil {
			t.Fatal(e)
		}
		inventory.Parts = append(inventory.Parts, MediaPart{Path: name, Size: int64(len(block)), SHA256: fingerprint(block)})
		offset = end
	}
	path := filepath.Join(dir, "parts.json")
	if e := writeJSON(path, inventory); e != nil {
		t.Fatal(e)
	}
	return path, inventory
}

func mediaTestRefusal(t *testing.T, parts, root, hash string, limit int64) error {
	t.Helper()
	parent := t.TempDir()
	output := filepath.Join(parent, "verified")
	e := UnpackMedia(context.Background(), parts, output, root, hash, limit)
	if e == nil {
		t.Fatal("unsafe or incomplete release media was accepted")
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatalf("refused media left published output or staging files: %v (%v)", entries, err)
	}
	return e
}

func TestMediaSignedReleaseAcrossPartBoundaries(t *testing.T) {
	bundle, manifest := fixture(t)
	// Real dependency notices include long paths that require PAX path records.
	longPath := "payload/" + strings.Repeat("component", 15) + ".txt"
	if e := os.WriteFile(filepath.Join(bundle, longPath), []byte("retained notice"), 0644); e != nil {
		t.Fatal(e)
	}
	manifest.Files = append(manifest.Files, FileEntry{Path: longPath, SHA256: fingerprint([]byte("retained notice")), Size: 15, Mode: 0644})
	saveManifest(t, bundle, manifest)
	_, root, hash := trustFixture(t, bundle, 1)
	data := mediaTestArchive(t, bundle, nil, make([]byte, 4096))
	for _, size := range []int{1, 17, len(data)} {
		t.Run(fmt.Sprintf("part-bytes-%d", size), func(t *testing.T) {
			parts, inventory := mediaTestParts(t, data, "1.0.0", size)
			if len(inventory.Parts) > mediaMaxParts {
				t.Fatal("synthetic split fixture exceeds supported part count")
			}
			output := filepath.Join(t.TempDir(), "verified")
			if e := UnpackMedia(context.Background(), parts, output, root, hash, 4<<20); e != nil {
				t.Fatal(e)
			}
			st, e := os.Stat(output)
			if e != nil || st.Mode().Perm() != 0700 {
				t.Fatalf("published media is not private: %v", e)
			}
			if _, e := verifyBundle(output, root, hash, t.TempDir()); e != nil {
				t.Fatal(e)
			}
		})
	}
}

func TestMediaPartAndWholeStreamHashesAreBothRequired(t *testing.T) {
	bundle, _ := fixture(t)
	_, root, hash := trustFixture(t, bundle, 1)
	data := mediaTestArchive(t, bundle, nil, nil)
	for _, kind := range []string{"part-hash", "stream-hash", "part-bytes", "part-truncated", "part-grown"} {
		t.Run(kind, func(t *testing.T) {
			parts, inventory := mediaTestParts(t, data, "1.0.0", 37)
			last := inventory.Parts[len(inventory.Parts)-1]
			path := filepath.Join(filepath.Dir(parts), last.Path)
			switch kind {
			case "part-hash":
				inventory.Parts[len(inventory.Parts)-1].SHA256 = strings.Repeat("0", 64)
			case "stream-hash":
				inventory.SHA256 = strings.Repeat("0", 64)
			case "part-bytes":
				b, _ := os.ReadFile(path)
				b[len(b)-1] ^= 1
				os.WriteFile(path, b, 0644)
			case "part-truncated":
				os.Truncate(path, last.Size-1)
			case "part-grown":
				f, e := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
				if e != nil {
					t.Fatal(e)
				}
				f.Write([]byte("x"))
				f.Close()
			}
			if e := writeJSON(parts, inventory); e != nil {
				t.Fatal(e)
			}
			mediaTestRefusal(t, parts, root, hash, 4<<20)
		})
	}
}

func TestMediaRejectsMaliciousTarEntries(t *testing.T) {
	bundle, _ := fixture(t)
	_, root, hash := trustFixture(t, bundle, 1)
	tests := map[string]tar.Header{
		"traversal":  {Name: "payload/../../escape", Mode: 0644, Typeflag: tar.TypeReg},
		"absolute":   {Name: "/tmp/escape", Mode: 0644, Typeflag: tar.TypeReg},
		"backslash":  {Name: "payload\\escape", Mode: 0644, Typeflag: tar.TypeReg},
		"outside":    {Name: "secrets/password", Mode: 0644, Typeflag: tar.TypeReg},
		"symlink":    {Name: "payload/link", Linkname: "/etc/passwd", Mode: 0644, Typeflag: tar.TypeSymlink},
		"hardlink":   {Name: "payload/link", Linkname: "payload/config/offline.yaml", Mode: 0644, Typeflag: tar.TypeLink},
		"device":     {Name: "payload/device", Mode: 0644, Typeflag: tar.TypeChar, Devmajor: 1, Devminor: 3},
		"directory":  {Name: "payload/directory", Mode: 0755, Typeflag: tar.TypeDir},
		"setuid":     {Name: "payload/setuid", Mode: 04755, Typeflag: tar.TypeReg},
		"writable":   {Name: "payload/writable", Mode: 0666, Typeflag: tar.TypeReg},
		"meta-exec":  {Name: "metadata/root.json", Mode: 0755, Typeflag: tar.TypeReg},
		"extra-meta": {Name: "metadata/run.sh", Mode: 0644, Typeflag: tar.TypeReg},
	}
	for name, header := range tests {
		t.Run(name, func(t *testing.T) {
			data := mediaTestArchive(t, bundle, func(entries []mediaTestEntry) []mediaTestEntry {
				return append(entries, mediaTestEntry{header: header})
			}, nil)
			parts, _ := mediaTestParts(t, data, "1.0.0", 89)
			mediaTestRefusal(t, parts, root, hash, 4<<20)
		})
	}
	t.Run("duplicate", func(t *testing.T) {
		data := mediaTestArchive(t, bundle, func(entries []mediaTestEntry) []mediaTestEntry { return append(entries, entries[0]) }, nil)
		parts, _ := mediaTestParts(t, data, "1.0.0", 0)
		mediaTestRefusal(t, parts, root, hash, 4<<20)
	})
}

func TestMediaTransportCannotAuthorizeTamperedSignedPayloadOrMode(t *testing.T) {
	bundle, _ := fixture(t)
	_, root, hash := trustFixture(t, bundle, 1)
	for _, kind := range []string{"contents", "mode", "unlisted-file"} {
		t.Run(kind, func(t *testing.T) {
			data := mediaTestArchive(t, bundle, func(entries []mediaTestEntry) []mediaTestEntry {
				if kind == "unlisted-file" {
					return append(entries, mediaTestEntry{header: tar.Header{Name: "payload/unlisted.txt", Mode: 0644, Typeflag: tar.TypeReg}})
				}
				for i := range entries {
					if !strings.HasPrefix(entries[i].header.Name, "payload/") {
						continue
					}
					if kind == "contents" {
						entries[i].data = []byte("attacker changed signed payload")
						entries[i].header.Size = int64(len(entries[i].data))
					} else {
						entries[i].header.Mode = 0755
					}
					break
				}
				return entries
			}, nil)
			parts, _ := mediaTestParts(t, data, "1.0.0", 0)
			mediaTestRefusal(t, parts, root, hash, 4<<20)
		})
	}
}

func TestMediaIndependentPublisherAndCurrentExpiryRemainMandatory(t *testing.T) {
	bundle, _ := fixture(t)
	keys, root, hash := trustFixture(t, bundle, 1)
	data := mediaTestArchive(t, bundle, nil, nil)
	parts, _ := mediaTestParts(t, data, "1.0.0", 0)
	mediaTestRefusal(t, parts, root, strings.Repeat("0", 64), 4<<20)
	otherBundle, _ := fixture(t)
	_, otherRoot, otherHash := trustFixture(t, otherBundle, 1)
	mediaTestRefusal(t, parts, otherRoot, otherHash, 4<<20)
	wrongLabel, _ := mediaTestParts(t, data, "2.0.0", 0)
	mediaTestRefusal(t, wrongLabel, root, hash, 4<<20)
	if e := expiredTimestamp(bundle, keys); e != nil {
		t.Fatal(e)
	}
	expired, _ := mediaTestParts(t, mediaTestArchive(t, bundle, nil, nil), "1.0.0", 0)
	mediaTestRefusal(t, expired, root, hash, 4<<20)
}

func TestMediaBoundsEntireExpansionAndRejectsHiddenTrailers(t *testing.T) {
	bundle, _ := fixture(t)
	_, root, hash := trustFixture(t, bundle, 1)
	valid := mediaTestArchive(t, bundle, nil, nil)
	parts, _ := mediaTestParts(t, valid, "1.0.0", 0)
	mediaTestRefusal(t, parts, root, hash, 512)
	// A legal amount of zero padding still consumes the global expansion budget,
	// even though all signed file sizes fit and tar.Reader has already hit EOF.
	plain, e := gzip.NewReader(bytes.NewReader(valid))
	if e != nil {
		t.Fatal(e)
	}
	expandedSize, e := io.Copy(io.Discard, plain)
	plain.Close()
	if e != nil {
		t.Fatal(e)
	}
	paddingParts, _ := mediaTestParts(t, mediaTestArchive(t, bundle, nil, make([]byte, 8192)), "1.0.0", 0)
	if e = mediaTestRefusal(t, paddingParts, root, hash, expandedSize+4096); !strings.Contains(e.Error(), "expanded byte limit") {
		t.Fatalf("trailing padding did not consume global expansion budget: %v", e)
	}
	badCRC := append([]byte{}, valid...)
	badCRC[len(badCRC)-8] ^= 1
	for name, data := range map[string][]byte{
		"gzip-concatenation": append(append([]byte{}, valid...), valid...),
		"compressed-junk":    append(append([]byte{}, valid...), []byte("hidden")...),
		"truncated-trailer":  valid[:len(valid)-1],
		"rehashed-bad-crc":   badCRC,
		"tar-junk":           mediaTestArchive(t, bundle, nil, []byte("hidden after tar EOF")),
		"excess-tar-padding": mediaTestArchive(t, bundle, nil, make([]byte, 2<<20)),
	} {
		t.Run(name, func(t *testing.T) {
			parts, _ := mediaTestParts(t, data, "1.0.0", 41)
			mediaTestRefusal(t, parts, root, hash, 4<<20)
		})
	}
}

func TestMediaRefusesUnsafeTransportInventoryAndPartLinks(t *testing.T) {
	bundle, _ := fixture(t)
	_, root, hash := trustFixture(t, bundle, 1)
	data := mediaTestArchive(t, bundle, nil, nil)
	for _, kind := range []string{"traversal", "absolute", "duplicate", "size-total", "oversized-part", "symlink", "hardlink"} {
		t.Run(kind, func(t *testing.T) {
			parts, inventory := mediaTestParts(t, data, "1.0.0", 71)
			path := filepath.Join(filepath.Dir(parts), inventory.Parts[0].Path)
			switch kind {
			case "traversal":
				inventory.Parts[0].Path = "../escape"
			case "absolute":
				inventory.Parts[0].Path = path
			case "duplicate":
				inventory.Parts[1].Path = inventory.Parts[0].Path
			case "size-total":
				inventory.Bytes++
			case "oversized-part":
				inventory.Parts[0].Size = mediaMaxPartBytes + 1
			case "symlink":
				other := filepath.Join(t.TempDir(), "part")
				os.Rename(path, other)
				if e := os.Symlink(other, path); e != nil {
					t.Fatal(e)
				}
			case "hardlink":
				if e := os.Link(path, filepath.Join(t.TempDir(), "alias")); e != nil {
					t.Fatal(e)
				}
			}
			if e := writeJSON(parts, inventory); e != nil {
				t.Fatal(e)
			}
			mediaTestRefusal(t, parts, root, hash, 4<<20)
		})
	}
}

func TestMediaExistingOutputAndAtomicPublishNeverOverwrite(t *testing.T) {
	bundle, _ := fixture(t)
	_, root, hash := trustFixture(t, bundle, 1)
	parts, _ := mediaTestParts(t, mediaTestArchive(t, bundle, nil, nil), "1.0.0", 0)
	parent := t.TempDir()
	output := filepath.Join(parent, "existing-empty")
	if e := os.Mkdir(output, 0700); e != nil {
		t.Fatal(e)
	}
	before, _ := os.Stat(output)
	if e := UnpackMedia(context.Background(), parts, output, root, hash, 4<<20); e == nil {
		t.Fatal("existing empty output directory accepted")
	}
	stage := filepath.Join(parent, "ready")
	os.Mkdir(stage, 0700)
	os.WriteFile(filepath.Join(stage, "verified.txt"), []byte("complete"), 0644)
	fd, e := os.Open(parent)
	if e != nil {
		t.Fatal(e)
	}
	defer fd.Close()
	// This models a destination appearing after the initial existence check.
	// os.Rename would replace the empty directory; the platform primitive must not.
	if e := mediaPublishNoReplace(fd, "ready", "existing-empty"); e == nil {
		t.Fatal("atomic publication replaced an existing empty directory")
	}
	after, e := os.Stat(output)
	if e != nil || !os.SameFile(before, after) {
		t.Fatal("existing directory identity changed")
	}
	if _, e := os.Stat(filepath.Join(stage, "verified.txt")); e != nil {
		t.Fatal("refused publication consumed the verified stage")
	}
}

func TestMediaCancellationDoesNotCreateOutput(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	output := filepath.Join(t.TempDir(), "never-created")
	if e := UnpackMedia(ctx, "unused", output, "unused", "unused", 1); !errors.Is(e, context.Canceled) {
		t.Fatalf("cancelled unpack did not stop: %v", e)
	}
	if _, e := os.Lstat(output); !os.IsNotExist(e) {
		t.Fatal("cancelled unpack created output")
	}
}
