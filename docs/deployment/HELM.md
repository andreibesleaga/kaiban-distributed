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
- Docker image built and accessible (see [KUBERNETES.md — Step 1](KUBERNETES.md#1-build-and-push-the-docker-image))

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
  repository: kaiban-distributed
  pullPolicy: IfNotPresent
  tag: "latest"

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

secrets:
  OPENAI_API_KEY: ""        # required — pass via --set or external secret manager
  OPENROUTER_API_KEY: ""    # optional
```

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

```bash
helm install blog-team examples/blog-team/infra/helm \
  --set redis.enabled=false \
  --set secrets.OPENAI_API_KEY="sk-your-key"
```

> You must also override `REDIS_URL` in the ConfigMap template, or pass it via a custom values file.

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

Disable the built-in secret (`secrets.OPENAI_API_KEY=""`) and create a matching `ExternalSecret` resource that populates `<release>-kaiban-blog-team-secrets`.

**Option C — Sealed Secrets**

Seal your Secret with `kubeseal` and commit the `SealedSecret`. The chart's Secret will be overridden if names match.

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

The `REDIS_URL` in the ConfigMap template is automatically constructed:
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

See [KUBERNETES.md — Build and Push](KUBERNETES.md#1-build-and-push-the-docker-image) to load the image into your cluster.

### Agents not processing tasks

```bash
kubectl logs deployment/blog-team-kaiban-blog-team-researcher
```

Verify the Secret was rendered with a real key (not empty):

```bash
kubectl get secret blog-team-kaiban-blog-team-secrets -o jsonpath='{.data.OPENAI_API_KEY}' | base64 -d
```
