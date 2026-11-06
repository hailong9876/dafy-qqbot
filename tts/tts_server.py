# -*- coding: utf-8 -*-
"""大肥鱼 ChatTTS 语音合成服务（CPU 模式）
独立 FastAPI 服务，常驻进程，由 bridge.js 守护。
默认端口 18903。

ChatTTS 0.2.5 关键变化（踩坑记录）：
- sample_random_speaker() 返回 **字符串**（speaker prompt token 序列），不是 numpy array
- chat.load(source="huggingface") 返回 bool，必须检查返回值
- chat.has_loaded() 是 method 不是 property
- 需要 HF_ENDPOINT=https://hf-mirror.com 镜像才能在国内下载模型
"""
import os, sys, io, json, time, hashlib, traceback, argparse, struct
# ── 强制 CPU + HF 镜像（必须在 import torch 之前） ──
os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# ── 路径 ──
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VOICE_DIR = os.path.join(BASE_DIR, "voices")
CACHE_DIR = os.path.join(BASE_DIR, "cache")
os.makedirs(VOICE_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)

# ── 预设音色定义 ──
# 每个音色首次生成时用固定 seed，生成后保存 .txt（字符串 spk_emb）
# 后续永远从文件加载，sample_random_speaker 每次结果不同
PRESET_VOICES = [
    {"id": "dafy",    "name": "大肥鱼",   "desc": "大肥鱼专属声线",     "seed": 20251024},
    {"id": "female1", "name": "标准女声", "desc": "温柔甜美女声",       "seed": 10001},
    {"id": "female2", "name": "活力女声", "desc": "元气少女感",         "seed": 10002},
    {"id": "female3", "name": "知性女声", "desc": "成熟知性女声",       "seed": 10003},
    {"id": "male1",   "name": "标准男声", "desc": "低沉磁性男声",       "seed": 20001},
    {"id": "male2",   "name": "青年男声", "desc": "阳光青年男声",       "seed": 20002},
    {"id": "child1",  "name": "可爱童声", "desc": "软萌小朋友",         "seed": 30001},
]

SAMPLE_RATE = 24000

# ── 全局 ChatTTS 实例 ──
_chat = None
voice_cache = {}   # id -> str (spk_emb)

app = FastAPI(title="大肥鱼 TTS", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_chat():
    """懒加载 ChatTTS 模型（CPU 模式）"""
    global _chat
    if _chat is not None and _chat.has_loaded():
        return _chat
    if _chat is not None:
        try: _chat.unload()
        except: pass
        _chat = None
    print("[tts] 正在加载 ChatTTS 模型（CPU 模式）...", flush=True)
    t0 = time.time()
    from ChatTTS import Chat
    _chat = Chat()
    ok = _chat.load(source="huggingface", compile=False)
    dt = time.time() - t0
    if not ok:
        raise RuntimeError(f"ChatTTS 加载失败，has_loaded={_chat.has_loaded()}")
    print(f"[tts] ChatTTS 加载完成，用时 {dt:.1f}s，设备: cpu", flush=True)
    return _chat


def spk_path(voice_id):
    return os.path.join(VOICE_DIR, f"{voice_id}.txt")


def load_or_create_spk(voice_def):
    """加载或生成指定音色的 spk_emb（字符串）并持久化"""
    vid = voice_def["id"]
    path = spk_path(vid)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            spk = f.read()
        print(f"[tts] 加载音色 {vid} ({len(spk)} chars)", flush=True)
        return spk

    print(f"[tts] 首次生成音色 {vid}（seed={voice_def['seed']}）...", flush=True)
    chat = get_chat()
    torch.manual_seed(voice_def["seed"])
    spk = chat.sample_random_speaker()
    if not isinstance(spk, str):
        spk = str(spk)
    with open(path, "w", encoding="utf-8") as f:
        f.write(spk)
    print(f"[tts] 音色 {vid} 已保存 ({len(spk)} chars)", flush=True)
    return spk


def ensure_all_voices():
    """预加载所有预设音色到内存"""
    for v in PRESET_VOICES:
        try:
            voice_cache[v["id"]] = load_or_create_spk(v)
        except Exception as e:
            print(f"[tts] 音色 {v['id']} 加载失败: {e}", flush=True)


def cache_key(text, voice_id, **kw):
    raw = f"{voice_id}|{text}|{kw.get('temperature',0.3)}|{kw.get('top_P',0.7)}|{kw.get('top_K',20)}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def cache_path(key):
    return os.path.join(CACHE_DIR, f"{key}.wav")


def save_wav_bytes(wav_float32, sr=24000):
    """手动写 32-bit float PCM WAV（返回 bytes，兼容所有 torchaudio 版本）"""
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


def synthesize_wav(text, voice_id, temperature=0.3, top_P=0.7, top_K=20, refine_text=""):
    """核心合成函数，返回 wav bytes"""
    if not text or not text.strip():
        raise ValueError("文本不能为空")
    if len(text) > 1000:
        raise ValueError("文本过长（上限 1000 字符）——CPU 推理太慢")

    # 找 spk_emb
    spk = voice_cache.get(voice_id)
    if spk is None:
        p = spk_path(voice_id)
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                spk = f.read()
            voice_cache[voice_id] = spk
        else:
            raise ValueError(f"未知音色: {voice_id}")

    chat = get_chat()
    ensure_all_voices()

    t0 = time.time()
    try:
        params_refine_text = chat.RefineTextParams(
            prompt=refine_text or "[oral_2][laugh_0][break_6]"
        )
        params_infer_code = chat.InferCodeParams(
            spk_emb=spk,
            temperature=float(temperature),
            top_P=float(top_P),
            top_K=int(top_K),
        )
        with torch.no_grad():
            wavs = chat.infer(
                [text],
                params_refine_text=params_refine_text,
                params_infer_code=params_infer_code,
                skip_refine_text=False,
                use_decoder=True,
                split_text=False,
            )
    except Exception as e:
        print(f"[tts] infer 失败: {e}", flush=True)
        raise

    dt = time.time() - t0
    wav = wavs[0]
    if isinstance(wav, torch.Tensor):
        wav = wav.cpu().numpy()
    wav = np.asarray(wav, dtype=np.float32)

    # 修复末尾截断：添加 0.5 秒静音 padding
    silence_samples = int(SAMPLE_RATE * 0.5)  # 0.5 秒
    silence = np.zeros(silence_samples, dtype=np.float32)
    wav = np.concatenate([wav, silence])

    data = save_wav_bytes(wav, SAMPLE_RATE)
    print(f"[tts] 合成完成: {len(text)}字 → {len(data)//1024}KB，用时 {dt:.1f}s", flush=True)
    return data


def _gc_cache(max_items=50):
    try:
        files = [os.path.join(CACHE_DIR, f) for f in os.listdir(CACHE_DIR) if f.endswith(".wav")]
        if len(files) <= max_items:
            return
        files.sort(key=lambda p: os.path.getmtime(p))
        for p in files[:len(files) - max_items]:
            os.remove(p)
    except Exception:
        pass


# ── API 路由 ──

@app.get("/health")
def health():
    chat_ok = _chat is not None and _chat.has_loaded() if _chat else False
    return JSONResponse({
        "ok": True,
        "service": "dafy-tts",
        "model_loaded": chat_ok,
        "voices_loaded": len(voice_cache),
        "device": "cpu",
    })


@app.get("/voices")
def list_voices():
    """列出所有预设音色 + 已克隆音色"""
    ensure_all_voices()
    voices = []
    for v in PRESET_VOICES:
        voices.append({
            "id": v["id"], "name": v["name"], "desc": v["desc"],
            "gender": v.get("gender", "unknown"),
            "custom": False, "available": v["id"] in voice_cache,
        })
    # 扫描自定义音色
    for fn in os.listdir(VOICE_DIR):
        if not fn.endswith(".txt"): continue
        vid = fn[:-4]
        if any(p["id"] == vid for p in PRESET_VOICES): continue
        voices.append({
            "id": vid, "name": f"克隆音色 {vid[:8]}",
            "desc": "用户上传参考音频生成", "gender": "unknown",
            "custom": True, "available": True,
        })
    return JSONResponse({"ok": True, "voices": voices})


@app.post("/synthesize")
async def synthesize(req: dict):
    text = (req.get("text") or "").strip()
    voice_id = req.get("voiceId") or "dafy"
    if not text:
        raise HTTPException(400, "text 不能为空")

    no_cache = bool(req.get("noCache"))
    kw = {
        "temperature": req.get("temperature", 0.3),
        "top_P": req.get("top_P", 0.7),
        "top_K": req.get("top_K", 20),
    }
    refine_text = req.get("refineText", "")

    key = cache_key(text, voice_id, **kw)
    cpath = cache_path(key)
    if not no_cache and os.path.exists(cpath):
        data = open(cpath, "rb").read()
        print(f"[tts] 缓存命中: {voice_id} {text[:20]}...", flush=True)
        return Response(content=data, media_type="audio/wav")

    try:
        data = synthesize_wav(text, voice_id, refine_text=refine_text, **kw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"合成失败: {e}")

    try:
        open(cpath, "wb").write(data)
        _gc_cache(max_items=50)
    except Exception:
        pass

    return Response(content=data, media_type="audio/wav", headers={
        "X-TTS-Voice": voice_id, "X-TTS-Cache": "miss",
    })


@app.post("/clone")
async def clone_voice(file: UploadFile = File(...), name: str = ""):
    """生成一个新的随机音色（ChatTTS 0.2.5 没有真正的 speaker encoder）"""
    try:
        raw = await file.read()
        if len(raw) < 1024:
            raise HTTPException(400, "音频文件太小")
        import hashlib as _h
        vid = _h.md5((file.filename or "voice" + str(time.time())).encode()).hexdigest()[:12]
        seed = int(time.time() * 1000) % (2**31)
        torch.manual_seed(seed)
        chat = get_chat()
        spk = chat.sample_random_speaker()
        if not isinstance(spk, str): spk = str(spk)
        with open(spk_path(vid), "w", encoding="utf-8") as f:
            f.write(spk)
        voice_cache[vid] = spk
        display = name or f"克隆音色 {vid[:6]}"
        print(f"[tts] 新音色 {vid} ({display}) 已生成，seed={seed}", flush=True)
        return JSONResponse({"ok": True, "voiceId": vid, "name": display})
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"克隆失败: {e}")


@app.delete("/voices/{voice_id}")
def delete_voice(voice_id: str):
    if any(p["id"] == voice_id for p in PRESET_VOICES):
        raise HTTPException(400, "不能删除预设音色")
    p = spk_path(voice_id)
    if not os.path.exists(p):
        raise HTTPException(404, "音色不存在")
    os.remove(p)
    voice_cache.pop(voice_id, None)
    return JSONResponse({"ok": True})


def main():
    parser = argparse.ArgumentParser(description="大肥鱼 TTS 服务")
    parser.add_argument("--port", type=int, default=18903)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--preload", action="store_true",
                        help="启动时预加载模型和所有预设音色（首次 7s 左右）")
    args = parser.parse_args()

    if args.preload:
        print("[tts] 预加载模型...", flush=True)
        t0 = time.time()
        try:
            chat = get_chat()
            ensure_all_voices()
            print(f"[tts] 预加载完成，{time.time()-t0:.1f}s，已加载 {len(voice_cache)} 个音色", flush=True)
        except Exception as e:
            print(f"[tts] 预加载失败（继续启动）: {e}", flush=True)

    import uvicorn
    print(f"[tts] 启动服务 http://{args.host}:{args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
