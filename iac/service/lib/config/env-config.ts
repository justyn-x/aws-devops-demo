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

  // Monitoring
  readonly enableAlarms: boolean;

  // Deployment
  // Services listed here use ECS-native LINEAR strategy with weighted ALB target groups.
  // Other services keep ROLLING (default). Only set for environments where LINEAR is desired.
  readonly linearServices?: readonly string[];
  readonly linearStepPercent?: number;
  readonly linearStepBakeMinutes?: number;
  readonly linearDeploymentBakeMinutes?: number;

  // Common
  readonly removalPolicy: cdk.RemovalPolicy;
  readonly logRetentionDays: logs.RetentionDays;
}

export const envConfigs: Record<string, EnvConfig> = {
  dev: {
    envName: 'dev',
    ecsCpu: 256,
    ecsMemory: 512,
    // Bumped from 1 to 5 so LINEAR step shifts (20% per step) actually exercise
    // request-level distribution. With desiredCount=1 the service has only
    // 2 tasks total during a deploy (1 blue + 1 green) which makes Service
    // Connect end always look 50/50 regardless of LINEAR config.
    ecsDesiredCount: 5,
    ecsMinCapacity: 5,
    ecsMaxCapacity: 10,
    cpuTargetUtilization: 60,
    enableAlarms: true,
    linearServices: ['todo-service'],
    linearStepPercent: 20,
    linearStepBakeMinutes: 2,
    linearDeploymentBakeMinutes: 5,
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
    enableAlarms: true,
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
    enableAlarms: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    logRetentionDays: logs.RetentionDays.ONE_WEEK,
  },
};
