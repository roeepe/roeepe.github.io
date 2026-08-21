#!/usr/bin/env python3
"""Generates notebooks/ivrit_transcribe.ipynb from tools/ivrit_transcribe.py.

The notebook is the phone-friendly half of the Colab route: the `colab` CLI
needs a Linux/macOS terminal, which a phone does not have, so the app writes a
copy of this notebook to Drive with the job parameters filled in and opens it in
Colab. Keeping it generated means the notebook and the CLI path can never drift
apart — they run byte-identical transcription code.

    python3 tools/build_notebook.py
"""

import json
import os
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "tools" / "ivrit_transcribe.py"
OUT = ROOT / "notebooks" / "ivrit_transcribe.ipynb"

PARAMS_MARKER = "# --- ivrit-job-params ---"

DEFAULT_PARAMS = f"""{PARAMS_MARKER}
# האפליקציה בנייד מחליפה את התא הזה בפרטי העבודה שלכם.
# אפשר גם לערוך ידנית ולהריץ.
JOB = {{
    "input": "drive:PUT_AUDIO_FILE_ID_HERE",     # או נתיב מקומי אחרי העלאה ידנית
    "output": "drive:PUT_RESULT_FILE_ID_HERE",   # קובץ תוצאה שהאפליקציה יצרה מראש
    "model": "ivrit-ai/whisper-large-v3-turbo-ct2",
    "language": "he",
    "beam_size": 5,
}}
"""


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.splitlines(keepends=True)}


def code(text, **meta):
    return {"cell_type": "code", "execution_count": None, "metadata": meta,
            "outputs": [], "source": text.splitlines(keepends=True)}


def build():
    script = SCRIPT.read_text(encoding="utf-8")

    cells = [
        md(
            "# תמלול עברית עם ivrit-ai על Colab\n"
            "\n"
            "המחברת הזאת מתמללת הקלטה מ-Google Drive עם המשקולות של "
            "[`ivrit-ai/whisper-large-v3-turbo-ct2`](https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ct2) "
            "ומחזירה את התוצאה לאותו קובץ ב-Drive שהאפליקציה בנייד ממתינה לו.\n"
            "\n"
            "**לפני שמריצים:** תפריט `Runtime → Change runtime type → T4 GPU`. "
            "בלי GPU זה עדיין יעבוד, אבל בערך פי עשרה לאט יותר.\n"
            "\n"
            "מריצים `Runtime → Run all` ואפשר לסגור את הטלפון — ההתקדמות נכתבת ל-Drive תוך כדי.\n"
        ),
        code(
            "#@title 1. בדיקת החומרה שהוקצתה\n"
            "!nvidia-smi || echo 'אין GPU — Runtime → Change runtime type → T4 GPU'\n"
        ),
        code(
            "#@title 2. התקנת התלויות (דקה בערך)\n"
            "%pip install -q faster-whisper google-api-python-client google-auth\n"
        ),
        code(DEFAULT_PARAMS, tags=["parameters"]),
        code("#@title 3. כתיבת קוד התמלול לדיסק\n" + f"script = r'''{script}'''\n"
             "open('/content/ivrit_transcribe.py', 'w', encoding='utf-8').write(script)\n"
             "print('ok', len(script), 'bytes')\n"),
        code(
            "#@title 4. הרשאה ל-Drive\n"
            "from google.colab import auth\n"
            "auth.authenticate_user()\n"
            "print('מחובר')\n"
        ),
        code(
            "#@title 5. תמלול\n"
            "import sys\n"
            "sys.argv = [\n"
            "    'ivrit_transcribe.py',\n"
            "    '--input', JOB['input'],\n"
            "    '--output', JOB['output'],\n"
            "    '--model', JOB['model'],\n"
            "    '--language', JOB['language'],\n"
            "    '--beam-size', str(JOB['beam_size']),\n"
            "    '--verbose',\n"
            "]\n"
            "sys.path.insert(0, '/content')\n"
            "import ivrit_transcribe\n"
            "rc = ivrit_transcribe.main(sys.argv[1:])\n"
            "print('exit code:', rc)\n"
        ),
        md(
            "כשהתא האחרון מסיים, האפליקציה בנייד כבר הציגה את התמלול — היא קוראת את "
            "קובץ התוצאה ב-Drive תוך כדי ריצה.\n"
        ),
    ]

    nb = {
        "nbformat": 4, "nbformat_minor": 0,
        "metadata": {
            "colab": {"provenance": [], "gpuType": "T4", "toc_visible": True},
            "kernelspec": {"name": "python3", "display_name": "Python 3"},
            "language_info": {"name": "python"},
            "accelerator": "GPU",
        },
        "cells": cells,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes, {len(cells)} cells)")


if __name__ == "__main__":
    build()
