#!/usr/bin/env bash
# Builds three outputs from src/:
#   artifact.html        page body only (what claude.ai wraps in its own skeleton)
#   edge-desk.html       standalone page (open as a file, or host anywhere)
#   edge-desk.worker.js  Cloudflare Worker serving the page at / and relaying Kalshi's public API
set -euo pipefail
cd "$(dirname "$0")"
node --check src/core.js && node --check src/plain.js && node --check src/app1.js && node --check src/app2.js
{
  cat src/head.html
  cat src/body.html
  echo '<script>'; cat src/core.js; echo '</script>'
  echo '<script>'; cat src/plain.js; echo '</script>'
  echo '<script>'; cat src/app1.js; echo '</script>'
  echo '<script>'; cat src/app2.js; echo '</script>'
} > artifact.html
{
  printf '%s' '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>'
  cat artifact.html
  printf '%s' '</body></html>'
} > edge-desk.html
node -e '
const fs = require("fs");
const page = fs.readFileSync("edge-desk.html", "utf8");
const tpl = fs.readFileSync("src/worker.js", "utf8");
fs.writeFileSync("edge-desk.worker.js", tpl.replace("__PAGE__", () => JSON.stringify(page)));
'
node --check edge-desk.worker.js
echo "built artifact.html, edge-desk.html ($(wc -c < edge-desk.html) bytes), edge-desk.worker.js ($(wc -c < edge-desk.worker.js) bytes)"
