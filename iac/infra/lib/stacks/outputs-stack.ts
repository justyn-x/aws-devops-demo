import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface OutputsStackProps extends cdk.StackProps {
  readonly prefix: string;
  readonly vpcId: string;
  readonly ecsSgId: string;
  readonly albSgId: string;
  readonly clusterName: string;
  readonly namespaceArn: string;
  readonly dbHost: string;
  readonly dbSecretArn: string;
  readonly httpApiId: string;
  readonly vpcLinkId: string;
}

export class OutputsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OutputsStackProps) {
    super(scope, id, props);

    const params: Record<string, string> = {
      'vpc/id':             props.vpcId,
      'vpc/ecs-sg-id':      props.ecsSgId,
      'vpc/alb-sg-id':      props.albSgId,
      'ecs/cluster-name':   props.clusterName,
      'ecs/namespace-arn':  props.namespaceArn,
      'docdb/host':         props.dbHost,
      'docdb/secret-arn':   props.dbSecretArn,
      'apigw/http-api-id':  props.httpApiId,
      'apigw/vpc-link-id':  props.vpcLinkId,
    };

    for (const [key, value] of Object.entries(params)) {
      new ssm.StringParameter(this, key.replace(/\//g, '-'), {
        parameterName: `/projects/${props.prefix}/infra/${key}`,
        stringValue: value,
      });
    }
  }
}
