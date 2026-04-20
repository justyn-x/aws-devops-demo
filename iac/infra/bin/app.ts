#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { envConfigs } from '../lib/config/env-config';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { ClusterStack } from '../lib/stacks/cluster-stack';
import { EdgeStack } from '../lib/stacks/edge-stack';
import { OpsStack } from '../lib/stacks/ops-stack';
import { OutputsStack } from '../lib/stacks/outputs-stack';

const app = new cdk.App();
const envName = app.node.tryGetContext('env') || 'dev';
const projectName = app.node.tryGetContext('project') || 'awsdemo';
const config = envConfigs[envName];

if (!config) {
  throw new Error(`Unknown environment: ${envName}. Valid: ${Object.keys(envConfigs).join(', ')}`);
}

const env = {
  account: app.node.tryGetContext('account') || process.env.CDK_DEFAULT_ACCOUNT,
  region: app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION,
};
const prefix = `${projectName}-${envName}`;

const network = new NetworkStack(app, `${prefix}-Network`, { env, config, prefix });
const data = new DataStack(app, `${prefix}-Data`, {
  env, config, prefix,
  vpc: network.vpc,
  dataSubnets: network.dataSubnets,
  docdbSg: network.docdbSg,
});
const cluster = new ClusterStack(app, `${prefix}-Cluster`, {
  env, config, prefix,
  vpc: network.vpc,
});
const edge = new EdgeStack(app, `${prefix}-Edge`, {
  env, config, prefix,
  vpc: network.vpc,
  appSubnets: network.appSubnets,
  vpcLinkSg: network.vpcLinkSg,
});
const ops = new OpsStack(app, `${prefix}-Ops`, {
  env, config, prefix,
  httpApiId: edge.httpApiId,
  docdbClusterIdentifier: data.dbClusterIdentifier,
});

data.addDependency(network);
cluster.addDependency(network);
edge.addDependency(network);
ops.addDependency(edge);
ops.addDependency(data);

// --- Outputs Stack: writes infra values to SSM for service app ---
const outputs = new OutputsStack(app, `${prefix}-Outputs`, {
  env, prefix,
  vpcId: network.vpc.vpcId,
  ecsSgId: network.ecsSg.securityGroupId,
  albSgId: network.albSg.securityGroupId,
  clusterName: (cluster.ecsCluster as cdk.aws_ecs.Cluster).clusterName,
  namespaceArn: cluster.namespaceArn,
  dbHost: data.dbHost,
  dbSecretArn: data.dbSecretArn,
  httpApiId: edge.httpApiId,
  vpcLinkId: edge.vpcLinkId,
});
outputs.addDependency(network);
outputs.addDependency(data);
outputs.addDependency(cluster);
outputs.addDependency(edge);

app.synth();
