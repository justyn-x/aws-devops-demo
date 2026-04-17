import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvConfig } from '../config/env-config';

export interface GrafanaStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly prefix: string;
  readonly vpc: ec2.IVpc;
  readonly appSubnets: ec2.SubnetSelection;
  readonly ecsCluster: ecs.ICluster;
  readonly albSg: ec2.ISecurityGroup;
  readonly httpApiId: string;
  readonly vpcLinkId: string;
  readonly imageTag: string;
}

export class GrafanaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GrafanaStackProps) {
    super(scope, id, props);

    if (!props.config.enableGrafana) return;

    const grafanaPort = 3000;

    // --- ECR repo (created by CI, like other services) ---
    const repo = ecr.Repository.fromRepositoryName(this, 'Repo', 'awsdemo/grafana');
    const image = ecs.ContainerImage.fromEcrRepository(repo, props.imageTag);

    // --- Log Group ---
    const logGroup = new logs.LogGroup(this, 'GrafanaLogs', {
      logGroupName: `/ecs/${props.prefix}/grafana`,
      retention: props.config.logRetentionDays,
      removalPolicy: props.config.removalPolicy,
    });

    // --- Task Definition ---
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: `${props.prefix}-grafana`,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    taskDef.addToExecutionRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
      ],
      resources: ['*'],
    }));

    // IAM: Grafana reads CloudWatch, Logs, X-Ray
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
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

    // --- Container ---
    const container = taskDef.addContainer('grafana', {
      image,
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'grafana', logGroup }),
      environment: {
        GF_SECURITY_ADMIN_USER: 'admin',
        GF_SECURITY_ADMIN_PASSWORD: 'awsdemo2026',
        GF_SERVER_ROOT_URL: '%(protocol)s://%(domain)s/grafana/',
        GF_SERVER_SERVE_FROM_SUB_PATH: 'true',
        GF_AUTH_ANONYMOUS_ENABLED: 'false',
        AWS_REGION: this.region,
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:3000/grafana/api/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    container.addPortMappings({ containerPort: grafanaPort, protocol: ecs.Protocol.TCP });

    // --- Security Group ---
    const grafanaSg = new ec2.SecurityGroup(this, 'GrafanaSg', {
      vpc: props.vpc,
      description: 'Grafana ECS service',
      allowAllOutbound: true,
    });
    grafanaSg.addIngressRule(props.albSg, ec2.Port.tcp(grafanaPort), 'ALB to Grafana');

    // --- Fargate Service ---
    const service = new ecs.FargateService(this, 'Service', {
      serviceName: `${props.prefix}-grafana`,
      cluster: props.ecsCluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [grafanaSg],
      vpcSubnets: props.appSubnets,
      assignPublicIp: false,
      circuitBreaker: { enable: true, rollback: true },
    });

    // --- Internal ALB ---
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: props.albSg,
      vpcSubnets: props.appSubnets,
    });

    const listener = alb.addListener('Listener', {
      port: grafanaPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
    });

    listener.addTargets('GrafanaTarget', {
      port: grafanaPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service.loadBalancerTarget({
        containerName: 'grafana',
        containerPort: grafanaPort,
      })],
      healthCheck: {
        path: '/grafana/api/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // --- API Gateway Route: /grafana/* → ALB ---
    const integration = new apigatewayv2.CfnIntegration(this, 'ApiIntegration', {
      apiId: props.httpApiId,
      integrationType: 'HTTP_PROXY',
      integrationMethod: 'ANY',
      connectionType: 'VPC_LINK',
      connectionId: props.vpcLinkId,
      integrationUri: listener.listenerArn,
      payloadFormatVersion: '1.0',
      requestParameters: { 'overwrite:path': '$request.path' },
    });

    new apigatewayv2.CfnRoute(this, 'GrafanaRoute', {
      apiId: props.httpApiId,
      routeKey: 'ANY /grafana/{proxy+}',
      target: `integrations/${integration.ref}`,
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'GrafanaUrl', {
      value: `https://${props.httpApiId}.execute-api.${this.region}.amazonaws.com/grafana/`,
      description: 'Grafana URL (login: admin / awsdemo2026)',
    });
  }
}
