//go:build darwin

// SPDX-License-Identifier: Apache-2.0
package main

import (
	"errors"
	"net"
)

// Only portable relay-core tests run here. A Darwin build must never silently
// accept the production Linux peer-credential requirement.
func ingressPeerIdentity(_ *net.UnixConn, _, _ uint32) error {
	return errors.New("production Unix ingress peer credentials are unsupported on Darwin")
}
