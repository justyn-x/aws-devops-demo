import * as cdk from 'aws-cdk-lib';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { EnvConfig } from '../config/env-config';

export interface DataStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly prefix: string;
  readonly vpc: ec2.IVpc;
  readonly dataSubnets: ec2.SubnetSelection;
  readonly docdbSg: ec2.ISecurityGroup;
}

export class DataStack extends cdk.Stack {
  public readonly dbHost: string;
  public readonly dbSecretArn: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { config } = props;

    const paramGroup = new docdb.ClusterParameterGroup(this, 'ParamGroup', {
      family: 'docdb5.0',
      description: `${props.prefix} DocumentDB parameters`,
      parameters: { tls: 'enabled' },
    });

    const cluster = new docdb.DatabaseCluster(this, 'DocDbCluster', {
      masterUser: {
        username: 'docdbadmin',
        secretName: `${config.envName}/platform/docdb/master`,
        excludeCharacters: '"@/',
      },
      instanceType: new ec2.InstanceType(config.docdbInstanceClass),
      instances: config.docdbInstanceCount,
      vpc: props.vpc,
      vpcSubnets: props.dataSubnets,
      securityGroup: props.docdbSg,
      parameterGroup: paramGroup,
      port: 27017,
      storageEncrypted: true,
      deletionProtection: config.deletionProtection,
      removalPolicy: config.removalPolicy,
      dbClusterName: `${props.prefix}-docdb`,
    });

    this.dbHost = cluster.clusterEndpoint.hostname;
    this.dbSecretArn = cluster.secret!.secretArn;
  }
}
