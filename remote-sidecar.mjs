#!/usr/bin/env node
/**
 * Remote run-agent sidecar for Windows.
 * Run on the remote Windows host alongside cc-connect / opencode.
 * Exposes cc-connect and child opencode processes as runAgents JSON.
 *
 * Usage:
 *   node remote-sidecar.mjs --port 9099
 *
 * Then in fleet.config.json node:
 *   "runAgentsUrl": "http://10.253.109.134:9099/runagents"
 */
import http from "node:http";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const args = process.argv.slice(2);
const PORT = Number(args.find((_, i) => args[i - 1] === "--port") || 9099);

function run(cmd) {
  return execAsync(cmd, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }).then(({ stdout }) => stdout).catch(() => "");
}

async function tasklist() {
  const out = await run("wmic process get ProcessId,ParentProcessId,CommandLine /format:csv");
  const rows = [];
  for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 4) continue;
    const cmd = parts.slice(3).join(",").replace(/^"|"$/g, "");
    const pid = Number(parts[1]);
    const ppid = Number(parts[2]);
    rows.push({ pid, ppid, cmd });
  }
  return rows;
}

async function ccConnectAgents() {
  const tasks = await tasklist();
  const cc = tasks.filter((t) => t.cmd.toLowerCase().includes("cc-connect"));
  if (!cc.length) return [];

  const children = tasks.filter((t) => cc.some((p) => p.pid === t.ppid) && t.cmd.toLowerCase().includes("opencode"));
  const byDir = new Map();
  for (const c of children) {
    const m = c.cmd.match(/[\s"']([A-Za-z]:\\[^"'\s]+)/);
    const dir = m ? m[1].replace(/\\$/, "") : `pid:${c.pid}`;
    const g = byDir.get(dir) || { pids: [], dir };
    g.pids.push(c.pid);
    byDir.set(dir, g);
  }

  return [...byDir.values()].map((g) => ({
    id: `run-cc-${g.dir.replace(/[\\:\/]/g, "-")}`,
    kind: "run",
    label: `cc-connect · ${g.dir.split("\\").filter(Boolean).pop() || g.dir}`,
    pid: g.pids[0],
    procCount: g.pids.length,
    bridge: "cc-connect",
    workDir: g.dir,
    cpuSeconds: 0,
    active: true,
    busyCount: g.pids.length,
    lastActivityAt: Date.now(),
    activeDir: g.dir,
    sessions: [],
  }));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/runagents") {
    try {
      const runAgents = await ccConnectAgents();
      res.writeHead(200);
      res.end(JSON.stringify({ runAgents }, null, 2));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ ok: false }));
});

server.listen(PORT, () => console.log(`remote sidecar listening on http://0.0.0.0:${PORT}/runagents`));
