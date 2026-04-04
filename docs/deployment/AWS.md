# AWS Deployment Guide

Deploy kaiban-distributed to Amazon Web Services using EKS (Kubernetes), ECS (Fargate), or Elastic Beanstalk.

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

Never store API keys in ConfigMaps or Git. Use AWS Secrets Manager + the Secrets Store CSI driver instead:

```bash
# Store the secret
aws secretsmanager create-secret \
  --name kaiban/openai-api-key \
  --secret-string '{"OPENAI_API_KEY":"sk-...","OPENROUTER_API_KEY":"sk-or-..."}' \
  --region $REGION

# Install the CSI driver
helm repo add secrets-store-csi-driver https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts
helm install csi-secrets-store secrets-store-csi-driver/secrets-store-csi-driver --namespace kube-system

# Install the AWS provider
kubectl apply -f https://raw.githubusercontent.com/aws/secrets-store-csi-driver-provider-aws/main/deployment/aws-provider-installer.yaml
```

Then reference the CSI volume in your Deployment spec instead of `secretRef`.

### Step 4 — Deploy with Helm

```bash
# Update the image repository in values
helm install kaiban-blog-team ./examples/blog-team/infra/helm \
  --set image.repository=${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/kaiban-distributed \
  --set image.tag=latest \
  --set gateway.service.type=LoadBalancer \
  --namespace kaiban --create-namespace
```

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

# Deploy all
copilot env init --name production
copilot svc deploy --name gateway --env production
```

Set environment variables via Copilot's secret store:

```bash
copilot secret init --name OPENAI_API_KEY
copilot secret init --name OPENROUTER_API_KEY
```

---

## Option C — AWS Elastic Beanstalk (single-instance, quick start)

> Best for evaluation and low-traffic demos. Not recommended for production multi-agent workloads.

```bash
# Install the EB CLI
pip install awsebcli

eb init kaiban-gateway --platform docker --region $REGION
eb create kaiban-gateway-env --instance-type t3.small
eb deploy
```

Set env vars:

```bash
eb setenv OPENAI_API_KEY=sk-... REDIS_URL=redis://... GATEWAY_PORT=8080
```

---

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

Set `REDIS_URL` to the cluster endpoint (port 6379).

---

## Costs (approximate, us-east-1, 2024)

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
