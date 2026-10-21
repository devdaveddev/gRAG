# Graph RAG – Realtime Knowledge Graph from PDFs

Upload a PDF, extract it into a Neo4j knowledge graph (Patients, Doctors, Diseases, …), and query it in natural language with OpenAI + LangChain. The React UI shows the graph full-screen with floating upload and chat panels.

## Features
- PDF → graph extraction (`LLMGraphTransformer`)
- Natural-language → Cypher (`GraphCypherQAChain`)
- Semantic vector search over chunks (`Neo4jVector`)
- Interactive force-directed graph, colored by entity type

## Run locally
```bash
cp .env.example .env   # fill in OpenAI + Neo4j credentials
python -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
(cd backend && uvicorn main:app --reload) &
cd frontend && npm install && npm run dev   # http://localhost:5173
```

## Deploy (Render)
`render.yaml` builds the frontend and serves it from FastAPI. Set the four env vars in the dashboard.
