# opencode-fleet-sidecar

Remote cc-connect / opencode run-agent sidecar for the OpenCode Fleet Monitor.

Run this on a Windows host that has cc-connect/opencode running. It exposes
the cc-connect child opencode processes on `/runagents`, so the central fleet
hub can render them alongside remote opencode servers.

## Install

```bash
pip install opencode-fleet-sidecar
```

## Run

```bash
# Default port 9099
oc-sidecar

# Custom port
oc-sidecar --port 9099
```

Then in your fleet `fleet.config.json`:

```json
{
  "id": "win-ebao",
  "label": "Win · ebao_jk_kb_v1 :4096",
  "url": "http://10.253.109.134:4096",
  "username": "fleet",
  "password": "...",
  "runAgentsUrl": "http://10.253.109.134:9099/runagents"
}
```

## Development

```bash
python -m build
```
