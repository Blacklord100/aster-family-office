// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"time"
)

const ingressConnectionLimit = 128
const ingressBufferBytes = 32 * 1024
const ingressServiceID = 10001

// runIngress receives its only public listener from systemd. It does not bind a
// port, resolve a hostname, read installation credentials, or inspect payloads.
func runIngress(ctx context.Context, args []string, out io.Writer) error {
	if runtime.GOOS != "linux" || os.Getuid() == 0 || os.Geteuid() == 0 {
		return errors.New("ingress requires a nonroot Linux systemd service")
	}
	socket, err := ingressSocketArgument(args)
	if err != nil {
		return err
	}
	if err = validateIngressActivation(os.Getenv("LISTEN_PID"), os.Getenv("LISTEN_FDS"), os.Getpid()); err != nil {
		return err
	}
	file := os.NewFile(3, "systemd-ingress-listener")
	if file == nil {
		return errors.New("ingress requires TCP listening descriptor 3")
	}
	listener, err := ingressTCPListener(file)
	// FileListener duplicates the descriptor. No extra reference survives startup.
	_ = file.Close()
	if err != nil {
		return err
	}
	defer listener.Close()
	if out == nil {
		return errors.New("ingress requires a status writer")
	}
	if _, err = fmt.Fprintln(out, "Aster ingress relay ready"); err != nil {
		return errors.New("ingress status output failed")
	}
	return serveIngress(ctx, listener, socket, defaultIngressOptions())
}

func ingressSocketArgument(args []string) (string, error) {
	if len(args) != 2 || args[0] != "--socket" || (args[1] != "/sockets/http.sock" && args[1] != "/sockets/https.sock") {
		return "", errors.New("ingress requires exactly --socket /sockets/http.sock or /sockets/https.sock")
	}
	return args[1], nil
}

func validateIngressActivation(pid, fds string, actualPID int) error {
	if pid != strconv.Itoa(actualPID) || fds != "1" {
		return errors.New("ingress requires one systemd listening descriptor for this process")
	}
	return nil
}

func ingressTCPListener(file *os.File) (*net.TCPListener, error) {
	if file == nil {
		return nil, errors.New("ingress requires TCP listening descriptor 3")
	}
	if runtime.GOOS == "linux" {
		accepting, err := syscall.GetsockoptInt(int(file.Fd()), syscall.SOL_SOCKET, syscall.SO_ACCEPTCONN)
		if err != nil || accepting == 0 {
			return nil, errors.New("ingress descriptor is not a listening socket")
		}
	} else {
		// Darwin does not implement SO_ACCEPTCONN. This branch exists only for
		// core tests: runIngress refuses every non-Linux platform before FD use.
		if _, err := syscall.Getpeername(int(file.Fd())); err == nil {
			return nil, errors.New("ingress descriptor is a connected socket")
		}
	}
	listener, err := net.FileListener(file)
	if err != nil {
		return nil, errors.New("ingress descriptor is not a TCP listener")
	}
	tcp, ok := listener.(*net.TCPListener)
	if !ok {
		_ = listener.Close()
		return nil, errors.New("ingress descriptor is not a TCP listener")
	}
	if _, ok = tcp.Addr().(*net.TCPAddr); !ok {
		_ = tcp.Close()
		return nil, errors.New("ingress descriptor has no TCP address")
	}
	return tcp, nil
}

// PROXY v1 is derived solely from kernel-supplied endpoint addresses. Client
// headers (including a client-supplied PROXY line) remain opaque payload bytes.
func ingressProxyLine(remote, local net.Addr) ([]byte, error) {
	source, sourceOK := remote.(*net.TCPAddr)
	destination, destinationOK := local.(*net.TCPAddr)
	if !sourceOK || !destinationOK || source == nil || destination == nil || source.Port < 1 || source.Port > 65535 || destination.Port < 1 || destination.Port > 65535 {
		return nil, errors.New("ingress connection has invalid TCP endpoints")
	}
	sourceIP, sourceValid := netip.AddrFromSlice(source.IP)
	destinationIP, destinationValid := netip.AddrFromSlice(destination.IP)
	if !sourceValid || !destinationValid {
		return nil, errors.New("ingress connection has invalid IP endpoints")
	}
	sourceIP, destinationIP = sourceIP.Unmap(), destinationIP.Unmap()
	if sourceIP.Is4() != destinationIP.Is4() {
		return nil, errors.New("ingress connection has inconsistent address families")
	}
	family := "TCP6"
	if sourceIP.Is4() {
		family = "TCP4"
	}
	return fmt.Appendf(nil, "PROXY %s %s %s %d %d\r\n", family, sourceIP, destinationIP, source.Port, destination.Port), nil
}

type ingressOptions struct {
	connections int
	connectTime time.Duration
	idleTime    time.Duration
	dialUnix    func(context.Context, string) (net.Conn, error)
}

func defaultIngressOptions() ingressOptions {
	return ingressOptions{
		connections: ingressConnectionLimit,
		connectTime: 5 * time.Second,
		idleTime:    120 * time.Second,
		dialUnix:    dialIngressUnix,
	}
}

func validateIngressUnixMetadata(directory, socket string, uid, gid uint32) error {
	if filepath.Clean(directory) != directory || filepath.Clean(socket) != socket || filepath.Dir(socket) != directory {
		return errors.New("ingress Unix socket path is invalid")
	}
	for _, entry := range []struct {
		path string
		mode os.FileMode
	}{{directory, os.ModeDir | 0700}, {socket, os.ModeSocket | 0200}} {
		info, err := os.Lstat(entry.path)
		if err != nil {
			return errors.New("ingress Unix socket is unavailable")
		}
		owner, ok := info.Sys().(*syscall.Stat_t)
		if !ok || owner.Uid != uid || owner.Gid != gid || info.Mode() != entry.mode {
			return errors.New("ingress Unix socket has unsafe ownership, mode or type")
		}
	}
	return nil
}

func dialIngressUnix(ctx context.Context, socket string) (net.Conn, error) {
	if runtime.GOOS != "linux" {
		return nil, errors.New("production Unix ingress requires Linux peer credentials")
	}
	if _, err := ingressSocketArgument([]string{"--socket", socket}); err != nil {
		return nil, err
	}
	// Caddy creates these entries after startup. Validate on each connection,
	// never read their contents, and refuse symlinks or another service's socket.
	if err := validateIngressUnixMetadata("/sockets", socket, ingressServiceID, ingressServiceID); err != nil {
		return nil, err
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, errors.New("ingress Unix connection failed")
	}
	unix, ok := conn.(*net.UnixConn)
	if !ok {
		_ = conn.Close()
		return nil, errors.New("ingress destination is not Unix")
	}
	if err = ingressPeerIdentity(unix, ingressServiceID, ingressServiceID); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}

type ingressConnections struct {
	mu      sync.Mutex
	closing bool
	items   map[net.Conn]struct{}
}

func (connections *ingressConnections) add(conn net.Conn) bool {
	connections.mu.Lock()
	defer connections.mu.Unlock()
	if connections.closing {
		_ = conn.Close()
		return false
	}
	connections.items[conn] = struct{}{}
	return true
}

func (connections *ingressConnections) remove(conn net.Conn) {
	_ = conn.Close()
	connections.mu.Lock()
	delete(connections.items, conn)
	connections.mu.Unlock()
}

func (connections *ingressConnections) closeAll() {
	connections.mu.Lock()
	connections.closing = true
	items := make([]net.Conn, 0, len(connections.items))
	for conn := range connections.items {
		items = append(items, conn)
	}
	connections.mu.Unlock()
	for _, conn := range items {
		_ = conn.Close()
	}
}

// All accepted sockets, Unix dials, and copy loops finish before this returns.
// Options are internal test seams; the CLI exposes no resource-limit overrides.
func serveIngress(ctx context.Context, listener net.Listener, socket string, options ingressOptions) error {
	if options.connections < 1 || options.connections > ingressConnectionLimit || options.connectTime <= 0 || options.idleTime <= 0 || options.dialUnix == nil {
		return errors.New("invalid ingress limits")
	}
	connections := &ingressConnections{items: make(map[net.Conn]struct{})}
	slots := make(chan struct{}, options.connections)
	var workers sync.WaitGroup
	stopWatcher, watcherDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(watcherDone)
		select {
		case <-ctx.Done():
			_ = listener.Close()
			connections.closeAll()
		case <-stopWatcher:
		}
	}()
	defer func() {
		close(stopWatcher)
		_ = listener.Close()
		connections.closeAll()
		workers.Wait()
		<-watcherDone
	}()
	for {
		client, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return errors.New("ingress listener stopped unexpectedly")
		}
		prefix, err := ingressProxyLine(client.RemoteAddr(), client.LocalAddr())
		if err != nil {
			_ = client.Close()
			continue
		}
		select {
		case slots <- struct{}{}:
		default:
			_ = client.Close()
			continue
		}
		if !connections.add(client) {
			<-slots
			continue
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer func() { <-slots }()
			defer connections.remove(client)
			relayIngressConnection(ctx, client, prefix, socket, options, connections)
		}()
	}
}

func relayIngressConnection(ctx context.Context, client net.Conn, prefix []byte, socket string, options ingressOptions, connections *ingressConnections) {
	connectCtx, cancel := context.WithTimeout(ctx, options.connectTime)
	defer cancel()
	upstream, err := options.dialUnix(connectCtx, socket)
	if err != nil {
		return
	}
	if !connections.add(upstream) {
		return
	}
	defer connections.remove(upstream)
	deadline, _ := connectCtx.Deadline()
	if err = upstream.SetWriteDeadline(deadline); err != nil {
		return
	}
	if err = ingressWriteAll(upstream, prefix); err != nil {
		return
	}
	cancel()
	if err = upstream.SetWriteDeadline(time.Time{}); err != nil {
		return
	}
	// Clean EOF closes only the opposite write side, preserving the response
	// after a request half-close. Any read/write failure closes both directions.
	done := make(chan struct{})
	go func() {
		defer close(done)
		if ingressCopy(upstream, client, options.idleTime) != nil {
			_ = upstream.Close()
			_ = client.Close()
		}
	}()
	if ingressCopy(client, upstream, options.idleTime) != nil {
		_ = upstream.Close()
		_ = client.Close()
	}
	<-done
}

func ingressWriteAll(destination net.Conn, data []byte) error {
	for len(data) != 0 {
		n, err := destination.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrNoProgress
		}
		data = data[n:]
	}
	return nil
}

func ingressCopy(destination, source net.Conn, idle time.Duration) error {
	buffer := make([]byte, ingressBufferBytes)
	for {
		if err := source.SetReadDeadline(time.Now().Add(idle)); err != nil {
			return err
		}
		n, readError := source.Read(buffer)
		if n > 0 {
			remaining := buffer[:n]
			for len(remaining) != 0 {
				if err := destination.SetWriteDeadline(time.Now().Add(idle)); err != nil {
					return err
				}
				written, err := destination.Write(remaining)
				if err != nil {
					return err
				}
				if written == 0 {
					return io.ErrNoProgress
				}
				remaining = remaining[written:]
			}
		}
		if errors.Is(readError, io.EOF) {
			if half, ok := destination.(interface{ CloseWrite() error }); ok {
				return half.CloseWrite()
			}
			return errors.New("ingress destination cannot half-close")
		}
		if readError != nil {
			return readError
		}
		if n == 0 {
			return io.ErrNoProgress
		}
	}
}
