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


## Deploy free on Streamlit Community Cloud
1. Create a free Neo4j Aura instance (https://neo4j.com/cloud/aura-free/) and note the URI and password.
2. On https://share.streamlit.io, deploy this repo with main file `streamlit_app.py`.
3. In *Advanced settings → Secrets*, paste the contents of `.streamlit/secrets.toml.example` with your values.

Local run: `pip install -r requirements.txt && streamlit run streamlit_app.py`.
(Local Ollama models only work when self-hosting; Streamlit Cloud needs `OPENAI_API_KEY`.)
