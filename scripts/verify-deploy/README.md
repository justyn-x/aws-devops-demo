# LINEAR Deployment Verification

Tools for validating that the LINEAR deployment strategy on `todo-service` actually
shifts traffic in 20% increments — both on the ALB path (external API Gateway) and
the Service Connect path (internal user-service → todo-service gRPC).

## Prerequisites

1. CDK is configured to use LINEAR for `todo-service` in dev
   (`iac/service/lib/config/env-config.ts` → `linearServices: ['todo-service']`).
2. `todo-service` returns `X-Service-Revision` HTTP header and `x-service-revision`
   gRPC trailer on every response (wired in `internal/shared/logger`).
3. `grpcurl` is baked into the todo-service image (`deploy/todo-service.Dockerfile`).
4. AWS CLI configured with credentials that can:
   - call `ecs:ExecuteCommand` against todo-service tasks
   - call `cloudwatch:Logs:Insights:*` for the service log group
5. `hey` or just `curl` available locally for the external load script.

## Important: scale up before testing

The dev `desiredCount` is **1**. With a single task you can't get meaningful
percentage-shifted traffic — blue + green = 2 tasks, so Service Connect end will
look like 50/50 regardless of LINEAR step config. Bump it up before testing:

```bash
aws ecs update-service \
  --cluster awsdemo-dev \
  --service awsdemo-dev-todo-service \
  --desired-count 5 \
  --region us-east-1
```

Wait for `runningCount=5`, then trigger your LINEAR deploy. Scale back down after.

## Workflow

### Step 1 — Trigger a deploy via the normal pipeline

Make any small code change in `cmd/todo-service/main.go` (or anywhere the image
SHA changes), commit with a `--deploy=todo-service` flag, and push to a `feat/*`
branch. The GitHub Actions `Service Dev Deploy` workflow handles build + push +
`cdk deploy` + dev environment approval.

### Step 2 — Watch for the deployment to enter `IN_PROGRESS`

```bash
watch -n 5 'aws ecs describe-services \
  --cluster awsdemo-dev \
  --services awsdemo-dev-todo-service \
  --region us-east-1 \
  --query "services[0].deployments[*].{status:status,rolloutState:rolloutState,desiredCount:desiredCount,runningCount:runningCount}"'
```

When you see two deployments (an `ACTIVE` blue and an `IN_PROGRESS` green),
LINEAR has started — start the load samplers below.

### Step 3 — Sample external traffic (ALB path)

In one terminal on your workstation:

```bash
API_URL="https://<api-id>.execute-api.us-east-1.amazonaws.com/v1/todos"
./external-load.sh "$API_URL" 25 | tee external.log
```

In another terminal:

```bash
tail -f external.log | python3 analyze.py --step 20 --bake 2
```

Expected progression (rough — 20% step, 2-min bake):

```
[10:00:00] green=  0.0% (0/487)   expected≈ 0.0%  ✓
[10:02:00] green= 18.9% (94/498)  expected≈20.0%  ✓
[10:04:00] green= 39.5% (197/499) expected≈40.0%  ✓
[10:06:00] green= 60.1% (300/499) expected≈60.0%  ✓
[10:08:00] green= 79.7% (398/499) expected≈80.0%  ✓
[10:10:00] green=100.0% (500/500) expected≈100.0% ✓
```

### Step 4 — Sample internal Service Connect traffic (gRPC path)

Get a todo-service task ID:

```bash
TASK_ID=$(aws ecs list-tasks --cluster awsdemo-dev \
  --service-name awsdemo-dev-todo-service \
  --query 'taskArns[0]' --output text --region us-east-1 \
  | awk -F/ '{print $NF}')
```

Copy the script in (ECS Exec doesn't have a `cp` shortcut; embed instead):

```bash
SCRIPT_B64=$(base64 -w 0 < internal-load.sh)
aws ecs execute-command \
  --cluster awsdemo-dev --task "$TASK_ID" --container todo-service \
  --interactive --region us-east-1 \
  --command "/bin/sh -c 'echo $SCRIPT_B64 | base64 -d > /tmp/load.sh && chmod +x /tmp/load.sh && /tmp/load.sh 25'" \
  | tee internal.log
```

Then analyze the same way:

```bash
tail -f internal.log | python3 analyze.py --step 20 --bake 2
```

### Step 5 — Cross-check via CloudWatch Logs Insights

Open Logs Insights against `/ecs/awsdemo-dev-todo-service`, paste the query from
`logs-insights.txt`, and pick the deploy time range. The bin-by-revision counts
should match what `analyze.py` reported live.

## Things to look for

- **ALB path**: should hit `step ± 5%` in each stable bucket. Tighter than SC
  because ALB does request-level weighted forward.
- **Service Connect path**: depends on Envoy's connection lifecycle. With long-
  lived gRPC connections, freshly-bumped weights only affect *new* connections —
  if `step_bake_time` is shorter than the natural connection-cycle interval,
  expect coarser-than-step granularity. This is one of the things we're
  measuring: how much does long-connection stickiness blur the LINEAR contour?
- **Step alignment**: ALB and SC should reach 40% at roughly the same time
  (ECS pushes weight updates to both at each step). Significant skew points
  to a config-propagation delay worth investigating.

## Failure / rollback drill (optional but recommended)

After a clean run, deploy a deliberately-broken build (e.g. `panic` early in
`main.go`). The LINEAR rollout should fail at one of the early steps —
`UnhealthyHostAlarm` or `Target5xxAlarm` triggers `ROLLBACK_ON_ALARM`, ECS
flips the listener weights back to 100/0, blue keeps serving. Confirm:

```bash
aws ecs describe-services --cluster awsdemo-dev \
  --services awsdemo-dev-todo-service --region us-east-1 \
  --query 'services[0].deployments[*].{status:status,rolloutState:rolloutState,rolloutStateReason:rolloutStateReason}'
```

You should see `rolloutState: ROLLBACK_IN_PROGRESS` then `ROLLBACK_SUCCESSFUL`.
