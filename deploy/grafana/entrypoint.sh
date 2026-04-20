#!/bin/sh
set -e

# Replace ${PREFIX} and ${REGION} in provisioning files at startup
for f in /etc/grafana/provisioning/datasources/*.yaml; do
  envsubst '${PREFIX} ${REGION}' < "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done

for f in /var/lib/grafana/dashboards/*.json; do
  envsubst '${PREFIX} ${REGION}' < "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done

# Start Grafana
exec /run.sh "$@"
