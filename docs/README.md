# Documentation index

Start with the [README](../README.md). This page lists where to read next, by reader.

| You are | Read first | Then |
|---|---|---|
| **A user** who wants to run the demo | [README, Quick start (full demo)](../README.md#quick-start-full-demo), [EXAMPLES.md](../EXAMPLES.md) | [Board](../board/README.md), the examples repository [kaiban-distributed-examples](https://github.com/andreibesleaga/kaiban-distributed-examples) |
| **A developer** who builds on the library | [README, Use as a library](../README.md#use-as-a-library), [KAIBANJS_INTEGRATION.md](KAIBANJS_INTEGRATION.md) | [API specification](api/SPEC.md), [shared helpers](../src/shared/README.md), [MCP](federation/MCP.md), [economics](economics/ECONOMICS.md), [governance](governance/GOVERNANCE.md) |
| **An operator** who deploys it | [Docker](deployment/DOCKER.md) (start here: which variables reach the containers), [Kubernetes](deployment/KUBERNETES.md), [Helm](deployment/HELM.md) | [Railway](deployment/RAILWAY.md), [Vercel](deployment/VERCEL.md), [AWS](deployment/AWS.md), [Azure](deployment/AZURE.md), [GCP](deployment/GCP.md); upgrades: [MIGRATION.md](../MIGRATION.md) |
| **Security** | [SECURITY_FEATURES.md](security/SECURITY_FEATURES.md) (checklist in section 10), [SECURITY.md](../SECURITY.md) | [ASVS checklist](security/ASVS-5.0-checklist.md), README [Emergency STOP ALL](../README.md#emergency-stop-all-210) |
| **QA and release** | [VERIFICATION.md](VERIFICATION.md) (current record: 2.1.2), [testing](testing/) | [RELEASE.md](RELEASE.md), [CONTRIBUTING.md](../CONTRIBUTING.md), [CHANGELOG.md](../CHANGELOG.md) |
| **An architect** | [ACTOR_MODEL.md](architecture/ACTOR_MODEL.md), [DIAGRAMS.md](architecture/DIAGRAMS.md) | [PLAN.md](architecture/PLAN.md), [decisions (ADRs)](decisions/), [roadmap](roadmap/), [FEATURES.md](FEATURES.md), [AMQP seam](messaging/AMQP.md) |

Single homes for facts that appear in several places: configuration variables in [`.env.example`](../.env.example) and the README Configuration Reference; test counts in [VERIFICATION.md](VERIFICATION.md); gateway limits in [SPEC.md](api/SPEC.md); the wire protocol of STOP ALL in the SPEC and its design in ADR-025.
