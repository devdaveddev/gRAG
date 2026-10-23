import io
import os
from dataclasses import dataclass, field

from dotenv import load_dotenv
from langchain_core.documents import Document
from langchain_experimental.graph_transformers import LLMGraphTransformer
from langchain_neo4j import GraphCypherQAChain, Neo4jGraph, Neo4jVector
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pypdf import PdfReader

load_dotenv()

# Domain-agnostic: the model chooses entity types from the document itself.
EXTRACTION_HINT = (
    "Use short, singular, capitalised node types such as Person, Organization, Location, Event, "
    "Concept, Product, Technology, Document, Disease, Drug. Reuse the same type for similar entities "
    "and use the entity's full, canonical name as its id."
)
VECTOR_INDEX = "chunk_embeddings"


@dataclass
class Config:
    """Everything a session needs. Never read from globals, so sessions can't share secrets."""
    neo4j_uri: str
    neo4j_user: str
    neo4j_password: str = field(repr=False)
    provider: str = "openai"  # "openai" | "ollama"
    openai_api_key: str = field(default="", repr=False)
    openai_model: str = "gpt-4o-mini"
    ollama_model: str = "qwen2.5:1.5b"
    ollama_embed_model: str = "nomic-embed-text"

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            neo4j_uri=os.environ["NEO4J_URI"],
            neo4j_user=os.environ["NEO4J_USERNAME"],
            neo4j_password=os.environ["NEO4J_PASSWORD"],
            provider=os.getenv("LLM_PROVIDER", "openai"),
            openai_api_key=os.getenv("OPENAI_API_KEY", ""),
            openai_model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            ollama_model=os.getenv("OLLAMA_MODEL", "qwen2.5:1.5b"),
            ollama_embed_model=os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text"),
        )


def _label(labels: list[str]) -> str:
    return next((l for l in labels if not l.startswith("__")), "Entity")


class GraphRAG:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.local = cfg.provider == "ollama"
        if self.local:
            from langchain_ollama import ChatOllama, OllamaEmbeddings
            self.llm = ChatOllama(model=cfg.ollama_model, temperature=0)
            self.embeddings = OllamaEmbeddings(model=cfg.ollama_embed_model)
        else:
            from langchain_openai import ChatOpenAI, OpenAIEmbeddings
            self.llm = ChatOpenAI(model=cfg.openai_model, temperature=0, api_key=cfg.openai_api_key)
            self.embeddings = OpenAIEmbeddings(api_key=cfg.openai_api_key)
        self.graph = Neo4jGraph(url=cfg.neo4j_uri, username=cfg.neo4j_user, password=cfg.neo4j_password)

    def verify(self) -> None:
        """Raises if Neo4j or the LLM credentials don't work."""
        self.graph.query("RETURN 1")
        self.llm.invoke("ping")

    def _vector_store(self) -> Neo4jVector:
        return Neo4jVector.from_existing_graph(
            self.embeddings,
            url=self.cfg.neo4j_uri,
            username=self.cfg.neo4j_user,
            password=self.cfg.neo4j_password,
            index_name=VECTOR_INDEX,
            node_label="Chunk",
            text_node_properties=["text"],
            embedding_node_property="embedding",
        )

    def ingest_pdf_stream(self, data: bytes, filename: str):
        """Yield progress events as each chunk is extracted and written, so the UI can update live."""
        reader = PdfReader(io.BytesIO(data))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
        if not text.strip():
            raise ValueError("No extractable text in PDF")

        chunks = RecursiveCharacterTextSplitter(chunk_size=1500, chunk_overlap=150).split_text(text)
        transformer = LLMGraphTransformer(
            llm=self.llm,
            node_properties=["description"] if not self.local else False,
            ignore_tool_usage=self.local,
            additional_instructions=EXTRACTION_HINT,
        )
        total_nodes = total_rels = 0
        yield {"type": "start", "total": len(chunks)}
        for i, chunk in enumerate(chunks, 1):
            doc = Document(page_content=chunk, metadata={"source": filename})
            graph_docs = transformer.convert_to_graph_documents([doc])
            self.graph.add_graph_documents(graph_docs, baseEntityLabel=True, include_source=True)
            nodes = [{"id": n.id, "name": n.id, "label": n.type} for gd in graph_docs for n in gd.nodes]
            links = [
                {"source": r.source.id, "target": r.target.id, "type": r.type}
                for gd in graph_docs for r in gd.relationships
            ]
            total_nodes += len(nodes)
            total_rels += len(links)
            yield {"type": "chunk", "done": i, "total": len(chunks), "nodes": nodes, "links": links}

        yield {"type": "indexing"}
        # Embed the source chunks for semantic search.
        self.graph.query("MATCH (d:Document) WHERE d.text IS NOT NULL SET d:Chunk")
        self._vector_store()
        self.graph.refresh_schema()
        yield {"type": "done", "chunks": len(chunks), "nodes": total_nodes, "relationships": total_rels}

    def fetch_graph(self, limit: int = 1000) -> dict:
        rows = self.graph.query(
            """
            MATCH (n:__Entity__)
            WITH n LIMIT $limit
            OPTIONAL MATCH (n)-[r]->(m:__Entity__)
            RETURN n.id AS nid, labels(n) AS nlabels, n.id AS nname,
                   m.id AS mid, labels(m) AS mlabels, m.id AS mname, type(r) AS rtype
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

    def ask(self, question: str, mode: str = "cypher") -> dict:
        if mode == "vector":
            hits = self._vector_store().similarity_search(question, k=4)
            context = "\n\n".join(h.page_content for h in hits)
            answer = self.llm.invoke(
                f"Answer using only this context.\n\nContext:\n{context}\n\nQuestion: {question}"
            ).content
            return {"answer": answer, "cypher": None, "sources": [h.page_content[:300] for h in hits]}

        chain = GraphCypherQAChain.from_llm(
            self.llm, graph=self.graph, verbose=False, return_intermediate_steps=True,
            allow_dangerous_requests=True,
        )
        res = chain.invoke({"query": question})
        steps = res.get("intermediate_steps", [])
        return {"answer": res["result"], "cypher": steps[0]["query"] if steps else None, "sources": []}

    def clear_graph(self) -> None:
        self.graph.query("MATCH (n) DETACH DELETE n")
        self.graph.refresh_schema()
