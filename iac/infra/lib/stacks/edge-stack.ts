import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvConfig } from '../config/env-config';

export interface EdgeStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly prefix: string;
  readonly vpc: ec2.IVpc;
  readonly appSubnets: ec2.SubnetSelection;
  readonly vpcLinkSg: ec2.ISecurityGroup;
}

export class EdgeStack extends cdk.Stack {
  public readonly httpApiId: string;
  public readonly vpcLinkId: string;
  public readonly apiUrl: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const { config } = props;

    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/apigateway/${props.prefix}/api`,
      retention: config.logRetentionDays,
      removalPolicy: config.removalPolicy,
    });

    const appSubnetIds = props.vpc.selectSubnets(props.appSubnets).subnetIds;

    const vpcLink = new apigatewayv2.CfnVpcLink(this, 'VpcLink', {
      name: `${props.prefix}-vpclink`,
      subnetIds: appSubnetIds,
      securityGroupIds: [props.vpcLinkSg.securityGroupId],
    });

    const httpApi = new apigatewayv2.CfnApi(this, 'HttpApi', {
      name: `${props.prefix}-api`,
      protocolType: 'HTTP',
      corsConfiguration: {
        allowOrigins: ['*'],
        allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAge: 86400,
      },
    });

    this.httpApiId = httpApi.ref;
    this.vpcLinkId = vpcLink.ref;

    new apigatewayv2.CfnStage(this, 'Stage', {
      apiId: httpApi.ref,
      stageName: '$default',
      autoDeploy: true,
      accessLogSettings: {
        destinationArn: accessLogGroup.logGroupArn,
        format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          requestTime: '$context.requestTime',
          httpMethod: '$context.httpMethod',
          routeKey: '$context.routeKey',
          status: '$context.status',
          protocol: '$context.protocol',
          responseLength: '$context.responseLength',
          integrationLatency: '$context.integrationLatency',
        }),
      },
      defaultRouteSettings: {
        throttlingBurstLimit: 1000,
        throttlingRateLimit: 500,
      },
    });

    this.apiUrl = new cdk.CfnOutput(this, 'ApiUrl', {
      value: `https://${httpApi.ref}.execute-api.${this.region}.amazonaws.com`,
      description: 'API Gateway HTTP API URL',
    });
  }
}
