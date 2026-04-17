FROM grafana/grafana-oss:11.6.0

# Data sources: CloudWatch + X-Ray (auto-configured on startup)
COPY deploy/grafana/provisioning/datasources/ /etc/grafana/provisioning/datasources/

# Dashboard provisioning config
COPY deploy/grafana/provisioning/dashboards/ /etc/grafana/provisioning/dashboards/

# Dashboard JSON files
COPY deploy/grafana/dashboards/ /var/lib/grafana/dashboards/
