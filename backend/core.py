import io
import json
import os
import re
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
FULLTEXT_INDEX = "chunk_fulltext"
RRF_K = 60  # reciprocal-rank-fusion damping constant


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


def clean_text(text: str) -> str:
    """Undo PDF extraction artefacts: hyphenated line breaks and hard-wrapped lines."""
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    text = re.sub(r"(?<![.!?:\n])\n(?!\n)", " ", text)
    return re.sub(r"[ \t]+", " ", text).strip()


def lucene_escape(q: str) -> str:
    return re.sub(r'([+\-&|!(){}\[\]^"~*?:\\/])', r"\\\1", q)


def parse_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        return {}


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
        self.ensure_indexes()

    def ensure_indexes(self) -> None:
        # Lucene full-text index over chunk text: this is the BM25 side of hybrid retrieval.
        self.graph.query(
            f"CREATE FULLTEXT INDEX {FULLTEXT_INDEX} IF NOT EXISTS FOR (c:Chunk) ON EACH [c.text]"
        )

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

        yield {"type": "chunking"}
        chunks = self.smart_chunks(clean_text(text))
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
        self.ensure_indexes()
        self._vector_store()
        self.graph.refresh_schema()
        yield {"type": "done", "chunks": len(chunks), "nodes": total_nodes, "relationships": total_rels}

    def smart_chunks(self, text: str, max_chars: int = 1800, min_chars: int = 400, window: int = 2) -> list[str]:
        """TextTiling-style semantic chunking: embed sentences, compare the window of sentences before
        each gap with the window after it, and cut only at pronounced similarity dips (mean - 0.75 std).
        Homogeneous text stays in one chunk; size bounds are enforced afterwards."""
        import numpy as np

        sentences = [x.strip() for x in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])", text) if x.strip()]
        cuts: set[int] = set()
        if len(sentences) > 2 * window + 1:
            try:
                vecs = np.array(self.embeddings.embed_documents(sentences), dtype=float)
                vecs /= np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-9
                gaps = []
                for i in range(1, len(sentences)):
                    left = vecs[max(0, i - window):i].mean(axis=0)
                    right = vecs[i:i + window].mean(axis=0)
                    gaps.append(float(left @ right / (np.linalg.norm(left) * np.linalg.norm(right) + 1e-9)))
                g = np.array(gaps)
                thresh = g.mean() - 0.75 * g.std()
                for j, v in enumerate(g):  # gap j sits before sentence j+1
                    is_min = (j == 0 or v <= g[j - 1]) and (j == len(g) - 1 or v <= g[j + 1])
                    if v < thresh and is_min:
                        cuts.add(j + 1)
            except Exception:
                cuts = set()

        pieces, cur = [], []
        for i, sent in enumerate(sentences):
            if i in cuts and cur:
                pieces.append(" ".join(cur)); cur = []
            cur.append(sent)
        if cur:
            pieces.append(" ".join(cur))

        # Size bounds: merge undersized pieces forward, re-split oversized ones.
        sizer = RecursiveCharacterTextSplitter(chunk_size=1500, chunk_overlap=150)
        out: list[str] = []
        for piece in pieces:
            if out and len(out[-1]) < min_chars and len(out[-1]) + len(piece) <= max_chars:
                out[-1] += " " + piece
            else:
                out.append(piece)
        final: list[str] = []
        for piece in out:
            final.extend(sizer.split_text(piece) if len(piece) > max_chars else [piece])
        return final or [text]

    # ---- advanced retrieval -------------------------------------------------

    def rewrite_query(self, question: str, history: list[dict]) -> dict:
        """Make the question standalone using chat history, add paraphrases and BM25 keywords."""
        convo = "\n".join(f"{m['role']}: {m['text'][:300]}" for m in history[-6:])
        prompt = (
            "You rewrite search queries for a document retrieval system.\n"
            "Given the conversation and the latest question, reply with ONLY a JSON object:\n"
            '{"standalone": "the question rewritten to be fully self-contained (resolve pronouns and references)",'
            ' "variants": ["two different paraphrases that might match the document wording"],'
            ' "keywords": ["3-8 important search terms, names and synonyms"]}\n\n'
            f"Conversation:\n{convo or '(none)'}\n\nLatest question: {question}\nJSON:"
        )
        try:
            data = parse_json(self.llm.invoke(prompt).content)
        except Exception:
            data = {}
        standalone = str(data.get("standalone") or question).strip()
        variants = [str(v).strip() for v in (data.get("variants") or []) if str(v).strip()][:2]
        keywords = [str(k).strip() for k in (data.get("keywords") or []) if str(k).strip()][:8]
        return {"standalone": standalone, "variants": variants, "keywords": keywords}

    def _bm25(self, query: str, k: int) -> list[dict]:
        q = lucene_escape(query).strip()
        if not q:
            return []
        try:
            return self.graph.query(
                "CALL db.index.fulltext.queryNodes($idx, $q, {limit: $k}) YIELD node, score "
                "RETURN node.id AS id, node.text AS text, score",
                {"idx": FULLTEXT_INDEX, "q": q, "k": k},
            )
        except Exception:
            return []

    def _semantic(self, query: str, k: int) -> list[dict]:
        try:
            hits = self._vector_store().similarity_search_with_score(query, k=k)
        except Exception:
            return []
        return [{"id": d.metadata.get("id"), "text": d.page_content.removeprefix("\ntext: ").strip(), "score": sc} for d, sc in hits]

    def _graph_facts(self, chunk_ids: list[str], limit: int = 15) -> list[str]:
        rows = self.graph.query(
            """
            MATCH (c:Chunk)-[:MENTIONS]->(e:__Entity__) WHERE c.id IN $ids
            WITH DISTINCT e
            MATCH (e)-[r]->(f:__Entity__) WHERE type(r) <> 'MENTIONS'
            RETURN e.id AS a, type(r) AS r, f.id AS b LIMIT $limit
            """,
            {"ids": chunk_ids, "limit": limit},
        )
        return [f"{r['a']} {r['r'].replace('_', ' ').lower()} {r['b']}" for r in rows]

    def hybrid_search(self, question: str, history: list[dict] | None = None, top_n: int = 5) -> dict:
        rw = self.rewrite_query(question, history or [])
        queries = [rw["standalone"], *rw["variants"]]
        bm25_query = " ".join(rw["keywords"]) or rw["standalone"]

        rankings: list[tuple[str, list[dict]]] = [("vector", self._semantic(q, 6)) for q in queries]
        rankings.append(("bm25", self._bm25(bm25_query, 6)))
        rankings.append(("bm25", self._bm25(rw["standalone"], 6)))

        # Reciprocal rank fusion: chunks ranked high by several lists/retrievers float to the top.
        fused: dict[str, dict] = {}
        for origin, hits in rankings:
            for rank, h in enumerate(hits):
                if not h.get("id"):
                    continue
                e = fused.setdefault(h["id"], {"id": h["id"], "text": h["text"], "score": 0.0, "found_by": set()})
                e["score"] += 1.0 / (RRF_K + rank + 1)
                e["found_by"].add(origin)
        top = sorted(fused.values(), key=lambda e: e["score"], reverse=True)[:top_n]
        facts = self._graph_facts([e["id"] for e in top]) if top else []
        return {"rewrite": rw, "chunks": top, "facts": facts}

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

    def ask(self, question: str, mode: str = "hybrid", history: list[dict] | None = None) -> dict:
        if mode == "hybrid":
            r = self.hybrid_search(question, history)
            if not r["chunks"]:
                return {"answer": "I couldn't find anything relevant in the graph yet. Upload a document first.",
                        "cypher": None, "sources": [], "trace": None}
            context = "\n\n".join(f"[{i}] {c['text']}" for i, c in enumerate(r["chunks"], 1))
            facts = "\n".join(f"- {f}" for f in r["facts"]) or "(none)"
            answer = self.llm.invoke(
                "Answer the question using only the numbered passages and the graph facts below. "
                "Cite passages like [1]. If the answer is not there, say so.\n\n"
                f"Passages:\n{context}\n\nGraph facts:\n{facts}\n\nQuestion: {r['rewrite']['standalone']}"
            ).content
            return {
                "answer": answer, "cypher": None, "sources": [],
                "trace": {
                    "rewrite": r["rewrite"], "facts": r["facts"],
                    "chunks": [{"text": c["text"][:400], "score": round(c["score"], 4), "found_by": sorted(c["found_by"])} for c in r["chunks"]],
                },
            }
        if mode == "vector":
            hits = self._vector_store().similarity_search(question, k=4)
            context = "\n\n".join(h.page_content for h in hits)
            answer = self.llm.invoke(
                f"Answer using only this context.\n\nContext:\n{context}\n\nQuestion: {question}"
            ).content
            return {"answer": answer, "cypher": None, "sources": [h.page_content[:300] for h in hits], "trace": None}

        chain = GraphCypherQAChain.from_llm(
            self.llm, graph=self.graph, verbose=False, return_intermediate_steps=True,
            allow_dangerous_requests=True,
        )
        res = chain.invoke({"query": question})
        steps = res.get("intermediate_steps", [])
        return {"answer": res["result"], "cypher": steps[0]["query"] if steps else None, "sources": [], "trace": None}

    def clear_graph(self) -> None:
        self.graph.query("MATCH (n) DETACH DELETE n")
        self.graph.refresh_schema()
