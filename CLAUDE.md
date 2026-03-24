```markdown
# AI Coding Assistant Context: Project Eagleice

## 1. Project Overview
**Project Name:** Eagleice
**Lead Developer:** Dan Marc Llanes
**Description:** A real-time, lightweight aerospace telemetry viewer. Currently tracking the ISS over a 3D globe, with architectural flexibility to pivot into localized satellite/weather tracking Micro-SaaS applications (specifically for the Philippines).

## 2. Tech Stack & Rules
**You must strictly adhere to this stack. Do not suggest React, Vue, Next.js, WebSockets, or heavy Node backends.**

* **Backend & Routing:** FastHTML (Python).
* **Data Processing:** Polars (for high-speed, in-memory processing of coordinate arrays and telemetry history).
* **API Requests:** `httpx` (Python).
* **Frontend Visuals:** Globe.gl (for 3D tracking) or Leaflet.js (for 2D localized mapping). 
* **Frontend Interactivity:** HTMX (handled natively through FastHTML). 
* **Real-Time Data Flow:** Use standard HTTP Polling (via HTMX `hx-trigger="every Xs"`) or Server-Sent Events (SSE) via FastHTML generators. **Do not use WebSockets.**
* **Deployment & Infra:** Docker container deployed on Hugging Face Spaces. The FastHTML app must bind to `host="0.0.0.0"` and `port=7860`.

## 3. Coding Guidelines
* **Python-Native UI:** Write UI components using FastHTML's Pythonic HTML tags (e.g., `Div()`, `P()`, `Script()`). Do not write raw HTML strings unless absolutely necessary for external library injection.
* **Keep JS Minimal:** Vanilla JavaScript should only be used to initialize and update the Globe.gl/Leaflet canvas. All data fetching and state management belongs in Python.
* **Data Pipelines:** When handling time-series data (like recent coordinates), use Polars DataFrames to maintain the rolling window in memory.

## 4. Current Trajectory
Finalizing the global 3D ISS tracker by integrating Polars to store the last 90 minutes of flight data and draw an orbit trail. 
Next Phase: Adapt this continuous-polling Docker pipeline to pull Himawari-9 satellite data for a locked, 2D Philippine weather tracking dashboard.