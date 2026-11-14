# -*- coding: utf-8 -*-
"""大肥鱼 语音合成服务（sherpa-onnx 本地 TTS，CPU）
独立 FastAPI 服务，常驻进程，由 bridge.js / keep_alive.js 守护。默认端口 18903。

替换原因：ChatTTS 在 CPU 上 RTF≈1.4（21 字要 30 秒），Kokoro 实测 RTF≈1.7，
都太慢。现默认用 sherpa-onnx 的 Matcha 中文模型 + vocos 声码器：
- 纯 CPU，20 字约 0.5 秒（RTF≈0.13），45 字约 1 秒
- 22.05kHz 输出
- 中文 lexicon 分词，不依赖 espeak-ng

模型目录：tts/models/
  matcha-icefall-zh-baker/  （默认，需配合 tts/models/vocos-22khz-univ.onnx）
  vits-zh-hf-fanchen-C/     （备用，16kHz）
"""
import io
import os
import struct
import time
import hashlib
import traceback
import argparse

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# ── 路径 ──
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_ROOT = os.path.join(BASE_DIR, "models")
CACHE_DIR = os.path.join(BASE_DIR, "cache_tts")
os.makedirs(CACHE_DIR, exist_ok=True)

NUM_THREADS = int(os.environ.get("DAFY_TTS_THREADS", "4"))

# 可用模型（按优先级探测，取第一个文件齐全的）
MODEL_VARIANTS = [
    {
        "key": "matcha-baker",
        "type": "matcha",
        "dir": "matcha-icefall-zh-baker",
        "model": ["model-steps-3.onnx", "model-steps-4.onnx", "model.onnx"],
        "lexicon": ["lexicon.txt"],
    },
    {
        "key": "fanchen",
        "type": "vits",
        "dir": "vits-zh-hf-fanchen-C",
        "model": ["vits-zh-hf-fanchen-C.onnx", "model.onnx"],
        "lexicon": ["lexicon.txt"],
    },
]

# Matcha 模型需要单独的声码器（放在 models/ 根目录）
MATCHA_VOCODER = ["vocos-22khz-univ.onnx", "hifigan_v2.onnx"]

# ── 音色定义 ──
# 当前模型（Matcha baker）只有 1 个 speaker，音色靠语速区分。
VOICES = [
    {"id": "dafy",    "name": "大肥鱼",   "desc": "默认（清晰少女感）", "gender": "female", "sid": 0, "speed": 1.0},
    {"id": "female1", "name": "温柔女声", "desc": "语速偏慢，更柔和",   "gender": "female", "sid": 0, "speed": 0.9},
    {"id": "female2", "name": "活力女声", "desc": "语速偏快，更活泼",   "gender": "female", "sid": 0, "speed": 1.15},
    {"id": "female3", "name": "知性女声", "desc": "语速稍慢，平稳",     "gender": "female", "sid": 0, "speed": 0.95},
    {"id": "male1",   "name": "标准男声", "desc": "当前模型无男声（回落默认）", "gender": "male", "sid": 0, "speed": 1.0},
    {"id": "male2",   "name": "青年男声", "desc": "当前模型无男声（回落默认）", "gender": "male", "sid": 0, "speed": 1.0},
    {"id": "child1",  "name": "可爱童声", "desc": "语速加快，偏童声",   "gender": "female", "sid": 0, "speed": 1.25},
]

_variant = None
_voices = VOICES
_voice_map = {x["id"]: x for x in VOICES}
_tts = None
_sample_rate = 16000

app = FastAPI(title="大肥鱼 TTS", version="4.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _first_existing(directory, names):
    for n in names:
        p = os.path.join(directory, n)
        if os.path.exists(p):
            return p
    return None


def resolve_variant():
    """探测可用模型目录"""
    global _variant
    if _variant is not None:
        return _variant
    for v in MODEL_VARIANTS:
        d = os.path.join(MODELS_ROOT, v["dir"])
        model = _first_existing(d, v["model"])
        tokens = os.path.join(d, "tokens.txt")
        if not (model and os.path.exists(tokens)):
            continue
        info = {
            "key": v["key"],
            "type": v["type"],
            "dir": d,
            "model": model,
            "tokens": tokens,
            "lexicon": _first_existing(d, v["lexicon"]),
            "vocoder": None,
        }
        if v["type"] == "matcha":
            info["vocoder"] = _first_existing(MODELS_ROOT, MATCHA_VOCODER)
            if not info["vocoder"]:
                continue  # 声码器还没下载，跳过这个模型
        _variant = info
        return _variant
    raise RuntimeError(
        "没有找到可用的 TTS 模型，请把模型解压到 " + MODELS_ROOT +
        "（支持 " + " / ".join(v["dir"] for v in MODEL_VARIANTS) + "）"
    )


def get_voices():
    return VOICES


def get_tts():
    """懒加载模型（只构造一次）"""
    global _tts, _sample_rate
    if _tts is not None:
        return _tts

    v = resolve_variant()
    get_voices()

    import sherpa_onnx

    print(f"[tts] 正在加载 {v['type']} 模型 {v['key']}（CPU）...", flush=True)
    t0 = time.time()
    if v["type"] == "matcha":
        model_cfg = sherpa_onnx.OfflineTtsModelConfig(
            matcha=sherpa_onnx.OfflineTtsMatchaModelConfig(
                acoustic_model=v["model"],
                vocoder=v["vocoder"],
                tokens=v["tokens"],
                lexicon=v["lexicon"] or "",
            ),
            num_threads=NUM_THREADS,
            provider="cpu",
        )
    else:
        model_cfg = sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=v["model"],
                tokens=v["tokens"],
                lexicon=v["lexicon"] or "",
            ),
            num_threads=NUM_THREADS,
            provider="cpu",
        )
    cfg = sherpa_onnx.OfflineTtsConfig(model=model_cfg, max_num_sentences=1)
    if not cfg.validate():
        raise RuntimeError(f"{v['key']} 配置校验失败，请检查模型文件是否完整")
    _tts = sherpa_onnx.OfflineTts(cfg)
    _sample_rate = _tts.sample_rate or 16000
    print(
        f"[tts] 模型加载完成 {time.time() - t0:.1f}s，"
        f"音色数={_tts.num_speakers}，采样率={_sample_rate}，线程={NUM_THREADS}",
        flush=True,
    )
    return _tts


def cache_key(text, voice_id, speed):
    raw = f"vits|{voice_id}|{speed}|{text}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def save_wav_bytes(wav_float32, sr):
    """手动写 32-bit float PCM WAV（返回 bytes，无第三方依赖）"""
    wav = np.asarray(wav_float32, dtype=np.float32).ravel()
    peak = np.max(np.abs(wav)) if wav.size > 0 else 1.0
    if peak > 0.98:
        wav = wav * (0.98 / peak)
    data = wav.tobytes()
    buf = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + len(data)))
    buf.write(b"WAVEfmt ")
    buf.write(struct.pack("<IHHIIHH", 16, 3, 1, sr, sr * 4, 4, 32))
    buf.write(b"data")
    buf.write(struct.pack("<I", len(data)))
    buf.write(data)
    return buf.getvalue()


def synthesize_wav(text, voice_id, speed=1.0):
    if not text or not text.strip():
        raise ValueError("文本不能为空")
    if len(text) > 2000:
        raise ValueError("文本过长（上限 2000 字符）")

    v = _voice_map.get(voice_id) or _voice_map["dafy"]
    sid = int(v["sid"])
    spd = float(speed if speed else v["speed"])

    tts = get_tts()
    if sid >= tts.num_speakers:
        sid = 0

    t0 = time.time()
    audio = tts.generate(text, sid=sid, speed=spd)
    samples = getattr(audio, "samples", None)
    if samples is None:
        raise RuntimeError("模型未返回音频数据")
    sr = getattr(audio, "sample_rate", None) or _sample_rate

    wav = np.asarray(samples, dtype=np.float32).ravel()
    if wav.size == 0:
        raise RuntimeError("合成结果为空，可能是文本无法转换为音素")
    wav = np.concatenate([wav, np.zeros(int(sr * 0.15), dtype=np.float32)])
    data = save_wav_bytes(wav, sr)
    print(
        f"[tts] 合成完成: {len(text)}字 / {voice_id}(sid={sid},speed={spd}) → "
        f"{len(data) // 1024}KB，用时 {time.time() - t0:.2f}s",
        flush=True,
    )
    return data


def _gc_cache(max_items=200):
    try:
        files = [os.path.join(CACHE_DIR, f) for f in os.listdir(CACHE_DIR) if f.endswith(".wav")]
        if len(files) <= max_items:
            return
        files.sort(key=os.path.getmtime)
        for p in files[: len(files) - max_items]:
            os.remove(p)
    except Exception:
        pass


# ── API ──

@app.get("/health")
def health():
    v = None
    try:
        v = resolve_variant()
    except Exception:
        pass
    return JSONResponse({
        "ok": True,
        "service": "dafy-tts",
        "engine": f"sherpa-onnx-{v['type']}" if v else "sherpa-onnx",
        "model": v["key"] if v else None,
        "model_loaded": _tts is not None,
        "voices_loaded": len(_voices),
        "num_speakers": getattr(_tts, "num_speakers", 0) if _tts is not None else 0,
        "sample_rate": _sample_rate,
        "device": "cpu",
    })


@app.get("/voices")
def list_voices():
    names = []
    try:
        names = get_voices()
    except Exception:
        names = _voices
    return JSONResponse({
        "ok": True,
        "voices": [{
            "id": v["id"],
            "name": v["name"],
            "desc": v["desc"],
            "gender": v["gender"],
            "custom": False,
            "available": True,
        } for v in names],
    })


@app.post("/synthesize")
async def synthesize(req: dict):
    text = (req.get("text") or "").strip()
    voice_id = req.get("voiceId") or "dafy"
    if not text:
        raise HTTPException(400, "text 不能为空")

    speed = req.get("speed")
    try:
        speed = float(speed) if speed not in (None, "") else None
    except (TypeError, ValueError):
        speed = None
    if speed is not None:
        speed = max(0.5, min(2.0, speed))

    key = cache_key(text, voice_id, speed or "")
    cpath = os.path.join(CACHE_DIR, f"{key}.wav")
    if not req.get("noCache") and os.path.exists(cpath):
        print(f"[tts] 缓存命中: {voice_id} {text[:20]}...", flush=True)
        return Response(content=open(cpath, "rb").read(), media_type="audio/wav")

    try:
        data = synthesize_wav(text, voice_id, speed)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"合成失败: {e}")

    try:
        open(cpath, "wb").write(data)
        _gc_cache()
    except Exception:
        pass

    return Response(content=data, media_type="audio/wav", headers={
        "X-TTS-Voice": voice_id,
        "X-TTS-Cache": "miss",
        "X-TTS-Engine": "sherpa-vits",
    })


@app.post("/clone")
async def clone_voice():
    raise HTTPException(400, "当前离线引擎为 VITS 固定音色，不支持声音克隆")


@app.delete("/voices/{voice_id}")
def delete_voice(voice_id: str):
    raise HTTPException(400, "预设音色不可删除")


def main():
    parser = argparse.ArgumentParser(description="大肥鱼 TTS 服务")
    parser.add_argument("--port", type=int, default=18903)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--preload", action="store_true",
                        help="启动时预加载模型（首次约 2~4 秒）")
    args = parser.parse_args()

    if args.preload:
        print("[tts] 预加载模型...", flush=True)
        t0 = time.time()
        try:
            get_tts()
            print(f"[tts] 预加载完成，{time.time() - t0:.1f}s", flush=True)
        except Exception as e:
            print(f"[tts] 预加载失败（继续启动，首次请求时会重试）: {e}", flush=True)

    import uvicorn
    print(f"[tts] 启动服务 http://{args.host}:{args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
