#!/bin/bash
# Double-click this file to launch the VCE Organiser.
# It starts a tiny local web server and opens the app in your browser.
cd "$(dirname "$0")" || exit 1
PORT=8123
echo "Starting VCE Organiser at http://localhost:$PORT ..."
# Open the browser once the server is up.
( sleep 1; open "http://localhost:$PORT/index.html" ) &
# Serve the current folder. Press Ctrl+C in this window to stop.
python3 -m http.server "$PORT"
