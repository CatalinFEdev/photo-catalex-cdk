# Project photo-catalex-cdk

Infrastructure as code for a photo platform, written in TypeScript with AWS CDK.
The stack is built incrementally: data layer first, then compute, authentication, API and CDN.

## Architecture

See [doc/architecture.md](doc/architecture.md) for the current state, the target state and the deployment flow.

## Resources

| Resource    | Name                         | Managed by CDK  | Status     | Notes                                                             |
|-------------|------------------------------|-----------------|------------|-------------------------------------------------------------------|
| DynamoDB    | `photo-categories`           | No (referenced) | Existing   | No GSIs                                                           |
| DynamoDB    | `photo-pictures`             | No (referenced) | Existing   | No GSIs                                                           |
| DynamoDB    | `photo-users`                | Yes             | Deployed   | PK `userId`, GSI `username-index`, on-demand, retained            |
| DynamoDB    | `photo-user-profiles`        | Yes             | Deployed   | PK `userId`, on-demand, retained                                  |
| Cognito     | Existing User Pool           | No (referenced) | Referenced | Referenced with `fromUserPoolId`; ID kept in git-ignored config   |
| API Gateway | REST API `photo-catalex-api` | Yes             | Deployed   | Stage `prod`, throttling, CORS, Cognito authorizer on every route |
| Lambda      | `UsersApiFn`               | Yes             | Defined    | Single handler for the `/user` and `/users` routes (same contract as the Angular app) |
| S3          | `photo-ca-user-profiles`   | No (referenced) | Existing   | Avatars under `avatars/` (presigned upload/read)                |

Planned, not yet in the stack: CloudFront.

## API routes

All routes require a valid Cognito ID token (`Authorization` header).

| Route                                                        | Who                                              |
|--------------------------------------------------------------|--------------------------------------------------|
| `GET/POST/PUT/PATCH /user`                                 | Authenticated user (own record, `userId` = token `sub`; created on first `GET`) |
| `POST/PUT/PATCH /user/profile`                             | Authenticated user (own extended profile)        |
| `POST /user/avatar`                                        | Authenticated user (presigned S3 upload URL)     |
| `GET /users`                                               | `admins` (list) or any user with `?username=` (public projection) |
| `GET/PUT/PATCH /users/{userId}` (+ `/profile`, `/avatar`) | Owner or `admins`; others get the public projection on `GET` |

Responses are wrapped as `{ "data": ... }` and errors as `{ "message", "code" }`, matching `UserProfileService` in the Angular app (`photo-catalinalexandru`).

## Permissions

| Function     | Access |
|--------------|--------|
| `UsersApiFn` | `photo-users`: Get/Put/Update/Query/Scan; `photo-user-profiles`: Get/Put/Update; S3 `photo-ca-user-profiles/avatars/*`: Get/Put. No delete anywhere. |
## Design decisions

- **On-demand billing** (`PAY_PER_REQUEST`): no capacity planning for a low, unpredictable load.
- **`RemovalPolicy.RETAIN`** on stateful resources, so deleting the stack never drops data.
- **Existing resources are referenced**, not recreated: tables with `fromTableName`, the Cognito User Pool with `fromUserPoolId`, so CDK never modifies or deletes them and users stay unchanged.
- **One Lambda for the user API**, mirroring the Angular app's contract, with least-privilege grants (no delete, S3 limited to `avatars/*`).
- **Node.js 24 on ARM64**, bundled from TypeScript with esbuild (`NodejsFunction`), 1-month log retention.
- **Authentication before exposure**: user data is exposed, so every API route has a Cognito authorizer from the start.
- **Two layers of access control**: the authorizer verifies the token; the Lambda decides what the caller may read. Members of the Cognito group `admins` can read and edit any user; every other authenticated user can only edit their own data and sees others' public fields (`userId` always comes from the token, never from the request body).
- **Roles come from Cognito groups**, which can only be changed server-side, not from user-editable attributes.
- **No secrets in the repository**: sensitive values live in AWS Secrets Manager / SSM Parameter Store.

## Project structure

```
bin/photo-catalex-cdk.ts          CDK app entry point (account from profile, region eu-central-1)
lib/photo-catalex-cdk-stack.ts    Stack definition
lambda/                           Lambda handlers (one file per action)
lambda/shared/                    Shared helpers
config/                           example.json committed; dev.local.json git-ignored
doc/                              Architecture diagrams (architecture.md)
scripts/                          One-off scripts (git-ignored)
```

## Getting started

Prerequisites: Node.js (LTS), AWS CLI with configured credentials, AWS CDK CLI.

```bash
npm install
cdk bootstrap   # once per account/region
cdk synth       # generate CloudFormation
cdk diff        # preview changes
cdk deploy      # deploy
```

`cdk destroy` removes the stack but keeps the tables (`RETAIN`).

## Data migration

The data of the new tables was copied from the earlier `photo-ca-*` tables with a one-off script
(scan and conditional put, so existing items are never overwritten and the script can be re-run safely).
The script is not part of the repository.

## Configuration

- Account comes from the active AWS profile, region is `eu-central-1`.
- Local-only settings (such as `userPoolId`) go in `config/dev.local.json` (git-ignored); `config/example.json` shows the expected keys.
- Secrets are never committed.

## Roadmap

- [x] CDK project, bootstrap, DynamoDB tables
- [x] Data copied into the new tables
- [x] Lambda deployed (`UsersApiFn`)
- [x] Existing Cognito User Pool referenced in the stack
- [x] API Gateway with a Cognito authorizer deployed
- [ ] Angular app (`photo-catalinalexandru`) switched to the new API URL and tested end to end
- [ ] CloudFront in front of the API
