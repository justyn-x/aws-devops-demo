import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface EnvConfig {
  readonly envName: string;

  // ECS Service
  readonly ecsCpu: number;
  readonly ecsMemory: number;
  readonly ecsDesiredCount: number;
  readonly ecsMinCapacity: number;
  readonly ecsMaxCapacity: number;
  readonly cpuTargetUtilization: number;

  // Common
  readonly removalPolicy: cdk.RemovalPolicy;
  readonly logRetentionDays: logs.RetentionDays;
}

export const envConfigs: Record<string, EnvConfig> = {
  dev: {
    envName: 'dev',
    ecsCpu: 256,
    ecsMemory: 512,
    ecsDesiredCount: 1,
    ecsMinCapacity: 1,
    ecsMaxCapacity: 2,
    cpuTargetUtilization: 60,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    logRetentionDays: logs.RetentionDays.ONE_WEEK,
  },
  staging: {
    envName: 'staging',
    ecsCpu: 256,
    ecsMemory: 512,
    ecsDesiredCount: 1,
    ecsMinCapacity: 1,
    ecsMaxCapacity: 2,
    cpuTargetUtilization: 60,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    logRetentionDays: logs.RetentionDays.ONE_WEEK,
  },
  prod: {
    envName: 'prod',
    ecsCpu: 256,
    ecsMemory: 512,
    ecsDesiredCount: 1,
    ecsMinCapacity: 1,
    ecsMaxCapacity: 2,
    cpuTargetUtilization: 60,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    logRetentionDays: logs.RetentionDays.ONE_WEEK,
  },
};
