#!/usr/bin/env python3
"""Transcribe Hebrew audio with the ivrit-ai Whisper weights.

One script, three homes: a Colab GPU VM (driven by the official `colab` CLI or
by the generated notebook), a GitHub Actions runner, and any local machine.

It streams progress into the result file while it works, so a session that
drops halfway still leaves usable text behind, and the phone that is polling
that file can show a live ETA.

Input and output may each be either a local path or `drive:<fileId>`:

    ivrit_transcribe.py --input drive:1AbC... --output drive:1XyZ... --model ivrit-ai/whisper-large-v3-turbo-ct2

Drive access comes from, in order: an explicit --credentials service-account
JSON, the GDRIVE_SERVICE_ACCOUNT_JSON environment variable, or the ambient
Colab user credentials.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import traceback
from dataclasses import dataclass, field, asdict

DEFAULT_MODEL = "ivrit-ai/whisper-large-v3-turbo-ct2"
PROGRESS_EVERY_SEC = 12.0
SCOPES = ["https://www.googleapis.com/auth/drive"]


# ── Drive plumbing ──────────────────────────────────────────────────────────

def _drive_service(credentials_path=None):
    from googleapiclient.discovery import build

    raw = None
    if credentials_path and os.path.exists(credentials_path):
        raw = open(credentials_path, "r", encoding="utf-8").read()
    elif os.environ.get("GDRIVE_SERVICE_ACCOUNT_JSON"):
        raw = os.environ["GDRIVE_SERVICE_ACCOUNT_JSON"]

    if raw:
        from google.oauth2 import service_account
        info = json.loads(raw)
        creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
        return build("drive", "v3", credentials=creds, cache_discovery=False)

    # Running inside Colab: borrow the signed-in user's credentials.
    from google.colab import auth as colab_auth  # noqa: F401  (import has side effects)
    colab_auth.authenticate_user()
    return build("drive", "v3", cache_discovery=False)


def drive_download(service, file_id, dest_path, on_progress=None):
    from googleapiclient.http import MediaIoBaseDownload

    meta = service.files().get(fileId=file_id, fields="name,size").execute()
    request = service.files().get_media(fileId=file_id)
    with open(dest_path, "wb") as fh:
        downloader = MediaIoBaseDownload(fh, request, chunksize=16 * 1024 * 1024)
        done = False
        while not done:
            status, done = downloader.next_chunk()
            if status and on_progress:
                on_progress(status.progress())
    return meta


def drive_update_text(service, file_id, text, mime="application/json"):
    from googleapiclient.http import MediaIoBaseUpload

    media = MediaIoBaseUpload(io.BytesIO(text.encode("utf-8")), mimetype=mime, resumable=False)
    return service.files().update(fileId=file_id, media_body=media).execute()


def drive_create(service, name, parent, text, mime="application/json"):
    from googleapiclient.http import MediaIoBaseUpload

    media = MediaIoBaseUpload(io.BytesIO(text.encode("utf-8")), mimetype=mime, resumable=False)
    body = {"name": name, "parents": [parent] if parent else []}
    return service.files().create(body=body, media_body=media, fields="id,name").execute()


# ── result file ─────────────────────────────────────────────────────────────

@dataclass
class Sink:
    """Writes the shared result JSON, wherever it lives."""
    target: str
    service: object = None
    _last_write: float = 0.0

    def write(self, payload: dict, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_write < PROGRESS_EVERY_SEC:
            return
        self._last_write = now
        text = json.dumps(payload, ensure_ascii=False, indent=1)
        if self.target.startswith("drive:"):
            try:
                drive_update_text(self.service, self.target.split(":", 1)[1], text)
            except Exception as exc:                      # a lost progress write must not kill the job
                print(f"[warn] progress write failed: {exc}", file=sys.stderr, flush=True)
        else:
            tmp = self.target + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(text)
            os.replace(tmp, self.target)


def srt_timestamp(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_srt(segments) -> str:
    return "\n".join(
        f"{i}\n{srt_timestamp(seg['start'])} --> {srt_timestamp(seg['end'])}\n{seg['text'].strip()}\n"
        for i, seg in enumerate(segments, 1)
    )


# ── the actual work ─────────────────────────────────────────────────────────

def pick_device(requested: str):
    if requested != "auto":
        return requested, ("float16" if requested == "cuda" else "int8")
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda", "float16"
    except Exception:
        pass
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def describe_gpu() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
    except Exception:
        pass
    return ""


def transcribe(args) -> int:
    started = time.time()
    service = None
    if args.input.startswith("drive:") or args.output.startswith("drive:"):
        service = _drive_service(args.credentials)

    sink = Sink(target=args.output, service=service)
    payload = {
        "status": "running",
        "stage": "starting",
        "progress": {"doneSeconds": 0, "totalSeconds": None, "ratio": 0, "rtf": None, "etaSec": None},
        "text": "",
        "segments": [],
        "meta": {"model": args.model, "startedAt": started, "language": args.language},
        "error": None,
    }
    sink.write(payload, force=True)

    # 1. get the audio onto local disk
    if args.input.startswith("drive:"):
        payload["stage"] = "downloading audio"
        sink.write(payload, force=True)
        local_audio = os.path.join(args.workdir, "input_audio")
        meta = drive_download(service, args.input.split(":", 1)[1], local_audio)
        payload["meta"]["sourceName"] = meta.get("name")
    else:
        local_audio = args.input
        payload["meta"]["sourceName"] = os.path.basename(local_audio)

    # 2. load the model
    payload["stage"] = "loading model"
    sink.write(payload, force=True)
    from faster_whisper import WhisperModel

    device, compute_type = pick_device(args.device)
    if args.compute_type != "auto":
        compute_type = args.compute_type
    load_t0 = time.time()
    model = WhisperModel(args.model, device=device, compute_type=compute_type, download_root=args.workdir)
    payload["meta"].update({
        "device": device, "computeType": compute_type, "gpu": describe_gpu(),
        "modelLoadSec": round(time.time() - load_t0, 2),
    })

    # 3. transcribe, reporting as we go
    payload["stage"] = "transcribing"
    sink.write(payload, force=True)
    infer_t0 = time.time()
    segments, info = model.transcribe(
        local_audio,
        language=args.language,
        beam_size=args.beam_size,
        vad_filter=not args.no_vad,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,   # keeps a bad guess from poisoning the rest
    )
    total = float(getattr(info, "duration", 0) or 0)
    payload["progress"]["totalSeconds"] = total
    payload["meta"]["audioSec"] = total

    collected = []
    for seg in segments:
        collected.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip()})
        elapsed = time.time() - infer_t0
        done = seg.end
        rtf = done / elapsed if elapsed > 0 else None
        payload["segments"] = collected
        payload["text"] = " ".join(s["text"] for s in collected)
        payload["progress"] = {
            "doneSeconds": round(done, 1),
            "totalSeconds": total,
            "ratio": round(done / total, 4) if total else None,
            "rtf": round(rtf, 3) if rtf else None,
            "etaSec": round((total - done) / rtf, 1) if rtf and total and rtf > 0 else None,
        }
        sink.write(payload)                     # rate-limited internally
        if args.verbose:
            print(f"[{srt_timestamp(seg.start)}] {seg.text.strip()}", flush=True)

    wall = time.time() - started
    payload.update({
        "status": "done",
        "stage": "done",
        "srt": to_srt(collected),
        "error": None,
    })
    payload["progress"]["ratio"] = 1.0
    payload["meta"].update({
        "finishedAt": time.time(),
        "wallSec": round(wall, 1),
        "inferSec": round(time.time() - infer_t0, 1),
        "rtf": round(total / (time.time() - infer_t0), 3) if total else None,
    })
    sink.write(payload, force=True)

    print(json.dumps({"ok": True, "audioSec": total, "wallSec": round(wall, 1),
                      "rtf": payload["meta"]["rtf"], "chars": len(payload["text"])}, ensure_ascii=False))
    if args.text_output:
        with open(args.text_output, "w", encoding="utf-8") as fh:
            fh.write(payload["text"])
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Transcribe Hebrew audio with ivrit-ai Whisper")
    p.add_argument("--input", required=True, help="local path or drive:<fileId>")
    p.add_argument("--output", required=True, help="local path or drive:<fileId> for the result JSON")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--language", default="he")
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    p.add_argument("--compute-type", default="auto", dest="compute_type")
    p.add_argument("--beam-size", type=int, default=5, dest="beam_size")
    p.add_argument("--no-vad", action="store_true")
    p.add_argument("--workdir", default=os.environ.get("IVRIT_WORKDIR", "/tmp/ivrit"))
    p.add_argument("--credentials", default=None, help="service-account JSON path")
    p.add_argument("--text-output", default=None, dest="text_output")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args(argv)
    os.makedirs(args.workdir, exist_ok=True)

    try:
        return transcribe(args)
    except Exception as exc:
        detail = traceback.format_exc()
        print(detail, file=sys.stderr)
        try:
            service = _drive_service(args.credentials) if args.output.startswith("drive:") else None
            Sink(target=args.output, service=service).write(
                {"status": "error", "error": f"{type(exc).__name__}: {exc}", "traceback": detail[-4000:],
                 "meta": {"model": args.model}}, force=True)
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
