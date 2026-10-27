# Fleet Hub Specification

## Purpose
Define how one atrium instance aggregates, tracks and publishes the state of every OpenCode node and run agent it can see, and how snapshots are streamed to the UI.

## Requirements

### Requirement: Snapshot contract
The hub SHALL expose the aggregated fleet state on `GET /api/snapshot` with `generatedAt`, `nodes[]`, `runAgents[]`, `self{}` and the peer list, so that any consumer (UI or peer instance) can render the whole fleet from one document.

#### Scenario: UI bootstrap
- **WHEN** the web UI loads
- **THEN** it SHALL receive a snapshot over `GET /api/stream` (SSE `snapshot` events) without polling

#### Scenario: Peer consumption
- **WHEN** another instance fetches `/api/snapshot` with a valid team key
- **THEN** the response SHALL be the same document shape the local UI consumes

### Requirement: Node polling
For every configured or discovered OpenCode node the hub SHALL poll sessions, session status, pending permissions and pending questions, and SHALL derive a node status of `online` / `stale` / `offline` from the last successful poll.

#### Scenario: Slow network
- **WHEN** a node has not answered for longer than twice the poll interval
- **THEN** its status SHALL degrade to `stale` and later `offline` without removing it from the snapshot

### Requirement: Run agent detection
The hub SHALL report local run agents for cc-connect worker processes, openclaw and hermes gateway daemons, standalone `pi`, and the OpenCode desktop application main process, each with pid, bridge, workDir, cpuSeconds and an `active` flag.

#### Scenario: Desktop main process only
- **WHEN** the OpenCode desktop app is running
- **THEN** exactly one run agent SHALL be reported for it
- **AND** Electron helper, renderer, gpu, crashpad and `serve --port` processes SHALL be excluded

#### Scenario: Idle process is not "writing"
- **WHEN** a run agent has no busy session and its CPU time is not increasing
- **THEN** it SHALL be reported as not active (asleep) rather than busy

### Requirement: One-hop peer merge
The hub SHALL merge peer snapshots by prefixing ids with the peer id, and SHALL accept only entries that the peer itself owns (ids without a `::` prefix) so that a fully-connected mesh cannot recursively re-export third-party entries.

#### Scenario: Two paired instances
- **WHEN** instance A and instance B both see each other
- **THEN** A's snapshot SHALL contain B's local nodes/runAgents exactly once
- **AND** SHALL NOT contain labels repeated like `@A @B`

#### Scenario: Peer unreachable
- **WHEN** a peer stops answering for more than 30 seconds
- **THEN** its entries SHALL be reported as `stale` and eventually dropped, never duplicated

### Requirement: Event log
The hub SHALL keep a bounded per-node ring buffer of normalized events and expose them on `GET /api/events` with `since`, `node`, `type` and `limit` filters plus the known type list.

#### Scenario: Tailing the log
- **WHEN** the UI polls `/api/events` every two seconds
- **THEN** newly arrived events SHALL be distinguishable by timestamp and rendered as a live tail

### Requirement: Control forwarding
The hub SHALL forward control operations (prompt, abort, permission reply, question reply, message fetch) to the instance that owns the target node, using the `peerId::nodeId` id form.

#### Scenario: Steering a remote agent
- **WHEN** the user sends a prompt to a node whose id is prefixed with a peer id
- **THEN** the request SHALL be relayed to that peer's API with the team key
