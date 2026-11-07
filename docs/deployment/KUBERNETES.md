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
- Docker image built and accessible to the cluster (see [Build the image](#step-1--build-and-push-the-docker-image))
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

Update `image` in `agents.yaml` and `gateway.yaml` if using a remote registry. The manifests use the locally built `kaiban-distributed:latest`; the Helm chart defaults to the published image `ghcr.io/andreibesleaga/kaiban-distributed:<appVersion>`. To use the published image instead, set `image:` to `ghcr.io/andreibesleaga/kaiban-distributed:2.1.3` and skip the build.

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
  OPENROUTER_API_KEY: ""                    # leave empty unless you use OpenRouter
```

> When `OPENROUTER_API_KEY` is set it takes precedence over `OPENAI_API_KEY`, so a placeholder value breaks every LLM call. The manifests ship it empty.

> **Never commit real secrets.** Use an external secrets operator (External Secrets Operator, Sealed Secrets, Vault Agent Injector) in production.

---

## Step 3 — Apply Manifests

Apply in this order (the ConfigMap and Secret first, then Redis, then the services that read them):

```bash
kubectl apply -f examples/blog-team/infra/kubernetes/configmap.yaml
kubectl apply -f examples/blog-team/infra/kubernetes/redis.yaml
kubectl apply -f examples/blog-team/infra/kubernetes/gateway.yaml
kubectl apply -f examples/blog-team/infra/kubernetes/agents.yaml
```

Or apply the whole directory at once. `kubectl apply -f <dir>` applies the files alphabetically (agents, configmap, gateway, redis) and Kubernetes has no dependency resolution: the pods that start before the ConfigMap, Secret and Redis exist wait in `CreateContainerConfigError` or restart until they do. The ordered commands above avoid those restarts:

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

## Production settings and emergency STOP ALL

The shipped ConfigMap has `CONTROL_PLANE_ENABLED: "false"` and the Secret holds only the two LLM keys. To turn on the emergency STOP ALL (see the README, Emergency STOP ALL):

1. Set `CONTROL_PLANE_ENABLED: "true"` in the ConfigMap.
2. Uncomment `BOARD_JWT_SECRET` and `CHANNEL_SIGNING_SECRET` in the Secret and give them values (`openssl rand -base64 32`). The gateway and the agent Deployments read that Secret with `secretRef`.
3. Mint a board token from the same `BOARD_JWT_SECRET` ([SECURITY_FEATURES §1.1](../security/SECURITY_FEATURES.md#11-board-viewer-jwt-socketio)).

Other optional settings are commented in the ConfigMap: `NODE_ENV`, `SOCKET_CORS_ORIGINS`, `TRUST_PROXY`, `A2A_PUBLIC_URL`, `AGENT_TIMEOUT_MS`, `RETRY_ON_TIMEOUT`, `MCP_SERVER_ENABLED`, the firewall, breaker and JIT switches. With `NODE_ENV: "production"` every pod refuses to start unless `BOARD_JWT_SECRET`, `A2A_JWT_SECRET` and `CHANNEL_SIGNING_SECRET` are set (32+ bytes, all different), and the gateway also needs `SOCKET_CORS_ORIGINS`. Set the timeouts identically on the gateway and every worker.

The gateway also serves `/ready` and `/startup`; the shipped probes use `/health`.

---

## Manifest Reference

### `configmap.yaml`

| Key | Value | Notes |
|-----|-------|-------|
| `REDIS_URL` | `redis://kaiban-redis:6379` | Internal cluster DNS |
| `MESSAGING_DRIVER` | `bullmq` | BullMQ over Redis |
| `PORT` | `3000` | Gateway HTTP port (gateway role only; worker has no HTTP surface) |
| `SERVICE_NAME` | `kaiban-gateway` | Telemetry label |
| `AGENT_IDS` | `researcher,writer,editor` | The agent ids the workers run; on the gateway the agent card advertises one skill per id |
| `LLM_MODEL` | `gpt-4o-mini` | Override per agent if needed |

> **Role selection (ADR-013).** The single image picks its role at runtime from `ROLE` (default
> `gateway`). The shipped `gateway.yaml` relies on that default; the Deployments in `agents.yaml`
> start each worker with its own command (`dist/examples/blog-team/<agent>-node.js`) and set no `ROLE`.
> To run the generic worker pool instead, set `ROLE=worker` on a Deployment (LLM-backed task pool, no
> HTTP surface, so no `/health` probe). Scale a worker with `kubectl scale deployment kaiban-writer --replicas=N`.

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

## Global research manifests

`examples/global-research/infra/kubernetes/` holds the same set for the global-research team: `configmap.yml`, `redis.yml`, `gateway.yml` and one file each for `searcher.yml` (4 replicas by default), `writer.yml`, `reviewer.yml` and `editor.yml`. Names start with `kaiban-research-` (ConfigMap `kaiban-research-config`, Secret `kaiban-research-secrets`). Apply `configmap.yml` first, then the rest. Scale the searchers with `kubectl scale deployment kaiban-research-searcher --replicas=N`.

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
