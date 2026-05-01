# Vusion SVG Validator

A browser-based tool for validating SVG floor plan files against the Vusion/Pointr geolocation API.

## Starting the App

This is a **static frontend** — no server, no `npm install`, no build step required.

**Option 1 — Open directly in browser:**
```
open tools/vusion-svg-validator/index.html
```

**Option 2 — Serve locally (avoids any browser file:// restrictions):**
```bash
cd tools/vusion-svg-validator
python3 -m http.server 8080
# then open http://localhost:8080
```

## Usage

1. Enter your **API endpoint** and **subscription key** in the sidebar.
2. Select or drop an SVG file to validate.
3. The tool checks the SVG against the geolocation API and reports any issues.
