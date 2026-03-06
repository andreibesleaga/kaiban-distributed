# Guide: Threat Modeling
<!-- STRIDE, Attack Trees, Risk Assessment -->

---

## 1. What is Threat Modeling?
Threat modeling is a structured process for identifying and mitigating security vulnerabilities during the architectural design phase *before* a single line of code is written.

**The Four Questions:**
1. What are we building? (Data Flow Diagrams)
2. What can go wrong? (STRIDE Methodology)
3. What are we going to do about it? (Mitigations)
4. Did we do a good enough job? (Validation)

## 2. The STRIDE Methodology
Use STRIDE to systematically identify threats across your architecture components.

| Threat | Definition | Security Property Violated | Mitigation Example |
|---|---|---|---|
| **S**poofing | Pretending to be someone else. | Authentication | TLS, Strong Passwords, MFA, JWT. |
| **T**ampering | Modifying data maliciously. | Integrity | Hashing, Digital Signatures, Immutable Logs, TLS. |
| **R**epudiation | Denying an action took place. | Non-repudiation | Secure Audit Logs, Digital Signatures. |
| **I**nformation Disclosure | Exposing exact data to unauthorized eyes. | Confidentiality | Encryption at rest/transit, RBAC. |
| **D**enial of Service | Making the system unavailable. | Availability | Rate Limiting, WAF, Auto-scaling, Caching. |
| **E**levation of Privilege | Gaining permissions you shouldn't have. | Authorization | Principle of Least Privilege, Strict Input Validation. |

## 3. How to Conduct a Threat Modeling Session
Best done collaboratively during Phase 0 (Planning/Design).

1. **Draw the Diagram**: Create a Data Flow Diagram (DFD) showing External Entities, Processes, Data Stores, and Trust Boundaries (e.g., the line between public internet and internal VPC).
2. **Brainstorm**: Walk through each component and data flow. Apply STRIDE.
   * "Can an attacker *Tamper* with the data while it flows from the API Gateway to the Auth Microservice?"
3. **Log Threats**: Record findings in an Agile backlog or a Threat Register.
4. **Prioritize**: Use DREAD or CVSS to rank threats based on Risk (Likelihood * Impact).

## 4. Attack Trees
For complex critical systems, use Attack Trees to model how an attacker might achieve a specific goal.

- **Root Node**: The ultimate attacker goal (e.g., "Steal Customer Database").
- **Leaf Nodes**: The methods to achieve it (e.g., "SQL Injection", "Phishing an Admin", "Finding unencrypted backup on S3").
- This helps visualize the easiest path for an attacker and prioritize mitigations for those specific leaves.

## 5. Integrating with AI Agents
When generating architecture using AI:
- Always prompt the agent to explicitly list STRIDE threats for any proposed design.
- Example Prompt: "Generate a C4 container diagram for this feature, and identify the top 3 STRIDE threats crossing the major Trust Boundaries."
