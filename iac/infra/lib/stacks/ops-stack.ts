import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { EnvConfig } from '../config/env-config';

export interface OpsStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly prefix: string;
  readonly httpApiId: string;
  readonly docdbClusterIdentifier: string;
}

export class OpsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);

    const { config } = props;

    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${props.prefix}-alarms`,
    });

    if (!config.enableAlarms) return;

    const alarmAction = new cw_actions.SnsAction(alarmTopic);

    // --- API Gateway Alarms ---
    const api5xx = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway', metricName: '5xx',
      dimensionsMap: { ApiId: props.httpApiId },
      statistic: 'Sum', period: cdk.Duration.minutes(5),
    });

    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      metric: api5xx, threshold: 10, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: `${props.prefix} API Gateway 5xx errors > 10 in 5min`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    const apiLatency = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway', metricName: 'Latency',
      dimensionsMap: { ApiId: props.httpApiId },
      statistic: 'p99', period: cdk.Duration.minutes(5),
    });

    new cloudwatch.Alarm(this, 'ApiLatencyAlarm', {
      metric: apiLatency, threshold: 2000, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: `${props.prefix} API p99 latency > 2000ms for 5min`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // --- DocumentDB Metrics ---
    const docdbDims = { DBClusterIdentifier: props.docdbClusterIdentifier };

    const docdbCpu = new cloudwatch.Metric({
      namespace: 'AWS/DocDB', metricName: 'CPUUtilization',
      dimensionsMap: docdbDims, statistic: 'Average', period: cdk.Duration.minutes(1),
    });
    const docdbMemory = new cloudwatch.Metric({
      namespace: 'AWS/DocDB', metricName: 'FreeableMemory',
      dimensionsMap: docdbDims, statistic: 'Average', period: cdk.Duration.minutes(1),
    });
    const docdbConnections = new cloudwatch.Metric({
      namespace: 'AWS/DocDB', metricName: 'DatabaseConnections',
      dimensionsMap: docdbDims, statistic: 'Sum', period: cdk.Duration.minutes(1),
    });
    const docdbReadLatency = new cloudwatch.Metric({
      namespace: 'AWS/DocDB', metricName: 'ReadLatency',
      dimensionsMap: docdbDims, statistic: 'Average', period: cdk.Duration.minutes(1),
    });
    const docdbWriteLatency = new cloudwatch.Metric({
      namespace: 'AWS/DocDB', metricName: 'WriteLatency',
      dimensionsMap: docdbDims, statistic: 'Average', period: cdk.Duration.minutes(1),
    });

    // --- DocumentDB Alarms ---
    new cloudwatch.Alarm(this, 'DocDbCpuAlarm', {
      metric: docdbCpu.with({ period: cdk.Duration.minutes(5) }),
      threshold: 80, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: `${props.prefix} DocumentDB CPU > 80% for 5min`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    new cloudwatch.Alarm(this, 'DocDbMemoryAlarm', {
      metric: docdbMemory.with({ period: cdk.Duration.minutes(5) }),
      threshold: 256 * 1024 * 1024, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      alarmDescription: `${props.prefix} DocumentDB FreeableMemory < 256MB for 5min`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    new cloudwatch.Alarm(this, 'DocDbConnectionsAlarm', {
      metric: docdbConnections.with({ period: cdk.Duration.minutes(5) }),
      threshold: config.docdbConnectionAlarmThreshold, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: `${props.prefix} DocumentDB connections > ${config.docdbConnectionAlarmThreshold} for 5min`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(alarmAction);

    // --- Dashboard ---
    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.prefix}`,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'API Gateway Requests', width: 8,
            left: [new cloudwatch.Metric({ namespace: 'AWS/ApiGateway', metricName: 'Count', dimensionsMap: { ApiId: props.httpApiId }, statistic: 'Sum', period: cdk.Duration.minutes(1) })],
          }),
          new cloudwatch.GraphWidget({
            title: 'API Gateway Errors', width: 8,
            left: [
              new cloudwatch.Metric({ namespace: 'AWS/ApiGateway', metricName: '4xx', dimensionsMap: { ApiId: props.httpApiId }, statistic: 'Sum', period: cdk.Duration.minutes(1) }),
              new cloudwatch.Metric({ namespace: 'AWS/ApiGateway', metricName: '5xx', dimensionsMap: { ApiId: props.httpApiId }, statistic: 'Sum', period: cdk.Duration.minutes(1) }),
            ],
          }),
          new cloudwatch.GraphWidget({
            title: 'API Gateway Latency (p99)', width: 8,
            left: [apiLatency],
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'DocumentDB CPU (%)', width: 6,
            left: [docdbCpu],
          }),
          new cloudwatch.GraphWidget({
            title: 'DocumentDB FreeableMemory', width: 6,
            left: [docdbMemory],
          }),
          new cloudwatch.GraphWidget({
            title: 'DocumentDB Connections', width: 6,
            left: [docdbConnections],
          }),
          new cloudwatch.GraphWidget({
            title: 'DocumentDB Latency', width: 6,
            left: [docdbReadLatency, docdbWriteLatency],
          }),
        ],
      ],
    });
  }
}
