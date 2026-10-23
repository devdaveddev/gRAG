import os

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import core

_rag: core.GraphRAG | None = None


def rag() -> core.GraphRAG:
    # Single-tenant API: credentials come from the server's env.
    global _rag
    if _rag is None:
        _rag = core.GraphRAG(core.Config.from_env())
    return _rag

app = FastAPI(title="Graph RAG")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported")
    try:
        return rag().ingest_pdf(await file.read(), file.filename)
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.get("/api/graph")
def get_graph(limit: int = 300):
    return rag().fetch_graph(limit)


class Query(BaseModel):
    question: str
    mode: str = "cypher"  # "cypher" | "vector"


@app.post("/api/query")
def query(q: Query):
    return rag().ask(q.question, q.mode)


@app.delete("/api/graph")
def clear_graph():
    rag().clear_graph()
    return {"ok": True}


# Serve built frontend (production).
dist = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.isdir(dist):
    app.mount("/", StaticFiles(directory=dist, html=True), name="static")
