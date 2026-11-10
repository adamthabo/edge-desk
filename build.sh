#!/usr/bin/env bash
# Builds three outputs from src/:
#   artifact.html        page body only (what claude.ai wraps in its own skeleton)
#   edge-desk.html       standalone page (open as a file, or host anywhere)
#   edge-desk.worker.js  Cloudflare Worker serving the page at / and relaying Kalshi's public API
set -euo pipefail
cd "$(dirname "$0")"
node --check src/money.js && node --check src/app5.js && node --check src/core.js && node --check src/plain.js && node --check src/lessons.js && node --check src/app1.js && node --check src/acct.js && node --check src/app2.js && node --check src/app3.js && node --check src/app4.js && node --check src/worker-desk.js && node --check src/worker-engine.js
{
  cat src/head.html
  cat src/body.html
  echo '<script>'; cat src/money.js; echo '</script>'
  echo '<script>'; cat src/core.js; echo '</script>'
  echo '<script>'; cat src/lessons.js; echo '</script>'
  echo '<script>'; cat src/plain.js; echo '</script>'
  echo '<script>'; cat src/app1.js; echo '</script>'
  echo '<script>'; cat src/acct.js; echo '</script>'
  echo '<script>'; cat src/app2.js; echo '</script>'
  echo '<script>'; cat src/app3.js; echo '</script>'
  echo '<script>'; cat src/app4.js; echo '</script>'
  echo '<script>'; cat src/app5.js; echo '</script>'
} > artifact.html
{
  printf '%s' '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>'
  cat artifact.html
  printf '%s' '</body></html>'
} > edge-desk.html
node -e '
const fs = require("fs");
const page = fs.readFileSync("edge-desk.html", "utf8");
const tpl = fs.readFileSync("src/worker.js", "utf8").replace("__MONEY__", () => fs.readFileSync("src/money.js", "utf8")).replace("__DESK__", () => fs.readFileSync("src/worker-desk.js", "utf8")).replace("__ENGINE__", () => fs.readFileSync("src/worker-engine.js", "utf8"));
fs.writeFileSync("edge-desk.worker.js", tpl.replace("__PAGE__", () => JSON.stringify(page)));
'
node --check edge-desk.worker.js
# Dependency-free tests gate every build (Cloudflare runs this script before deploying; a failure keeps the last good version live).
if [ "${SKIP_TESTS:-}" != "1" ]; then node --test 'test/unit/*.test.mjs' > /tmp/edge-desk-unit.log 2>&1 || { tail -40 /tmp/edge-desk-unit.log; echo "unit tests failed; build aborted"; exit 1; }; fi
echo "built artifact.html, edge-desk.html ($(wc -c < edge-desk.html) bytes), edge-desk.worker.js ($(wc -c < edge-desk.worker.js) bytes)$( [ "${SKIP_TESTS:-}" = "1" ] && echo " (tests skipped)" || echo "; unit tests passed" )"
