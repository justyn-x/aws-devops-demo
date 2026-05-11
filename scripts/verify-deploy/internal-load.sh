#!/bin/sh
# internal-load.sh — sample x-service-revision gRPC trailer from real
# Service Connect (Envoy) traffic during a LINEAR deployment.
#
# Run this INSIDE a todo-service container via ECS Exec; grpcurl is baked into
# the todo-service image (deploy/todo-service.Dockerfile). The container's
# Envoy sidecar intercepts traffic to todo-service-grpc:50051 and routes by
# weighted upstream — so calling that alias from inside any task in the
# Service Connect namespace exercises the same code path as user-service.
#
# Usage:
#   /internal-load.sh [duration_minutes]   # default 25
#
# Each call prints one line on stdout:
#       <unix_ts_seconds> <revision>
set -eu

DURATION_MIN="${1:-25}"
TARGET="todo-service-grpc:50051"
METHOD="todo.v1.TodoService/ListTodos"
PAYLOAD='{"page_size":1}'

end_ts=$(( $(date +%s) + DURATION_MIN * 60 ))
echo "[internal-load] sampling $TARGET for ${DURATION_MIN}min" 1>&2

while [ "$(date +%s)" -lt "$end_ts" ]; do
  i=0
  while [ "$i" -lt 50 ]; do
    # -v dumps response headers/trailers; we filter for the revision trailer.
    # Errors are swallowed (some tasks may temporarily 500 while green warms up,
    # which is itself useful signal in the analyze.py output if revision is missing).
    grpcurl -plaintext -v -d "$PAYLOAD" "$TARGET" "$METHOD" 2>&1 \
      | awk -v ts="$(date +%s)" '/x-service-revision:/ {gsub(/[\r\n]/, "", $2); print ts, $2; exit}' &
    i=$((i + 1))
  done
  wait
  sleep 1
done

echo "[internal-load] done." 1>&2
