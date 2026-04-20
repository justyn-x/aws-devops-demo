import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvConfig } from '../config/env-config';

export interface GrafanaStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly prefix: string;
  readonly imageTag: string;
  readonly ssmBase: string;
}

export class GrafanaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GrafanaStackProps) {
    super(scope, id, props);

    const grafanaPort = 8080;

    // --- Resolve infra resources from SSM (same pattern as ServiceStack) ---
    const vpcId = ssm.StringParameter.valueFromLookup(this, `${props.ssmBase}/vpc/id`);
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId });

    const albSgId = ssm.StringParameter.valueForStringParameter(this, `${props.ssmBase}/vpc/alb-sg-id`);
    const albSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'AlbSg', albSgId);

    const ecsSgId = ssm.StringParameter.valueForStringParameter(this, `${props.ssmBase}/vpc/ecs-sg-id`);
    const ecsSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'EcsSg', ecsSgId);

    const clusterName = ssm.StringParameter.valueForStringParameter(this, `${props.ssmBase}/ecs/cluster-name`);
    const ecsCluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', {
      clusterName, vpc, securityGroups: [],
    });

    const httpApiId = ssm.StringParameter.valueForStringParameter(this, `${props.ssmBase}/apigw/http-api-id`);
    const vpcLinkId = ssm.StringParameter.valueForStringParameter(this, `${props.ssmBase}/apigw/vpc-link-id`);

    // --- ECR (created by CI) ---
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
        GF_SERVER_HTTP_PORT: '8080',
        GF_SERVER_ROOT_URL: '%(protocol)s://%(domain)s/grafana/',
        GF_SERVER_SERVE_FROM_SUB_PATH: 'true',
        GF_AUTH_ANONYMOUS_ENABLED: 'false',
        GF_INSTALL_PLUGINS: 'grafana-x-ray-datasource',
        GF_PLUGIN_ADMIN_ENABLED: 'false',
        PREFIX: props.prefix,
        REGION: this.region,
        AWS_REGION: this.region,
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:8080/grafana/api/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 5,
        startPeriod: cdk.Duration.seconds(120),
      },
    });

    container.addPortMappings({ containerPort: grafanaPort, protocol: ecs.Protocol.TCP });

    // --- Fargate Service (reuse ECS SG — ALB SG already allows egress to ECS SG on 8080) ---
    const service = new ecs.FargateService(this, 'Service', {
      serviceName: `${props.prefix}-grafana`,
      cluster: ecsCluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [ecsSg],
      vpcSubnets: { subnetGroupName: 'App' },
      assignPublicIp: false,
      circuitBreaker: { enable: true, rollback: true },
    });

    // --- Internal ALB (listen on 8080 to match ALB SG rules, forward to container 3000) ---
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc, internetFacing: false, securityGroup: albSg,
      vpcSubnets: { subnetGroupName: 'App' },
    });

    const listener = alb.addListener('Listener', {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
    });

    listener.addTargets('GrafanaTarget', {
      port: grafanaPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service.loadBalancerTarget({
        containerName: 'grafana', containerPort: grafanaPort,
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
      apiId: httpApiId,
      integrationType: 'HTTP_PROXY',
      integrationMethod: 'ANY',
      connectionType: 'VPC_LINK',
      connectionId: vpcLinkId,
      integrationUri: listener.listenerArn,
      payloadFormatVersion: '1.0',
      requestParameters: { 'overwrite:path': '$request.path' },
    });

    new apigatewayv2.CfnRoute(this, 'GrafanaRoute', {
      apiId: httpApiId,
      routeKey: 'ANY /grafana/{proxy+}',
      target: `integrations/${integration.ref}`,
    });

    new cdk.CfnOutput(this, 'GrafanaUrl', {
      value: `https://${httpApiId}.execute-api.${this.region}.amazonaws.com/grafana/`,
      description: 'Grafana URL (login: admin / awsdemo2026)',
    });
  }
}
