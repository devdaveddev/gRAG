import os
import sys

import streamlit as st
from pyvis.network import Network

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))
import core  # noqa: E402

COLORS = {
    "Patient": "#4f9dff", "Doctor": "#34d399", "Disease": "#f87171", "Symptom": "#fbbf24",
    "Treatment": "#a78bfa", "Medication": "#f472b6", "Hospital": "#22d3ee", "Entity": "#94a3b8",
}

st.set_page_config(page_title="Graph RAG", layout="wide")
st.markdown(
    "<style>.block-container{padding-top:1.5rem}</style>", unsafe_allow_html=True
)


def clean(text) -> str:
    # Node text comes from LLM output on uploaded PDFs and is embedded in same-origin HTML.
    return "".join(ch for ch in str(text) if ch not in '<>&"\'`\\')


def render_graph(data: dict) -> str:
    net = Network(height="640px", width="100%", bgcolor="#0b1020", font_color="#e2e8f0", directed=True)
    for n in data["nodes"]:
        net.add_node(n["id"], label=clean(n["name"]), title=clean(n["label"]), color=COLORS.get(n["label"], COLORS["Entity"]))
    for l in data["links"]:
        net.add_edge(l["source"], l["target"], title=clean(l["type"]), label=clean(l["type"]))
    net.set_options('{"physics":{"solver":"forceAtlas2Based"},"edges":{"font":{"size":9,"color":"#94a3b8"}}}')
    return net.generate_html()


def setup_screen():
    """Collect credentials. They live only in this browser session's st.session_state."""
    st.title("Graph RAG")
    st.write("Enter your credentials to begin. They are kept in memory for this session only and never stored.")
    with st.form("setup"):
        provider = st.radio("LLM provider", ["OpenAI", "Local (Ollama)"], horizontal=True)
        key = st.text_input("OpenAI API key", type="password", placeholder="sk-...",
                            help="Ignored for local Ollama.")
        st.markdown("**Neo4j** (a free [Aura](https://neo4j.com/cloud/aura-free/) instance works)")
        uri = st.text_input("URI", value=os.getenv("NEO4J_URI", ""), placeholder="neo4j+s://xxxx.databases.neo4j.io")
        user = st.text_input("Username", value=os.getenv("NEO4J_USERNAME", "neo4j"))
        pw = st.text_input("Password", type="password")
        go = st.form_submit_button("Connect", type="primary")
    if not go:
        return
    local = provider.startswith("Local")
    if not uri or not pw or (not local and not key):
        st.error("Please fill in all required fields.")
        return
    with st.spinner("Verifying credentials…"):
        try:
            rag = core.GraphRAG(core.Config(
                neo4j_uri=uri.strip(), neo4j_user=user.strip(), neo4j_password=pw,
                provider="ollama" if local else "openai", openai_api_key=key.strip(),
            ))
            rag.verify()
        except Exception as e:
            # Show only the exception type + message; never echo the inputs.
            st.error(f"Could not connect: {type(e).__name__}: {str(e)[:300]}")
            return
    st.session_state["rag"] = rag
    st.rerun()


rag = st.session_state.get("rag")
if rag is None:
    setup_screen()
    st.stop()

st.title("Graph RAG")

with st.sidebar:
    st.header("Upload")
    pdf = st.file_uploader("PDF", type="pdf")
    if pdf and st.button("Extract graph", type="primary"):
        with st.spinner("Extracting entities and relationships…"):
            try:
                r = rag.ingest_pdf(pdf.getvalue(), pdf.name)
                st.success(f"Added {r['nodes']} nodes, {r['relationships']} relationships")
            except Exception as e:
                st.error(str(e))
    if st.button("Clear graph"):
        rag.clear_graph()
        st.session_state.pop("messages", None)
        st.rerun()
    st.divider()
    if st.button("Disconnect"):
        for k in ("rag", "messages"):
            st.session_state.pop(k, None)
        st.rerun()
    mode = st.radio("Query mode", ["cypher", "vector"], horizontal=True)

try:
    data = rag.fetch_graph()
except Exception as e:
    st.error(f"Cannot reach Neo4j: {e}")
    st.stop()

if data["nodes"]:
    st.iframe(render_graph(data), height=660)
else:
    st.info("The graph is empty. Upload a PDF in the sidebar.")

st.subheader("Ask your graph")
msgs = st.session_state.setdefault("messages", [])
for m in msgs:
    with st.chat_message(m["role"]):
        st.write(m["text"])
        if m.get("cypher"):
            st.code(m["cypher"], language="cypher")

if q := st.chat_input("e.g. Which doctors treat diabetes?"):
    msgs.append({"role": "user", "text": q})
    with st.chat_message("user"):
        st.write(q)
    with st.chat_message("assistant"):
        with st.spinner("Thinking…"):
            try:
                r = rag.ask(q, mode)
                st.write(r["answer"])
                if r["cypher"]:
                    st.code(r["cypher"], language="cypher")
                msgs.append({"role": "assistant", "text": r["answer"], "cypher": r["cypher"]})
            except Exception as e:
                st.error(str(e))
