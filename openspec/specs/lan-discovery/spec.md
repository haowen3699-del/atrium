# LAN Discovery & Team Key Specification

## Purpose
Define how independent atrium instances find each other on a LAN without configuration, and how they decide whether to trust each other.

## Requirements

### Requirement: Zero-config LAN discovery
Each instance SHALL periodically announce itself over UDP broadcast on a well-known port (default 41800, overridable by `ATRIUM_DISCOVERY_PORT`) and listen for announcements, so that instances on the same subnet appear to each other without any configuration file.

#### Scenario: New machine joins
- **WHEN** a freshly installed instance starts on the same subnet
- **THEN** it SHALL appear in existing instances' peer list within a few seconds
- **AND** it SHALL list the existing instances itself

#### Scenario: Instance disappears
- **WHEN** an instance stops announcing for longer than the peer TTL (15 s)
- **THEN** it SHALL be removed from the peer list without manual cleanup

#### Scenario: Same host, multiple instances
- **WHEN** two instances run on one machine
- **THEN** they SHALL discover each other through the loopback announcement as well as broadcast

### Requirement: Announcement contents
Announcements SHALL be limited to identity and reachability (`id`, `port`, `label`, `version`) and SHALL NOT contain the team key or any node data.

#### Scenario: Packet capture
- **WHEN** an announcement packet is inspected
- **THEN** no credential, key or session data SHALL be present

### Requirement: Team key authentication
HTTP APIs SHALL require the team key via the `x-atrium-key` header (or `key` query parameter for SSE). Requests from loopback SHALL be exempt; `/api/node-info` SHALL remain open because it carries no fleet data.

#### Scenario: LAN browser
- **WHEN** a browser opens the UI over a LAN address without a key
- **THEN** the UI SHALL show a key gate and, after the key is entered once, remember it

#### Scenario: Mismatched keys
- **WHEN** a peer responds 401/403 to a snapshot request
- **THEN** its data SHALL NOT be merged
- **AND** the peer SHALL be shown as "密钥不匹配" with the fix explained

### Requirement: Join guidance
A newly installed instance that discovers peers but is paired with none SHALL proactively offer to join the fleet.

#### Scenario: First launch with peers present
- **WHEN** the board loads and no discovered peer is paired
- **THEN** a "join the fleet" dialog SHALL appear listing the discovered instances
- **AND** entering the shared key SHALL pair them without a page reload

#### Scenario: Already paired
- **WHEN** at least one peer is paired
- **THEN** the dialog SHALL NOT be shown, and dismissals SHALL be remembered per peer set

### Requirement: Version consistency surfacing
The peer list SHALL include each peer's version and SHALL flag mismatches as older/newer than the local version, with an upgrade command.

#### Scenario: Mixed versions
- **WHEN** a peer announces a different version
- **THEN** the topology panel SHALL mark it, and the board SHALL badge the entry point
