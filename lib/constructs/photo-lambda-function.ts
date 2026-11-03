import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';

export interface PhotoLambdaFunctionProps {
  /** File name (without extension) inside the `lambda/` folder. */
  fileName: string;
  environment: Record<string, string>;
}

/**
 * Extends NodejsFunction directly (and creates the log group in the parent scope)
 * so the logical IDs of already deployed resources stay unchanged.
 */
export class PhotoLambdaFunction extends nodejs.NodejsFunction {
  constructor(scope: Construct, id: string, props: PhotoLambdaFunctionProps) {
    super(scope, id, {
      entry: path.join(__dirname, '..', '..', 'lambda', `${props.fileName}.ts`),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: props.environment,
      bundling: { minify: true, sourceMap: true },
      logGroup: new logs.LogGroup(scope, `${id}Logs`, {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
  }
}
