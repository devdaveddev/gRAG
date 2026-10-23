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
1. Create a free Neo4j Aura instance (https://neo4j.com/cloud/aura-free/).
2. On https://share.streamlit.io, deploy this repo with main file `streamlit_app.py`. No secrets need configuring.
3. On first load the app asks each visitor for their OpenAI API key and Neo4j credentials. They are held in that session's memory only.

Local run: `pip install -r requirements.txt && streamlit run streamlit_app.py`.
Choose "Local (Ollama)" in the setup form to use local models instead of OpenAI (self-hosting only).
