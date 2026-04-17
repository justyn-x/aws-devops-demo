const { GrafanaClient, CreateWorkspaceApiKeyCommand, DeleteWorkspaceApiKeyCommand } = require('@aws-sdk/client-grafana');
const https = require('https');
const fs = require('fs');
const path = require('path');

const grafanaClient = new GrafanaClient({ region: process.env.REGION });

exports.handler = async (event) => {
  const workspaceId = process.env.WORKSPACE_ID;
  const prefix = process.env.PREFIX;

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId || 'grafana-dashboards' };
  }

  // 1. Create temporary API key
  const keyName = `provision-${Date.now()}`;
  const createKeyResp = await grafanaClient.send(new CreateWorkspaceApiKeyCommand({
    workspaceId,
    keyName,
    keyRole: 'ADMIN',
    secondsToLive: 300, // 5 minutes
  }));
  const apiKey = createKeyResp.key;

  try {
    // 2. Get workspace endpoint
    const endpoint = await getWorkspaceEndpoint(workspaceId);

    // 3. Configure CloudWatch data source
    await grafanaApi(endpoint, apiKey, 'POST', '/api/datasources', {
      name: 'CloudWatch',
      type: 'cloudwatch',
      access: 'proxy',
      isDefault: true,
      jsonData: {
        authType: 'default',
        defaultRegion: process.env.REGION,
      },
    }).catch(() => {
      // Data source may already exist, try update
      return grafanaApi(endpoint, apiKey, 'PUT', '/api/datasources/uid/cloudwatch', {
        name: 'CloudWatch',
        uid: 'cloudwatch',
        type: 'cloudwatch',
        access: 'proxy',
        isDefault: true,
        jsonData: {
          authType: 'default',
          defaultRegion: process.env.REGION,
        },
      });
    });

    // 4. Configure X-Ray data source
    await grafanaApi(endpoint, apiKey, 'POST', '/api/datasources', {
      name: 'X-Ray',
      type: 'grafana-x-ray-datasource',
      access: 'proxy',
      jsonData: {
        authType: 'default',
        defaultRegion: process.env.REGION,
      },
    }).catch(() => {});

    // 5. Push dashboards
    const dashboardDir = path.join(__dirname, 'dashboards');
    if (fs.existsSync(dashboardDir)) {
      const files = fs.readdirSync(dashboardDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const raw = fs.readFileSync(path.join(dashboardDir, file), 'utf-8');
        const dashboard = JSON.parse(raw.replace(/\$\{PREFIX\}/g, prefix));
        await grafanaApi(endpoint, apiKey, 'POST', '/api/dashboards/db', {
          dashboard: { ...dashboard, id: null },
          overwrite: true,
        });
        console.log(`Provisioned dashboard: ${file}`);
      }
    }
  } finally {
    // 6. Delete temporary API key
    await grafanaClient.send(new DeleteWorkspaceApiKeyCommand({
      workspaceId,
      keyName,
    })).catch(() => {});
  }

  return { PhysicalResourceId: 'grafana-dashboards' };
};

async function getWorkspaceEndpoint(workspaceId) {
  const { DescribeWorkspaceCommand } = require('@aws-sdk/client-grafana');
  const resp = await grafanaClient.send(new DescribeWorkspaceCommand({ workspaceId }));
  return resp.workspace.endpoint;
}

function grafanaApi(endpoint, apiKey, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: endpoint,
      path: apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body || '{}'));
        } else {
          console.warn(`Grafana API ${method} ${apiPath}: ${res.statusCode} ${body}`);
          reject(new Error(`${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
