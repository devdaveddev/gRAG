import { useState } from "react";

export default function Setup({ onConnect, onClose }) {
  const [provider, setProvider] = useState("openai");
  const [f, setF] = useState({ openai_api_key: "", neo4j_uri: "", neo4j_user: "neo4j", neo4j_password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/connect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, ...f }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || res.statusText);
      setF({ ...f, openai_api_key: "", neo4j_password: "" }); // drop secrets from component state
      onConnect(body.token);
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  return (
    <main className="setup">
      <form className="setup-card" onSubmit={submit} autoComplete="off">
        {onClose && <button type="button" className="x" onClick={onClose} aria-label="Close">×</button>}
        <h1>Connect your data</h1>
        <p>Enter your credentials to begin. They are held in server memory for this session only and are never saved.</p>

        <div className="seg" role="group" aria-label="LLM provider">
          <button type="button" aria-pressed={provider === "openai"} onClick={() => setProvider("openai")}>OpenAI</button>
          <button type="button" aria-pressed={provider === "ollama"} onClick={() => setProvider("ollama")}>Local (Ollama)</button>
        </div>

        {provider === "openai" && (
          <label>OpenAI API key
            <input type="password" value={f.openai_api_key} onChange={set("openai_api_key")} placeholder="sk-…" autoComplete="off" required />
          </label>
        )}
        <label>Neo4j URI
          <input value={f.neo4j_uri} onChange={set("neo4j_uri")} placeholder="neo4j+s://xxxx.databases.neo4j.io" required />
        </label>
        <label>Neo4j username
          <input value={f.neo4j_user} onChange={set("neo4j_user")} required />
        </label>
        <label>Neo4j password
          <input type="password" value={f.neo4j_password} onChange={set("neo4j_password")} autoComplete="off" required />
        </label>

        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn" disabled={busy}>{busy ? "Verifying…" : "Connect"}</button>
      </form>
    </main>
  );
}
