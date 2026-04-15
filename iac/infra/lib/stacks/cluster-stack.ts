import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as cloudmap from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { EnvConfig } from '../config/env-config';

export interface ClusterStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly prefix: string;
  readonly vpc: ec2.IVpc;
}

export class ClusterStack extends cdk.Stack {
  public readonly ecsCluster: ecs.ICluster;
  public readonly namespaceArn: string;

  constructor(scope: Construct, id: string, props: ClusterStackProps) {
    super(scope, id, props);

    const { config } = props;

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: `${props.prefix}`,
      defaultCloudMapNamespace: {
        name: `${props.prefix}`,
        type: cloudmap.NamespaceType.HTTP,
        useForServiceConnect: true,
      },
      containerInsightsV2: config.enableAlarms ? ecs.ContainerInsights.ENABLED : ecs.ContainerInsights.DISABLED,
    });

    this.ecsCluster = cluster;
    this.namespaceArn = cluster.defaultCloudMapNamespace!.namespaceArn;
  }
}
