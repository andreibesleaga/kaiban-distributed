# GCP Deployment Guide

Deploy kaiban-distributed to Google Cloud Platform using GKE (Kubernetes), Cloud Run, or Google Compute Engine.

---

## Option A — Google Kubernetes Engine (GKE)

### Prerequisites

- Google Cloud SDK installed and authenticated (`gcloud auth login`)
- `kubectl` installed
- Docker image pushed to Artifact Registry

### Step 1 — Create an Artifact Registry and Push the Image

```bash
PROJECT=your-gcp-project-id
REGION=us-central1
REPO=kaiban-repo

# Enable required services
gcloud services enable container.googleapis.com artifactregistry.googleapis.com

# Create an Artifact Registry repository
gcloud artifacts repositories create $REPO \
  --repository-format=docker \
  --location=$REGION \
  --project=$PROJECT

# Configure Docker authentication
gcloud auth configure-docker ${REGION}-docker.pkg.dev

# Build and push
docker build -t kaiban-distributed:latest .
docker tag kaiban-distributed:latest ${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/kaiban-distributed:latest
docker push ${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/kaiban-distributed:latest
```

### Step 2 — Create a GKE Cluster

```bash
# Autopilot (recommended — fully managed nodes)
gcloud container clusters create-auto kaiban-cluster \
  --location=$REGION \
  --project=$PROJECT

# Standard (if you need more control)
gcloud container clusters create kaiban-cluster \
  --num-nodes=3 \
  --machine-type=e2-medium \
  --region=$REGION \
  --project=$PROJECT

gcloud container clusters get-credentials kaiban-cluster --region=$REGION
```

### Step 3 — Store Secrets in Secret Manager

```bash
gcloud services enable secretmanager.googleapis.com

# Create secrets
printf "sk-..." | gcloud secrets create openai-api-key     --data-file=- --project=$PROJECT
printf "sk-or-..." | gcloud secrets create openrouter-api-key --data-file=- --project=$PROJECT

# Grant GKE Workload Identity access
gcloud secrets add-iam-policy-binding openai-api-key \
  --member="serviceAccount:${PROJECT}.svc.id.goog[kaiban/kaiban-sa]" \
  --role="roles/secretmanager.secretAccessor" \
  --project=$PROJECT
```

Use the [External Secrets Operator](https://external-secrets.io/) or the GKE Secret Manager CSI driver to mount secrets as environment variables.

### Step 4 — Deploy with Helm

```bash
helm install kaiban-blog-team ./examples/blog-team/infra/helm \
  --set image.repository=${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/kaiban-distributed \
  --set image.tag=latest \
  --set gateway.service.type=LoadBalancer \
  --namespace kaiban --create-namespace
```

### Step 5 — Access the Gateway

```bash
kubectl get svc -n kaiban
# Use the EXTERNAL-IP of the kaiban-blog-team-gateway Service
```

---

## Option B — Cloud Run (serverless containers)

Cloud Run is the simplest option for stateless services. Worker agents subscribe to a Redis queue; Cloud Run scales them horizontally.

```bash
# Deploy the gateway (publicly accessible)
gcloud run deploy kaiban-gateway \
  --image=${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/kaiban-distributed:latest \
  --platform=managed \
  --region=$REGION \
  --port=3000 \
  --allow-unauthenticated \
  --set-env-vars="GATEWAY_PORT=3000,REDIS_URL=redis://..." \
  --set-secrets="OPENAI_API_KEY=openai-api-key:latest" \
  --project=$PROJECT

# Deploy each worker agent (no external traffic)
for AGENT in researcher writer editor; do
  gcloud run deploy kaiban-${AGENT} \
    --image=${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/kaiban-distributed:latest \
    --platform=managed \
    --region=$REGION \
    --no-allow-unauthenticated \
    --set-env-vars="REDIS_URL=redis://..." \
    --set-secrets="OPENAI_API_KEY=openai-api-key:latest" \
    --command="node" \
    --args="dist/examples/blog-team/${AGENT}-node.js" \
    --project=$PROJECT
done
```

> **Note:** Cloud Run workers must continuously poll Redis (BullMQ) rather than receiving push traffic. This works out-of-the-box with the existing BullMQ driver.

---

## Option C — Google Compute Engine (single VM, quick start)

> Suitable for development and low-traffic demos only.

```bash
gcloud compute instances create-with-container kaiban-vm \
  --container-image=${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/kaiban-distributed:latest \
  --machine-type=e2-medium \
  --zone=${REGION}-a \
  --container-env="GATEWAY_PORT=3000,REDIS_URL=redis://..." \
  --tags=http-server \
  --project=$PROJECT

gcloud compute firewall-rules create allow-kaiban \
  --allow=tcp:3000 \
  --target-tags=http-server \
  --project=$PROJECT
```

---

## Redis on GCP

Use **Memorystore for Redis** (Basic tier for dev, Standard for production):

```bash
gcloud redis instances create kaiban-redis \
  --size=1 \
  --region=$REGION \
  --redis-version=redis_7_0 \
  --tier=basic \
  --project=$PROJECT

# Retrieve the host IP
gcloud redis instances describe kaiban-redis --region=$REGION --project=$PROJECT \
  | grep host
```

Memorystore is VPC-only — your GKE nodes or Cloud Run services must be in the same VPC.

---

## Costs (approximate, us-central1, 2024)

| Resource                     | Spec                 | $/month |
|------------------------------|----------------------|---------|
| GKE Autopilot (3 workloads)  | 0.25 vCPU/0.5 GB ea  | ~$40    |
| GKE Standard                 | e2-medium ×3         | ~$90    |
| Cloud Run (4 services, idle) | min-instances=0      | ~$0–20  |
| Memorystore Redis (1 GB)     | Basic                | ~$35    |
| Artifact Registry (1 GB)     | —                    | ~$0.10  |

---

## Further Reading

- [GKE Quickstart](https://cloud.google.com/kubernetes-engine/docs/quickstarts/create-cluster)
- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- [Secret Manager with GKE](https://cloud.google.com/kubernetes-engine/docs/how-to/workload-identity)
- [Memorystore for Redis](https://cloud.google.com/memorystore/docs/redis)
- [External Secrets Operator on GCP](https://external-secrets.io/latest/provider/google-secrets-manager/)
