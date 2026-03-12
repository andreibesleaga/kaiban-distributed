# Kubernetes Deployment Guide

> Deploy the kaiban-distributed blog team pipeline to any Kubernetes cluster using the raw manifests in `examples/blog-team/infra/kubernetes/`.

For a templated, values-driven deployment see [HELM.md](HELM.md).

---

## Overview

```
examples/blog-team/infra/kubernetes/
├── configmap.yaml   ← shared env vars + Secret (OPENAI key)
├── redis.yaml       ← Redis Deployment + ClusterIP Service
├── gateway.yaml     ← Gateway Deployment + NodePort Service (port 30000)
└── agents.yaml      ← Researcher, Writer, Editor Deployments
```

---

## Prerequisites

- `kubectl` configured and connected to your cluster
- Docker image built and accessible to the cluster (see [Build the image](#1-build-and-push-the-docker-image))
- `OPENAI_API_KEY` (and optionally `OPENROUTER_API_KEY`)

---

## Step 1 — Build and Push the Docker Image

```bash
# Build from repo root
docker build -t kaiban-distributed:latest .

# For a remote cluster, tag and push to your registry
docker tag kaiban-distributed:latest your-registry/kaiban-distributed:latest
docker push your-registry/kaiban-distributed:latest
```

Update `image` in `configmap.yaml` or patch `agents.yaml` / `gateway.yaml` if using a remote registry.

For **local clusters** (kind, minikube, k3s):

```bash
# kind
kind load docker-image kaiban-distributed:latest

# minikube
minikube image load kaiban-distributed:latest
```

---

## Step 2 — Configure Secrets

Edit `examples/blog-team/infra/kubernetes/configmap.yaml` and replace the placeholder values:

```yaml
stringData:
  OPENAI_API_KEY: "sk-your-real-key"
  OPENROUTER_API_KEY: "sk-or-v1-your-key"   # optional
```

> **Never commit real secrets.** Use an external secrets operator (External Secrets Operator, Sealed Secrets, Vault Agent Injector) in production.

---

## Step 3 — Apply Manifests

Apply in dependency order:

```bash
kubectl apply -f examples/blog-team/infra/kubernetes/configmap.yaml
kubectl apply -f examples/blog-team/infra/kubernetes/redis.yaml
kubectl apply -f examples/blog-team/infra/kubernetes/gateway.yaml
kubectl apply -f examples/blog-team/infra/kubernetes/agents.yaml
```

Or apply the whole directory at once (order is handled by Kubernetes dependency resolution):

```bash
kubectl apply -f examples/blog-team/infra/kubernetes/
```

---

## Step 4 — Verify Deployment

```bash
kubectl get pods
# NAME                                  READY   STATUS    RESTARTS   AGE
# kaiban-redis-xxxxx                    1/1     Running   0          30s
# kaiban-gateway-xxxxx                  1/1     Running   0          25s
# kaiban-researcher-xxxxx               1/1     Running   0          20s
# kaiban-writer-xxxxx                   1/1     Running   0          20s
# kaiban-editor-xxxxx                   1/1     Running   0          20s

kubectl get services
# NAME              TYPE        CLUSTER-IP      PORT(S)          AGE
# kaiban-redis      ClusterIP   10.96.x.x       6379/TCP         30s
# kaiban-gateway    NodePort    10.96.x.x       3000:30000/TCP   25s
```

Check gateway health:

```bash
# NodePort access (local cluster)
curl http://localhost:30000/health

# Or port-forward for any cluster
kubectl port-forward svc/kaiban-gateway 3000:3000
curl http://localhost:3000/health
```

---

## Step 5 — Run the Orchestrator

```bash
# Port-forward if not using NodePort externally
kubectl port-forward svc/kaiban-gateway 3000:3000 &

GATEWAY_URL=http://localhost:3000 \
TOPIC="The Future of AI Agents" \
npx ts-node examples/blog-team/orchestrator.ts
```

---

## Manifest Reference

### `configmap.yaml`

| Key | Value | Notes |
|-----|-------|-------|
| `REDIS_URL` | `redis://kaiban-redis:6379` | Internal cluster DNS |
| `MESSAGING_DRIVER` | `bullmq` | BullMQ over Redis |
| `GATEWAY_PORT` | `3000` | Gateway HTTP port |
| `SERVICE_NAME` | `kaiban-gateway` | Telemetry label |
| `AGENT_IDS` | `gateway` | Gateway-role identifier |
| `LLM_MODEL` | `gpt-4o-mini` | Override per agent if needed |

Secrets (in the same file, `kind: Secret`):

| Key | Notes |
|-----|-------|
| `OPENAI_API_KEY` | Required |
| `OPENROUTER_API_KEY` | Optional |

### `redis.yaml`

- **Deployment**: `redis:7-alpine`, liveness probe via `redis-cli ping`
- **Service**: ClusterIP `kaiban-redis:6379`

> For production, replace with a managed Redis (AWS ElastiCache, GCP Memorystore, Upstash) and update `REDIS_URL` in the ConfigMap.

### `gateway.yaml`

- **Deployment**: image `kaiban-distributed:latest`, port 3000, liveness probe on `/health`
- **Service**: NodePort 30000 → 3000 (change to `LoadBalancer` for cloud providers)

### `agents.yaml`

Three deployments — `kaiban-researcher`, `kaiban-writer`, `kaiban-editor`:

- Command: `node dist/examples/blog-team/<agent>-node.js`
- Env from: `kaiban-blog-team-config` ConfigMap + `kaiban-blog-team-secrets` Secret
- Default `replicas: 1` (scale independently)

---

## Scaling Workers

```bash
# Scale writer to 3 replicas
kubectl scale deployment kaiban-writer --replicas=3

# Scale all agents
kubectl scale deployment kaiban-researcher kaiban-writer kaiban-editor --replicas=2
```

BullMQ distributes queue jobs across all running replicas automatically.

---

## Switching to LoadBalancer (Cloud)

Edit `gateway.yaml`:

```yaml
spec:
  type: LoadBalancer   # was: NodePort
  ports:
  - port: 3000
    targetPort: 3000
    # remove nodePort line
```

Then re-apply:

```bash
kubectl apply -f examples/blog-team/infra/kubernetes/gateway.yaml
kubectl get svc kaiban-gateway   # wait for EXTERNAL-IP
```

---

## Teardown

```bash
kubectl delete -f examples/blog-team/infra/kubernetes/
```

---

## Troubleshooting

### Pods in `ImagePullBackOff`

The image `kaiban-distributed:latest` is not accessible to the cluster. Either:
- Load it into a local cluster: `kind load docker-image kaiban-distributed:latest`
- Push to a registry and update the `image:` field in the manifests

### Pods in `CrashLoopBackOff`

```bash
kubectl logs deployment/kaiban-researcher
```

Common causes:
- `OPENAI_API_KEY` placeholder not replaced in `configmap.yaml`
- Redis not yet ready (researcher starts before Redis is healthy)

### Gateway liveness probe failing

The gateway liveness probe checks `/health` after `initialDelaySeconds: 10`. If the build is slow, increase this value in `gateway.yaml`.
