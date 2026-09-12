// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"
	"sort"
	"strings"
)

// Optional services are an explicit installation choice, never inherited from
// the invoking shell or inferred from provider credentials found in a backup.
func parseOptionalServices(profile, value string) ([]string, error) {
	var services []string
	if value != "" {
		services = strings.Split(value, ",")
	}
	if err := validateOptionalServices(profile, services); err != nil {
		return nil, err
	}
	sort.Strings(services)
	return services, nil
}

func validateOptionalServices(profile string, services []string) error {
	if profile != "offline" && profile != "connected" {
		return fmt.Errorf("invalid installation network profile")
	}
	if profile == "offline" && len(services) != 0 {
		return fmt.Errorf("offline installations cannot enable optional network services")
	}
	seen := map[string]bool{}
	for _, service := range services {
		if (service != "mailbox" && service != "delivery") || seen[service] {
			return fmt.Errorf("optional services must be distinct mailbox or delivery names")
		}
		seen[service] = true
	}
	return nil
}

func (s Installation) hasOptionalService(name string) bool {
	for _, service := range s.OptionalServices {
		if service == name {
			return true
		}
	}
	return false
}

func validateUpdateNetworkPolicy(previous, candidate Installation) error {
	for _, installation := range []Installation{previous, candidate} {
		if err := validateOptionalServices(installation.Profile, installation.OptionalServices); err != nil {
			return err
		}
	}
	if previous.Profile != candidate.Profile || len(previous.OptionalServices) != len(candidate.OptionalServices) {
		return fmt.Errorf("update cannot change the installed network profile or optional services")
	}
	for _, service := range previous.OptionalServices {
		if !candidate.hasOptionalService(service) {
			return fmt.Errorf("update cannot change the installed network profile or optional services")
		}
	}
	return nil
}
