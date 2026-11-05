#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import { PhotoCatalexCdkStack } from '../lib/photo-catalex-cdk-stack';

const configPath = path.join(__dirname, '..', 'config', 'dev.local.json');
if (!fs.existsSync(configPath)) {
  throw new Error('Missing config/dev.local.json (copy config/example.json and fill in the values)');
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
  userPoolId: string;
  avatarBucketName?: string;
  avatarCdnDomain?: string;
};

const app = new cdk.App();

new PhotoCatalexCdkStack(app, 'PhotoCatalexCdkStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'eu-central-1',
  },
  userPoolId: config.userPoolId,
  avatarBucketName: config.avatarBucketName,
  avatarCdnDomain: config.avatarCdnDomain,
});


