#!/usr/bin/env bash
set -euo pipefail

API=${API:-http://localhost:8080}

echo "==> Inserting sample telemetry"
curl -sS -X POST "$API/telemetry/sample" -H 'Content-Type: application/json' -d '{}' 

echo "\n==> Running a hardening cycle"
curl -sS -X POST "$API/cycle/run" -H 'Content-Type: application/json' -d '{"environment":"sandbox"}'

echo "\n==> Timeline (latest 10)"
curl -sS "$API/timeline?limit=10"
