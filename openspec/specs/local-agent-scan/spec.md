# Local Agent Scan Specification

## Purpose
Define what an instance discovers about its own machine: OpenCode servers listening on loopback and agent processes that are not nodes of their own.

## Requirements

### Requirement: Local OpenCode server discovery
The instance SHALL detect OpenCode servers listening on `127.0.0.1`, verify them with an authenticated `GET /session`, and register each as a dynamic node, so a machine always shows its own server without configuration.

#### Scenario: Server appears later
- **WHEN** an OpenCode server starts after the instance
- **THEN** it SHALL be added within one discovery cycle
- **AND** SHALL be removed only after three consecutive failed probes, so a busy server does not flicker

### Requirement: Credential recovery
When a local server requires basic auth, the instance SHALL recover credentials from the local process environment (macOS `ps eww -A`, Linux `/proc/<pid>/environ`), pairing username and password per process, trying candidates until one authenticates. Recovered credentials SHALL stay in memory only.

#### Scenario: Desktop-embedded server
- **WHEN** the OpenCode desktop app serves on an ephemeral port with a generated password
- **THEN** the instance SHALL authenticate and show the server as its own node

#### Scenario: Recovery not possible
- **WHEN** credentials cannot be recovered (for example on Windows, which does not expose other processes' environment)
- **THEN** the port SHALL be reported as needing credentials, and the panel SHALL offer an inline form

### Requirement: Manual credential entry
The UI SHALL allow entering username and password for a specific local port; the backend SHALL verify them before accepting, then persist them to the instance config and apply them immediately.

#### Scenario: Wrong password
- **WHEN** the submitted credentials fail authentication
- **THEN** the request SHALL be rejected with an explicit "authentication failed" message and nothing SHALL be persisted

#### Scenario: Restart persistence
- **WHEN** the instance restarts after a successful entry
- **THEN** the server SHALL be picked up automatically from the persisted credentials

### Requirement: Run agent scanning
The instance SHALL scan local processes for agent activity (see the fleet-hub run agent requirements) exactly like a remote sidecar would, so that no sidecar installation is required on any machine.

#### Scenario: No sidecar installed
- **WHEN** only the atrium package is installed on a machine
- **THEN** its run agents SHALL still be reported to the fleet
