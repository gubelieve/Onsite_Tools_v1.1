#!/usr/bin/env bash
# Onsite Tools v2 - Linux / macOS / Git-Bash launcher
set -e
cd "$(dirname "$0")"

PY=${PYTHON:-python3}
command -v "$PY" >/dev/null 2>&1 || PY=python
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "Python 3.9+ not found. Install it and run again."; exit 1
fi

if [ ! -x ".venv/bin/python" ] && [ ! -x ".venv/Scripts/python.exe" ]; then
  echo "Creating virtual environment..."
  "$PY" -m venv .venv
fi
if [ -x ".venv/bin/python" ]; then VPY=".venv/bin/python"; else VPY=".venv/Scripts/python.exe"; fi

STAMP=".venv/requirements.stamp"
if ! cmp -s requirements.txt "$STAMP"; then
  echo "Installing dependencies (first run can take a few minutes)..."
  "$VPY" -m pip install --disable-pip-version-check -q --upgrade pip >/dev/null 2>&1 || true
  if "$VPY" -m pip install --disable-pip-version-check -r requirements.txt; then
    cp requirements.txt "$STAMP"
  else
    echo "Dependency installation failed - starting anyway."
  fi
fi

exec "$VPY" -m app "$@"
