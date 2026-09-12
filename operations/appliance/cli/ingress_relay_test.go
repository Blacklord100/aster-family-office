// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func ingressTestOptions() ingressOptions {
	options := defaultIngressOptions()
	options.dialUnix = func(ctx context.Context, socket string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}
	return options
}

func ingressUnixFixture(t *testing.T) (*net.UnixListener, string) {
	t.Helper()
	// Keep the path within Darwin's Unix socket length limit.
	directory, err := os.MkdirTemp("", "aster-ir-")
	if err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(directory, "c.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		_ = os.RemoveAll(directory)
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close(); _ = os.RemoveAll(directory) })
	return listener, socket
}

func ingressTCPFixture(t *testing.T, network string) *net.TCPListener {
	t.Helper()
	address := "127.0.0.1:0"
	if network == "tcp6" {
		address = "[::1]:0"
	}
	listener, err := net.Listen(network, address)
	if err != nil && network == "tcp6" {
		t.Skipf("IPv6 loopback unavailable: %v", err)
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener.(*net.TCPListener)
}

func ingressServerFixture(t *testing.T, network string, options ingressOptions) (*net.TCPListener, *net.UnixListener, context.CancelFunc, <-chan error) {
	t.Helper()
	upstream, socket := ingressUnixFixture(t)
	listener := ingressTCPFixture(t, network)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serveIngress(ctx, listener, socket, options); close(done) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(3 * time.Second):
			t.Error("ingress did not join its connection workers")
		}
	})
	return listener, upstream, cancel, done
}

func ingressClient(t *testing.T, listener *net.TCPListener) *net.TCPConn {
	t.Helper()
	client, err := net.DialTCP("tcp", nil, listener.Addr().(*net.TCPAddr))
	if err != nil {
		t.Fatal(err)
	}
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestIngressStrictArgumentsAndActivation(t *testing.T) {
	for _, socket := range []string{"/sockets/http.sock", "/sockets/https.sock"} {
		if actual, err := ingressSocketArgument([]string{"--socket", socket}); err != nil || actual != socket {
			t.Fatalf("approved socket rejected: %q %v", actual, err)
		}
	}
	for _, args := range [][]string{nil, {"--socket"}, {"--socket=/sockets/http.sock"}, {"--socket", "http://example.invalid"}, {"--socket", "/sockets/../else.sock"}, {"--socket", "/sockets/http.sock", "extra"}, {"--socket", "@abstract"}, {"--socket", "/sockets/https.sock/"}, {"--port", "443"}} {
		if _, err := ingressSocketArgument(args); err == nil {
			t.Fatalf("unapproved destination or extra argument accepted: %v", args)
		}
	}
	if err := validateIngressActivation("123", "1", 123); err != nil {
		t.Fatal(err)
	}
	for _, values := range [][2]string{{"", ""}, {"123", "0"}, {"123", "2"}, {"123", "01"}, {"124", "1"}, {"0123", "1"}, {"123", "1 "}} {
		if err := validateIngressActivation(values[0], values[1], 123); err == nil {
			t.Fatalf("invalid activation accepted: %v", values)
		}
	}
	t.Setenv("LISTEN_PID", "")
	t.Setenv("LISTEN_FDS", "")
	err := runIngress(context.Background(), []string{"--socket", "/sockets/http.sock"}, io.Discard)
	if err == nil {
		t.Fatal("entrypoint accepted an unactivated process")
	}
	if (runtime.GOOS != "linux" || os.Getuid() == 0 || os.Geteuid() == 0) && !strings.Contains(err.Error(), "nonroot Linux") {
		t.Fatalf("platform/root guard did not run first: %v", err)
	}
}

func TestIngressInheritedDescriptorMustBeListeningTCP(t *testing.T) {
	listener := ingressTCPFixture(t, "tcp4")
	file, err := listener.File()
	if err != nil {
		t.Fatal(err)
	}
	inherited, err := ingressTCPListener(file)
	_ = file.Close()
	if err != nil {
		t.Fatal(err)
	}
	defer inherited.Close()
	if inherited.Addr().String() != listener.Addr().String() {
		t.Fatal("inherited descriptor changed its bound endpoint")
	}
	_ = listener.Close()
	client := ingressClient(t, inherited)
	accepted, err := inherited.AcceptTCP()
	if err != nil {
		t.Fatal(err)
	}
	defer accepted.Close()
	connectedFile, err := client.File()
	if err != nil {
		t.Fatal(err)
	}
	defer connectedFile.Close()
	unix, _ := ingressUnixFixture(t)
	unixFile, err := unix.File()
	if err != nil {
		t.Fatal(err)
	}
	defer unixFile.Close()
	readPipe, writePipe, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer readPipe.Close()
	defer writePipe.Close()
	regular, err := os.CreateTemp(t.TempDir(), "not-a-socket")
	if err != nil {
		t.Fatal(err)
	}
	defer regular.Close()
	for _, invalid := range []*os.File{nil, connectedFile, unixFile, readPipe, regular} {
		if unexpected, err := ingressTCPListener(invalid); err == nil {
			_ = unexpected.Close()
			t.Fatal("non-listening/non-TCP descriptor accepted")
		}
	}
}

func TestIngressLinuxRejectsBoundButNonListeningTCP(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux systemd admission requires SO_ACCEPTCONN")
	}
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	file := os.NewFile(uintptr(fd), "synthetic-bound-not-listening")
	defer file.Close()
	if err = syscall.Bind(fd, &syscall.SockaddrInet4{Addr: [4]byte{127, 0, 0, 1}}); err != nil {
		t.Fatal(err)
	}
	if unexpected, err := ingressTCPListener(file); err == nil {
		_ = unexpected.Close()
		t.Fatal("bound non-listening TCP descriptor accepted")
	}
}

func TestIngressUnixMetadataRejectsLinksOwnersModesAndRegularFiles(t *testing.T) {
	_, socket := ingressUnixFixture(t)
	directory := filepath.Dir(socket)
	uid, gid := uint32(os.Geteuid()), uint32(os.Getegid())
	if err := os.Chmod(socket, 0200); err != nil {
		t.Fatal(err)
	}
	if err := validateIngressUnixMetadata(directory, socket, uid, gid); err != nil {
		t.Fatal(err)
	}
	for _, owner := range [][2]uint32{{uid + 1, gid}, {uid, gid + 1}} {
		if err := validateIngressUnixMetadata(directory, socket, owner[0], owner[1]); err == nil {
			t.Fatal("foreign ownership accepted")
		}
	}
	if err := os.Chmod(socket, 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateIngressUnixMetadata(directory, socket, uid, gid); err == nil {
		t.Fatal("permissive socket mode accepted")
	}
	_ = os.Chmod(socket, 0200)
	if err := os.Chmod(directory, 0755); err != nil {
		t.Fatal(err)
	}
	if err := validateIngressUnixMetadata(directory, socket, uid, gid); err == nil {
		t.Fatal("public socket directory accepted")
	}
	_ = os.Chmod(directory, 0700)
	regular := filepath.Join(directory, "regular.sock")
	if err := os.WriteFile(regular, []byte("synthetic"), 0200); err != nil {
		t.Fatal(err)
	}
	if err := validateIngressUnixMetadata(directory, regular, uid, gid); err == nil {
		t.Fatal("regular file accepted as socket")
	}
	link := filepath.Join(directory, "linked.sock")
	if err := os.Symlink(socket, link); err != nil {
		t.Fatal(err)
	}
	if err := validateIngressUnixMetadata(directory, link, uid, gid); err == nil {
		t.Fatal("socket symlink accepted")
	}
	parentLink := filepath.Join(t.TempDir(), "linked-directory")
	if err := os.Symlink(directory, parentLink); err != nil {
		t.Fatal(err)
	}
	if err := validateIngressUnixMetadata(parentLink, filepath.Join(parentLink, "c.sock"), uid, gid); err == nil {
		t.Fatal("directory symlink accepted")
	}
	if err := validateIngressUnixMetadata(directory, filepath.Join(directory, "missing.sock"), uid, gid); err == nil {
		t.Fatal("missing Caddy socket accepted")
	}
}

func TestIngressUnixPeerCredentialsAreNeverAnUnverifiedSuccess(t *testing.T) {
	listener, socket := ingressUnixFixture(t)
	client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	peer, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	if runtime.GOOS != "linux" {
		if err = ingressPeerIdentity(client, uint32(os.Geteuid()), uint32(os.Getegid())); err == nil {
			t.Fatal("non-Linux peer identity silently passed")
		}
		if _, err = dialIngressUnix(context.Background(), "/sockets/http.sock"); err == nil {
			t.Fatal("non-Linux production Unix dial accepted")
		}
		return
	}
	if err = ingressPeerIdentity(client, uint32(os.Geteuid()), uint32(os.Getegid())); err != nil {
		t.Fatal(err)
	}
	if err = ingressPeerIdentity(client, uint32(os.Geteuid())+1, uint32(os.Getegid())); err == nil {
		t.Fatal("wrong peer UID accepted")
	}
	if err = ingressPeerIdentity(client, uint32(os.Geteuid()), uint32(os.Getegid())+1); err == nil {
		t.Fatal("wrong peer GID accepted")
	}
}

func TestIngressProxyAddressesCanonicalAndNeverClientSupplied(t *testing.T) {
	for _, test := range []struct{ source, destination, expected string }{
		{"192.0.2.1", "192.0.2.2", "PROXY TCP4 192.0.2.1 192.0.2.2 1234 443\r\n"},
		{"::ffff:192.0.2.1", "192.0.2.2", "PROXY TCP4 192.0.2.1 192.0.2.2 1234 443\r\n"},
		{"2001:0db8:0000::1", "2001:db8::2", "PROXY TCP6 2001:db8::1 2001:db8::2 1234 443\r\n"},
	} {
		prefix, err := ingressProxyLine(&net.TCPAddr{IP: net.ParseIP(test.source), Port: 1234}, &net.TCPAddr{IP: net.ParseIP(test.destination), Port: 443})
		if err != nil || string(prefix) != test.expected {
			t.Fatalf("incorrect canonical prefix %q: %v", prefix, err)
		}
	}
	valid := &net.TCPAddr{IP: net.ParseIP("192.0.2.1"), Port: 443}
	for _, endpoints := range [][2]net.Addr{
		{nil, valid}, {(*net.TCPAddr)(nil), valid}, {&net.UnixAddr{Name: "PROXY TCP4 spoofed"}, valid},
		{&net.TCPAddr{IP: nil, Port: 10}, valid}, {&net.TCPAddr{IP: valid.IP, Port: 0}, valid},
		{&net.TCPAddr{IP: valid.IP, Port: 65536}, valid},
		{&net.TCPAddr{IP: net.ParseIP("2001:db8::1"), Port: 10}, valid},
	} {
		if _, err := ingressProxyLine(endpoints[0], endpoints[1]); err == nil {
			t.Fatal("invalid endpoint metadata accepted")
		}
	}
}

type ingressShortWrites struct{ net.Conn }

func (conn ingressShortWrites) Write(data []byte) (int, error) {
	if len(data) > 7 {
		data = data[:7]
	}
	return conn.Conn.Write(data)
}
func (conn ingressShortWrites) CloseWrite() error {
	return conn.Conn.(interface{ CloseWrite() error }).CloseWrite()
}

func TestIngressForwardsOpaqueBytesAndPreservesRequestHalfClose(t *testing.T) {
	for _, network := range []string{"tcp4", "tcp6"} {
		for _, shortWrites := range []bool{false, true} {
			t.Run(network+"/short="+strconv.FormatBool(shortWrites), func(t *testing.T) {
				options := ingressTestOptions()
				options.idleTime = 2 * time.Second
				if shortWrites {
					original := options.dialUnix
					options.dialUnix = func(ctx context.Context, socket string) (net.Conn, error) {
						conn, err := original(ctx, socket)
						if err != nil {
							return nil, err
						}
						return ingressShortWrites{conn}, nil
					}
				}
				listener, unix, _, _ := ingressServerFixture(t, network, options)
				body := append([]byte{0x16, 0x03, 0x03, 0, 255}, bytes.Repeat([]byte("PROXY TCP4 203.0.113.9 203.0.113.8 1 443\r\nX-Real-IP: spoofed\r\n\x00"), 1200)...)
				if shortWrites {
					body = body[:5000]
				}
				response := bytes.Repeat([]byte{0, 1, 2, 255}, 20000)
				type result struct {
					prefix string
					body   []byte
					err    error
				}
				upstreamDone := make(chan result, 1)
				go func() {
					conn, err := unix.AcceptUnix()
					if err != nil {
						upstreamDone <- result{err: err}
						return
					}
					defer conn.Close()
					_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
					reader := bufio.NewReader(conn)
					prefix, err := reader.ReadString('\n')
					if err != nil {
						upstreamDone <- result{err: err}
						return
					}
					received, err := io.ReadAll(reader)
					if err == nil {
						err = ingressWriteAll(conn, response)
					}
					if err == nil {
						err = conn.CloseWrite()
					}
					upstreamDone <- result{prefix, received, err}
				}()
				client := ingressClient(t, listener)
				if err := ingressWriteAll(client, body); err != nil {
					t.Fatal(err)
				}
				if err := client.CloseWrite(); err != nil {
					t.Fatal(err)
				}
				received, err := io.ReadAll(client)
				if err != nil || !bytes.Equal(received, response) {
					t.Fatalf("response changed after request half-close: %d %v", len(received), err)
				}
				upstreamResult := <-upstreamDone
				family := "TCP4"
				if network == "tcp6" {
					family = "TCP6"
				}
				source, destination := client.LocalAddr().(*net.TCPAddr), client.RemoteAddr().(*net.TCPAddr)
				expected := fmt.Sprintf("PROXY %s %s %s %d %d\r\n", family, source.IP.String(), destination.IP.String(), source.Port, destination.Port)
				if upstreamResult.err != nil || upstreamResult.prefix != expected || !bytes.Equal(upstreamResult.body, body) {
					t.Fatalf("opaque payload or trusted endpoint prefix changed: %q %v", upstreamResult.prefix, upstreamResult.err)
				}
			})
		}
	}
}

func TestIngressUpstreamHalfCloseStillAllowsClientData(t *testing.T) {
	listener, unix, _, _ := ingressServerFixture(t, "tcp4", ingressTestOptions())
	upstreamDone := make(chan error, 1)
	go func() {
		conn, err := unix.AcceptUnix()
		if err != nil {
			upstreamDone <- err
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		reader := bufio.NewReader(conn)
		if _, err = reader.ReadString('\n'); err == nil {
			err = ingressWriteAll(conn, []byte("response-complete"))
		}
		if err == nil {
			err = conn.CloseWrite()
		}
		if err == nil {
			data, readErr := io.ReadAll(reader)
			err = readErr
			if !bytes.Equal(data, []byte("client-after-response")) {
				err = errors.New("client data was lost after upstream half-close")
			}
		}
		upstreamDone <- err
	}()
	client := ingressClient(t, listener)
	response, err := io.ReadAll(client)
	if err != nil || string(response) != "response-complete" {
		t.Fatalf("upstream half-close lost response: %q %v", response, err)
	}
	if err = ingressWriteAll(client, []byte("client-after-response")); err != nil {
		t.Fatal(err)
	}
	_ = client.CloseWrite()
	if err = <-upstreamDone; err != nil {
		t.Fatal(err)
	}
}

func TestIngressConnectionLimitAndCancellationJoinAllWorkers(t *testing.T) {
	options := ingressTestOptions()
	options.connections = 2
	listener, unix, cancel, done := ingressServerFixture(t, "tcp4", options)
	upstream := make(chan *net.UnixConn, 2)
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		for range 2 {
			conn, err := unix.AcceptUnix()
			if err != nil {
				return
			}
			upstream <- conn
		}
	}()
	clients := []*net.TCPConn{ingressClient(t, listener), ingressClient(t, listener)}
	peers := []*net.UnixConn{<-upstream, <-upstream}
	<-acceptDone
	for _, conn := range peers {
		defer conn.Close()
	}
	excess := ingressClient(t, listener)
	if _, err := excess.Read(make([]byte, 1)); err == nil || isIngressTimeout(err) {
		t.Fatalf("excess connection was not promptly closed: %v", err)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not join all relay loops")
	}
	for _, conn := range clients {
		if _, err := conn.Read(make([]byte, 1)); err == nil || isIngressTimeout(err) {
			t.Fatalf("cancel left client open: %v", err)
		}
	}
	for _, conn := range peers {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := io.ReadAll(conn); err != nil {
			t.Fatalf("cancel left Unix peer open: %v", err)
		}
	}
}

func isIngressTimeout(err error) bool {
	var timeout net.Error
	return errors.As(err, &timeout) && timeout.Timeout()
}

func TestIngressDialDeadlineReleasesItsConnectionSlot(t *testing.T) {
	options := ingressTestOptions()
	options.connections, options.connectTime = 1, 30*time.Millisecond
	var dialled atomic.Int32
	options.dialUnix = func(ctx context.Context, _ string) (net.Conn, error) {
		dialled.Add(1)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	listener, _, _, _ := ingressServerFixture(t, "tcp4", options)
	for range 3 {
		client := ingressClient(t, listener)
		if _, err := client.Read(make([]byte, 1)); err == nil || isIngressTimeout(err) {
			t.Fatalf("Unix dial did not time out and close client: %v", err)
		}
		_ = client.Close()
	}
	if dialled.Load() != 3 {
		t.Fatal("timed-out dials leaked connection slots")
	}
}

func TestIngressPrefixDeadlineAndPendingDialCancellation(t *testing.T) {
	t.Run("prefix-write", func(t *testing.T) {
		options := ingressTestOptions()
		options.connectTime = 30 * time.Millisecond
		writer, unread := net.Pipe()
		defer unread.Close()
		options.dialUnix = func(context.Context, string) (net.Conn, error) { return writer, nil }
		listener, _, _, _ := ingressServerFixture(t, "tcp4", options)
		client := ingressClient(t, listener)
		if _, err := client.Read(make([]byte, 1)); err == nil || isIngressTimeout(err) {
			t.Fatalf("blocked prefix write did not close client: %v", err)
		}
	})
	t.Run("pending-dial", func(t *testing.T) {
		options := ingressTestOptions()
		entered := make(chan struct{})
		exited := make(chan struct{})
		options.dialUnix = func(ctx context.Context, _ string) (net.Conn, error) {
			close(entered)
			<-ctx.Done()
			close(exited)
			return nil, ctx.Err()
		}
		listener, _, cancel, done := ingressServerFixture(t, "tcp4", options)
		_ = ingressClient(t, listener)
		<-entered
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("cancellation did not await pending dial")
		}
		select {
		case <-exited:
		default:
			t.Fatal("dial goroutine survived relay return")
		}
	})
}

func TestIngressIdleDeadlineClosesBothDirections(t *testing.T) {
	options := ingressTestOptions()
	options.idleTime = 40 * time.Millisecond
	listener, unix, _, _ := ingressServerFixture(t, "tcp4", options)
	client := ingressClient(t, listener)
	upstream, err := unix.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	_ = upstream.SetDeadline(time.Now().Add(time.Second))
	prefix, err := bufio.NewReader(upstream).ReadString('\n')
	if err != nil || !strings.HasPrefix(prefix, "PROXY TCP4 ") {
		t.Fatalf("initial prefix missing: %q %v", prefix, err)
	}
	if _, err = client.Read(make([]byte, 1)); err == nil || isIngressTimeout(err) {
		t.Fatalf("idle connection not closed: %v", err)
	}
	if _, err = io.ReadAll(upstream); err != nil {
		t.Fatalf("idle upstream not closed: %v", err)
	}
}

type ingressMeasuredWrite struct {
	net.Conn
	largest atomic.Int32
}

func (conn *ingressMeasuredWrite) Write(data []byte) (int, error) {
	conn.largest.Store(int32(len(data)))
	return conn.Conn.Write(data)
}

func TestIngressCopyUsesBoundedBufferAndWriteIdleDeadline(t *testing.T) {
	source, writer := net.Pipe()
	destination, unread := net.Pipe()
	defer source.Close()
	defer writer.Close()
	defer destination.Close()
	defer unread.Close()
	measured := &ingressMeasuredWrite{Conn: destination}
	writeDone := make(chan struct{})
	go func() { defer close(writeDone); _, _ = writer.Write(make([]byte, ingressBufferBytes*3)) }()
	err := ingressCopy(measured, source, 30*time.Millisecond)
	if !isIngressTimeout(err) {
		t.Fatalf("backpressure did not reach bounded write timeout: %v", err)
	}
	if measured.largest.Load() != ingressBufferBytes {
		t.Fatalf("copy buffer changed: %d", measured.largest.Load())
	}
	_ = source.Close()
	_ = writer.Close()
	select {
	case <-writeDone:
	case <-time.After(time.Second):
		t.Fatal("writer survived timeout cleanup")
	}
}
