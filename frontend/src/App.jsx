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

// Merge a delta into the graph, reusing existing node/link objects so the layout keeps its positions.
function merge(prev, delta) {
  const nodes = new Map(prev.nodes.map((n) => [n.id, n]));
  const links = new Map(prev.links.map((l) => [`${endId(l.source)}|${l.type}|${endId(l.target)}`, l]));
  const now = Date.now();
  for (const n of delta.nodes || []) if (!nodes.has(n.id)) nodes.set(n.id, { ...n, born: now });
  for (const l of delta.links || []) {
    const key = `${l.source}|${l.type}|${l.target}`;
    // Relationships may reference entities the transformer didn't list as nodes.
    for (const id of [l.source, l.target]) if (!nodes.has(id)) nodes.set(id, { id, name: id, label: "Entity", born: now });
    if (!links.has(key)) links.set(key, { ...l });
  }
  return { nodes: [...nodes.values()], links: [...links.values()] };
}

export default function App() {
  const [session, setSession] = useState(() => sessionStorage.getItem("grag-session"));
  const connect = (t) => { sessionStorage.setItem("grag-session", t); setSession(t); };
  const leave = () => { sessionStorage.removeItem("grag-session"); setSession(null); };
  return session ? <Workspace session={session} onLeave={leave} /> : <Setup onConnect={connect} />;
}

function Workspace({ session, onLeave }) {
  const [data, setData] = useState({ nodes: [], links: [] });
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(null); // { done, total }
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState("cypher");
  const chatEnd = useRef(null);
  const fg = useRef(null);
  const fitNext = useRef(true);

  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, { ...opts, headers: { ...opts.headers, "X-Session": session } });
    if (res.status === 401) { onLeave(); throw new Error("Session expired"); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    return res;
  }

  const loadGraph = useCallback(async () => {
    try {
      const res = await api("/graph");
      fitNext.current = true;
      setData(await res.json());
    } catch (e) { setStatus(e.message); }
  }, []);

  useEffect(() => {
    loadGraph();
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [loadGraph]);

  useEffect(() => chatEnd.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  const legend = useMemo(() => {
    const counts = new Map();
    for (const n of data.nodes) counts.set(n.label, (counts.get(n.label) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  async function onUpload(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setStatus(`Reading ${file.name}…`);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await api("/upload", { method: "POST", body: form });
      // NDJSON stream: each chunk's entities are merged into the live graph as they arrive.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const handle = (ev) => {
        if (ev.type === "start") setProgress({ done: 0, total: ev.total });
        else if (ev.type === "chunk") {
          fitNext.current = true;
          setData((prev) => merge(prev, ev));
          setProgress({ done: ev.done, total: ev.total });
          setStatus(`Extracting… chunk ${ev.done}/${ev.total}`);
        } else if (ev.type === "indexing") setStatus("Building vector index…");
        else if (ev.type === "done") setStatus(`Done: ${ev.nodes} entities, ${ev.relationships} relationships from ${ev.chunks} chunks`);
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
      const res = await api("/query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, mode }),
      });
      const r = await res.json();
      setMessages((m) => [...m, { role: "bot", text: r.answer, cypher: r.cypher }]);
    } catch (err) { setMessages((m) => [...m, { role: "bot", text: `Error: ${err.message}` }]); }
    setBusy(false);
  }

  async function onClear() {
    if (!confirm("Delete the entire graph?")) return;
    await api("/graph", { method: "DELETE" });
    setData({ nodes: [], links: [] });
    setStatus("Graph cleared");
  }

  return (
    <div className="app">
      <ForceGraph2D
        ref={fg} width={size.w} height={size.h} graphData={data}
        cooldownTicks={80}
        onEngineStop={() => { if (fitNext.current) { fitNext.current = false; fg.current?.zoomToFit(400, 120); } }}
        backgroundColor={token("--color-bg")}
        nodeLabel={(n) => `${n.label}: ${n.name}`}
        nodeColor={(n) => color(n.label)}
        linkColor={() => token("--color-edge")}
        linkDirectionalArrowLength={4} linkDirectionalArrowRelPos={1}
        linkLabel="type"
        nodeCanvasObjectMode={() => "after"}
        nodeCanvasObject={(n, ctx, scale) => {
          // Pulse ring on freshly added nodes.
          const age = n.born ? Date.now() - n.born : Infinity;
          if (age < 1800) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, 5 + (age / 1800) * 14, 0, 2 * Math.PI);
            ctx.strokeStyle = color(n.label);
            ctx.globalAlpha = 1 - age / 1800;
            ctx.lineWidth = 1.5 / scale;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          if (scale < 1.2) return;
          ctx.font = `${10 / scale}px sans-serif`;
          ctx.fillStyle = token("--color-text");
          ctx.textAlign = "center";
          ctx.fillText(n.name, n.x, n.y + 9 / scale);
        }}
      />

      <div className="panel top-left">
        <h1>Graph RAG</h1>
        <label className={`btn ${busy ? "disabled" : ""}`}>
          Upload PDF
          <input type="file" accept="application/pdf" onChange={onUpload} disabled={busy} hidden />
        </label>
        <button className="btn ghost" onClick={loadGraph}>Refresh</button>
        <button className="btn danger" onClick={onClear}>Clear</button>
        <button className="btn ghost" onClick={async () => { await api("/disconnect", { method: "POST" }).catch(() => {}); onLeave(); }}>Disconnect</button>
        {progress && (
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
            <i style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        )}
        {status && <p className="status">{busy && <span className="spin" />}{status}</p>}
        <p className="stats">{data.nodes.length} nodes · {data.links.length} relationships</p>
        <div className="legend">
          {legend.map(([k, c]) => (
            <span key={k}><i style={{ background: color(k) }} />{k} {c}</span>
          ))}
        </div>
      </div>

      <div className="panel chat">
        <div className="messages">
          {messages.length === 0 && <p className="hint">Upload any PDF, then ask about it, e.g. “Who founded the company and what does it build?”</p>}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.text}
              {m.cypher && <pre>{m.cypher}</pre>}
            </div>
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
      </div>
    </div>
  );
}
