//go:build linux

// SPDX-License-Identifier: Apache-2.0
package main

import (
	"errors"
	"net"
	"syscall"
)

func ingressPeerIdentity(conn *net.UnixConn, uid, gid uint32) error {
	raw, err := conn.SyscallConn()
	if err != nil {
		return errors.New("ingress Unix peer identity unavailable")
	}
	var identityError error
	err = raw.Control(func(fd uintptr) {
		credentials, failure := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		if failure != nil || credentials == nil || credentials.Uid != uid || credentials.Gid != gid {
			identityError = errors.New("ingress Unix peer identity rejected")
		}
	})
	if err != nil {
		return errors.New("ingress Unix peer identity unavailable")
	}
	return identityError
}
