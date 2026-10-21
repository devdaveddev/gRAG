import io
import os

from dotenv import load_dotenv
from langchain_core.documents import Document
from langchain_experimental.graph_transformers import LLMGraphTransformer
from langchain_neo4j import GraphCypherQAChain, Neo4jGraph, Neo4jVector
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pypdf import PdfReader

load_dotenv()

ALLOWED_NODES = ["Patient", "Doctor", "Disease", "Symptom", "Treatment", "Medication", "Hospital"]
VECTOR_INDEX = "chunk_embeddings"

_state: dict = {}


def local() -> bool:
    return os.getenv("LLM_PROVIDER", "openai") == "ollama"


def llm():
    if "llm" not in _state:
        if local():
            from langchain_ollama import ChatOllama
            _state["llm"] = ChatOllama(model=os.getenv("OLLAMA_MODEL", "qwen2.5:1.5b"), temperature=0)
        else:
            from langchain_openai import ChatOpenAI
            _state["llm"] = ChatOpenAI(model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"), temperature=0)
    return _state["llm"]


def embeddings():
    if local():
        from langchain_ollama import OllamaEmbeddings
        return OllamaEmbeddings(model=os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text"))
    from langchain_openai import OpenAIEmbeddings
    return OpenAIEmbeddings()


def graph() -> Neo4jGraph:
    if "graph" not in _state:
        _state["graph"] = Neo4jGraph(
            url=os.environ["NEO4J_URI"],
            username=os.environ["NEO4J_USERNAME"],
            password=os.environ["NEO4J_PASSWORD"],
        )
    return _state["graph"]


def vector_store() -> Neo4jVector:
    return Neo4jVector.from_existing_graph(
        embeddings(),
        url=os.environ["NEO4J_URI"],
        username=os.environ["NEO4J_USERNAME"],
        password=os.environ["NEO4J_PASSWORD"],
        index_name=VECTOR_INDEX,
        node_label="Chunk",
        text_node_properties=["text"],
        embedding_node_property="embedding",
    )


def ingest_pdf(data: bytes, filename: str) -> dict:
    reader = PdfReader(io.BytesIO(data))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    if not text.strip():
        raise ValueError("No extractable text in PDF")

    chunks = RecursiveCharacterTextSplitter(chunk_size=1500, chunk_overlap=150).split_text(text)
    docs = [Document(page_content=c, metadata={"source": filename}) for c in chunks]

    transformer = LLMGraphTransformer(
        llm=llm(),
        allowed_nodes=ALLOWED_NODES,
        node_properties=["description"] if not local() else False,
        ignore_tool_usage=local(),
    )
    graph_docs = transformer.convert_to_graph_documents(docs)
    g = graph()
    g.add_graph_documents(graph_docs, baseEntityLabel=True, include_source=True)

    # Embed the source chunks for semantic search.
    g.query("MATCH (d:Document) WHERE d.text IS NOT NULL SET d:Chunk")
    vector_store()  # builds index + embeddings for Chunk.text
    g.refresh_schema()

    return {
        "chunks": len(docs),
        "nodes": sum(len(gd.nodes) for gd in graph_docs),
        "relationships": sum(len(gd.relationships) for gd in graph_docs),
    }


def _label(labels: list[str]) -> str:
    return next((l for l in labels if not l.startswith("__")), "Entity")


def fetch_graph(limit: int = 300) -> dict:
    rows = graph().query(
        """
        MATCH (n:__Entity__)
        WITH n LIMIT $limit
        OPTIONAL MATCH (n)-[r]->(m:__Entity__)
        RETURN elementId(n) AS nid, labels(n) AS nlabels, n.id AS nname,
               elementId(m) AS mid, labels(m) AS mlabels, m.id AS mname, type(r) AS rtype
        """,
        {"limit": limit},
    )
    nodes: dict = {}
    links = []
    for r in rows:
        nodes[r["nid"]] = {"id": r["nid"], "name": r["nname"], "label": _label(r["nlabels"])}
        if r["mid"]:
            nodes.setdefault(r["mid"], {"id": r["mid"], "name": r["mname"], "label": _label(r["mlabels"])})
            links.append({"source": r["nid"], "target": r["mid"], "type": r["rtype"]})
    return {"nodes": list(nodes.values()), "links": links}


def ask(question: str, mode: str = "cypher") -> dict:
    if mode == "vector":
        hits = vector_store().similarity_search(question, k=4)
        context = "\n\n".join(h.page_content for h in hits)
        answer = llm().invoke(
            f"Answer using only this context.\n\nContext:\n{context}\n\nQuestion: {question}"
        ).content
        return {"answer": answer, "cypher": None, "sources": [h.page_content[:300] for h in hits]}

    chain = GraphCypherQAChain.from_llm(
        llm(), graph=graph(), verbose=False, return_intermediate_steps=True,
        allow_dangerous_requests=True,
    )
    res = chain.invoke({"query": question})
    steps = res.get("intermediate_steps", [])
    return {"answer": res["result"], "cypher": steps[0]["query"] if steps else None, "sources": []}


def clear_graph() -> None:
    graph().query("MATCH (n) DETACH DELETE n")
    graph().refresh_schema()
