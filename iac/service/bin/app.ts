#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { envConfigs } from '../lib/config/env-config';
import { serviceConfigs } from '../lib/config/service-configs';
import { ServiceStack } from '../lib/stacks/service-stack';

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
const ssmBase = `/projects/${prefix}/infra`;

for (const [svcName, svcConfig] of Object.entries(serviceConfigs)) {
  const imageTag = app.node.tryGetContext(`tag:${svcName}`);
  if (!imageTag) continue;

  new ServiceStack(app, `${prefix}-${svcName}`, {
    env, config, prefix,
    serviceConfig: svcConfig,
    imageTag,
    ssmBase,
  });
}

app.synth();
