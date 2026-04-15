# AGENTS.md

This file provides guidance to AI coding agents working in the `aws-devops-demo` repository.

## Commands

### Application (Go)

```bash
make generate       # Generate Go code from .proto files (uses Buf CLI)
make build-todo     # Build todo-service binary
make build-user     # Build user-service binary
make build-all      # Build both services
make run-todo       # Run todo-service
make run-user       # Run user-service
make clean          # Remove bin/ and gen/ directories
make tidy           # Run go mod tidy
go test ./... -v -race  # Run tests
```

### Infrastructure (CDK)

Two CDK applications under `iac/`:

```bash
# Infra app (VPC, DocumentDB, ECS Cluster, API Gateway, monitoring)
cd iac/infra
npm ci && npm run build && npm test
npx cdk synth --all -c env=dev -c account=$ACCOUNT_ID -c region=$REGION
npx cdk deploy --all -c env=dev -c account=$ACCOUNT_ID -c region=$REGION --require-approval never

# Service app (per-service ECS Fargate, ALB, API routes, auto-scaling)
cd iac/service
npm ci && npm run build && npm test
npx cdk deploy "awsdemo-dev-todo-service" --exclusively \
  -c env=dev -c "tag:todo-service=dev-abc1234" \
  -c account=$ACCOUNT_ID -c region=$REGION --require-approval never
```

### Service Code Deploy

```bash
# Build + push Docker image to ECR
bash .ci/build-and-push.sh todo-service dev-abc1234 $ACCOUNT_ID $REGION

# Deploy single service stack via CDK
cd iac/service
npx cdk deploy awsdemo-dev-todo-service --exclusively \
  -c env=dev -c "tag:todo-service=dev-abc1234" \
  -c account=$ACCOUNT_ID -c region=$REGION --require-approval never
```


## Architecture

This is a **multi-service** backend with two Go gRPC + gRPC-Gateway services:

### Services

| Service | External REST | Internal gRPC | Database |
|---------|--------------|---------------|----------|
| **todo-service** | `/v1/todos/*` on port 8080 | Server on port 50051 | `todo_db` |
| **user-service** | `/v1/users/*` on port 8080 | Client (calls todo-service) | `user_db` |

Both services expose:
- **gRPC** on port 50051 (native high-performance protocol)
- **HTTP/REST** on port 8080 (auto-generated gateway from proto definitions)

### Inter-Service Communication

`user-service` calls `todo-service` via gRPC through **ECS Service Connect**:
- Service Connect DNS: `todo-service-grpc:50051`
- Transport: insecure (within VPC, Service Connect Envoy handles routing)
- Retry: max 3 attempts for `UNAVAILABLE`
- Timeout: 5s per request

### Proto-First Design

API contracts live in `proto/` directory. All code generation flows from these files:

1. Edit `.proto` file → 2. `make generate` → 3. Generated code appears in `gen/`

Generated files (`gen/`) include protobuf messages, gRPC stubs, HTTP gateway handlers, and OpenAPI/Swagger spec. **Never edit files in `gen/` directly.**

### Layer Structure

```
cmd/
  todo-service/main.go       → Todo service startup, wiring, graceful shutdown
  user-service/main.go       → User service startup, gRPC client to todo-service
internal/
  shared/db/client.go        → Shared MongoDB/DocumentDB connection (Conn, Connect, Close)
  db/documentdb.go           → Todo-specific DB layer (TodoDoc, CRUD operations)
  service/todo.go            → Todo gRPC service implementation
  user/db.go                 → User-specific DB layer (UserDoc, CRUD operations)
  user/service.go            → User gRPC service implementation
  user/todoclient.go         → gRPC client wrapper for calling todo-service
proto/
  todo/v1/todo.proto         → Todo API contract (source of truth)
  user/v1/user.proto         → User API contract (imports todo.v1.Todo)
gen/
  todo/v1/                   → Auto-generated todo code (do not edit)
  user/v1/                   → Auto-generated user code (do not edit)
```

Services receive dependencies via constructors (dependency injection pattern). The shared `db.Conn` is created once and passed to each service's DB client.

### REST API Endpoints (via gRPC-Gateway)

**Todo Service:**
```
POST   /v1/todos              → CreateTodo
GET    /v1/todos/{id}         → GetTodo
GET    /v1/todos              → ListTodos (cursor-based pagination)
PATCH  /v1/todos/{todo.id}    → UpdateTodo (with FieldMask)
DELETE /v1/todos/{id}         → DeleteTodo
```

**User Service:**
```
POST   /v1/users              → CreateUser
GET    /v1/users/{id}         → GetUser
GET    /v1/users/{user_id}/todos → GetUserTodos (calls todo-service via gRPC)
```

### Database

MongoDB/AWS DocumentDB with the native Go driver (`go.mongodb.org/mongo-driver`). Key details:
- Shared DocumentDB cluster, each service uses its own database (`todo_db`, `user_db`)
- Cursor-based pagination using ObjectID as page token
- TLS support for DocumentDB production deployments (set `DOCUMENTDB_CA_FILE`)
- `retryWrites=false` is required for DocumentDB compatibility

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DOCUMENTDB_URI` | `mongodb://localhost:27017` | MongoDB connection string |
| `DOCUMENTDB_DATABASE` | `todo_db` / `user_db` | Database name (per service) |
| `DOCUMENTDB_CA_FILE` | (empty) | TLS CA certificate path for DocumentDB |
| `GRPC_PORT` | `50051` | gRPC server port |
| `HTTP_PORT` | `8080` | HTTP gateway port |
| `TODO_SERVICE_GRPC_ADDR` | `todo-service-grpc:50051` | (user-service only) todo-service gRPC address |

### Error Handling Convention

The service layer uses gRPC status codes: `codes.InvalidArgument` for validation failures, `codes.NotFound` for missing resources, `codes.Internal` for operational errors. These map automatically to HTTP status codes via the gateway.

### Code Generation Tooling

Uses **Buf CLI** (v2) for protobuf management. Config files:
- `buf.yaml` — Linting rules (STANDARD) and breaking change detection
- `buf.gen.yaml` — Four generators: protoc-gen-go, protoc-gen-go-grpc, protoc-gen-grpc-gateway, protoc-gen-openapiv2
- `buf.lock` — Dependency lock (googleapis)

## Infrastructure (CDK)

The `iac/` directory contains **two CDK TypeScript applications**: shared infrastructure (`iac/infra`) and per-service stacks (`iac/service`).

### Directory Structure

```
iac/
  infra/                       # CDK App 1: shared infrastructure
    bin/app.ts                 # Network, Data, Cluster, Edge, Ops, Outputs stacks
    lib/stacks/
      network-stack.ts         → VPC, subnets, security groups, VPC endpoints
      data-stack.ts            → DocumentDB cluster
      cluster-stack.ts         → ECS Cluster + Cloud Map HTTP namespace
      edge-stack.ts            → API Gateway HTTP API, VPC Link, Stage
      ops-stack.ts             → CloudWatch dashboards, alarms, SNS topics
      outputs-stack.ts         → Writes cross-app values to SSM for service app
    lib/config/
      env-config.ts            → EnvConfig (network, DB, monitoring)

  service/                     # CDK App 2: per-service stacks
    bin/app.ts                 # Creates ServiceStack per service (when tag provided)
    lib/stacks/
      service-stack.ts         → Per-service: Fargate, ALB, API GW routes, auto-scaling
    lib/config/
      env-config.ts            → Service EnvConfig (ECS CPU/memory, scaling)
      service-configs.ts       → ServiceConfig per service (ports, routes, DB name)
```

### Cross-App Communication

`iac/infra` writes 9 values to SSM Parameter Store (`/projects/{prefix}/infra/{category}/{key}`):

| Path | Source |
|------|--------|
| `vpc/id` | VPC ID |
| `vpc/ecs-sg-id` | ECS security group |
| `vpc/alb-sg-id` | ALB security group |
| `ecs/cluster-name` | ECS cluster name |
| `ecs/namespace-arn` | Cloud Map namespace ARN |
| `docdb/host` | DocumentDB endpoint |
| `docdb/secret-arn` | DB credentials secret ARN |
| `apigw/http-api-id` | API Gateway HTTP API ID |
| `apigw/vpc-link-id` | VPC Link ID |

Service app reads these via `ssm.StringParameter.valueForStringParameter` (deploy-time resolution), except VPC ID which uses `valueFromLookup` (synth-time, cached in `cdk.context.json`).

### Image Management

Docker images are NOT built by CDK. Instead:
- **CI** creates ECR repos (`awsdemo/{svc}`), builds images, pushes with semantic tags
- **CDK** uses `fromEcrRepository(repo, tag)` — references a pre-built image by ECR repo name + tag
- **Image tag** is passed via CDK context: `-c "tag:todo-service=dev-abc1234"`

ECR repos are created by CI (`build-and-push.sh`), not CDK. Naming: `awsdemo/{svc}`.

### Cross-Stack Communication

The two apps communicate via SSM Parameter Store. Within each app, stacks pass constructs directly as props.

Service stacks receive shared infrastructure values via `valueForStringParameter` (deploy-time SSM resolution).

### ECS Service Connect

- todo-service registers: `todo-service:8080` (HTTP) + `todo-service-grpc:50051` (gRPC)
- user-service registers: `user-service:8080` (HTTP), connects to `todo-service-grpc:50051`
- Port mappings use `appProtocol: http` and `appProtocol: grpc` for protocol-aware telemetry

### Environment Configs

Three environments defined in `env-config.ts`: `dev`, `staging`, `prod`. Account and region passed via CDK context (`-c account=... -c region=...`), sourced from `.ci/env.json`.

## CI/CD

### GitHub Actions (`.github/workflows/`)

CI/CD runs on GitHub Actions with OIDC authentication (zero AK/SK). Two long-lived branches: `main` (protected) and `iac/infra/dev` (direct push).

| Workflow | Trigger | Function |
|----------|---------|----------|
| `pr-validation.yml` | PR to `main` | Go test + infra file guard + CDK diff (staging/prod) posted as PR comment |
| `infra-dev-deploy.yml` | push to `iac/infra/dev` | CDK diff → Environment approval → CDK deploy dev |
| `infra-release.yml` | tag `infra/v*` | CDK deploy staging → approval → CDK deploy prod |
| `service-dev-deploy.yml` | push to `feat/*` etc. + `--deploy=svc` | Docker build/push → CDK diff → approval → CDK deploy dev |
| `service-release.yml` | tag `cmd/*/v*` | Docker build/push → staging approval → deploy → prod approval → deploy |

**Authentication**: GitHub OIDC → `AssumeRoleWithWebIdentity` → per-account IAM Role. Configured via GitHub Secrets (`DEV_ROLE_ARN`, `STAGING_ROLE_ARN`, `PROD_ROLE_ARN`) and Variables (`*_ACCOUNT_ID`, `*_REGION`).

**Approval**: GitHub Environment protection rules replace OCI 企业微信审批. Environments: `dev`, `staging`, `production`.

**Notifications**: Optional 企业微信 Webhook via `WECOM_WEBHOOK_URL` secret.

**Cross-account images**: ECR Replication Rule auto-syncs `awsdemo/*` from dev ECR to staging/prod. Images built once, deployed everywhere.

### OCI 云原生构建 (`.orange-ci.yml`) — Legacy

All CI/CD runs on OCI (云原生构建). Two long-lived branches: `master` (protected) and `iac/infra/dev` (direct push).

**MR Validation** — Go tests + infra file guard + parallel CDK diff (dev/staging/prod) posted as MR comment.

**Infra Dev Deploys** (`iac/infra/dev` branch, direct push):
- Developers push directly to `iac/infra/dev` (not protected, no MR needed)
- Push triggers: CDK diff --all + 企业微信 confirmation + `cdk deploy --all` (dev)
- When ready: MR `iac/infra/dev` → `master` (single review)
- Feature branches cannot modify `iac/infra/` (file guard enforces this)

**Service Dev Deploys** (feature branches, triggered by commit flags):
- `--deploy=todo-service` → Docker build + push ECR + `cdk deploy --exclusively` (~5 min)
- `--deploy=todo-service,user-service` → same, for multiple services

**Release Pipelines** (tag-based, from master):
- `infra/v*` tag → `iac/infra` CDK deploy --all staging → 企业微信 approval → CDK deploy --all prod
- `{service}/v*` tag → Docker build + push → CDK deploy --exclusively staging → approval → prod

### CI Env File

`.ci/env.json` — nested JSON, OCI flattens with `_` separator. Per-env credentials + account/region:
```json
{
  "dev":     { "AWS_ACCESS_KEY_ID": "...", "ACCOUNT_ID": "...", "REGION": "..." },
  "staging": { "AWS_ACCESS_KEY_ID": "...", "ACCOUNT_ID": "...", "REGION": "..." },
  "prod":    { "AWS_ACCESS_KEY_ID": "...", "ACCOUNT_ID": "...", "REGION": "..." }
}
```
Referenced as `$dev_AWS_ACCESS_KEY_ID`, `$staging_ACCOUNT_ID`, `$prod_REGION`, etc.

### CI Helper Scripts

```
.ci/
  install-aws-cli.sh    — installs AWS CLI v2 in node:20 CI container
  build-and-push.sh     — ECR login + docker build + push (args: svc tag account region)
```

### Branching & Release

- `master` — production baseline, release tags originate here (protected, MR only)
- `iac/infra/dev` — infra dev deploys, **direct push** (not protected), push triggers auto-deploy
- `{feat,fix,refactor,test,style,perf}/*` — feature branches, service dev deploys via commit flags
- `infra/v*` tags — infrastructure release (staging → approval → prod)
- `{service}/v*` tags — service code release (staging → approval → prod)

### Development Workflows

**Infra changes:**
1. `git checkout iac/infra/dev && git pull` → write code → push
2. Auto-deploys to dev → test → MR to master (one review)

**Service changes:**
1. Create `feat/*` branch → write code → commit with `--deploy=svc`
2. Auto-deploys to dev → test → MR to master

**Mixed changes** (infra + service):
1. Infra part → push to `iac/infra/dev`
2. Service part → push to `feat/*` with `--deploy=svc`
3. Two separate MRs to master

### New Service Bootstrap Flow

1. Register in `iac/service/lib/config/service-configs.ts` + create Dockerfile
2. Push to feature branch with `--deploy=new-service` → creates ECR, builds, pushes, creates service stack
3. Done — subsequent code changes go through `--deploy=` or service release pipeline

## Docker

- `deploy/todo-service.Dockerfile` — Multi-stage build for todo-service
- `deploy/user-service.Dockerfile` — Multi-stage build for user-service
- `deploy/entrypoint.sh` — Shared container entrypoint script
