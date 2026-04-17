import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as grafana from 'aws-cdk-lib/aws-grafana';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';
import { EnvConfig } from '../config/env-config';

export interface GrafanaStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly prefix: string;
}

export class GrafanaStack extends cdk.Stack {
  public readonly workspaceEndpoint: string;

  constructor(scope: Construct, id: string, props: GrafanaStackProps) {
    super(scope, id, props);

    if (!props.config.enableGrafana) return;

    // --- IAM Role for Grafana to read CloudWatch + X-Ray ---
    const workspaceRole = new iam.Role(this, 'WorkspaceRole', {
      roleName: `${props.prefix}-grafana-role`,
      assumedBy: new iam.ServicePrincipal('grafana.amazonaws.com'),
    });

    workspaceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cloudwatch:DescribeAlarmsForMetric',
        'cloudwatch:DescribeAlarmHistory',
        'cloudwatch:DescribeAlarms',
        'cloudwatch:ListMetrics',
        'cloudwatch:GetMetricData',
        'cloudwatch:GetInsightRuleReport',
        'ec2:DescribeTags',
        'ec2:DescribeInstances',
        'ec2:DescribeRegions',
        'tag:GetResources',
        'logs:DescribeLogGroups',
        'logs:GetLogGroupFields',
        'logs:StartQuery',
        'logs:StopQuery',
        'logs:GetQueryResults',
        'logs:GetLogEvents',
        'xray:GetTraceSummaries',
        'xray:BatchGetTraces',
        'xray:GetServiceGraph',
        'xray:GetTraceGraph',
        'xray:GetInsightSummaries',
        'xray:GetGroups',
        'xray:GetGroup',
        'xray:GetTimeSeriesServiceStatistics',
      ],
      resources: ['*'],
    }));

    // --- Managed Grafana Workspace ---
    const workspace = new grafana.CfnWorkspace(this, 'Workspace', {
      accountAccessType: 'CURRENT_ACCOUNT',
      authenticationProviders: ['AWS_SSO'],
      permissionType: 'CUSTOMER_MANAGED',
      dataSources: ['CLOUDWATCH', 'XRAY'],
      name: `${props.prefix}-grafana`,
      description: `${props.prefix} observability workspace`,
      grafanaVersion: '10.4',
      roleArn: workspaceRole.roleArn,
    });

    this.workspaceEndpoint = workspace.attrEndpoint;

    // --- Lambda for dashboard provisioning ---
    const logGroup = new logs.LogGroup(this, 'ProvisionLogGroup', {
      logGroupName: `/aws/lambda/${props.prefix}-grafana-provision`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.config.removalPolicy,
    });

    const provisionFn = new lambda.Function(this, 'ProvisionDashboards', {
      functionName: `${props.prefix}-grafana-provision`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../grafana')),
      timeout: cdk.Duration.seconds(60),
      environment: {
        WORKSPACE_ID: workspace.attrId,
        REGION: this.region,
        PREFIX: props.prefix,
      },
      logGroup,
    });

    provisionFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'grafana:CreateWorkspaceApiKey',
        'grafana:DeleteWorkspaceApiKey',
      ],
      resources: [workspace.attrGrafanaVersion ? `arn:aws:grafana:${this.region}:${this.account}:/workspaces/${workspace.attrId}` : '*'],
    }));

    // --- Trigger provisioning on every deploy ---
    const provider = new cr.Provider(this, 'ProvisionProvider', {
      onEventHandler: provisionFn,
    });

    new cdk.CustomResource(this, 'ProvisionDashboardsCR', {
      serviceToken: provider.serviceToken,
      properties: {
        // Change this value to force re-provisioning on deploy
        version: Date.now().toString(),
      },
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'GrafanaUrl', {
      value: `https://${workspace.attrEndpoint}`,
      description: 'Grafana workspace URL',
    });

    new cdk.CfnOutput(this, 'GrafanaWorkspaceId', {
      value: workspace.attrId,
      description: 'Grafana workspace ID',
    });
  }
}
