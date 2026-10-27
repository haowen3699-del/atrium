# Packaging & Release Specification

## Purpose
Define how atrium is distributed so that installing one package on any machine yields a complete, self-updating, auto-starting service.

## Requirements

### Requirement: Single package, complete service
The distribution SHALL be one pip package (`opencode-fleet-atrium`) whose install provides the hub, the built web assets and a Node runtime, so no separate sidecar and no pre-installed Node are required.

#### Scenario: Fresh machine
- **WHEN** a user runs `pip install -U opencode-fleet-atrium --index-url <internal index>` on a clean machine
- **THEN** the `atrium` command SHALL start the full service, including a bundled runtime

#### Scenario: Platform selection
- **WHEN** pip resolves the package on macOS (arm64/x86_64) or Windows
- **THEN** exactly one platform wheel containing that platform's runtime SHALL be selected
- **AND** an incompatible platform wheel SHALL be refused

### Requirement: Startup transparency
The launcher SHALL print local URL, LAN URL, team key and data directory once the service is ready, for both foreground and autostart invocation.

#### Scenario: Autostart has no terminal
- **WHEN** the service is started by the OS scheduler
- **THEN** `atrium autostart on` SHALL wait for readiness and print the same banner
- **AND** `atrium info` SHALL reproduce it later, identifying the instance by id

#### Scenario: Port already used
- **WHEN** the requested port is occupied
- **THEN** the launcher SHALL pick the next free port and report it, and the runtime info SHALL record the actual port

### Requirement: Autostart management
The package SHALL manage OS autostart: launchd on macOS, a per-user registry run entry on Windows and a systemd user unit on Linux, with `on`, `off` and `status` actions.

#### Scenario: Unusable interpreter
- **WHEN** autostart is requested from an interpreter that cannot import the package
- **THEN** the action SHALL be refused with an explanation instead of installing a broken job

#### Scenario: Minimal scheduler environment
- **WHEN** the scheduler starts the service with a minimal environment
- **THEN** the runtime SHALL still be found (bundled runtime first, then common locations) and PATH-dependent tools SHALL remain reachable

### Requirement: Release process
Releases SHALL be reproducible from the repository with one command that rebuilds the web assets, bundles the server, collects each platform runtime, builds platform-tagged wheels and prints the upload command.

#### Scenario: Bumping a version
- **WHEN** the maintainer bumps the version and runs the build script
- **THEN** wheels for the configured targets SHALL be produced in a single output directory with no stale platform bleed (no foreign runtime inside a wheel)

### Requirement: Version discovery
The instance SHALL discover the latest published version from the internal package index and expose it together with its own version, whether an update exists, and whether the instance is managed by an OS autostart job.

#### Scenario: Index unreachable
- **WHEN** the package index cannot be queried
- **THEN** the check SHALL report the error without blocking the board

#### Scenario: Peer is newer
- **WHEN** a peer announces a version newer than the local one
- **THEN** the topology panel SHALL flag it (and the update check remains the authoritative source)

### Requirement: One-click upgrade
The board SHALL offer a one-click upgrade when a newer version exists, and the upgrade SHALL preserve the running service: the current process steps aside, the package is upgraded in the same interpreter, and the service is restarted by the same mechanism that started it.

#### Scenario: Managed by the OS scheduler
- **WHEN** the instance is managed by launchd or systemd
- **THEN** the restart SHALL reuse that supervisor so the instance keeps the same port and data directory

#### Scenario: Started manually
- **WHEN** the instance was started from a terminal
- **THEN** the upgrade SHALL wait for the preferred port to be released and start a replacement instance on it

#### Scenario: Files in use
- **WHEN** the upgrade replaces the package that the running process uses
- **THEN** the upgrade SHALL run in a detached helper after the current process exits, logging to `<data dir>/logs/upgrade.log`

#### Scenario: Not a packaged install
- **WHEN** the instance was started from source (no packaging interpreter recorded)
- **THEN** the upgrade action SHALL be refused with the manual command instead

### Requirement: Optional auto-upgrade
Auto-upgrade SHALL be off by default and switchable; when enabled, the instance SHALL check the index periodically and upgrade itself without operator action.

#### Scenario: Enabled
- **WHEN** auto-upgrade is on and a newer version is published
- **THEN** the instance SHALL upgrade and restart on its own, leaving evidence in the upgrade log
