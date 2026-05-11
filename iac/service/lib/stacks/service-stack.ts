import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvConfig } from '../config/env-config';
import { ServiceConfig } from '../config/service-configs';

export interface ServiceStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly prefix: string;
  readonly serviceConfig: ServiceConfig;
  readonly imageTag: string;
  readonly ssmBase: string;
}

export class ServiceStack extends cdk.Stack {
  public readonly ecsService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ServiceStackProps) {
    super(scope, id, props);

    const { config, serviceConfig: svc } = props;
    const isLinear = (config.linearServices ?? []).includes(svc.serviceName);

    // --- Resolve infra resources ---
    const vpcId = ssm.StringParameter.valueFromLookup(this, `${props.ssmBase}/vpc/id`);
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId });

    const ecsSgId = ssm.StringParameter.valueForStringParameter(this, `${props.ssmBase}/vpc/ecs-sg-id`);
    const ecsSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'EcsSg', ecsSgId);

    const albSgId = ssm.StringParameter.valueForStringParameter(this, `${props.ssmBase}/vpc/alb-sg-id`);
    const albSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'AlbSg', albSgId);

    const clusterName = ssm.StringParameter.valueForStringParameter(this, `${props.ssmBase}/ecs/cluster-name`);
    const ecsCluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', {
      clusterName,
      vpc,
      securityGroups: [],
    });

    const namespaceArn = ssm.StringParameter.valueForStringParameter(this, `${props.ssmBase}/ecs/namespace-arn`);
    const dbHost = ssm.StringParameter.valueForStringParameter(this, `${props.ssmBase}/docdb/host`);
    const dbSecretArn = ssm.StringParameter.valueForStringParameter(this, `${props.ssmBase}/docdb/secret-arn`);
    const httpApiId = ssm.StringParameter.valueForStringParameter(this, `${props.ssmBase}/apigw/http-api-id`);
    const vpcLinkId = ssm.StringParameter.valueForStringParameter(this, `${props.ssmBase}/apigw/vpc-link-id`);

    // --- ECR (created by CI, referenced here) ---
    const repo = ecr.Repository.fromRepositoryName(this, 'Repo', `awsdemo/${svc.serviceName}`);
    const image = ecs.ContainerImage.fromEcrRepository(repo, props.imageTag);

    // --- Log Group ---
    const logGroup = new logs.LogGroup(this, 'ServiceLogs', {
      logGroupName: `/ecs/${props.prefix}/${svc.serviceName}`,
      retention: config.logRetentionDays,
      removalPolicy: config.removalPolicy,
    });

    // --- Internal ALB + Target Groups ---
    // Built before TaskDefinition because LINEAR mode wires `alternateTarget` into TaskDefinition.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'InternalAlb', {
      vpc,
      internetFacing: false,
      securityGroup: albSg,
      vpcSubnets: { subnetGroupName: 'App' },
    });

    const tgHealthCheck = {
      path: '/healthz',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    };

    const primaryTg = new elbv2.ApplicationTargetGroup(this, 'PrimaryTg', {
      vpc,
      port: svc.httpPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: tgHealthCheck,
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    let alternateTg: elbv2.ApplicationTargetGroup | undefined;
    let alternateTarget: ecs.AlternateTarget | undefined;

    if (isLinear) {
      alternateTg = new elbv2.ApplicationTargetGroup(this, 'AlternateTg', {
        vpc,
        port: svc.httpPort,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        healthCheck: tgHealthCheck,
        deregistrationDelay: cdk.Duration.seconds(30),
      });
    }

    // Listener: default action is fixedResponse 404 (no rule match → no route).
    // Production traffic flows through an explicit listener rule (priority 1, path "/*").
    // For LINEAR: rule is weighted forward [primary, alternate].
    // For ROLLING: rule is single-target forward to primary.
    const listener = alb.addListener('HttpListener', {
      port: svc.httpPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'no route',
      }),
    });

    const productionRule = new elbv2.ApplicationListenerRule(this, 'ProductionRule', {
      listener,
      priority: 1,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
      action: isLinear && alternateTg
        ? elbv2.ListenerAction.weightedForward([
            { targetGroup: primaryTg, weight: 100 },
            { targetGroup: alternateTg, weight: 0 },
          ])
        : elbv2.ListenerAction.forward([primaryTg]),
    });

    if (isLinear && alternateTg) {
      alternateTarget = new ecs.AlternateTarget('AlternateTarget', {
        alternateTargetGroup: alternateTg,
        productionListener: ecs.ListenerRuleConfiguration.applicationListenerRule(productionRule),
      });
    }

    // --- Task Definition ---
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: `${props.prefix}-${svc.serviceName}`,
      cpu: config.ecsCpu,
      memoryLimitMiB: config.ecsMemory,
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

    const dbSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'DbSecret', dbSecretArn);

    const environment: Record<string, string> = {
      DOCUMENTDB_HOST: dbHost,
      DOCUMENTDB_DATABASE: svc.databaseName,
      DOCUMENTDB_CA_FILE: '/etc/ssl/certs/global-bundle.pem',
      HTTP_PORT: String(svc.httpPort),
      GRPC_PORT: String(svc.grpcPort),
      OTEL_EXPORTER_OTLP_ENDPOINT: 'localhost:4317',
      OTEL_SERVICE_NAME: svc.serviceName,
      DEPLOYMENT_ENV: config.envName,
      LOG_LEVEL: 'info',
      SERVICE_REVISION: props.imageTag,
      ...svc.envVars,
    };

    const container = taskDef.addContainer(svc.serviceName, {
      image,
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: svc.serviceName,
        logGroup,
      }),
      environment,
      secrets: {
        DOCUMENTDB_USERNAME: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
        DOCUMENTDB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      },
      healthCheck: {
        command: ['CMD-SHELL', `wget -qO- http://localhost:${svc.httpPort}/healthz || exit 1`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      stopTimeout: cdk.Duration.seconds(30),
    });

    container.addPortMappings({
      containerPort: svc.httpPort,
      name: 'http',
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http,
    });

    container.addPortMappings({
      containerPort: svc.grpcPort,
      name: 'grpc',
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.grpc,
    });

    // --- ADOT Collector Sidecar ---
    const adotConfigYaml = [
      'extensions:',
      '  health_check:',
      'receivers:',
      '  otlp:',
      '    protocols:',
      '      grpc:',
      '        endpoint: 0.0.0.0:4317',
      'processors:',
      '  batch:',
      '    timeout: 10s',
      'exporters:',
      '  awsxray:',
      `    region: ${this.region}`,
      '  awsemf:',
      `    region: ${this.region}`,
      `    namespace: AppMetrics/${svc.serviceName}`,
      `    log_group_name: /ecs/${props.prefix}/${svc.serviceName}/metrics`,
      'service:',
      '  extensions: [health_check]',
      '  pipelines:',
      '    traces:',
      '      receivers: [otlp]',
      '      processors: [batch]',
      '      exporters: [awsxray]',
      '    metrics:',
      '      receivers: [otlp]',
      '      processors: [batch]',
      '      exporters: [awsemf]',
    ].join('\n');

    const adotContainer = taskDef.addContainer('adot-collector', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-observability/aws-otel-collector:latest'),
      essential: false,
      memoryLimitMiB: 256,
      cpu: 64,
      environment: {
        AOT_CONFIG_CONTENT: adotConfigYaml,
      },
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'adot',
        logGroup,
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://localhost:13133/ || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    adotContainer.addPortMappings({
      containerPort: 4317,
      protocol: ecs.Protocol.TCP,
    });

    container.addContainerDependencies({
      container: adotContainer,
      condition: ecs.ContainerDependencyCondition.START,
    });

    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
        'xray:GetSamplingRules',
        'xray:GetSamplingTargets',
        'cloudwatch:PutMetricData',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: ['*'],
    }));

    // --- Service Connect ---
    const scServices: ecs.ServiceConnectService[] = [
      {
        portMappingName: 'http',
        dnsName: svc.serviceName,
        discoveryName: svc.serviceName,
        port: svc.httpPort,
      },
      {
        portMappingName: 'grpc',
        dnsName: `${svc.serviceName}-grpc`,
        discoveryName: `${svc.serviceName}-grpc`,
        port: svc.grpcPort,
      },
    ];

    // --- Alarms (must exist before FargateService so we can pass names to deploymentAlarms) ---
    const svcFullName = `${props.prefix}-${svc.serviceName}`;
    const albFullName = alb.loadBalancerFullName;

    const albResponseTime = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB', metricName: 'TargetResponseTime',
      dimensionsMap: { LoadBalancer: albFullName, TargetGroup: primaryTg.targetGroupFullName },
      statistic: 'p99', period: cdk.Duration.minutes(1),
    });
    const alb5xx = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB', metricName: 'HTTPCode_Target_5XX_Count',
      dimensionsMap: { LoadBalancer: albFullName, TargetGroup: primaryTg.targetGroupFullName },
      statistic: 'Sum', period: cdk.Duration.minutes(5),
    });
    const alb4xx = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB', metricName: 'HTTPCode_Target_4XX_Count',
      dimensionsMap: { LoadBalancer: albFullName, TargetGroup: primaryTg.targetGroupFullName },
      statistic: 'Sum', period: cdk.Duration.minutes(1),
    });
    const healthyHosts = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB', metricName: 'HealthyHostCount',
      dimensionsMap: { LoadBalancer: albFullName, TargetGroup: primaryTg.targetGroupFullName },
      statistic: 'Average', period: cdk.Duration.minutes(1),
    });
    const unhealthyHosts = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB', metricName: 'UnHealthyHostCount',
      dimensionsMap: { LoadBalancer: albFullName, TargetGroup: primaryTg.targetGroupFullName },
      statistic: 'Average', period: cdk.Duration.minutes(1),
    });

    let rollbackAlarmNames: string[] = [];
    let alarmAction: cw_actions.SnsAction | undefined;

    if (config.enableAlarms) {
      const alarmTopic = new sns.Topic(this, 'ServiceAlarmTopic', {
        topicName: `${svcFullName}-alarms`,
      });
      alarmAction = new cw_actions.SnsAction(alarmTopic);

      const unhealthyHostAlarm = new cloudwatch.Alarm(this, 'UnhealthyHostAlarm', {
        metric: unhealthyHosts.with({ period: cdk.Duration.minutes(5) }),
        threshold: 0, evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: `${svcFullName} has unhealthy ALB targets`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      unhealthyHostAlarm.addAlarmAction(alarmAction);

      const target5xxAlarm = new cloudwatch.Alarm(this, 'Target5xxAlarm', {
        metric: alb5xx,
        threshold: 5, evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: `${svcFullName} ALB 5xx errors > 5 in 5min`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      target5xxAlarm.addAlarmAction(alarmAction);

      const latencyP99Alarm = new cloudwatch.Alarm(this, 'LatencyP99Alarm', {
        metric: albResponseTime.with({ period: cdk.Duration.minutes(5) }),
        threshold: 1, evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: `${svcFullName} ALB p99 latency > 1s for 15min`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      latencyP99Alarm.addAlarmAction(alarmAction);

      const noRunningTasksAlarm = new cloudwatch.Alarm(this, 'NoRunningTasksAlarm', {
        metric: new cloudwatch.Metric({
          namespace: 'ECS/ContainerInsights', metricName: 'RunningTaskCount',
          dimensionsMap: { ClusterName: clusterName, ServiceName: svcFullName },
          statistic: 'Average', period: cdk.Duration.minutes(1),
        }),
        threshold: 1, evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        alarmDescription: `${svcFullName} has no running tasks`,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      noRunningTasksAlarm.addAlarmAction(alarmAction);

      // Rollback alarms — fire if green tasks are unhealthy / erroring / slow.
      // CPU/Memory alarms (created after FargateService) reflect steady-state load,
      // not deployment health, so they're not in this list.
      rollbackAlarmNames = [
        unhealthyHostAlarm.alarmName,
        target5xxAlarm.alarmName,
        latencyP99Alarm.alarmName,
      ];
    }

    // --- Fargate Service ---
    this.ecsService = new ecs.FargateService(this, 'Service', {
      serviceName: svcFullName,
      cluster: ecsCluster,
      taskDefinition: taskDef,
      desiredCount: config.ecsDesiredCount,
      securityGroups: [ecsSg],
      vpcSubnets: { subnetGroupName: 'App' },
      assignPublicIp: false,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      enableExecuteCommand: true,
      serviceConnectConfiguration: {
        namespace: namespaceArn,
        services: scServices,
      },
      ...(isLinear
        ? {
            deploymentStrategy: ecs.DeploymentStrategy.LINEAR,
            bakeTime: cdk.Duration.minutes(config.linearDeploymentBakeMinutes ?? 5),
            linearConfiguration: {
              stepPercent: config.linearStepPercent ?? 20,
              stepBakeTime: cdk.Duration.minutes(config.linearStepBakeMinutes ?? 2),
            },
            ...(rollbackAlarmNames.length > 0
              ? {
                  deploymentAlarms: {
                    alarmNames: rollbackAlarmNames,
                    behavior: ecs.AlarmBehavior.ROLLBACK_ON_ALARM,
                  },
                }
              : {}),
          }
        : {
            // DeploymentCircuitBreaker is only valid for ROLLING.
            circuitBreaker: { enable: true, rollback: true },
          }),
    });

    // Register the service as a target of the primary TG.
    // For LINEAR, passing `alternateTarget` here causes CDK to populate
    // LoadBalancers[].AdvancedConfiguration on the ECS service (alternate TG ARN,
    // production listener rule ARN, IAM role ARN that ECS uses to flip ALB weights).
    primaryTg.addTarget(this.ecsService.loadBalancerTarget({
      containerName: svc.serviceName,
      containerPort: svc.httpPort,
      ...(alternateTarget ? { alternateTarget } : {}),
    }));

    // CPU/Memory metrics (used by dashboard + extra alarms) — service must exist first.
    const cpuMetric = this.ecsService.metricCpuUtilization({ period: cdk.Duration.minutes(1) });
    const memMetric = this.ecsService.metricMemoryUtilization({ period: cdk.Duration.minutes(1) });

    if (config.enableAlarms && alarmAction) {
      const cpuAlarm = new cloudwatch.Alarm(this, 'CpuAlarm', {
        metric: cpuMetric.with({ period: cdk.Duration.minutes(5), statistic: 'Average' }),
        threshold: 80, evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: `${svcFullName} ECS CPU > 80% for 5min`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      cpuAlarm.addAlarmAction(alarmAction);

      const memoryAlarm = new cloudwatch.Alarm(this, 'MemoryAlarm', {
        metric: memMetric.with({ period: cdk.Duration.minutes(5), statistic: 'Average' }),
        threshold: 80, evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: `${svcFullName} ECS Memory > 80% for 5min`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      memoryAlarm.addAlarmAction(alarmAction);
    }

    // --- API Gateway Routes ---
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

    for (const [i, routeKey] of svc.routeKeys.entries()) {
      new apigatewayv2.CfnRoute(this, `ApiRoute${i}`, {
        apiId: httpApiId,
        routeKey,
        target: `integrations/${integration.ref}`,
      });
    }

    // --- Auto Scaling ---
    const scaling = this.ecsService.autoScaleTaskCount({
      minCapacity: config.ecsMinCapacity,
      maxCapacity: config.ecsMaxCapacity,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: config.cpuTargetUtilization,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // --- Dashboard ---
    new cloudwatch.Dashboard(this, 'ServiceDashboard', {
      dashboardName: svcFullName,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'ECS CPU Utilization (%)', width: 8,
            left: [cpuMetric],
          }),
          new cloudwatch.GraphWidget({
            title: 'ECS Memory Utilization (%)', width: 8,
            left: [memMetric],
          }),
          new cloudwatch.SingleValueWidget({
            title: 'Running Tasks', width: 8,
            metrics: [new cloudwatch.Metric({
              namespace: 'ECS/ContainerInsights', metricName: 'RunningTaskCount',
              dimensionsMap: { ClusterName: clusterName, ServiceName: svcFullName },
              statistic: 'Average', period: cdk.Duration.minutes(1),
            })],
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'ALB Response Time (p99)', width: 8,
            left: [albResponseTime],
          }),
          new cloudwatch.GraphWidget({
            title: 'ALB Error Counts', width: 8,
            left: [alb5xx, alb4xx],
          }),
          new cloudwatch.GraphWidget({
            title: 'ALB Host Health', width: 8,
            left: [healthyHosts, unhealthyHosts],
          }),
        ],
      ],
    });
  }
}
