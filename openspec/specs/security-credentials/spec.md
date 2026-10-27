# Security & Credentials Specification

## Purpose
Define how secrets and trust material are handled by atrium, in the repository, at runtime and across instances.

## Requirements

### Requirement: No secrets in the repository
Real credentials (node passwords, package index passwords, peer tokens) SHALL NOT be committed; the repository SHALL ship placeholders instead.

#### Scenario: Configuration
- **WHEN** the repository is inspected
- **THEN** it SHALL contain `fleet.config.example.json` with `${NODE_PASSWORD}` style placeholders
- **AND** the real `fleet.config.json` SHALL be ignored by git

#### Scenario: Package index credentials
- **WHEN** publishing metadata is inspected
- **THEN** only a placeholder example SHALL be present, never the deployer password

### Requirement: Key handling between instances
The team key SHALL be transmitted only in HTTP requests between instances and in the browser's local storage; it SHALL NOT appear in discovery broadcasts, logs of other machines or any peer's configuration.

#### Scenario: Pairing
- **WHEN** an operator joins a fleet by pasting a key
- **THEN** the key SHALL be stored in the local config file only
- **AND** discovery SHALL remain key-free

### Requirement: Local credential scope
Credentials recovered or entered for local OpenCode servers SHALL remain on the machine and SHALL NOT be exposed through the API or included in snapshots.

#### Scenario: Snapshot inspection
- **WHEN** a snapshot is fetched by a peer
- **THEN** it SHALL contain no credential fields, only node/agent state
