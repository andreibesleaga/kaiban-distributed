# Helm Deployment Guide

> Deploy the kaiban-distributed blog team pipeline using the Helm chart in `examples/blog-team/infra/helm/`.

For raw manifest deployment without Helm see [KUBERNETES.md](KUBERNETES.md).

---

## Chart Overview

```
examples/blog-team/infra/helm/
├── Chart.yaml              ← chart metadata (name: kaiban-blog-team, version: 0.1.0)
├── values.yaml             ← default configuration values
└── templates/
    ├── _helpers.tpl        ← fullname / labels helpers
    ├── configmap.yaml      ← ConfigMap + Secret
    ├── redis.yaml          ← Redis Deployment + Service (toggleable)
    ├── gateway.yaml        ← Gateway Deployment + Service
    └── agents.yaml         ← Researcher / Writer / Editor Deployments (range loop)
```

---

## Prerequisites

- [Helm 3](https://helm.sh/docs/intro/install/) (`helm version` ≥ 3.0)
- `kubectl` configured against your target cluster
- Docker image built and accessible (see [KUBERNETES.md — Step 1](KUBERNETES.md#step-1--build-and-push-the-docker-image))

---

## Quick Install

```bash
helm install blog-team examples/blog-team/infra/helm \
  --set secrets.OPENAI_API_KEY="sk-your-key"
```

This installs the chart with release name `blog-team` using default values (BullMQ, `gpt-4o-mini`, NodePort 30000).

---

## Values Reference

`examples/blog-team/infra/helm/values.yaml`:

```yaml
image:
  repository: ghcr.io/andreibesleaga/kaiban-distributed
  pullPolicy: IfNotPresent
  # Empty tag → uses Chart.AppVersion, the release image tag (for example 2.1.3).
  # For a local image built as in KUBERNETES.md, install with
  # `--set image.repository=kaiban-distributed --set image.tag=latest`.
  tag: ""

redis:
  enabled: true            # set false to use an external Redis
  image:
    repository: redis
    tag: 7-alpine

gateway:
  replicas: 1
  port: 3000
  service:
    type: NodePort          # LoadBalancer for cloud providers
    nodePort: 30000

agents:
  researcher:
    replicas: 1
  writer:
    replicas: 1             # scale up for parallel processing
  editor:
    replicas: 1

config:
  MESSAGING_DRIVER: "bullmq"
  LLM_MODEL: "gpt-4o-mini"
  # Emergency STOP ALL (2.1.0, ADR-025): "true" on every pod turns it on (also set secrets.BOARD_JWT_SECRET).
  CONTROL_PLANE_ENABLED: "false"
  REDIS_URL: ""                    # empty = the in-cluster Redis; set it when redis.enabled=false
  # Optional, rendered into the ConfigMap only when non-empty (empty = the code default):
  NODE_ENV: ""                     # "production" needs the three secrets below and SOCKET_CORS_ORIGINS
  TRUST_PROXY: ""                  # "true" behind an ingress or load balancer
  SOCKET_CORS_ORIGINS: ""          # comma-separated board origins
  A2A_PUBLIC_URL: ""
  AGENT_TIMEOUT_MS: ""             # one value for the gateway and every worker
  RETRY_ON_TIMEOUT: ""
  LOG_LEVEL: ""
  MCP_SERVER_ENABLED: ""
  SEMANTIC_FIREWALL_ENABLED: ""
  CIRCUIT_BREAKER_ENABLED: ""
  JIT_TOKENS_ENABLED: ""

secrets:                           # plain text: the chart base64-encodes them
  create: true                     # false = render no Secret; supply <release>-kaiban-blog-team-secrets yourself
  OPENAI_API_KEY: ""               # required — pass via --set or external secret manager
  OPENROUTER_API_KEY: ""           # optional; when set it takes precedence over OPENAI_API_KEY
  BOARD_JWT_SECRET: ""             # needed for board/HTTP stop; rendered only when non-empty
  CHANNEL_SIGNING_SECRET: ""       # optional; rendered only when non-empty
  A2A_JWT_SECRET: ""               # optional; A2A bearer-token auth; rendered only when non-empty
```

With `config.NODE_ENV=production` the gateway refuses to start unless `BOARD_JWT_SECRET`, `A2A_JWT_SECRET` and `CHANNEL_SIGNING_SECRET` are set (32+ bytes, all different) and `config.SOCKET_CORS_ORIGINS` is set; the agent pods refuse to start without `CHANNEL_SIGNING_SECRET` when `CONTROL_PLANE_ENABLED` is true (they do not run the three-secret check).

---

## Common Install Scenarios

### Local cluster (kind / minikube)

```bash
helm install blog-team examples/blog-team/infra/helm \
  --set secrets.OPENAI_API_KEY="sk-your-key"
```

Access the gateway:

```bash
# NodePort
curl http://localhost:30000/health

# Or port-forward
kubectl port-forward svc/blog-team-kaiban-blog-team-gateway 3000:3000
```

### Cloud cluster with LoadBalancer

```bash
helm install blog-team examples/blog-team/infra/helm \
  --set secrets.OPENAI_API_KEY="sk-your-key" \
  --set gateway.service.type=LoadBalancer
```

### External Redis (disable in-cluster Redis)

Point the pods at your Redis with `config.REDIS_URL` (include the password and use `rediss://` for TLS). The URL is stored in the ConfigMap, so for a production password prefer a managed secret over `--set`:

```bash
helm install blog-team examples/blog-team/infra/helm \
  --set redis.enabled=false \
  --set config.REDIS_URL="redis://:your-password@redis.example.com:6379" \
  --set secrets.OPENAI_API_KEY="sk-your-key"
```

### Custom values file

```bash
# my-values.yaml
secrets:
  OPENAI_API_KEY: "sk-your-key"
  OPENROUTER_API_KEY: "sk-or-v1-your-key"
config:
  LLM_MODEL: "gpt-4o"
agents:
  writer:
    replicas: 3
gateway:
  service:
    type: LoadBalancer
```

```bash
helm install blog-team examples/blog-team/infra/helm -f my-values.yaml
```

---

## Verify the Release

```bash
helm status blog-team
kubectl get pods -l app.kubernetes.io/instance=blog-team
kubectl get svc  -l app.kubernetes.io/instance=blog-team
```

Check gateway health:

```bash
kubectl port-forward svc/blog-team-kaiban-blog-team-gateway 3000:3000
curl http://localhost:3000/health
```

---

## Upgrade

```bash
# Scale writers to 3
helm upgrade blog-team examples/blog-team/infra/helm \
  --reuse-values \
  --set agents.writer.replicas=3

# Change LLM model
helm upgrade blog-team examples/blog-team/infra/helm \
  --reuse-values \
  --set config.LLM_MODEL=gpt-4o
```

---

## Uninstall

```bash
helm uninstall blog-team
```

---

## Secrets Management

The chart renders secrets with `{{ .Values.secrets.OPENAI_API_KEY | b64enc }}`. For production:

**Option A — Helm `--set` (CI/CD)**

```bash
helm upgrade --install blog-team examples/blog-team/infra/helm \
  --set secrets.OPENAI_API_KEY="$OPENAI_API_KEY"
```

**Option B — External Secrets Operator**

Install with `--set secrets.create=false`: the chart then renders no Secret. Let the `ExternalSecret` create a Secret named `<fullname>-secrets`, where the fullname is the release name when it already contains the chart name, else `<release>-kaiban-blog-team` (release `kaiban-blog-team`: `kaiban-blog-team-secrets`; release `blog-team`: `blog-team-kaiban-blog-team-secrets`; `fullnameOverride` wins). Check with `helm template <release> … | grep -A1 secretRef`. The Secret holds the keys `OPENAI_API_KEY` and, as needed, `OPENROUTER_API_KEY`, `BOARD_JWT_SECRET`, `CHANNEL_SIGNING_SECRET`, `A2A_JWT_SECRET`. The pods read it by that name. Two objects of the same name conflict at install, so do not leave `secrets.create` on.

**Option C — Sealed Secrets**

Same as option B: install with `--set secrets.create=false` and commit a `SealedSecret` that unseals to the Secret name above.

The chart cannot mount a CSI volume; it reads secrets only through `envFrom`.

---

## Global research chart

`examples/global-research/infra/helm/` is the same chart layout for the global-research team (chart name `kaiban-global-research`). It runs a gateway and the `searcher` (3 replicas by default), `writer`, `reviewer` and `editor` agents, and takes the same `config` and `secrets` keys. Install and scale it like the blog-team chart:

```bash
helm install research examples/global-research/infra/helm \
  --set secrets.OPENAI_API_KEY="$OPENAI_API_KEY" \
  --set agents.searcher.replicas=6
```

Names follow `<release>-kaiban-global-research-<part>` (for release `research`: `research-kaiban-global-research-gateway`, `-searcher`, `-writer`, `-reviewer`, `-editor`, `-redis`, `-config`, `-secrets`).

---

## Naming

The chart uses the standard Helm `fullname` helper. With release name `blog-team`:

| Resource | Name |
|----------|------|
| ConfigMap | `blog-team-kaiban-blog-team-config` |
| Secret | `blog-team-kaiban-blog-team-secrets` |
| Redis Service | `blog-team-kaiban-blog-team-redis` |
| Gateway Service | `blog-team-kaiban-blog-team-gateway` |
| Researcher Deployment | `blog-team-kaiban-blog-team-researcher` |
| Writer Deployment | `blog-team-kaiban-blog-team-writer` |
| Editor Deployment | `blog-team-kaiban-blog-team-editor` |

Unless `config.REDIS_URL` is set, the `REDIS_URL` in the ConfigMap is constructed as:
```
redis://{{ fullname }}-redis:6379
```

---

## Troubleshooting

### Render templates without installing

```bash
helm template blog-team examples/blog-team/infra/helm \
  --set secrets.OPENAI_API_KEY="sk-test" | less
```

### Lint the chart

```bash
helm lint examples/blog-team/infra/helm \
  --set secrets.OPENAI_API_KEY="sk-test"
```

### Pods not starting — image not found

See [KUBERNETES.md — Build and Push](KUBERNETES.md#step-1--build-and-push-the-docker-image) to load the image into your cluster.

### Agents not processing tasks

```bash
kubectl logs deployment/blog-team-kaiban-blog-team-researcher
```

Verify the Secret was rendered with a real key (not empty). This prints the key: do not run it on a shared screen.

```bash
kubectl get secret blog-team-kaiban-blog-team-secrets -o jsonpath='{.data.OPENAI_API_KEY}' | base64 -d
```
