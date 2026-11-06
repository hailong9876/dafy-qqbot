# edge_tts_server.py —— Edge-TTS FastAPI 服务
# 端口 18904，速度极快，需联网
import argparse
import asyncio
import hashlib
import io
import json
import os
import re
import tempfile
import time
from pathlib import Path

import edge_tts
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, FileResponse
import uvicorn

app = FastAPI(title="Edge-TTS Server", version="1.0")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 音色映射表（基于 edge-tts --list-voices 实际可用音色）
VOICES = {
    "xiaoxiao": {"id": "zh-CN-XiaoxiaoNeural", "name": "晓晓（女声）", "gender": "female"},
    "xiaoyi": {"id": "zh-CN-XiaoyiNeural", "name": "小艺（女声）", "gender": "female"},
    "yunjian": {"id": "zh-CN-YunjianNeural", "name": "云健（男声）", "gender": "male"},
    "yunxi": {"id": "zh-CN-YunxiNeural", "name": "云希（男声）", "gender": "male"},
    "yunxia": {"id": "zh-CN-YunxiaNeural", "name": "云夏（男声）", "gender": "male"},
    "yunyang": {"id": "zh-CN-YunyangNeural", "name": "云扬（男声）", "gender": "male"},
    "xiaobei": {"id": "zh-CN-liaoning-XiaobeiNeural", "name": "小北（东北话）", "gender": "female"},
    "xiaoni": {"id": "zh-CN-shaanxi-XiaoniNeural", "name": "小妮（陕西话）", "gender": "female"},
}

# 缓存目录
CACHE_DIR = Path(__file__).parent / "cache_edge"
CACHE_DIR.mkdir(exist_ok=True)
MAX_CACHE = 100


def cache_key(text: str, voice: str, rate: str, pitch: str) -> str:
    s = f"{text}|{voice}|{rate}|{pitch}"
    return hashlib.md5(s.encode()).hexdigest()


def cleanup_cache():
    files = sorted(CACHE_DIR.glob("*.mp3"), key=lambda f: f.stat().st_mtime)
    while len(files) > MAX_CACHE:
        files.pop(0).unlink(missing_ok=True)


@app.get("/health")
async def health():
    return {"ok": True, "service": "edge-tts", "engine": "edge-tts", "voices": len(VOICES)}


@app.get("/voices")
async def list_voices():
    result = []
    for k, v in VOICES.items():
        result.append({"id": k, "name": v["name"], "gender": v["gender"], "engine": "edge"})
    return {"ok": True, "voices": result}


@app.post("/synthesize")
async def synthesize(
    text: str = Form(...),
    voice: str = Form("xiaoxiao"),
    rate: str = Form("+0%"),
    pitch: str = Form("+0Hz"),
):
    return await _do_synthesize(text, voice, rate, pitch)


@app.post("/synthesize_json")
async def synthesize_json(body: dict):
    return await _do_synthesize(
        body.get("text", ""),
        body.get("voice", "xiaoxiao"),
        body.get("rate", "+0%"),
        body.get("pitch", "+0Hz"),
    )


async def _do_synthesize(text: str, voice: str, rate: str, pitch: str):
    """统一合成入口：先写临时文件再原子替换，避免并发读到半截音频"""
    if not text or not text.strip():
        raise HTTPException(400, "text is empty")
    if len(text) > 2000:
        raise HTTPException(400, "文本过长（上限 2000 字符）")

    voice_id = VOICES.get(voice, VOICES["xiaoxiao"])["id"]
    key = cache_key(text, voice, rate, pitch)
    cache_path = CACHE_DIR / f"{key}.mp3"

    if cache_path.exists() and cache_path.stat().st_size > 0:
        return FileResponse(cache_path, media_type="audio/mpeg")

    tmp_path = CACHE_DIR / f"{key}.{time.time_ns()}.tmp"
    try:
        communicate = edge_tts.Communicate(text, voice_id, rate=rate, pitch=pitch)
        await communicate.save(str(tmp_path))
        if not tmp_path.exists() or tmp_path.stat().st_size == 0:
            raise RuntimeError("合成结果为空（请检查网络是否可访问微软服务）")
        os.replace(tmp_path, cache_path)
        cleanup_cache()
        return FileResponse(cache_path, media_type="audio/mpeg")
    except HTTPException:
        raise
    except Exception as e:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise HTTPException(500, f"Edge-TTS error: {e}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18904)
    args = parser.parse_args()

    print(f"[edge-tts] 启动服务 http://127.0.0.1:{args.port}")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
