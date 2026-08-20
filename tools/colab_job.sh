#!/usr/bin/env bash
# Transcribe a recording on a Colab GPU with the official Google Colab CLI.
#
#   pip install google-colab-cli          # provides the `colab` binary (Linux/macOS, py>=3.12)
#   tools/colab_job.sh shiur.m4a          # -> shiur.json + shiur.txt next to it
#
# The phone cannot run this — the CLI needs a terminal — so the app uses the
# generated notebook instead. Both paths execute the same ivrit_transcribe.py.
#
# Options:
#   -s NAME     session name                       (default: ivrit)
#   -g GPU      T4 | L4 | G4 | A100 | H100         (default: T4)
#   -m MODEL    HF model id                        (default: ivrit-ai/whisper-large-v3-turbo-ct2)
#   -o FILE     result JSON path                   (default: <input>.json)
#   -k          keep the VM alive when done (next run reuses it and skips setup)
#   -d ID       input is a Drive file id instead of a local path

set -euo pipefail

SESSION=ivrit
GPU=T4
MODEL="ivrit-ai/whisper-large-v3-turbo-ct2"
OUT=""
KEEP=0
DRIVE_ID=""
REMOTE_DIR=/content/ivrit

while getopts "s:g:m:o:d:kh" opt; do
  case "$opt" in
    s) SESSION="$OPTARG" ;;
    g) GPU="$OPTARG" ;;
    m) MODEL="$OPTARG" ;;
    o) OUT="$OPTARG" ;;
    d) DRIVE_ID="$OPTARG" ;;
    k) KEEP=1 ;;
    h) sed -n '2,20p' "$0"; exit 0 ;;
    *) exit 2 ;;
  esac
done
shift $((OPTIND - 1))

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/ivrit_transcribe.py"

if ! command -v colab >/dev/null 2>&1; then
  echo "colab CLI not found. Install it with:  pip install google-colab-cli" >&2
  exit 1
fi
[[ -f "$SCRIPT" ]] || { echo "missing $SCRIPT" >&2; exit 1; }

if [[ -n "$DRIVE_ID" ]]; then
  INPUT_ARG="drive:$DRIVE_ID"
  BASE="${OUT:-drive-$DRIVE_ID}"
else
  AUDIO="${1:-}"
  [[ -n "$AUDIO" && -f "$AUDIO" ]] || { echo "usage: $0 [options] <audio-file>   (or -d <driveFileId>)" >&2; exit 2; }
  BASE="${AUDIO%.*}"
  INPUT_ARG="$REMOTE_DIR/$(basename "$AUDIO")"
fi
OUT="${OUT:-$BASE.json}"

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

step "session '$SESSION' on a $GPU"
if colab sessions 2>/dev/null | grep -qw "$SESSION"; then
  echo "reusing the running session (setup will be skipped where possible)"
else
  colab new -s "$SESSION" --gpu "$GPU"
fi
colab status -s "$SESSION" || true

step "dependencies"
colab install -s "$SESSION" faster-whisper google-api-python-client google-auth

step "uploading the transcription code"
colab exec -s "$SESSION" <<< "import os; os.makedirs('$REMOTE_DIR', exist_ok=True); print('$REMOTE_DIR ready')"
colab upload -s "$SESSION" "$SCRIPT" "$REMOTE_DIR/ivrit_transcribe.py"

if [[ -z "$DRIVE_ID" ]]; then
  step "uploading $(basename "$AUDIO") ($(du -h "$AUDIO" | cut -f1))"
  colab upload -s "$SESSION" "$AUDIO" "$INPUT_ARG"
else
  step "authorising Drive on the VM"
  colab auth -s "$SESSION"
fi

step "transcribing with $MODEL"
colab exec -s "$SESSION" <<PY
import sys, runpy
sys.argv = ["ivrit_transcribe.py",
            "--input", "$INPUT_ARG",
            "--output", "$REMOTE_DIR/result.json",
            "--model", "$MODEL",
            "--text-output", "$REMOTE_DIR/result.txt",
            "--verbose"]
sys.path.insert(0, "$REMOTE_DIR")
runpy.run_path("$REMOTE_DIR/ivrit_transcribe.py", run_name="__main__")
PY

step "downloading the result"
colab download -s "$SESSION" "$REMOTE_DIR/result.json" "$OUT"
colab download -s "$SESSION" "$REMOTE_DIR/result.txt" "${OUT%.json}.txt" || true

if [[ "$KEEP" -eq 0 ]]; then
  step "stopping the VM"
  colab stop -s "$SESSION"
else
  echo "VM kept alive — reuse it with: $0 -s $SESSION -k <next-file>"
fi

step "done"
python3 - "$OUT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
m = d.get("meta", {})
print(f"  status : {d.get('status')}")
print(f"  device : {m.get('device')} {m.get('gpu','')} ({m.get('computeType','')})")
print(f"  audio  : {m.get('audioSec')}s   wall: {m.get('wallSec')}s   speed: {m.get('rtf')}x realtime")
print(f"  text   : {len(d.get('text',''))} characters -> {sys.argv[1].removesuffix('.json')}.txt")
PY
