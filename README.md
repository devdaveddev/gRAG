# gRAG – Realtime Knowledge Graph from PDFs

Upload a PDF, extract it into a Neo4j knowledge graph (Patients, Doctors, Diseases, …), and query it in natural language with OpenAI + LangChain. The React UI shows the graph full-screen with floating upload and chat panels.

## Features
- PDF → graph extraction (`LLMGraphTransformer`)
- Natural-language → Cypher (`GraphCypherQAChain`)
- Semantic vector search over chunks (`Neo4jVector`)
- Interactive force-directed graph, colored by entity type

## Run locally
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cd frontend && npm install && npm run build && cd ..
cd backend && uvicorn main:app          # open http://localhost:8000
```
For frontend hot-reload run `npm run dev` in `frontend/` (http://localhost:5173, proxies `/api` to port 8000).

On first load the app asks for your OpenAI API key (or choose Local Ollama) and Neo4j credentials. They are held in server memory per session (2h idle timeout), never written to disk or logs, and the browser only keeps an opaque session token. Run it over HTTPS if you host it publicly.

## Host it
The `Dockerfile` builds the React UI and serves everything from one FastAPI container on `$PORT` (default 7860).

**Hugging Face Spaces (free, HTTPS):** create a Space with SDK *Docker*, add this to the top of its `README.md`:
```
---
title: gRAG
sdk: docker
app_port: 7860
---
```
then push this repo to the Space. Use a free [Neo4j Aura](https://neo4j.com/cloud/aura-free/) instance; users enter their keys in the setup screen.

**Render:** push to GitHub, then in Render choose *New → Blueprint* and select this repo; `render.yaml` sets up a Docker web service. Add no env vars; users enter keys in the app.

Any container host works too (Fly.io, Railway, Cloud Run): build the Dockerfile and expose `$PORT`.

## Design system
`frontend/src/tokens.css` defines primitive → semantic → component tokens; components and the graph canvas read only from these.
