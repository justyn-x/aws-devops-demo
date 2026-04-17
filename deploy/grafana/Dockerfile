FROM grafana/grafana-oss:11.6.0

# Data sources: CloudWatch + X-Ray (auto-configured on startup)
COPY provisioning/datasources/ /etc/grafana/provisioning/datasources/

# Dashboard provisioning config
COPY provisioning/dashboards/ /etc/grafana/provisioning/dashboards/

# Dashboard JSON files
COPY dashboards/ /var/lib/grafana/dashboards/
