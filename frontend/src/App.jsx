import { useCallback, useEffect, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import Setup from "./Setup.jsx";

const TYPES = ["Patient", "Doctor", "Disease", "Symptom", "Treatment", "Medication", "Hospital"];
// Canvas needs concrete colors, so resolve the CSS tokens once.
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = (type) => token(`--entity-${(type || "").toLowerCase()}`) || token("--entity-default");

export default function App() {
  const [session, setSession] = useState(() => sessionStorage.getItem("grag-session"));
  const connect = (t) => { sessionStorage.setItem("grag-session", t); setSession(t); };
  const leave = (note) => { sessionStorage.removeItem("grag-session"); setSession(null); };
  return session ? <Workspace session={session} onLeave={leave} /> : <Setup onConnect={connect} />;
}

function Workspace({ session, onLeave }) {
  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, { ...opts, headers: { ...opts.headers, "X-Session": session } });
    if (res.status === 401) { onLeave(); throw new Error("Session expired"); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    return res.json();
  }

  const [data, setData] = useState({ nodes: [], links: [] });
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState("cypher");
  const chatEnd = useRef(null);
  const fg = useRef(null);

  const loadGraph = useCallback(async () => {
    try { setData(await api("/graph")); } catch (e) { setStatus(e.message); }
  }, []);

  useEffect(() => {
    loadGraph();
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [loadGraph]);

  useEffect(() => chatEnd.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  async function onUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    setBusy(true);
    setStatus(`Extracting graph from ${file.name}…`);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await api("/upload", { method: "POST", body: form });
      setStatus(`Added ${r.nodes} nodes, ${r.relationships} relationships from ${r.chunks} chunks`);
      await loadGraph();
    } catch (err) { setStatus(`Error: ${err.message}`); }
    setBusy(false);
    e.target.value = "";
  }

  async function onAsk(e) {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setQuestion("");
    setMessages((m) => [...m, { role: "user", text: q }]);
    setBusy(true);
    try {
      const r = await api("/query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, mode }),
      });
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
        ref={fg} cooldownTicks={80} onEngineStop={() => fg.current?.zoomToFit(400, 120)}
        width={size.w} height={size.h} graphData={data}
        backgroundColor={token("--color-bg")}
        nodeLabel={(n) => `${n.label}: ${n.name}`}
        nodeColor={(n) => color(n.label)}
        linkColor={() => token("--color-edge")}
        linkDirectionalArrowLength={4} linkDirectionalArrowRelPos={1}
        linkLabel="type"
        nodeCanvasObjectMode={() => "after"}
        nodeCanvasObject={(n, ctx, scale) => {
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
        {status && <p className="status">{busy && <span className="spin" />}{status}</p>}
        <div className="legend">
          {TYPES.map((k) => (
            <span key={k}><i style={{ background: color(k) }} />{k}</span>
          ))}
        </div>
      </div>

      <div className="panel chat">
        <div className="messages">
          {messages.length === 0 && <p className="hint">Ask about the graph, e.g. “Which doctors treat diabetes?”</p>}
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
