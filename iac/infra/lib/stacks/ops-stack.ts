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

    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.prefix}`,
      widgets: [[
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
          title: 'API Gateway Latency', width: 8,
          left: [apiLatency],
        }),
      ]],
    });
  }
}
