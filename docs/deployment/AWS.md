# AWS Deployment Guide

Deploy kaiban-distributed to Amazon Web Services using EKS (Kubernetes), ECS (Fargate), or Elastic Beanstalk.

> The Helm chart in `examples/blog-team/infra/helm/` covers the blog-team demo only. It does not set the production secrets or `NODE_ENV`: for an internet-facing gateway also set `config.NODE_ENV=production`, `config.SOCKET_CORS_ORIGINS`, `config.TRUST_PROXY` and the `secrets.*` signing secrets described in [HELM.md](HELM.md), and see [SECURITY_FEATURES §10](../security/SECURITY_FEATURES.md#10-production-deployment-checklist).

---

## Option A — Amazon EKS (Kubernetes)

### Prerequisites

- AWS CLI configured (`aws configure`)
- `kubectl` and `eksctl` installed
- Docker image pushed to Amazon ECR

### Step 1 — Create an ECR Repository and Push the Image

```bash
REGION=us-east-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REPO=kaiban-distributed

# Create the repository (one-off)
aws ecr create-repository --repository-name $REPO --region $REGION

# Build and push
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com

docker build -t $REPO:latest .
docker tag $REPO:latest ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/$REPO:latest
docker push ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/$REPO:latest
```

### Step 2 — Create an EKS Cluster

```bash
eksctl create cluster \
  --name kaiban-cluster \
  --region $REGION \
  --nodegroup-name workers \
  --node-type t3.medium \
  --nodes 3 \
  --nodes-min 2 \
  --nodes-max 6 \
  --managed
```

### Step 3 — Store Secrets in AWS Secrets Manager

Never store API keys in ConfigMaps or Git. Keep them in AWS Secrets Manager:

```bash
# Store the secret
aws secretsmanager create-secret \
  --name kaiban/openai-api-key \
  --secret-string '{"OPENAI_API_KEY":"sk-...","OPENROUTER_API_KEY":"sk-or-..."}' \
  --region $REGION

```

The chart cannot mount a CSI volume: its Deployments read one Kubernetes Secret through `envFrom`. Either pass the key with `--set secrets.OPENAI_API_KEY=...` in Step 4, or create a Kubernetes Secret named `<release>-kaiban-blog-team-secrets` from Secrets Manager (External Secrets Operator) and install with `--set secrets.create=false`; see [HELM.md, Secrets Management](HELM.md#secrets-management).

### Step 4 — Deploy with Helm

```bash
# Update the image repository in values
helm install kaiban-blog-team ./examples/blog-team/infra/helm \
  --set image.repository=${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/kaiban-distributed \
  --set image.tag=latest \
  --set gateway.service.type=LoadBalancer \
  --set secrets.OPENAI_API_KEY="$OPENAI_API_KEY" \
  --namespace kaiban --create-namespace
```

If you keep the key in the secret manager only, install with `--set secrets.create=false` and create a Kubernetes Secret named `kaiban-blog-team-kaiban-blog-team-secrets` (`<release>-kaiban-blog-team-secrets`) from it with the External Secrets Operator; see [HELM.md, Secrets Management](HELM.md#secrets-management).

### Step 5 — Access the Gateway

```bash
kubectl get svc -n kaiban
# Copy the EXTERNAL-IP of kaiban-blog-team-gateway
```

---

## Option B — AWS ECS with Fargate

Fargate removes the need to manage EC2 nodes. Use the AWS Copilot CLI for the simplest path:

```bash
# Install Copilot CLI
brew install aws/tap/copilot-cli

# Initialise the application
copilot app init kaiban-distributed

# Each agent becomes a worker service; gateway becomes a load-balanced web service
copilot svc init --name gateway     --svc-type "Load Balanced Web Service" --dockerfile Dockerfile
copilot svc init --name researcher  --svc-type "Worker Service"             --dockerfile Dockerfile
copilot svc init --name writer      --svc-type "Worker Service"             --dockerfile Dockerfile
copilot svc init --name editor      --svc-type "Worker Service"             --dockerfile Dockerfile
```

> **Important:** the worker services reuse the same image, whose default `CMD` is the
> **gateway** (`node dist/src/main/index.js`). Override each worker's command in its
> Copilot manifest (`copilot/<svc>/manifest.yml`) to run the agent node, e.g.
> `command: node dist/examples/blog-team/researcher-node.js`, and give each worker
> `REDIS_URL`, its `AGENT_ID`, and an LLM key. Otherwise every "worker" boots the
> gateway and crashes on the missing `AGENT_IDS`.

```bash
# Deploy all
copilot env init --name production
copilot svc deploy --name gateway --env production
```

Set environment variables via Copilot's secret store:

```bash
copilot secret init --name OPENAI_API_KEY
copilot secret init --name OPENROUTER_API_KEY
```

> **Reminder:** `copilot secret init` only stores the secret — it does not wire it into a
> service. You must reference the LLM secret in **each worker's** manifest
> (`copilot/<svc>/manifest.yml`) under its `secrets:` block so the worker can actually call
> the model, e.g.:
>
> ```yaml
> secrets:
>   OPENAI_API_KEY: /copilot/${COPILOT_APPLICATION_NAME}/${COPILOT_ENVIRONMENT_NAME}/secrets/OPENAI_API_KEY
> ```

---

## Option C — AWS Elastic Beanstalk (single-instance, quick start)

> Best for evaluation and low-traffic demos. Not recommended for production multi-agent workloads. Elastic Beanstalk runs this one container as the gateway only (`ROLE` unset): no agent runs, so no task completes. Run the workers on EKS or Fargate (Option A or B) against the same Redis.

```bash
# Install the EB CLI
pip install awsebcli

eb init kaiban-gateway --platform docker --region $REGION
eb create kaiban-gateway-env --instance-type t3.small
eb deploy
```

Set env vars:

```bash
eb setenv OPENAI_API_KEY=sk-... REDIS_URL=redis://... AGENT_IDS=researcher,writer,editor SOCKET_CORS_ORIGINS=https://<your-viewer-domain>
```

---

## Emergency STOP ALL (optional)

Set `CONTROL_PLANE_ENABLED=true` on every service (gateway, workers and orchestrator), and put `BOARD_JWT_SECRET` and `CHANNEL_SIGNING_SECRET` in the Secret next to the model keys. See [Emergency STOP ALL](../../README.md#emergency-stop-all-210) in the README and [HELM.md](HELM.md).

## Redis on AWS

Use **Amazon ElastiCache for Redis** (cluster mode disabled, single node for dev):

```bash
aws elasticache create-cache-cluster \
  --cache-cluster-id kaiban-redis \
  --cache-node-type cache.t3.micro \
  --engine redis \
  --engine-version 7.0 \
  --num-cache-nodes 1 \
  --region $REGION
```

Set `REDIS_URL` to the cluster endpoint (port 6379). To use in-transit encryption and an auth token, enable them on the cluster and use `rediss://:<token>@<endpoint>:6379`; since 2.1.2 the password, user and `rediss://` in `REDIS_URL` apply to every client, the task queues included.

---

## Costs (illustrative only, check [AWS pricing](https://aws.amazon.com/pricing/))

| Resource            | Spec           | $/month  |
|---------------------|----------------|----------|
| EKS cluster         | t3.medium ×3   | ~$150    |
| Fargate (4 services)| 0.25 vCPU/0.5GB| ~$30     |
| ElastiCache Redis   | cache.t3.micro | ~$12     |
| ECR storage (1 GB)  | —              | ~$0.10   |

---

## Further Reading

- [EKS Getting Started](https://docs.aws.amazon.com/eks/latest/userguide/getting-started.html)
- [AWS Copilot CLI](https://aws.github.io/copilot-cli/)
- [Secrets Store CSI Driver for AWS](https://github.com/aws/secrets-store-csi-driver-provider-aws)
- [ElastiCache Redis](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/WhatIs.html)
