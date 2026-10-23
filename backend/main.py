import json
import os
import secrets
import time

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import core

SESSION_TTL = 60 * 60 * 2  # seconds of inactivity

app = FastAPI(title="Graph RAG")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Credentials live only here, in memory, keyed by an unguessable token. Never logged or persisted.
_sessions: dict[str, tuple[core.GraphRAG, float]] = {}


def rag(token: str | None) -> core.GraphRAG:
    now = time.time()
    for t in [t for t, (_, seen) in _sessions.items() if now - seen > SESSION_TTL]:
        del _sessions[t]
    entry = _sessions.get(token or "")
    if not entry:
        raise HTTPException(401, "Not connected")
    _sessions[token] = (entry[0], now)
    return entry[0]


class Connect(BaseModel):
    provider: str = "openai"  # "openai" | "ollama"
    openai_api_key: str = Field("", repr=False)
    neo4j_uri: str
    neo4j_user: str = "neo4j"
    neo4j_password: str = Field(repr=False)


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/connect")
def connect(c: Connect):
    if c.provider not in ("openai", "ollama"):
        raise HTTPException(400, "Unknown provider")
    if c.provider == "openai" and not c.openai_api_key.strip():
        raise HTTPException(400, "OpenAI API key is required")
    try:
        instance = core.GraphRAG(core.Config(
            neo4j_uri=c.neo4j_uri.strip(), neo4j_user=c.neo4j_user.strip(),
            neo4j_password=c.neo4j_password, provider=c.provider,
            openai_api_key=c.openai_api_key.strip(),
        ))
        instance.verify()
    except Exception as e:
        # Type + short message only; never echo submitted credentials.
        raise HTTPException(400, f"{type(e).__name__}: {str(e)[:200]}")
    token = secrets.token_urlsafe(32)
    _sessions[token] = (instance, time.time())
    return {"token": token}


@app.post("/api/disconnect")
def disconnect(x_session: str | None = Header(None)):
    _sessions.pop(x_session or "", None)
    return {"ok": True}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...), x_session: str | None = Header(None)):
    r = rag(x_session)
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported")
    data = await file.read()

    def events():
        # NDJSON: one event per line, flushed as each chunk lands in Neo4j.
        try:
            for ev in r.ingest_pdf_stream(data, file.filename):
                yield json.dumps(ev) + "\n"
        except Exception as e:
            yield json.dumps({"type": "error", "message": f"{type(e).__name__}: {str(e)[:200]}"}) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson")


@app.get("/api/graph")
def get_graph(limit: int = 1000, x_session: str | None = Header(None)):
    return rag(x_session).fetch_graph(limit)


class Query(BaseModel):
    question: str
    mode: str = "cypher"  # "cypher" | "vector"


@app.post("/api/query")
def query(q: Query, x_session: str | None = Header(None)):
    return rag(x_session).ask(q.question, q.mode)


@app.delete("/api/graph")
def clear_graph(x_session: str | None = Header(None)):
    rag(x_session).clear_graph()
    return {"ok": True}


# Serve built frontend (production).
dist = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.isdir(dist):
    app.mount("/", StaticFiles(directory=dist, html=True), name="static")
