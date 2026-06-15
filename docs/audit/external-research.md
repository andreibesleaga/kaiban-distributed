# External Standards Verification — Authoritative Sources

> Phase 2D. Each spec/standard claim verified against primary/authoritative sources (2025–2026).
> Status: ⬜ PENDING fix · ✔️ correct. These feed the doc corrections and the new CI.

## 1. A2A (Agent-to-Agent) protocol — ⬜ NOT WIRE-CONFORMANT
Source: A2A Protocol, now **Linux Foundation** (donated by Google, Jun 2025); current stable **v1.0** (~Apr 2026); `agent-card.json` rename landed in **v0.3.0**. Methods use slash form: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`. https://a2a-protocol.org/latest/specification/
- ✔️ Card path `/.well-known/agent-card.json` is **correct** (v0.3.0+).
- ⬜ Method names `agent.status` / `tasks.create` / `tasks.get` (dot form) are **custom, not A2A**.
- ⬜ `AgentCard` shape `{name,version,description,capabilities:string[],endpoints}` is **not** the spec (real card needs `protocolVersion`, `url`, `skills[]`, object-form `capabilities`, `defaultInput/OutputModes`).
- ⬜ README links stale `google-deepmind.github.io/a2a`.
- **Fix (strict-compat):** keep the path; **document** "A2A-inspired RPC surface — not wire-compatible with A2A v0.3/v1.0" + cite a pinned version + fix the link. (Full conformance = additive new methods/schema, or a v2 breaking change — defer the rename.)

## 2. MCP — ✔️ CORRECT (version slightly behind)
Spec rev **2025-06-18**; TS SDK latest **1.29.0**. Repo pins `^1.27.1` (caret covers 1.29). `Client`/`StdioClientTransport`/`connect`/`listTools`/`callTool` usage is current and unbroken. **Fix:** optional bump `^1.29.0`; cite spec rev. No code change.

## 3. KaibanJS 0.23.1 — ✔️ API correct / ⬜ CVE wording outdated
0.23.1 confirmed latest; bridge usage (`Team`/`Agent`/`Task`/`team.start()`/`stats.llmUsageStats`) matches the real API. README "6 moderate CVEs" line is **outdated**: Dec 2025 brought **CVE-2025-68665** (LangChain.js, CVSS 8.6) + **CVE-2025-2828** (SSRF, langchain-community). Repo `npm ci` showed 31 vulns. **Fix:** rewrite the CVE line to current reality + the override mitigations (now applied: langsmith≥0.7.4, axios≥1.16.1, @langchain/* pins); re-state/soften the "security-audit-complete" badge.

## 4. OWASP mappings — ⬜ several MISCITED (lists are real)
- **ASVS 5.0.0** released May 2025 (17 chapters). Repo doesn't cite ASVS yet — target 5.0 for the new checklist.
- **LLM Top 10 2025** + **Top 10 for Agentic Applications (ASI01–ASI10, "2026" edition, released Dec 9 2025)** are both **real**.
- ⬜ `SECURITY_FEATURES.md`: **LLM10** labeled "Model DoS" → real name **"Unbounded Consumption"**. **LLM02** label → **"Sensitive Information Disclosure"**. **ASI10** alt-label "Abnormal Agent Behavior" → official **"Rogue Agents"**.
- ✔️ ASI01/03/05/07/10 mappings otherwise accurate.
- **Fix:** rename those three labels; title = "OWASP Top 10 for Agentic Applications (2026)"; add a citation line; clarify ASI ≠ the older T1–T15 taxonomy.

## 5. OpenTelemetry / W3C Trace Context — ✔️ CORRECT
W3C Trace Context is a Recommendation (Feb 2020); `traceparent` v `00` 4-field format. Repo's `propagation.inject/extract` + validation regex `^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$` are exactly correct. **Fix:** none (optional: set explicit `W3CTraceContextPropagator`).

## 6. Supply chain (for new CI) — targets
- **SLSA v1.1** (v1.2 in RC) — target **Build L3** via `slsa-github-generator`.
- **Sigstore/cosign keyless** OIDC (Fulcio+Rekor), verify narrow identity, sign image+attestations.
- **CycloneDX 1.6** (regulatory floor; 1.7 latest) via `cyclonedx-npm`.
- **OpenSSF Scorecard** action; **pin all GitHub Actions by full commit SHA** (post tj-actions).
- ⬜ The committed `ci.yml` `npm audit` is **non-blocking** (`|| echo warning`) → make osv/audit a **blocking HIGH+** gate.

## 7. Compliance wording (GDPR / SOC 2 / ISO 27001) — ⬜ OVERSTATED
None is a property a library can possess (regulation / org attestation / org certification). Repo asserts them as delivered (README compliance table, PRD:11, SECURITY_FEATURES:439/468, ADR-005:11).
- **Fix (capability language):** retitle "Compliance-supporting controls"; reframe each row as a capability the *deploying organization* can use (e.g. "Supports GDPR data-minimization: SHA-256 hashed IDs + `sanitizeDelta()`"; "least-privilege container baseline supporting SOC 2 CC6"; "mTLS supporting ISO 27001 A.8.24"). Add a standing disclaimer: *"kaiban-distributed is a library, not a certified product; compliance/certification is the deploying organization's responsibility."* Verb swaps: "is compliant/ensures" → "supports/helps satisfy".

### Quick table
| # | Item | Verdict | Core fix |
|---|------|---------|----------|
|1|A2A|inspired, not conformant|document non-compat + version; (v2: real methods/schema)|
|2|MCP|correct|optional bump + cite rev|
|3|KaibanJS|API ok / CVE stale|rewrite CVE line; overrides applied|
|4|OWASP|miscited labels|LLM10→Unbounded Consumption, LLM02→Sensitive Info Disclosure, ASI10→Rogue Agents|
|5|OTel/W3C|correct|none|
|6|supply chain|greenfield|SLSA L3, cosign, CycloneDX, Scorecard, SHA-pin, blocking audit|
|7|compliance|overstated|capability language + disclaimer|
