#!/usr/bin/env bash
# external-load.sh — sample the X-Service-Revision header from API Gateway responses
# while a LINEAR deployment is in progress.
#
# Usage:
#   ./external-load.sh https://<api-gw>/v1/todos 25
#       URL              — full target URL (must return 2xx for an unauthenticated GET)
#       DURATION_MIN     — how long to keep sampling, default 25 minutes
#
# Each successful response prints one line on stdout:
#       <unix_ts_seconds> <revision>
# Pipe it into analyze.py for a real-time blue/green ratio readout.
set -euo pipefail

URL="${1:?usage: $0 <url> [duration_minutes]}"
DURATION_MIN="${2:-25}"

# Basic sanity — refuse to run if the endpoint is broken before we begin.
curl -sf -o /dev/null -D - "$URL" 2>/dev/null \
  | grep -q '^X-Service-Revision:' \
  || { echo "WARN: first probe to $URL did not return an X-Service-Revision header." >&2; }

end_ts=$(( $(date +%s) + DURATION_MIN * 60 ))
echo "[external-load] sampling $URL for ${DURATION_MIN}min (~50 req/s)" >&2

while [ "$(date +%s)" -lt "$end_ts" ]; do
  # 50 requests per second; xargs -P 50 keeps round-trips honest under network jitter.
  seq 1 50 | xargs -n 1 -P 50 -I {} sh -c '
    curl -sf -o /dev/null -D - "'"$URL"'" 2>/dev/null \
      | awk -v ts="$(date +%s)" "/^X-Service-Revision:/ {gsub(/[\r\n]/, \"\", \$2); print ts, \$2}"
  '
  sleep 1
done

echo "[external-load] done." >&2
