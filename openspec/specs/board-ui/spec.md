# Board UI Specification

## Purpose
Define the operator-facing board: how agents are displayed, filtered, inspected and controlled, and what attention mechanisms exist for unattended operation.

## Requirements

### Requirement: Multiple display styles
The board SHALL offer several display styles over the same filtered data set — lanes (default, grouped by machine), helix, orbit and grid — with the choice persisted locally and switchable from the top bar.

#### Scenario: Switching styles
- **WHEN** the operator switches to helix or orbit
- **THEN** the same agents SHALL be shown with continuous motion, drag-to-rotate and hover emphasis
- **AND** selection, context menu, pinning and state filters SHALL keep working

#### Scenario: Empty filter result
- **WHEN** the selected state filter matches no agent
- **THEN** an explicit "no agent in this state" message SHALL be shown instead of a blank area

### Requirement: Agent states
Every agent SHALL be classified as `writing`, `awaiting`, `ready`, `asleep` or `done`, and the classification SHALL drive color, animation and filtering consistently across all display styles.

#### Scenario: Pending approval wins
- **WHEN** a node has a pending permission or question
- **THEN** it SHALL be classified `awaiting` even if a session is busy

### Requirement: Session interaction
Selecting an agent SHALL open a detail panel with its sessions, live conversation, and the ability to send prompts, abort, approve or reject permissions, and answer questions.

#### Scenario: Remote agent without HTTP API
- **WHEN** the selected run agent has no HTTP API of its own
- **THEN** the panel SHALL route conversation through the owning node and explain the path

### Requirement: Attention mechanisms
The board SHALL notify the operator when a new pending permission or question appears, through in-app alert cards, a desktop notification, a sound and a title badge, each individually switchable.

#### Scenario: New pending item
- **WHEN** a pending permission appears that was not present before
- **THEN** all enabled channels SHALL fire once
- **AND** the same item SHALL NOT notify again
- **AND** the alert card SHALL offer a jump to that agent

#### Scenario: Baseline on first load
- **WHEN** the board is opened while pending items already exist
- **THEN** no notification SHALL be produced for them

### Requirement: Topology and help surfaces
The board SHALL provide a topology panel (local instance identity, peers, manual nodes, team key management) and a help panel documenting installation, upgrade, common commands and troubleshooting for the running instance.

#### Scenario: Self-description
- **WHEN** the help panel is opened
- **THEN** it SHALL show version, platform, port, instance id, local and LAN URLs, run mode (manual or autostart), key source, data directory, config path and the pip install/upgrade commands with copy buttons
