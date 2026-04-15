import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { EnvConfig } from '../config/env-config';

export interface NetworkStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly prefix: string;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly appSubnets: ec2.SubnetSelection;
  public readonly dataSubnets: ec2.SubnetSelection;
  public readonly vpcLinkSg: ec2.ISecurityGroup;
  public readonly albSg: ec2.ISecurityGroup;
  public readonly ecsSg: ec2.ISecurityGroup;
  public readonly docdbSg: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      maxAzs: config.maxAzs,
      natGateways: config.natGateways,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'App', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { cidrMask: 24, name: 'Data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    this.appSubnets = { subnetGroupName: 'App' };
    this.dataSubnets = { subnetGroupName: 'Data' };

    // --- Security Groups (source-SG chaining, no CIDRs) ---
    this.vpcLinkSg = new ec2.SecurityGroup(this, 'VpcLinkSg', {
      vpc: this.vpc, description: 'VPC Link ENIs for API Gateway', allowAllOutbound: false,
    });
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc, description: 'Internal ALB for API Gateway to ECS routing', allowAllOutbound: false,
    });
    this.ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc: this.vpc, description: 'ECS Fargate tasks', allowAllOutbound: false,
    });
    this.docdbSg = new ec2.SecurityGroup(this, 'DocDbSg', {
      vpc: this.vpc, description: 'DocumentDB cluster', allowAllOutbound: false,
    });

    this.vpcLinkSg.addEgressRule(this.albSg, ec2.Port.tcp(8080), 'To ALB');
    this.albSg.addIngressRule(this.vpcLinkSg, ec2.Port.tcp(8080), 'From VPC Link');
    this.albSg.addEgressRule(this.ecsSg, ec2.Port.tcp(8080), 'To ECS tasks');
    this.ecsSg.addIngressRule(this.albSg, ec2.Port.tcp(8080), 'From ALB');
    this.ecsSg.addEgressRule(this.docdbSg, ec2.Port.tcp(27017), 'To DocumentDB');
    this.docdbSg.addIngressRule(this.ecsSg, ec2.Port.tcp(27017), 'From ECS tasks');
    this.ecsSg.addIngressRule(this.ecsSg, ec2.Port.tcp(50051), 'gRPC from other ECS tasks');
    this.ecsSg.addEgressRule(this.ecsSg, ec2.Port.tcp(50051), 'gRPC to other ECS tasks');

    // HTTPS egress for AWS APIs — endpoints keep traffic private, NAT handles the rest
    this.ecsSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'To AWS APIs');

    // --- VPC Endpoints (optional, staging/prod) ---
    if (config.enableVpcEndpoints) {
      // S3: Gateway Endpoint (free, unlimited bandwidth, route-table based)
      this.vpc.addGatewayEndpoint('S3GwEndpoint', {
        service: ec2.GatewayVpcEndpointAwsService.S3,
        subnets: [this.appSubnets],
      });

      // Other services: Interface Endpoints (ENI with private IP)
      const endpointSg = new ec2.SecurityGroup(this, 'VpcEndpointSg', {
        vpc: this.vpc, description: 'VPC Interface Endpoints', allowAllOutbound: false,
      });
      endpointSg.addIngressRule(this.ecsSg, ec2.Port.tcp(443), 'From ECS tasks');

      for (const [name, service] of [
        ['EcrDkr', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
        ['EcrApi', ec2.InterfaceVpcEndpointAwsService.ECR],
        ['Logs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
        ['SecretsManager', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ] as const) {
        this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
          service, subnets: this.appSubnets, securityGroups: [endpointSg],
        });
      }
    }
  }
}
