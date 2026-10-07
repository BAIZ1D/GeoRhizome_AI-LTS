import time
import os
import json
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn
from sentence_transformers import SentenceTransformer
import torch

# Load configuration from config/app_config.json
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config", "app_config.json")
CONFIG = {}
if os.path.exists(CONFIG_PATH):
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            CONFIG = json.load(f)
    except Exception as e:
        print(f"Warning: could not read {CONFIG_PATH}: {e}")

emb_cfg = CONFIG.get("embedding", {})
ts_cfg = CONFIG.get("text_splitter", {})

EMBEDDING_MODEL_NAME = os.getenv("EMBEDDING_MODEL_PREF", emb_cfg.get("model_name", "BAAI/bge-m3"))
CHUNK_SIZE = int(os.getenv("EMBEDDING_MAX_CHUNK_LENGTH", ts_cfg.get("chunk_size", 1024)))
BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", emb_cfg.get("max_concurrent_chunks", 2)))
HOST = os.getenv("EMBEDDING_HOST", "127.0.0.1")
PORT = int(os.getenv("EMBEDDING_PORT", 8000))

app = FastAPI()

# Use MPS if available with feather-light batch size to guarantee 0% VRAM swapping & 0% lag
device = "mps" if torch.backends.mps.is_available() else "cpu"
print(f"Loading {EMBEDDING_MODEL_NAME} on device: {device}...")
model = SentenceTransformer(EMBEDDING_MODEL_NAME, device=device)
print(f"{EMBEDDING_MODEL_NAME} successfully loaded on {device}!")

@app.post("/v1/embeddings")
@app.post("/embeddings")
async def create_embedding(request: Request):
    data = await request.json()
    input_text = data.get("input", "")
    if isinstance(input_text, str):
        input_text = [input_text]
    
    # Capped to CHUNK_SIZE chars per text chunk to prevent attention matrix memory explosion
    truncated_input = [str(t)[:CHUNK_SIZE] if t else "" for t in input_text]
    
    t0 = time.time()
    embeddings = model.encode(truncated_input, batch_size=BATCH_SIZE, normalize_embeddings=True)
    duration = time.time() - t0
    
    response_data = []
    for idx, vec in enumerate(embeddings):
        response_data.append({
            "object": "embedding",
            "index": idx,
            "embedding": vec.tolist()
        })
    
    print(f"Embedded {len(input_text)} chunks in {round(duration, 3)}s on M1 ({device})!")
    return JSONResponse({
        "object": "list",
        "data": response_data,
        "model": EMBEDDING_MODEL_NAME,
        "usage": {"prompt_tokens": 0, "total_tokens": 0}
    })

if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)

