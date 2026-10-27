import { Application, Container, Graphics, Sprite, Text, TextStyle, Texture } from "https://cdn.jsdelivr.net/npm/pixi.js@8.6.6/dist/pixi.min.mjs";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = (ts) => { if (!ts) return "—"; const s = Math.floor((Date.now() - ts) / 1000); if (s < 60) return s + "s"; if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h"; return Math.floor(s / 86400) + "d"; };
const allNodes = () => [...(lastSnap?.nodes ?? []), ...(lastSnap?.runAgents ?? [])];

const aliasStore = (() => { try { return JSON.parse(localStorage.getItem("atrium.aliases") || "{}"); } catch { return {}; } })();
const aliasOf = (nd) => aliasStore[nd.id] || nd.label;
const pinStore = new Set((() => { try { return JSON.parse(localStorage.getItem("atrium.pins") || "[]"); } catch { return []; } })());
const savePins = () => localStorage.setItem("atrium.pins", JSON.stringify([...pinStore]));
const saveAliases = () => localStorage.setItem("atrium.aliases", JSON.stringify(aliasStore));

const isBusy = (nd) => (nd.sessions ?? []).some((s) => s.busy);
const pendingCount = (nd) => (nd.kind === "run" ? 0 : (nd.pendingPermissions?.length ?? 0) + (nd.pendingQuestions?.length ?? 0));

const STATE = {
  writing: { c: 0xb8c8ff, label: "WRITING" },
  awaiting: { c: 0xf4d27a, label: "AWAITING" },
  ready: { c: 0xa8d4a0, label: "READY" },
  asleep: { c: 0x6a5a4a, label: "ASLEEP" },
};
const STATE_ORDER = ["writing", "awaiting", "ready", "asleep"];

function stateOf(nd) {
  if (nd.kind === "run") return nd.active ? "writing" : "asleep";
  if (pendingCount(nd)) return "awaiting";
  if (isBusy(nd)) return "writing";
  if (nd.status === "offline" || Date.now() - (nd.lastOkAt ?? 0) > 180000) return "asleep";
  return "ready";
}

let lastSnap = null;
let selectedId = null;
let stateFilter = "all";
let pixiOK = false;

const settings = (() => {
  try { return JSON.parse(localStorage.getItem("atrium.settings") || "{}"); } catch { return {}; }
})();
const saveSettings = () => localStorage.setItem("atrium.settings", JSON.stringify(settings));
const getSpeed = () => settings.speed ?? 0.3;
const getSize = () => settings.size ?? 1.6;
const getView = () => settings.view ?? "solar"; // "solar" or "flat"

// 3D rotation state
let rotX = 0.35;
let rotY = 0;
let targetRotX = 0.35;
let targetRotY = 0;
let isDragging = false;
let dragStartX = 0, dragStartY = 0, dragStartRotX = 0, dragStartRotY = 0;
const FOCAL = 800;

// view toggle
let lastMachineKey = "";
function setView(v) {
  settings.view = v;
  saveSettings();
  const btn = document.getElementById("view-toggle");
  if (btn) btn.textContent = v === "solar" ? "星系" : "平面";
  lastMachineKey = ""; // force rebuild
  syncFlames();
}
document.getElementById("view-toggle")?.addEventListener("click", () => {
  setView(getView() === "solar" ? "flat" : "solar");
});
setView(getView()); // init label

const CTX_CAP = 256000;
function contextUsage(nd) {
  if (nd.kind !== "server" && !nd.sessions) return 0;
  let used = 0;
  for (const s of nd.sessions ?? []) used += (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0);
  return Math.min(1, used / CTX_CAP);
}

/* ============ PIXI init ============ */
const app = new Application();
const bg = new Container();
const orbitLayer = new Container();
const world = new Container();
const flamesLayer = new Container();
let W = window.innerWidth, H = window.innerHeight;
const sprites = new Map();
const embers = [];

// 3D projection: rotate (x,y,z) by rotX/rotY, project to 2D screen
function project3d(x, y, z) {
  // rotate around Y axis
  const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
  let x1 = x * cosY + z * sinY;
  let z1 = -x * sinY + z * cosY;
  // rotate around X axis
  const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
  let y1 = y * cosX - z1 * sinX;
  let z2 = y * sinX + z1 * cosX;
  // perspective projection
  const scale = FOCAL / (FOCAL + z2);
  return { x: x1 * scale, y: y1 * scale, z: z2, scale };
}

// mouse drag for 3D rotation
const canvas3d = document.getElementById("stage");
canvas3d.addEventListener("mousedown", (ev) => {
  isDragging = true;
  dragStartX = ev.clientX;
  dragStartY = ev.clientY;
  dragStartRotX = targetRotX;
  dragStartRotY = targetRotY;
  canvas3d.style.cursor = "grabbing";
});
window.addEventListener("mousemove", (ev) => {
  if (!isDragging) return;
  const dx = ev.clientX - dragStartX;
  const dy = ev.clientY - dragStartY;
  targetRotY = dragStartRotY + dx * 0.008;
  targetRotX = Math.max(-1.2, Math.min(1.4, dragStartRotX + dy * 0.008));
});
window.addEventListener("mouseup", () => {
  isDragging = false;
  canvas3d.style.cursor = "grab";
});
canvas3d.style.cursor = "grab";

let appReady;
try {
  await app.init({ canvas: document.getElementById("stage"), resizeTo: window, antialias: true, backgroundAlpha: 0, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true });
  app.stage.addChild(bg, world);
  app.stage.eventMode = "static";
  world.addChild(orbitLayer);
  orbitLayer.addChild(flamesLayer);
  flamesLayer.eventMode = "static";
  orbitLayer.sortableChildren = true;
  flamesLayer.sortableChildren = true;
  pixiOK = true;
  appReady = Promise.resolve();
} catch (e) {
  console.error("pixi init failed", e);
  appReady = Promise.reject(e);
}

function makeGlowTex(color, size = 200) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const cx = c.getContext("2d");
  const g = cx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  const r = (color >> 16) & 0xff, gC = (color >> 8) & 0xff, b = color & 0xff;
  g.addColorStop(0, `rgba(${r},${gC},${b},0.85)`);
  g.addColorStop(0.3, `rgba(${r},${gC},${b},0.25)`);
  g.addColorStop(1, `rgba(${r},${gC},${b},0)`);
  cx.fillStyle = g;
  cx.fillRect(0, 0, size, size);
  return Texture.from(c);
}

/* ============ starfield background ============ */
const stars = [];
function makeBackdrop() {
  bg.removeChildren();
  stars.length = 0;
  W = window.innerWidth; H = window.innerHeight;
  // faint nebulae
  const nebColors = [0x2a1408, 0x181410, 0x201408];
  for (let i = 0; i < 3; i++) {
    const sp = new Sprite(makeGlowTex(nebColors[i], 800));
    sp.anchor.set(0.5);
    sp.width = sp.height = 1200 + i * 200;
    sp.alpha = 0.06;
    sp.x0 = (i + 0.5) * W / 3; sp.y0 = (i + 0.5) * H / 3;
    sp.phase = Math.random() * 6.28;
    bg.addChild(sp);
    stars.push(sp);
  }
  // stars
  for (let i = 0; i < 120; i++) {
    const d = new Graphics().circle(0, 0, Math.random() * 1.2 + 0.2).fill({ color: 0xc4b89a, alpha: Math.random() * 0.4 + 0.05 });
    d.x = Math.random() * W; d.y = Math.random() * H;
    d.x0 = d.x; d.y0 = d.y;
    d.phase = Math.random() * 6.28;
    d.twinkle = 0.5 + Math.random();
    bg.addChild(d);
    stars.push(d);
  }
}
makeBackdrop();
window.addEventListener("resize", () => { makeBackdrop(); });

/* ============ solar system data ============ */
let sunGfx = null;
let orbits = [];
let planetData = new Map();

function buildSolarSystem() {
  const nodes = lastSnap?.nodes ?? [];
  const runAgents = lastSnap?.runAgents ?? [];

  // each node IS a machine/planet; match run agents by machine label → node label
  const byMachine = new Map(); // key = node.id → { node, runAgents: [] }
  for (const nd of nodes) {
    byMachine.set(nd.id, { node: nd, runAgents: [] });
  }
  for (const ra of runAgents) {
    // find parent node: ra.machine matches node.label, or "local" → first local node
    let parentId = null;
    if (ra.machine) {
      const match = nodes.find((nd) => nd.label === ra.machine || nd.id === ra.machine);
      parentId = match?.id;
    }
    if (!parentId) {
      // local run agents → first node without machine field
      const localNd = nodes.find((nd) => !nd.machine) ?? nodes[0];
      parentId = localNd?.id;
    }
    if (parentId && byMachine.has(parentId)) byMachine.get(parentId).runAgents.push(ra);
  }

  const machines = [...byMachine.entries()];
  // sort: local machine (no machine field) first
  machines.sort((a, b) => {
    const aLocal = !a[1].node?.machine;
    const bLocal = !b[1].node?.machine;
    if (aLocal && !bLocal) return -1;
    if (!aLocal && bLocal) return 1;
    return a[0].localeCompare(b[0]);
  });
  const key = machines.map(([m]) => m).join("|");

  // preserve angles if machines haven't changed
  const oldAngles = new Map();
  for (const [m, pd] of planetData) oldAngles.set(m, pd.angle);

  orbitLayer.removeChildren();
  orbits = [];
  planetData.clear();

  // position orbit layer at screen center
  orbitLayer.position.set(W / 2, H / 2);

  // count active/asleep for even distribution
  let activeCount = 0, asleepCount = 0;
  const machineList = machines.map(([id, g]) => {
    const st = g.node ? stateOf(g.node) : "asleep";
    if (st === "asleep") asleepCount++; else activeCount++;
    return { id, g, st, active: st !== "asleep" };
  });
  let aIdx = 0, sIdx = 0;

  machineList.forEach(({ id: machineId, g: group, st, active }) => {
    const idx = machines.findIndex(([m]) => m === machineId);
    const isFlat = getView() === "flat";
    const orbitRadius = isFlat ? 0 : (160 + idx * 150) * getSize();
    const planetR = 10 * getSize();

    // even spread: active → sunny half (-π/2..π/2), asleep → dark half (π/2..3π/2)
    let startAngle;
    if (isFlat) {
      const total = machines.length;
      startAngle = oldAngles.get(machineId) ?? ((idx / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2);
    } else if (active) {
      startAngle = oldAngles.get(machineId) ?? (-Math.PI / 2 + (aIdx + 0.5) * Math.PI / Math.max(1, activeCount));
      aIdx++;
    } else {
      startAngle = oldAngles.get(machineId) ?? (Math.PI / 2 + (sIdx + 0.5) * Math.PI / Math.max(1, asleepCount));
      sIdx++;
    }
    // flat layout position
    const flatR = Math.min(W, H) * 0.32;
    const flatX = isFlat ? Math.cos(startAngle) * flatR : 0;
    const flatY = isFlat ? Math.sin(startAngle) * flatR * 0.7 : 0;
    planetData.set(machineId, { angle: startAngle, targetAngle: startAngle, orbitRadius, speed: 0, planetRadius: planetR, machineId, group, flatX, flatY });
  });

  // sun only in solar mode
  const isFlatMode = getView() === "flat";
  if (!isFlatMode) {
    sunGfx = new Container();
    const sunR = 55 * getSize();

    const sunGlow = new Sprite(makeGlowTex(0xe89a4f, 600));
    sunGlow.anchor.set(0.5);
    sunGlow.width = sunGlow.height = sunR * 5;
    sunGlow.alpha = 0.08;
    sunGfx.addChild(sunGlow);

    const sunBody = new Sprite(makeGlowTex(0xf0aa46, Math.round(sunR * 4)));
    sunBody.anchor.set(0.5);
    sunBody.width = sunBody.height = sunR * 3;
    sunBody.alpha = 0.9;
    sunGfx.addChild(sunBody);

    const sunCore = new Sprite(makeGlowTex(0xffd070, Math.round(sunR * 2)));
    sunCore.anchor.set(0.5);
    sunCore.width = sunCore.height = sunR * 1.8;
    sunCore.alpha = 0.7;
    sunGfx.addChild(sunCore);

    const sunHL = new Sprite(makeGlowTex(0xfff5e0, 200));
    sunHL.anchor.set(0.5);
    sunHL.width = sunHL.height = sunR * 0.7;
    sunHL.x = -sunR * 0.25;
    sunHL.y = -sunR * 0.3;
    sunHL.alpha = 0.35;
    sunGfx.addChild(sunHL);

    const sunLabel = new Text({ text: "☉ Hub", style: new TextStyle({ fontFamily: "Cormorant Garamond, Songti SC, Georgia, serif", fontSize: 11, fill: 0xe89a4f, alpha: 0.4, fontStyle: "italic" }) });
    sunLabel.resolution = 3;
    sunLabel.anchor.set(0.5, 0);
    sunLabel.y = sunR + 8;
    sunGfx.addChild(sunLabel);

    const linesGfx = new Graphics();
    orbitLayer.addChild(linesGfx);
    sunGfx._linesGfx = linesGfx;
    orbitLayer.addChild(sunGfx);
  } else {
    sunGfx = null;
  }

  orbitLayer.addChild(flamesLayer);
  lastMachineKey = key;
  return key;
}

/* ============ planet (wireframe globe, subtle) ============ */
function makePlanet(nd, pd) {
  const g = new Container();
  const state = stateOf(nd);
  const color = STATE[state].c;
  const r = pd.planetRadius;

  // wireframe globe — clean, minimal
  const wire = new Graphics();
  // 2 latitude lines
  for (const lat of [Math.PI / 3, (2 * Math.PI) / 3]) {
    const lr = r * Math.sin(lat), ly = r * Math.cos(lat);
    wire.moveTo(-lr, ly).lineTo(lr, ly).stroke({ width: 0.5, color, alpha: 0.10 });
    wire.moveTo(-lr, -ly).lineTo(lr, -ly).stroke({ width: 0.5, color, alpha: 0.10 });
  }
  // 2 longitude lines
  for (const a of [Math.PI / 3, (2 * Math.PI) / 3]) {
    const w = r * Math.abs(Math.sin(a));
    if (w > 0.5) wire.ellipse(0, 0, w, r).stroke({ width: 0.5, color, alpha: 0.08 });
  }
  // equator
  wire.circle(0, 0, r).stroke({ width: 0.6, color, alpha: 0.12 });
  g.addChild(wire);
  g.wire = wire;

  // label
  const label = new Text({ text: "", style: new TextStyle({ fontFamily: "Cormorant Garamond, Songti SC, Georgia, serif", fontSize: 10, fill: 0x9a8c70, fontStyle: "italic" }) });
  label.resolution = 3;
  label.anchor.set(0.5, 0);
  label.y = r + 4;
  g.addChild(label);
  g.label = label;

  g._nd = nd;
  g._pd = pd;
  return g;
}

/* ============ agent (prominent, solid, glowing) ============ */
function makeMoon(ra, pd) {
  const g = new Container();
  const state = stateOf(ra);
  const color = STATE[state].c;
  const r = 10 * getSize();

  // big glow halo
  const halo = new Sprite(makeGlowTex(color, 200));
  halo.anchor.set(0.5);
  halo.width = halo.height = r * 5;
  halo.alpha = state === "asleep" ? 0.15 : 0.6;
  g.addChild(halo);
  g.halo = halo;

  // solid body
  const body = new Graphics().circle(0, 0, r).fill({ color: 0x0a0807, alpha: 0.9 }).stroke({ width: 2, color, alpha: 0.95 });
  g.addChild(body);
  g.body = body;

  // inner glow
  const core = new Sprite(makeGlowTex(color, 100));
  core.anchor.set(0.5);
  core.width = core.height = r * 1.8;
  g.addChild(core);
  g.core = core;

  // label — prominent
  const label = new Text({ text: "", style: new TextStyle({ fontFamily: "Cormorant Garamond, Songti SC, Georgia, serif", fontSize: 11, fill: 0xe8dcc4, fontStyle: "italic" }) });
  label.resolution = 3;
  label.anchor.set(0.5, 0);
  label.y = r + 6;
  g.addChild(label);
  g.label = label;

  g._ra = ra;
  g._pd = pd;
  // static position around planet, no orbiting
  return g;
}

/* ============ sync: create/update planets & moons ============ */
function syncFlames() {
  if (!pixiOK) return;
  const nodes = lastSnap?.nodes ?? [];
  const runAgents = lastSnap?.runAgents ?? [];
  const byMachine = new Map();
  for (const nd of nodes) {
    byMachine.set(nd.id, { node: nd, runAgents: [] });
  }
  for (const ra of runAgents) {
    let parentId = null;
    if (ra.machine) {
      const match = nodes.find((nd) => nd.label === ra.machine || nd.id === ra.machine);
      parentId = match?.id;
    }
    if (!parentId) {
      const localNd = nodes.find((nd) => !nd.machine) ?? nodes[0];
      parentId = localNd?.id;
    }
    if (parentId && byMachine.has(parentId)) byMachine.get(parentId).runAgents.push(ra);
  }
  const machines = [...byMachine.entries()];
  machines.sort((a, b) => {
    const aLocal = !a[1].node?.machine;
    const bLocal = !b[1].node?.machine;
    if (aLocal && !bLocal) return -1;
    if (!aLocal && bLocal) return 1;
    return a[0].localeCompare(b[0]);
  });
  const key = machines.map(([m]) => m).join("|");

  // only rebuild if machine set changed
  if (key !== lastMachineKey) {
    buildSolarSystem();
    // clear old sprites
    for (const [id, g] of sprites) flamesLayer.removeChild(g);
    sprites.clear();

    const list = allNodes();
    const filtered = list.filter((n) => stateFilter === "all" || stateOf(n) === stateFilter);
    const visibleIds = new Set(filtered.map((n) => n.id));

    for (const [machineId, pd] of planetData) {
      const primaryNd = pd.group.node;
      if (!primaryNd) continue;
      const g = makePlanet(primaryNd, pd);
      flamesLayer.addChild(g);
      sprites.set(primaryNd.id, g);
      g._visible = visibleIds.has(primaryNd.id);

      for (let i = 0; i < pd.group.runAgents.length; i++) {
        const ra = pd.group.runAgents[i];
        const moon = makeMoon(ra, pd);
        // static 3D position around planet on XZ plane
        const total = pd.group.runAgents.length;
        const spread = Math.min(Math.PI * 0.8, total * 0.4);
        const a = -spread / 2 + (total > 1 ? (i / (total - 1)) * spread : 0);
        const dist = (pd.planetRadius + 28) * getSize();
        moon._localX = Math.cos(a) * dist;
        moon._localY = Math.sin(a) * dist;
        moon.position.x = moon._localX;
        moon.position.y = moon._localY;
        g.addChild(moon);
        sprites.set(ra.id, moon);
        moon._visible = visibleIds.has(ra.id);
      }
    }
  }

  // update data references (keep positions)
  for (const [machineId, pd] of planetData) {
    pd.group = byMachine.get(machineId) || pd.group;
    const primaryNd = pd.group.node;
    if (primaryNd) {
      const g = sprites.get(primaryNd.id);
      if (g) g._nd = primaryNd;
    }
    for (const ra of pd.group.runAgents) {
      const m = sprites.get(ra.id);
      if (m) m._ra = ra;
    }
  }

  // update labels & visuals (no position reset)
  const list = allNodes();
  const filtered = list.filter((n) => stateFilter === "all" || stateOf(n) === stateFilter);
  const visibleIds = new Set(filtered.map((n) => n.id));

  for (const [id, g] of sprites) {
    const nd = g._nd || g._ra;
    if (!nd) continue;
    g._visible = visibleIds.has(id);
    const state = stateOf(nd);
    const color = STATE[state].c;
    if (g.label) g.label.text = aliasOf(nd);

    if (g._nd) {
      // planet: clean wireframe, update color
      g.wire?.clear();
      const r = g._pd.planetRadius;
      for (const lat of [Math.PI / 3, (2 * Math.PI) / 3]) {
        const lr = r * Math.sin(lat), ly = r * Math.cos(lat);
        g.wire.moveTo(-lr, ly).lineTo(lr, ly).stroke({ width: 0.5, color, alpha: 0.10 });
        g.wire.moveTo(-lr, -ly).lineTo(lr, -ly).stroke({ width: 0.5, color, alpha: 0.10 });
      }
      for (const a of [Math.PI / 3, (2 * Math.PI) / 3]) {
        const w = r * Math.abs(Math.sin(a));
        if (w > 0.5) g.wire.ellipse(0, 0, w, r).stroke({ width: 0.5, color, alpha: 0.08 });
      }
      g.wire.circle(0, 0, r).stroke({ width: 0.6, color, alpha: 0.12 });
    }

    if (g._ra) {
      // agent: solid, prominent, update body & glow
      const isSel = selectedId === nd.id;
      const r = 10 * getSize();
      g.body.clear().circle(0, 0, isSel ? r + 3 : r).fill({ color: 0x0a0807, alpha: 0.9 }).stroke({ width: isSel ? 2.5 : 2, color, alpha: 0.95 });
      g.halo.tint = color;
      g.core.tint = color;
    }

    g.visible = g._visible !== false;
  }

  if (selectedId) positionTranscript();
}

/* ============ ticker: orbital mechanics ============ */
if (pixiOK) {
  app.ticker.add((ticker) => {
    const now = performance.now();
    const dt = ticker.deltaMS;

    // background drift
    for (const sp of stars) {
      sp.x = (sp.x0 ?? sp.x) + Math.sin(now * 0.00003 + sp.phase) * 12;
      sp.y = (sp.y0 ?? sp.y) + Math.cos(now * 0.000025 + sp.phase) * 8;
      if (sp.twinkle) sp.alpha = 0.05 + Math.abs(Math.sin(now * 0.001 * sp.twinkle + sp.phase)) * 0.35;
    }

    // smooth rotation toward target (solar mode only)
    if (getView() === "solar") {
      rotX += (targetRotX - rotX) * 0.08;
      rotY += (targetRotY - rotY) * 0.08;
    }

    // sun pulse
    if (sunGfx) {
      const glow = sunGfx.children[0];
      if (glow) glow.alpha = 0.07 + Math.sin(now * 0.001) * 0.03;
    }

    // clear connection lines
    const linesGfx = sunGfx?._linesGfx;
    if (linesGfx) linesGfx.clear();

    // collect all sprites with positions for depth sorting
    const depthList = [];

    // sun
    if (sunGfx) depthList.push({ obj: sunGfx, z: 0, isSun: true });

    const isFlatMode = getView() === "flat";

    if (isFlatMode) {
      // flat mode: all items positioned independently, breathing + floating
      const allList = allNodes();
      const sorted = [...allList].sort((a, b) => {
        const sa = (a.sessions ?? [])[0]?.updatedAt ?? a.lastActivityAt ?? 0;
        const sb = (b.sessions ?? [])[0]?.updatedAt ?? b.lastActivityAt ?? 0;
        return sb - sa;
      });
      const total = sorted.length;

      // state-based breathing config
      const BREATH = {
        writing: { speed: 0.003, amp: 0.08, glow: [0.45, 0.8], core: [0.5, 0.9] },
        awaiting: { speed: 0.002, amp: 0.05, glow: [0.3, 0.5], core: [0.3, 0.6] },
        ready: { speed: 0.0012, amp: 0.03, glow: [0.12, 0.25], core: [0.15, 0.35] },
        asleep: { speed: 0.0005, amp: 0.01, glow: [0.04, 0.1], core: [0.05, 0.15] },
      };

      sorted.forEach((nd, i) => {
        const g = sprites.get(nd.id);
        if (!g) return;
        const hash = nd.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
        const xPct = ((hash % 1000) / 1000);
        const baseX = (xPct * 0.8 + 0.1) * W - W / 2;
        const yPct = total > 1 ? i / (total - 1) : 0.3;
        const baseY = (yPct * 0.55 + 0.1) * H - H / 2;

        const st = stateOf(nd);
        const cfg = BREATH[st] || BREATH.asleep;
        const color = STATE[st].c;

        // breathing phase (slow, organic)
        g._breathPhase = (g._breathPhase ?? hash * 0.01) + cfg.speed * dt;
        // floating (slower, larger, two sine waves for organic feel)
        g._floatPhase = (g._floatPhase ?? hash * 0.02) + 0.0015 * dt;
        const fy = Math.sin(g._floatPhase) * 8 + Math.sin(g._floatPhase * 0.3 + 1) * 4;
        const fx = Math.cos(g._floatPhase * 0.7) * 6 + Math.cos(g._floatPhase * 0.23 + 2) * 3;

        g.position.x = baseX + fx;
        g.position.y = baseY + fy;
        g._depthScale = 1;
        g._depthZ = 0;
        g.alpha = 1;
        if (g.label) { g.label.text = aliasOf(nd); g.label.scale.set(1); }

        // breathing scale
        const breath = 1 + Math.sin(g._breathPhase) * cfg.amp;
        g.scale.set(breath);

        // glow pulse (state-dependent)
        const glowPulse = (cfg.glow[0] + cfg.glow[1]) / 2 + (cfg.glow[1] - cfg.glow[0]) / 2 * Math.sin(g._breathPhase * 1.5);
        const corePulse = (cfg.core[0] + cfg.core[1]) / 2 + (cfg.core[1] - cfg.core[0]) / 2 * Math.sin(g._breathPhase * 2);

        if (g._ra) {
          g.halo.alpha = glowPulse + (selectedId === nd.id ? 0.2 : 0);
          g.halo.tint = color;
          g.halo.scale.set(1 + Math.sin(g._breathPhase) * 0.06);
          g.core.alpha = corePulse;
          g.core.tint = color;
          g.core.scale.set(0.8 + Math.sin(g._breathPhase * 1.3) * 0.1);
        } else if (g._nd) {
          // planet wireframe breathing
          if (g.wire) g.wire.alpha = glowPulse * 0.5;
        }

        depthList.push({ obj: g, z: 0, scale: 1 });
      });
    } else {
      // solar mode: planets & agents with 3D projection
      for (const [machine, pd] of planetData) {
      const nd = pd.group.node;
      const st = nd ? stateOf(nd) : "asleep";
      const active = st !== "asleep";
      const onSunny = Math.abs(pd.angle) < Math.PI / 2;
      if (active && !onSunny) {
        pd.targetAngle = 0.3 + (pd.angle % 0.5);
        pd.angle += (((pd.targetAngle - pd.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 0.002 * dt;
      } else if (!active && onSunny) {
        pd.targetAngle = Math.PI + 0.3;
        pd.angle += (((pd.targetAngle - pd.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 0.002 * dt;
      }

      // position: 3D in solar mode, flat 2D in flat mode
      let p;
      if (isFlatMode) {
        // flat: use flatX/flatY with gentle float
        p = { x: pd.flatX, y: pd.flatY, z: 0, scale: 1 };
      } else {
        // 3D position on XZ plane (orbit around sun at origin)
        const x3 = Math.cos(pd.angle) * pd.orbitRadius;
        const z3 = Math.sin(pd.angle) * pd.orbitRadius;
        p = project3d(x3, 0, z3);
      }

      // draw orbit ellipse (solar mode only)
      if (linesGfx && !isFlatMode) {
        const steps = 48;
        const orbitPts = [];
        for (let s = 0; s <= steps; s++) {
          const a = (s / steps) * Math.PI * 2;
          const ox = Math.cos(a) * pd.orbitRadius;
          const oz = Math.sin(a) * pd.orbitRadius;
          const op = project3d(ox, 0, oz);
          orbitPts.push(op);
        }
        for (let s = 0; s < orbitPts.length - 1; s++) {
          const pa = orbitPts[s], pb = orbitPts[s + 1];
          const alpha = 0.06 - Math.abs(pa.z) * 0.00005;
          if (alpha > 0.01) linesGfx.moveTo(pa.x, pa.y).lineTo(pb.x, pb.y).stroke({ width: 0.5, color: 0x8a7a5a, alpha });
        }
      }

      for (const [id, g] of sprites) {
        if (g._pd !== pd || !g._nd) continue;

        // set planet 2D position from projection
        g.position.x = p.x;
        g.position.y = p.y;
        g._depthScale = p.scale;
        g._depthZ = p.z;

        // sun → planet connection line
        if (linesGfx) {
          linesGfx.moveTo(0, 0).lineTo(p.x, p.y).stroke({ width: 0.4, color: 0x8a7a5a, alpha: 0.05 + (active ? 0.03 : 0) });
        }

        // planet wireframe alpha based on depth
        if (g.wire) g.wire.alpha = 0.5 + p.scale * 0.3;

        // agent: breathing glow + floating motion + 3D position
        const BREATH = {
          writing: { speed: 0.003, amp: 0.08, glow: [0.45, 0.8], core: [0.5, 0.9] },
          awaiting: { speed: 0.002, amp: 0.05, glow: [0.3, 0.5], core: [0.3, 0.6] },
          ready: { speed: 0.0012, amp: 0.03, glow: [0.12, 0.25], core: [0.15, 0.35] },
          asleep: { speed: 0.0005, amp: 0.01, glow: [0.04, 0.1], core: [0.05, 0.15] },
        };
        for (const child of g.children) {
          if (!child._ra) continue;
          const mstate = stateOf(child._ra);
          const mcolor = STATE[mstate].c;
          const mcfg = BREATH[mstate] || BREATH.asleep;

          // breathing + floating
          child._breathPhase = (child._breathPhase ?? Math.random() * 6.28) + mcfg.speed * dt;
          child._floatPhase = (child._floatPhase ?? Math.random() * 6.28) + 0.0015 * dt;
          const floatY = Math.sin(child._floatPhase) * 8 + Math.sin(child._floatPhase * 0.3 + 1) * 4;
          const floatX = Math.cos(child._floatPhase * 0.7) * 6 + Math.cos(child._floatPhase * 0.23 + 2) * 3;

          const ax = child._localX + floatX;
          const ay = child._localY + floatY;
          let ap;
          if (isFlatMode) {
            ap = { x: p.x + ax, y: p.y + ay, z: 0, scale: 1 };
          } else {
            const x3 = Math.cos(pd.angle) * pd.orbitRadius;
            const z3 = Math.sin(pd.angle) * pd.orbitRadius;
            ap = project3d(x3 + ax, floatY, z3 - ay);
          }
          child.position.x = (ap.x - p.x);
          child.position.y = (ap.y - p.y);
          child._depthScale = ap.scale;
          child._depthZ = ap.z;

          // breathing scale
          const breath = 1 + Math.sin(child._breathPhase) * mcfg.amp;

          // glow pulse (state-dependent)
          const glowPulse = (mcfg.glow[0] + mcfg.glow[1]) / 2 + (mcfg.glow[1] - mcfg.glow[0]) / 2 * Math.sin(child._breathPhase * 1.5);
          const corePulse = (mcfg.core[0] + mcfg.core[1]) / 2 + (mcfg.core[1] - mcfg.core[0]) / 2 * Math.sin(child._breathPhase * 2);

          // planet → agent connection line
          if (linesGfx) {
            linesGfx.moveTo(p.x, p.y).lineTo(ap.x, ap.y).stroke({ width: 0.3, color: mcolor, alpha: 0.06 + glowPulse * 0.05 });
          }

          child.halo.alpha = glowPulse + (selectedId === child._ra.id ? 0.2 : 0);
          child.halo.tint = mcolor;
          child.halo.scale.set(breath);
          child.core.alpha = corePulse;
          child.core.tint = mcolor;
          child.core.scale.set(0.8 + Math.sin(child._breathPhase * 1.3) * 0.1);
          child.label.text = aliasOf(child._ra).slice(0, 14);

          depthList.push({ obj: child, z: ap.z, scale: ap.scale * breath });
        }

        // ember sparks for active agents
        const anyHot = g.children.some((c) => c._ra && (stateOf(c._ra) === "writing" || stateOf(c._ra) === "awaiting"));
        if (anyHot && Math.random() < 0.02) {
          const ag = g.children.find((c) => c._ra && (stateOf(c._ra) === "writing" || stateOf(c._ra) === "awaiting"));
          const e = new Graphics().circle(0, 0, Math.random() * 1 + 0.3).fill({ color: STATE[stateOf(ag._ra)].c, alpha: 0.7 });
          e.x = ag?.position?.x ?? 0; e.y = ag?.position?.y ?? 0;
          e.vx = (Math.random() - 0.5) * 4;
          e.vy = -10 - Math.random() * 8;
          e.life = 0;
          g.addChild(e);
          embers.push({ obj: e, parent: g });
        }

        depthList.push({ obj: g, z: p.z, scale: p.scale });
      }
      }
    } // end solar mode else

    // depth sort: back to front, set zOrder
    depthList.sort((a, b) => b.z - a.z);
    depthList.forEach((item, i) => {
      if (item.obj.parent) item.obj.zIndex = i;
      // scale by depth for perspective
      const s = item.scale ?? 1;
      if (!item.isSun && item.obj._nd) {
        item.obj.scale.set(s);
        if (item.obj.label) item.obj.label.scale.set(1 / s);
      } else if (item.obj._ra) {
        item.obj.scale.set(s);
        if (item.obj.label) item.obj.label.scale.set(1 / s);
      }
      // dim objects behind sun
      if (item.z > 100 && !item.isSun) {
        if (item.obj._nd) item.obj.alpha = 0.5;
        else if (item.obj._ra) item.obj.alpha = 0.7;
      } else {
        item.obj.alpha = 1;
      }
    });

    // ember update
    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i];
      const o = e.obj;
      o.life += dt * 0.001;
      o.x += (o.vx ?? 0) * dt * 0.05;
      o.y += (o.vy ?? 0) * dt * 0.05;
      o.vy = (o.vy ?? 0) + dt * 0.005;
      o.alpha = Math.max(0, 1 - o.life * 1.5);
      o.scale.set(Math.max(0.1, 1 - o.life * 0.5));
      if (o.life > 0.8) { e.parent.removeChild(o); embers.splice(i, 1); }
    }
  });
}

function focusFlame(id) {
  const g = sprites.get(id);
  if (!g) return;
  g.attn = performance.now();
}

function selectFlame(id) {
  selectedId = id;
  syncTranscript();
  focusFlame(id);
}

/* DOM-level canvas click */
function worldPos(g) {
  let x = g.position.x, y = g.position.y;
  let p = g.parent;
  while (p && p !== app.stage) { x += p.position.x; y += p.position.y; p = p.parent; }
  return { x, y };
}
const canvasEl = document.getElementById("stage");
canvasEl.addEventListener("click", (ev) => {
  const rect = canvasEl.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  let best = null, bestDist = 45;
  for (const [id, g] of sprites) {
    if (!g.visible) continue;
    const wp = worldPos(g);
    const dx = wp.x - x;
    const dy = wp.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist) { best = id; bestDist = dist; }
  }
  if (best) selectFlame(best);
});
canvasEl.addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  const rect = canvasEl.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  let best = null, bestDist = 45;
  for (const [id, g] of sprites) {
    if (!g.visible) continue;
    const wp = worldPos(g);
    const dx = wp.x - x;
    const dy = wp.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist) { best = id; bestDist = dist; }
  }
  if (best) showContextMenu(ev.clientX, ev.clientY, best);
});

function positionTranscript() {
  const card = $("#transcript");
  const g = sprites.get(selectedId);
  if (!g || !pixiOK) { card.style.display = "none"; return; }
  card.style.display = "flex";
  const wp = worldPos(g);
  const cardW = 380;
  const cardH = card.offsetHeight || 480;
  let left = wp.x - cardW / 2;
  left = Math.max(20, Math.min(W - cardW - 20, left));
  let top = wp.y + 50;
  if (top + cardH > H - 100) top = Math.max(80, wp.y - cardH - 30);
  card.style.left = left + "px";
  card.style.top = top + "px";
}

function syncTranscript() {
  const card = $("#transcript");
  if (!selectedId) { card.style.display = "none"; return; }
  const nd = allNodes().find((n) => n.id === selectedId);
  if (!nd) { card.style.display = "none"; return; }
  card.style.display = "flex";
  const st = stateOf(nd);
  const sess = (nd.sessions ?? []).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  $(".t-name", card).textContent = aliasOf(nd);
  const stateEl = $(".t-state", card);
  stateEl.textContent = STATE[st].label;
  stateEl.dataset.s = st;
  const ctx = contextUsage(nd);
  const ctxPct = (ctx * 100).toFixed(0);
  const tokTotal = (nd.sessions ?? []).reduce((a, s) => a + (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0), 0);
  $(".t-ctx", card).textContent = `${(tokTotal / 1000).toFixed(1)}k / 256k · ${ctxPct}%`;
  $(".t-pin", card)?.removeAttribute("data-pinned");
  const stream = $("#t-stream");
  const sessions = (nd.sessions ?? []).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 8);
  if (sessions.length === 0 && nd.kind === "run") {
    const info = [
      ["bridge", nd.bridge || "—"],
      ["PID", String(nd.pid ?? "—")],
      ["进程数", String(nd.procCount ?? 1)],
      ["工作目录", nd.workDir || "—"],
      ["机器", nd.machine || "local"],
      ["最后活动", ago(nd.lastActivityAt) + "前"],
    ];
    stream.innerHTML =
      `<div class="t-leaf tool" style="border-left:none;padding-left:0">
        <div class="lr">RUN AGENT · 监控进程</div>
        <div class="lb" style="font-family:var(--mono);font-size:11px;font-style:normal;line-height:1.8">
          ${info.map(([k, v]) => `<div><span style="color:var(--ink-soft);display:inline-block;width:60px">${k}</span> <span style="color:var(--ink)">${esc(v)}</span></div>`).join("")}
        </div>
      </div>`;
  } else if (sessions.length === 0) {
    stream.innerHTML = `<div class="t-empty">还没有对话<br><br>在下方落笔，开始一段思绪</div>`;
  } else {
    stream.innerHTML = sessions.map((s, i) => {
      const role = i === 0 ? "user" : "asst";
      const roleName = i === 0 ? "新的指令" : "思绪";
      return `<div class="t-leaf ${role}">
        <div class="lr">${roleName} · ${ago(s.updatedAt)}前${s.busy ? " · 仍在回响" : ""}</div>
        <div class="lb">${esc(s.title || s.id)}</div>
      </div>`;
    }).join("");
  }
  if (nd.pendingPermissions?.length) {
    const p = nd.pendingPermissions[0];
    stream.insertAdjacentHTML("afterbegin", `<div class="t-leaf tool"><div class="lr">PENDING PERMISSION</div><div class="lb">${esc(p.pattern || p.id)}</div></div>`);
  }
  if (nd.pendingQuestions?.length) {
    const q = nd.pendingQuestions[0];
    stream.insertAdjacentHTML("afterbegin", `<div class="t-leaf tool"><div class="lr">PENDING QUESTION</div><div class="lb">${esc(q.header || q.question || q.id)}</div></div>`);
  }
  const pinBtn = document.querySelector('.t-actions button[data-act="t-pin"]');
  if (pinBtn) pinBtn.textContent = pinStore.has(nd.id) ? "已置顶" : "置顶";
  const input = $("#t-input");
  const sendBtn = $("#t-send");
  const canSteer = nd.kind !== "run" && nd.status !== "offline" && sess;
  input.disabled = !canSteer;
  sendBtn.disabled = !canSteer;
  input.placeholder = canSteer ? "在这里落笔…  ⏎ 寄出  ⌥⏎ 中止" : (nd.kind === "run" ? "监控进程 · 不可直接对话" : "等待连接…");
  positionTranscript();
}

/* ============ pinned strip ============ */
function renderPinned() {
  const el = $("#pinned");
  const pins = allNodes().filter((n) => pinStore.has(n.id));
  el.innerHTML = pins.map((n) => `<div class="pl ${selectedId === n.id ? "sel" : ""}" data-act="sel" data-id="${esc(n.id)}">${esc(aliasOf(n))}</div>`).join("");
}

/* ============ state filter ============ */
function renderStateFilter() {
  const counts = { all: allNodes().length, writing: 0, awaiting: 0, ready: 0, asleep: 0 };
  for (const n of allNodes()) counts[stateOf(n)]++;
  $("#state-filter").innerHTML = [
    `<div class="sf ${stateFilter === "all" ? "on" : ""}" data-act="sf" data-sf="all">all<b>${counts.all}</b></div>`,
    ...STATE_ORDER.map((s) => `<div class="sf ${stateFilter === s ? "on" : ""}" data-act="sf" data-sf="${s}">${s}<b>${counts[s]}</b></div>`),
  ].join("");
}

/* ============ context menu ============ */
function showContextMenu(x, y, id) {
  selectedId = id;
  syncTranscript();
  const m = $("#ctx-menu");
  m.style.left = Math.min(x, W - 180) + "px";
  m.style.top = Math.min(y, H - 120) + "px";
  m.style.display = "block";
  m.dataset.targetId = id;
}
function hideContextMenu() { $("#ctx-menu").style.display = "none"; }

document.addEventListener("click", (ev) => {
  if (!ev.target.closest("#ctx-menu")) hideContextMenu();
});

/* ============ settings panel ============ */
function shortId(id) { return id.length > 22 ? id.slice(0, 10) + "…" + id.slice(-9) : id; }
function renderSettings() {
  const spd = settings.speed ?? 0.3;
  const sz = settings.size ?? 1.6;
  $("#settings").innerHTML =
    `<div class="st-h">设置 <span class="st-tip">存本机</span><button class="st-x" data-act="cfg-close">×</button></div>` +
    `<div class="st-row" style="align-items:center;gap:8px"><span style="font-size:11px;color:var(--ink-soft);width:40px">转速</span><input type="range" data-cfg="speed" min="0.05" max="2" step="0.05" value="${spd}" style="flex:1"/><code style="width:30px;text-align:right">${spd.toFixed(2)}×</code></div>` +
    `<div class="st-row" style="align-items:center;gap:8px"><span style="font-size:11px;color:var(--ink-soft);width:40px">大小</span><input type="range" data-cfg="size" min="0.5" max="3" step="0.1" value="${sz}" style="flex:1"/><code style="width:30px;text-align:right">${sz.toFixed(1)}×</code></div>` +
    `<div style="border-top:1px solid var(--line);margin:8px 0;padding-top:8px;font-size:11px;color:var(--ink-soft);font-style:italic">别名</div>` +
    allNodes().map((nd) => `<div class="st-row"><code title="${esc(nd.id)}">${esc(shortId(nd.id))}</code><input data-aid="${esc(nd.id)}" value="${esc(aliasStore[nd.id] ?? "")}" placeholder="${esc(nd.label)}" maxlength="24" /></div>`).join("") +
    `<button class="st-clear" data-act="cfg-clear">清空别名</button>`;
}

/* ============ ⌘K palette ============ */
let cmdOpen = false, cmdIdx = 0, cmdQ = "";
function cmdItems() {
  const q = cmdQ.toLowerCase();
  return allNodes().filter((nd) => !q || (aliasOf(nd) + " " + nd.label + " " + (nd.workDir ?? "")).toLowerCase().includes(q));
}
function renderCmd() {
  const items = cmdItems();
  cmdIdx = Math.max(0, Math.min(cmdIdx, items.length - 1));
  $("#cmd-list").innerHTML = items.map((nd, i) => {
    const st = stateOf(nd);
    return `<div class="cmd-item ${i === cmdIdx ? "on" : ""}" data-ci="${i}">
      <span class="ci-tag">${STATE[st].label}</span>${esc(aliasOf(nd))}
    </div>`;
  }).join("") || `<div class="cmd-item">…</div>`;
}
function cmdShow() { cmdOpen = true; cmdQ = ""; cmdIdx = 0; $("#cmd").style.display = "flex"; $("#cmd-in").value = ""; renderCmd(); $("#cmd-in").focus(); }
function cmdHide() { cmdOpen = false; $("#cmd").style.display = "none"; }
function cmdPick(i) {
  const nd = cmdItems()[i]; if (!nd) return;
  selectedId = nd.id; cmdHide(); syncFlames(); syncTranscript();
}
$("#cmd-in")?.addEventListener("input", (e) => { cmdQ = e.target.value; cmdIdx = 0; renderCmd(); });
$("#cmd")?.addEventListener("click", (e) => {
  if (e.target.id === "cmd") return cmdHide();
  const it = e.target.closest(".cmd-item[data-ci]");
  if (it) cmdPick(+it.dataset.ci);
});

/* ============ whisper ============ */
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
async function whisper() {
  const inp = $("#whisper-in");
  const text = inp.value.trim();
  if (!text) return;
  const nd = allNodes().find((n) => n.id === selectedId) || allNodes().find((n) => n.kind === "server" && stateOf(n) === "ready");
  if (!nd || nd.kind !== "server") { whisperFlash(nd ? "此 agent 暂不可对话" : "没有可对话的 agent"); return; }
  const sess = (nd.sessions ?? []).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  if (!sess) { whisperFlash("无可用会话"); return; }
  inp.value = "";
  const r = await post(`/api/nodes/${nd.id}/sessions/${sess.id}/prompt`, { text });
  if (!r.ok) whisperFlash("发送失败");
}
function whisperFlash(msg) {
  const inp = $("#whisper-in");
  const old = inp.placeholder;
  inp.placeholder = msg;
  setTimeout(() => inp.placeholder = old, 2000);
}
$("#whisper-send")?.addEventListener("click", whisper);
$("#whisper-in")?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); whisper(); }
});

/* ============ transcript interactions ============ */
$("#t-input")?.addEventListener("keydown", async (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    if (ev.altKey) { return sendAbort(); }
    await sendSteer();
  }
});
$("#t-send")?.addEventListener("click", sendSteer);
async function sendSteer() {
  const inp = $("#t-input");
  const text = inp.value.trim();
  if (!text) return;
  const nd = allNodes().find((n) => n.id === selectedId);
  const sess = (nd?.sessions ?? []).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  if (!nd || !sess) return;
  inp.value = "";
  await post(`/api/nodes/${nd.id}/sessions/${sess.id}/prompt`, { text });
}
async function sendAbort() {
  const nd = allNodes().find((n) => n.id === selectedId);
  const sess = (nd?.sessions ?? []).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  if (!nd || !sess) return;
  await post(`/api/nodes/${nd.id}/sessions/${sess.id}/abort`, {});
}

/* ============ global click handler ============ */
document.body.addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-act]");
  if (!b) return;
  const { act, id, sf } = b.dataset;
  if (act === "sf") { stateFilter = sf; renderStateFilter(); syncFlames(); }
  else if (act === "sel") { selectedId = id; syncFlames(); syncTranscript(); }
  else if (act === "cfg-close") { $("#settings").style.display = "none"; }
  else if (act === "cfg-clear") {
    for (const k of Object.keys(aliasStore)) delete aliasStore[k];
    saveAliases(); renderSettings(); syncFlames();
  }
  else if (act === "t-close") { selectedId = null; syncTranscript(); syncFlames(); $("#transcript").style.display = "none"; }
  else if (act === "t-abort") { await sendAbort(); }
  else if (act === "t-pin") {
    const id = selectedId; if (!id) return;
    if (pinStore.has(id)) pinStore.delete(id); else pinStore.add(id);
    savePins(); syncFlames(); renderPinned(); syncTranscript();
  }
  else if (act === "ctx-pin") { const id = ev.target.closest("#ctx-menu").dataset.targetId; if (pinStore.has(id)) pinStore.delete(id); else pinStore.add(id); savePins(); syncFlames(); renderPinned(); hideContextMenu(); }
  else if (act === "ctx-abort") { selectedId = ev.target.closest("#ctx-menu").dataset.targetId; syncTranscript(); sendAbort(); hideContextMenu(); }
  else if (act === "ctx-alias") { renderSettings(); $("#settings").style.display = "block"; hideContextMenu(); }
});

document.body.addEventListener("input", (ev) => {
  const aliasInp = ev.target.closest("#settings input[data-aid]");
  if (aliasInp) {
    const id = aliasInp.dataset.aid;
    const v = aliasInp.value.trim();
    if (v) aliasStore[id] = v; else delete aliasStore[id];
    saveAliases(); syncFlames();
    return;
  }
  const cfgInp = ev.target.closest('#settings input[data-cfg]');
  if (cfgInp) {
    const key = cfgInp.dataset.cfg;
    const val = Number(cfgInp.value);
    settings[key] = val;
    saveSettings();
    // update display
    const code = cfgInp.parentElement.querySelector('code');
    if (code) code.textContent = (key === 'speed' ? val.toFixed(2) : val.toFixed(1)) + '×';
    // force rebuild for size changes
    lastMachineKey = '';
    syncFlames();
  }
});

document.body.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") { ev.preventDefault(); cmdOpen ? cmdHide() : cmdShow(); return; }
  if (cmdOpen) {
    const items = cmdItems();
    if (ev.key === "Escape") cmdHide();
    else if (ev.key === "ArrowDown") { cmdIdx = Math.min(cmdIdx + 1, items.length - 1); renderCmd(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { cmdIdx = Math.max(cmdIdx - 1, 0); renderCmd(); ev.preventDefault(); }
    else if (ev.key === "Enter") { cmdPick(cmdIdx); ev.preventDefault(); }
    return;
  }
  if (ev.key === "Escape") { cmdHide(); $("#settings").style.display = "none"; selectedId = null; syncTranscript(); syncFlames(); }
});

$("#cfg-btn")?.addEventListener("click", () => {
  const el = $("#settings");
  if (el.style.display === "block") el.style.display = "none";
  else { renderSettings(); el.style.display = "block"; }
});

/* ============ SSE stream ============ */
function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("snapshot", (m) => {
    const snap = JSON.parse(m.data);
    update(snap);
    const conn = $("#conn");
    conn.textContent = "·";
    conn.className = "conn on";
  });
  es.onerror = () => {
    const conn = $("#conn");
    conn.textContent = "·";
    conn.className = "conn off";
  };
}

function update(snap) {
  lastSnap = snap;
  if (selectedId && !allNodes().some((n) => n.id === selectedId)) selectedId = null;
  renderStateFilter();
  renderPinned();
  syncFlames();
  if (selectedId) syncTranscript();
  $("#clock").textContent = new Date(snap.generatedAt).toLocaleTimeString("zh", { hour12: false });
}

window.__dbg = { sprites, planetData, app, lastSnap, flamesLayer, orbitLayer, worldPos, get rotX(){return rotX}, get rotY(){return rotY} };
connect();
