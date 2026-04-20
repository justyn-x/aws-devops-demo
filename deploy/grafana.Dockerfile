FROM grafana/grafana-oss:11.6.0

USER root
RUN apk add --no-cache gettext

# Copy templates (with ${PREFIX} and ${REGION} placeholders)
COPY deploy/grafana/provisioning/datasources/ /etc/grafana/provisioning/datasources/
COPY deploy/grafana/provisioning/dashboards/ /etc/grafana/provisioning/dashboards/
COPY deploy/grafana/dashboards/ /var/lib/grafana/dashboards/
COPY deploy/grafana/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER grafana
ENTRYPOINT ["/entrypoint.sh"]
