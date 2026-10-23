import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import Setup from "./Setup.jsx";

// Canvas needs concrete colors, so resolve the CSS tokens once.
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const PALETTE = 12;
const typeColors = new Map();
// Entity types are chosen by the model, so assign colors from the categorical palette by hash.
function color(type = "Entity") {
  if (!typeColors.has(type)) {
    let h = 0;
    for (const ch of type) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    typeColors.set(type, token(`--cat-${(h % PALETTE) + 1}`) || token("--entity-default"));
  }
  return typeColors.get(type);
}

const endId = (e) => (typeof e === "object" ? e.id : e);
const linkKey = (l) => `${endId(l.source)}|${l.type}|${endId(l.target)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Merge a delta into the graph, reusing existing objects so the layout keeps its positions.
// New nodes spawn next to a neighbour so they visibly "bloom" out of the existing graph.
function merge(prev, delta) {
  const nodes = new Map(prev.nodes.map((n) => [n.id, n]));
  const links = new Map(prev.links.map((l) => [linkKey(l), l]));
  const now = Date.now();
  const spawn = (n, otherId) => {
    const o = nodes.get(otherId);
    if (o && o.x !== undefined) { n.x = o.x + (Math.random() - 0.5) * 12; n.y = o.y + (Math.random() - 0.5) * 12; }
  };
  for (const n of delta.nodes || []) {
    const old = nodes.get(n.id);
    if (old) { if (old.label === "Entity" && n.label !== "Entity") old.label = n.label; continue; }
    const fresh = { ...n, born: now };
    const l = (delta.links || []).find((l) => l.source === n.id || l.target === n.id);
    if (l) spawn(fresh, l.source === n.id ? l.target : l.source);
    nodes.set(n.id, fresh);
  }
  for (const l of delta.links || []) {
    for (const id of [l.source, l.target]) if (!nodes.has(id)) nodes.set(id, { id, name: id, label: "Entity", born: now });
    if (!links.has(linkKey(l))) links.set(linkKey(l), { ...l, born: now });
  }
  return { nodes: [...nodes.values()], links: [...links.values()] };
}

const hexA = (hex, a) => hex + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");

// Idle state: one master node drifting, with faint ghost nodes orbiting it on blinking edges.
const GHOSTS = 8;
function idleGraph() {
  const nodes = [{ id: "you", name: "Your data", label: "Master", master: true }];
  const links = [];
  for (let i = 0; i < GHOSTS; i++) {
    nodes.push({ id: `g${i}`, name: "", label: "Ghost", ghost: true, i,
      radius: 85 + (i % 3) * 38 + Math.random() * 14, speed: (0.12 + Math.random() * 0.14) * (i % 2 ? 1 : -1), phase: Math.random() * 6.28 });
    links.push({ source: "you", target: `g${i}`, type: "", phase: Math.random() * 6.28 });
  }
  stepIdle(nodes, 0);
  return { nodes, links };
}
function stepIdle(nodes, t) {
  const m = nodes.find((n) => n.master);
  if (!m) return;
  m.fx = 46 * Math.sin(t * 0.45); m.fy = 28 * Math.sin(t * 0.7 + 1);
  m.x = m.fx; m.y = m.fy;
  for (const n of nodes) {
    if (!n.ghost) continue;
    const a = n.phase + t * n.speed, r = n.radius + 8 * Math.sin(t * 0.6 + n.i);
    n.fx = m.x + Math.cos(a) * r * 1.35; n.fy = m.y + Math.sin(a) * r * 0.8;
    n.x = n.fx; n.y = n.fy;
  }
}

export default function App() {
  const [session, setSession] = useState(() => sessionStorage.getItem("grag-session"));
  const [showSetup, setShowSetup] = useState(false);
  const connect = (t) => { sessionStorage.setItem("grag-session", t); setSession(t); setShowSetup(false); };
  const leave = () => { sessionStorage.removeItem("grag-session"); setSession(null); };
  return (
    <>
      <Workspace key={session || "demo"} session={session} onLeave={leave} onConnectClick={() => setShowSetup(true)} />
      {showSetup && (
        <div className="overlay" onClick={() => setShowSetup(false)}>
          <div onClick={(e) => e.stopPropagation()}><Setup onConnect={connect} onClose={() => setShowSetup(false)} /></div>
        </div>
      )}
    </>
  );
}

function Workspace({ session, onLeave, onConnectClick }) {
  const demo = !session;
  const [data, setData] = useState(() => (session ? { nodes: [], links: [] } : idleGraph()));
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feed, setFeed] = useState([]);
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState("cypher");
  const [hover, setHover] = useState(null);
  const [selected, setSelected] = useState(null);
  const [hidden, setHidden] = useState(new Set());
  const [autoFit, setAutoFit] = useState(!!session);
  const chatEnd = useRef(null);
  const fg = useRef(null);
  const run = useRef(0);          // bumped to cancel a running playback
  const queue = useRef(Promise.resolve());
  const degRef = useRef(new Map());
  const dataRef = useRef(data);
  dataRef.current = data;

  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, { ...opts, headers: { ...opts.headers, "X-Session": session } });
    if (res.status === 401) { onLeave(); throw new Error("Session expired"); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    return res;
  }

  const pushFeed = (item) => setFeed((f) => [{ ...item, k: Math.random() }, ...f].slice(0, 60));

  // Reveal one extraction result: nodes first, one at a time, then the edges between them.
  const reveal = useCallback((ev, myRun) => {
    queue.current = queue.current.then(async () => {
      if (run.current !== myRun) return;
      if (ev.text) pushFeed({ kind: "read", text: ev.text });
      const pace = Math.max(70, Math.min(320, 2400 / Math.max(1, ev.nodes.length)));
      for (const n of ev.nodes) {
        if (run.current !== myRun) return;
        setData((p) => merge(p, { nodes: [n], links: [] }));
        pushFeed({ kind: "node", label: n.label, text: n.name });
        await sleep(pace);
      }
      for (const l of ev.links) {
        if (run.current !== myRun) return;
        setData((p) => merge(p, { nodes: [], links: [l] }));
        pushFeed({ kind: "link", text: `${l.source} → ${l.target}`, rel: l.type.replaceAll("_", " ").toLowerCase() });
        await sleep(Math.max(60, pace * 0.6));
      }
    });
    return queue.current;
  }, []);

  const loadGraph = useCallback(async () => {
    try {
      const g = await (await api("/graph")).json();
      setAutoFit(true);
      setData(g);
    } catch (e) { setStatus(e.message); }
  }, []);

  useEffect(() => {
    let raf;
    if (demo) {
      const tick = () => { stepIdle(dataRef.current.nodes, performance.now() / 1000); raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
    } else loadGraph();
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => { run.current++; cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
  }, []);

  useEffect(() => {
    fg.current?.d3Force("charge")?.strength(-170);
    fg.current?.d3Force("link")?.distance(64);
  }, []);
  useEffect(() => chatEnd.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  // Degree + adjacency for node sizing and hover highlight.
  const { neighbors, legend } = useMemo(() => {
    const nb = new Map(), deg = new Map(), counts = new Map();
    for (const n of data.nodes) { nb.set(n.id, new Set()); counts.set(n.label, (counts.get(n.label) || 0) + 1); }
    for (const l of data.links) {
      const a = endId(l.source), b = endId(l.target);
      nb.get(a)?.add(b); nb.get(b)?.add(a);
      deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1);
    }
    degRef.current = deg;
    return { neighbors: nb, legend: [...counts.entries()].sort((a, b) => b[1] - a[1]) };
  }, [data]);

  // Frame the whole graph, but never zoom in past a readable level when there are only a few nodes.
  const fit = useCallback(() => {
    fg.current?.zoomToFit(600, 190);
    setTimeout(() => { if (fg.current && fg.current.zoom() > 1.6) fg.current.zoom(1.6, 300); }, 650);
  }, []);

  // Keep the camera framing the graph as it grows, until the user takes over.
  useEffect(() => {
    if (!autoFit || !data.nodes.length) return;
    const t = setTimeout(fit, 900);
    return () => clearTimeout(t);
  }, [data.nodes.length, autoFit, fit]);

  const visible = useMemo(() => ({
    nodes: data.nodes.filter((n) => !hidden.has(n.label)),
    links: data.links.filter((l) => {
      const a = data.nodes.find((n) => n.id === endId(l.source)), b = data.nodes.find((n) => n.id === endId(l.target));
      return a && b && !hidden.has(a.label) && !hidden.has(b.label);
    }),
  }), [data, hidden]);

  const focus = hover || selected;
  const lit = focus ? new Set([focus, ...(neighbors.get(focus) || [])]) : null;

  async function onUpload(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setStatus(`Reading ${file.name}…`);
    const myRun = ++run.current;
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await api("/upload", { method: "POST", body: form });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const handle = (ev) => {
        if (ev.type === "start") setProgress({ done: 0, total: ev.total });
        else if (ev.type === "chunk") {
          setProgress({ done: ev.done, total: ev.total });
          setStatus(`Extracting… chunk ${ev.done}/${ev.total}`);
          reveal({ nodes: ev.nodes, links: ev.links, text: `Chunk ${ev.done}/${ev.total}` }, myRun);
        } else if (ev.type === "indexing") setStatus("Building vector index…");
        else if (ev.type === "done") setStatus(`Done: ${ev.nodes} entities, ${ev.relationships} relationships`);
        else if (ev.type === "error") setStatus(`Error: ${ev.message}`);
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        lines.filter(Boolean).forEach((l) => handle(JSON.parse(l)));
      }
      await queue.current;
    } catch (err) { setStatus(`Error: ${err.message}`); }
    setProgress(null);
    setBusy(false);
  }

  async function onAsk(e) {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setQuestion("");
    setMessages((m) => [...m, { role: "user", text: q }]);
    setBusy(true);
    try {
      const r = await (await api("/query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, mode }),
      })).json();
      setMessages((m) => [...m, { role: "bot", text: r.answer, cypher: r.cypher }]);
    } catch (err) { setMessages((m) => [...m, { role: "bot", text: `Error: ${err.message}` }]); }
    setBusy(false);
  }

  async function onClear() {
    if (!confirm("Delete the entire graph?")) return;
    await api("/graph", { method: "DELETE" });
    run.current++;
    setData({ nodes: [], links: [] }); setFeed([]);
    setStatus("Graph cleared");
  }

  const sel = selected && data.nodes.find((n) => n.id === selected);
  const toggle = (t) => setHidden((h) => { const s = new Set(h); s.has(t) ? s.delete(t) : s.add(t); return s; });

  return (
    <div className="app" onWheel={() => setAutoFit(false)} onPointerDown={() => setAutoFit(false)}>
      <ForceGraph2D
        ref={fg} width={size.w} height={size.h} graphData={visible}
        backgroundColor={token("--color-bg")}
        cooldownTicks={demo ? Infinity : 120} d3VelocityDecay={0.28} autoPauseRedraw={false}
        enableZoomInteraction={!demo} enablePanInteraction={!demo} enableNodeDrag={!demo}
        onEngineStop={() => autoFit && fit()}
        linkCurvature={demo ? 0.08 : 0.14}
        linkColor={(l) => demo
          ? hexA(token("--blue-400"), 0.07 + 0.6 * Math.pow(Math.max(0, Math.sin(Date.now() / 450 + l.phase)), 3))
          : (!lit || (lit.has(endId(l.source)) && lit.has(endId(l.target))) ? token("--color-edge-strong") : token("--color-edge-dim"))}
        linkWidth={(l) => demo ? 1.2 : (lit && lit.has(endId(l.source)) && lit.has(endId(l.target)) ? 1.8 : 0.7)}
        linkDirectionalArrowLength={demo ? 0 : 4} linkDirectionalArrowRelPos={0.92}
        linkDirectionalParticles={(l) => demo ? 1 : (l.born && Date.now() - l.born < 2600 ? 4 : 0)}
        linkDirectionalParticleWidth={2.6} linkDirectionalParticleSpeed={demo ? 0.005 : 0.012}
        linkLabel={(l) => l.type.replaceAll("_", " ").toLowerCase()}
        onNodeHover={(n) => setHover(n ? n.id : null)}
        onNodeClick={(n) => { setSelected(n.id); setAutoFit(false); fg.current?.centerAt(n.x, n.y, 500); }}
        onBackgroundClick={() => setSelected(null)}
        nodeLabel={() => ""}
        nodePointerAreaPaint={(n, c, ctx) => {
          ctx.fillStyle = c; ctx.beginPath(); ctx.arc(n.x, n.y, 6 + Math.sqrt(degRef.current.get(n.id) || 0) * 2.5, 0, 2 * Math.PI); ctx.fill();
        }}
        nodeCanvasObjectMode={() => "replace"}
        nodeCanvasObject={(n, ctx, scale) => {
          if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return;
          if (n.ghost) {
            const blink = 0.12 + 0.55 * Math.pow(Math.max(0, Math.sin(Date.now() / 450 + n.phase + 1.2)), 3);
            ctx.beginPath(); ctx.arc(n.x, n.y, 5, 0, 2 * Math.PI);
            ctx.setLineDash([2 / scale, 2 / scale]); ctx.lineWidth = 1.2 / scale;
            ctx.strokeStyle = hexA(token("--blue-400"), blink); ctx.stroke(); ctx.setLineDash([]);
            return;
          }
          if (n.master) {
            const t = Date.now() / 1000, pulse = 1 + 0.08 * Math.sin(t * 2), r = 15 * pulse, c = token("--blue-500");
            const g = ctx.createRadialGradient(n.x, n.y, r * 0.4, n.x, n.y, r * 4.2);
            g.addColorStop(0, hexA(c, 0.5)); g.addColorStop(1, hexA(c, 0));
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, n.y, r * 4.2, 0, 2 * Math.PI); ctx.fill();
            ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI); ctx.fillStyle = c; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = token("--color-text-strong"); ctx.stroke();
            ctx.textAlign = "center"; ctx.textBaseline = "top";
            ctx.font = `600 14px ${token("--font-sans") || "sans-serif"}`; ctx.fillStyle = token("--color-text-strong");
            ctx.fillText("Your data", n.x, n.y + r + 8);
            ctx.font = `12px ${token("--font-sans") || "sans-serif"}`; ctx.fillStyle = token("--color-text-muted");
            ctx.fillText("could be next", n.x, n.y + r + 26);
            return;
          }
          const deg = degRef.current.get(n.id) || 0;
          const r = 4 + Math.sqrt(deg) * 2.4;
          const c = color(n.label);
          const dim = lit && !lit.has(n.id);
          const age = n.born ? Date.now() - n.born : Infinity;
          ctx.globalAlpha = dim ? 0.18 : 1;
          // glow
          const g = ctx.createRadialGradient(n.x, n.y, r * 0.5, n.x, n.y, r * 3);
          g.addColorStop(0, c + "55"); g.addColorStop(1, c + "00");
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, n.y, r * 3, 0, 2 * Math.PI); ctx.fill();
          // birth: node scales in, ring expands outward
          const grow = Math.min(1, age / 450);
          ctx.beginPath(); ctx.arc(n.x, n.y, r * (0.4 + 0.6 * grow), 0, 2 * Math.PI);
          ctx.fillStyle = c; ctx.fill();
          ctx.lineWidth = (n.id === selected ? 2.2 : 1) / scale; ctx.strokeStyle = n.id === selected ? token("--color-text-strong") : token("--color-bg"); ctx.stroke();
          if (age < 1800) {
            ctx.beginPath(); ctx.arc(n.x, n.y, r + (age / 1800) * 26, 0, 2 * Math.PI);
            ctx.strokeStyle = c; ctx.globalAlpha = (1 - age / 1800) * (dim ? 0.2 : 1); ctx.lineWidth = 2 / scale; ctx.stroke();
            ctx.globalAlpha = dim ? 0.18 : 1;
          }
          // label: hubs always, everyone when zoomed or highlighted
          if (deg >= 3 || scale > 1.5 || (lit && lit.has(n.id)) || age < 2200) {
            const fs = Math.max(3.2, 11 / scale);
            ctx.font = `${deg >= 3 ? 600 : 500} ${fs}px ${token("--font-sans") || "sans-serif"}`;
            ctx.textAlign = "center"; ctx.textBaseline = "top";
            ctx.lineWidth = 3 / scale; ctx.strokeStyle = token("--color-bg"); ctx.strokeText(n.name, n.x, n.y + r + 2 / scale);
            ctx.fillStyle = token("--color-text-strong"); ctx.fillText(n.name, n.x, n.y + r + 2 / scale);
          }
          ctx.globalAlpha = 1;
        }}
      />

      <header className="panel topbar">
        <strong className="brand">Graph RAG</strong>
        <span className={`chip ${demo ? "demo" : "live"}`}><i />{demo ? "Waiting for data" : "Live"}</span>
        {!demo && <span className="stats">{data.nodes.length} nodes · {data.links.length} edges</span>}
        <span className="spacer" />
        {demo ? (
          <>
            <button className="btn" onClick={onConnectClick}>Connect your data</button>
          </>
        ) : (
          <>
            <label className={`btn ${busy ? "disabled" : ""}`}>Upload PDF
              <input type="file" accept="application/pdf" onChange={onUpload} disabled={busy} hidden />
            </label>
            <button className="btn ghost" onClick={loadGraph}>Refresh</button>
            <button className="btn danger" onClick={onClear}>Clear</button>
            <button className="btn ghost" onClick={async () => { await api("/disconnect", { method: "POST" }).catch(() => {}); onLeave(); }}>Disconnect</button>
          </>
        )}
        {!demo && <button className="btn ghost" onClick={() => { setAutoFit(true); fit(); }} aria-label="Re-center">⤢</button>}
        {progress && (
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
            <i style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        )}
      </header>

      {!demo && <aside className="panel feed" aria-live="polite">
        <h2>Live discoveries</h2>
        {status && <p className="status">{(busy || progress) && <span className="spin" />}{status}</p>}
        <ul>
          {feed.length === 0 && <li className="hint">Waiting for entities…</li>}
          {feed.map((f) => (
            <li key={f.k} className={f.kind}>
              {f.kind === "node" && <><i style={{ background: color(f.label) }} /><b>{f.text}</b><em>{f.label}</em></>}
              {f.kind === "link" && <><span className="arrow">↳</span><span>{f.text}</span><em>{f.rel}</em></>}
              {f.kind === "read" && <span className="read">“{f.text}”</span>}
            </li>
          ))}
        </ul>
      </aside>}

      {!demo && legend.length > 0 && <div className="panel legend" role="group" aria-label="Filter by type">
        {legend.map(([k, c]) => (
          <button key={k} className={hidden.has(k) ? "off" : ""} onClick={() => toggle(k)} aria-pressed={!hidden.has(k)}>
            <i style={{ background: color(k) }} />{k} <small>{c}</small>
          </button>
        ))}
      </div>}

      {sel && (
        <div className="panel detail">
          <button className="x" onClick={() => setSelected(null)} aria-label="Close">×</button>
          <h3>{sel.name}</h3>
          <span className="tag" style={{ borderColor: color(sel.label), color: color(sel.label) }}>{sel.label}</span>
          <ul>
            {data.links.filter((l) => endId(l.source) === sel.id || endId(l.target) === sel.id).map((l, i) => {
              const out = endId(l.source) === sel.id;
              return <li key={i}>{out ? "" : `${endId(l.source)} `}<em>{l.type.replaceAll("_", " ").toLowerCase()}</em>{out ? ` ${endId(l.target)}` : ""}</li>;
            })}
          </ul>
        </div>
      )}

      <div className="panel chat">
        {demo ? (
          <div className="cta">
            <p>Upload a PDF and watch its entities and relationships appear here live, then ask questions in natural language. Connect an OpenAI key and Neo4j to begin.</p>
            <button className="btn" onClick={onConnectClick}>Connect your data</button>
          </div>
        ) : (
          <>
            <div className="messages">
              {messages.length === 0 && <p className="hint">Upload any PDF, then ask about it.</p>}
              {messages.map((m, i) => (
                <div key={i} className={`msg ${m.role}`}>{m.text}{m.cypher && <pre>{m.cypher}</pre>}</div>
              ))}
              <div ref={chatEnd} />
            </div>
            <form onSubmit={onAsk}>
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="cypher">Cypher</option>
                <option value="vector">Vector</option>
              </select>
              <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask your graph…" />
              <button className="btn" disabled={busy}>Ask</button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
