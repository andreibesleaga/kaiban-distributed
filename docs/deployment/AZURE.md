# Azure Deployment Guide

Deploy kaiban-distributed to Microsoft Azure using AKS (Kubernetes), Azure Container Apps, or Azure App Service.

---

## Option A — Azure Kubernetes Service (AKS)

### Prerequisites

- Azure CLI installed and signed in (`az login`)
- `kubectl` installed
- Docker image pushed to Azure Container Registry (ACR)

### Step 1 — Create an ACR and Push the Image

```bash
RESOURCE_GROUP=kaiban-rg
REGISTRY=kaibanacr       # must be globally unique
REGION=eastus

az group create --name $RESOURCE_GROUP --location $REGION

az acr create \
  --resource-group $RESOURCE_GROUP \
  --name $REGISTRY \
  --sku Basic

az acr login --name $REGISTRY

docker build -t kaiban-distributed:latest .
docker tag kaiban-distributed:latest ${REGISTRY}.azurecr.io/kaiban-distributed:latest
docker push ${REGISTRY}.azurecr.io/kaiban-distributed:latest
```

### Step 2 — Create an AKS Cluster

```bash
az aks create \
  --resource-group $RESOURCE_GROUP \
  --name kaiban-cluster \
  --node-count 3 \
  --node-vm-size Standard_B2ms \
  --attach-acr $REGISTRY \
  --generate-ssh-keys

az aks get-credentials --resource-group $RESOURCE_GROUP --name kaiban-cluster
```

The `--attach-acr` flag grants the cluster pull access to your ACR automatically.

### Step 3 — Store Secrets in Azure Key Vault

```bash
KEYVAULT=kaiban-kv   # must be globally unique

az keyvault create \
  --resource-group $RESOURCE_GROUP \
  --name $KEYVAULT \
  --location $REGION

az keyvault secret set --vault-name $KEYVAULT --name openai-api-key     --value "sk-..."
az keyvault secret set --vault-name $KEYVAULT --name openrouter-api-key --value "sk-or-..."

# Enable the Secrets Store CSI Driver add-on
az aks enable-addons \
  --addons azure-keyvault-secrets-provider \
  --name kaiban-cluster \
  --resource-group $RESOURCE_GROUP
```

Create a `SecretProviderClass` manifest that maps Key Vault secrets to a Kubernetes Secret, then reference it in your Deployment as a volume.

### Step 4 — Deploy with Helm

```bash
helm install kaiban-blog-team ./examples/blog-team/infra/helm \
  --set image.repository=${REGISTRY}.azurecr.io/kaiban-distributed \
  --set image.tag=latest \
  --set gateway.service.type=LoadBalancer \
  --namespace kaiban --create-namespace
```

### Step 5 — Access the Gateway

```bash
kubectl get svc -n kaiban
# Use the EXTERNAL-IP of the gateway service
```

---

## Option B — Azure Container Apps

Container Apps is serverless and scales to zero automatically — ideal for dev/test.

```bash
# Install the extension
az extension add --name containerapp

az containerapp env create \
  --name kaiban-env \
  --resource-group $RESOURCE_GROUP \
  --location $REGION

# Gateway (externally accessible)
az containerapp create \
  --name kaiban-gateway \
  --resource-group $RESOURCE_GROUP \
  --environment kaiban-env \
  --image ${REGISTRY}.azurecr.io/kaiban-distributed:latest \
  --registry-server ${REGISTRY}.azurecr.io \
  --target-port 3000 \
  --ingress external \
  --env-vars "GATEWAY_PORT=3000" "REDIS_URL=redis://..." \
  --secrets "openai-api-key=keyvaultref:<key-vault-uri>,identityref:<mi-id>"

# Worker (no public ingress)
az containerapp create \
  --name kaiban-researcher \
  --resource-group $RESOURCE_GROUP \
  --environment kaiban-env \
  --image ${REGISTRY}.azurecr.io/kaiban-distributed:latest \
  --ingress none \
  --command "node" "dist/examples/blog-team/researcher-node.js" \
  --env-vars "REDIS_URL=redis://..."
```

---

## Option C — Azure App Service (single-container, quick start)

> Best for demos. Does not support multi-container agent deployments natively.

```bash
az appservice plan create \
  --name kaiban-plan \
  --resource-group $RESOURCE_GROUP \
  --is-linux \
  --sku B2

az webapp create \
  --name kaiban-gateway \
  --resource-group $RESOURCE_GROUP \
  --plan kaiban-plan \
  --deployment-container-image-name ${REGISTRY}.azurecr.io/kaiban-distributed:latest

az webapp config appsettings set \
  --name kaiban-gateway \
  --resource-group $RESOURCE_GROUP \
  --settings OPENAI_API_KEY=@Microsoft.KeyVault(SecretUri=https://${KEYVAULT}.vault.azure.net/secrets/openai-api-key/) \
             REDIS_URL=redis://... \
             GATEWAY_PORT=8080
```

---

## Redis on Azure

Use **Azure Cache for Redis** (Basic C0 for dev, Standard C1 for production):

```bash
az redis create \
  --resource-group $RESOURCE_GROUP \
  --name kaiban-redis \
  --sku Basic \
  --vm-size c0 \
  --location $REGION

# Get connection string
az redis list-keys --resource-group $RESOURCE_GROUP --name kaiban-redis
```

Set `REDIS_URL` to `rediss://:PASSWORD@kaiban-redis.redis.cache.windows.net:6380` (TLS port 6380).

---

## Costs (approximate, East US, 2024)

| Resource                   | Spec              | $/month |
|----------------------------|-------------------|---------|
| AKS node pool              | Standard_B2ms ×3  | ~$180   |
| Container Apps (4 workers) | 0.25 vCPU/0.5GB   | ~$25    |
| Azure Cache for Redis (C1) | 1 GB Standard     | ~$55    |
| ACR (Basic)                | —                 | ~$5     |

---

## Further Reading

- [AKS Quickstart](https://learn.microsoft.com/azure/aks/learn/quick-kubernetes-deploy-cli)
- [Azure Container Apps](https://learn.microsoft.com/azure/container-apps/overview)
- [Azure Key Vault + AKS](https://learn.microsoft.com/azure/aks/csi-secrets-store-driver)
- [Azure Cache for Redis](https://learn.microsoft.com/azure/azure-cache-for-redis/cache-overview)
