# Project Eagleice - Folder Structure

This repository is containerized for a continuous-running deployment on Hugging Face Spaces (Docker tier). 

```text
eagleice/
├── Dockerfile           # Builds the Python 3.11 environment and exposes port 7860
├── main.py              # Core FastHTML application, backend routing, and UI rendering
├── requirements.txt     # Python dependencies (python-fasthtml, httpx, polars)
├── .gitignore           # Ignored files (venv, __pycache__, local DBs)
├── claude.md            # AI Assistant context and system prompt
├── static/              # (Optional) Frontend assets
│   ├── style.css        # Custom overrides for the Globe.gl or Leaflet UI
│   └── custom.js        # Minimal vanilla JS for the map canvas
└── data/                # (Optional) Local storage for development
    └── telemetry.db     # SQLite/Polars storage for historical orbit data