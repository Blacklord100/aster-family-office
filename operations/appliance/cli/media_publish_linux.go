// SPDX-License-Identifier: Apache-2.0
package main

import (
	"os"

	"golang.org/x/sys/unix"
)

func mediaPublishNoReplace(parent *os.File, from, to string) error {
	return unix.Renameat2(int(parent.Fd()), from, int(parent.Fd()), to, unix.RENAME_NOREPLACE)
}
