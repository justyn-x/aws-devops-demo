import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface EnvConfig {
  readonly envName: string;

  // Network
  readonly vpcCidr: string;
  readonly maxAzs: number;
  readonly natGateways: number;
  readonly enableVpcEndpoints: boolean;

  // DocumentDB
  readonly docdbInstanceClass: string;
  readonly docdbInstanceCount: number;
  readonly deletionProtection: boolean;

  // Monitoring
  readonly enableAlarms: boolean;

  // Common
  readonly removalPolicy: cdk.RemovalPolicy;
  readonly logRetentionDays: logs.RetentionDays;
}

export const envConfigs: Record<string, EnvConfig> = {
  dev: {
    envName: 'dev',
    vpcCidr: '10.0.0.0/16',
    maxAzs: 2,
    natGateways: 1,
    enableVpcEndpoints: false,
    docdbInstanceClass: 't3.medium',
    docdbInstanceCount: 1,
    deletionProtection: false,
    enableAlarms: true,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    logRetentionDays: logs.RetentionDays.ONE_WEEK,
  },
  staging: {
    envName: 'staging',
    vpcCidr: '10.1.0.0/16',
    maxAzs: 2,
    natGateways: 1,
    enableVpcEndpoints: true,
    docdbInstanceClass: 't3.medium',
    docdbInstanceCount: 1,
    deletionProtection: false,
    enableAlarms: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    logRetentionDays: logs.RetentionDays.ONE_WEEK,
  },
  prod: {
    envName: 'prod',
    vpcCidr: '10.2.0.0/16',
    maxAzs: 2,
    natGateways: 1,
    enableVpcEndpoints: true,
    docdbInstanceClass: 't3.medium',
    docdbInstanceCount: 1,
    deletionProtection: false,
    enableAlarms: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    logRetentionDays: logs.RetentionDays.ONE_WEEK,
  },
};
