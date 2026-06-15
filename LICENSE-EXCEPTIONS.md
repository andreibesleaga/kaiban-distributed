# License notes & exceptions

`kaiban-distributed` is licensed under **GPL-3.0-only** (see [LICENSE](LICENSE)).
This note clarifies common questions; it does **not** modify the GPL-3.0 terms.

## TL;DR

| You want to… | GPL-3.0 obligation |
|--------------|--------------------|
| Run it internally / as a SaaS backend (no distribution of the software) | **No copyleft trigger.** GPL-3.0 obligations attach on *distribution* of the software or a derivative, not on running it to provide a network service. (Unlike AGPL-3.0, network use alone is not "distribution".) |
| Distribute a modified version / bundle it into software you ship | You must release your corresponding source under GPL-3.0. |
| Embed it in a closed-source product you distribute | Not permitted under GPL-3.0 — see commercial licensing below. |
| Use the published npm **library** in a GPL-compatible project | Fine under GPL-3.0. |

## SaaS / network use

Running kaiban-distributed to power an internal or hosted service does **not**, by
itself, require you to publish your application's source code, because GPL-3.0's
copyleft is triggered by *distribution* of the covered software, not by providing
access to it over a network. (If network-use copyleft is desired, that would be
AGPL-3.0 — which this project deliberately does **not** use.)

## Commercial / proprietary licensing

If you need to embed kaiban-distributed in a **closed-source, distributed product**
and cannot meet GPL-3.0's source-availability obligation, a separate commercial
license may be available. Contact the maintainer
([andreibesleaga](https://github.com/andreibesleaga)) to discuss terms.

## Third-party dependencies

Dependency licenses are their own; the published library ships only `dist/src`
(no examples/board/tests). A CycloneDX SBOM is produced per release, and CI runs a
license allow-list check. See [SECURITY.md](SECURITY.md) for the supply-chain posture.

> This document is informational and is **not** legal advice. The authoritative
> terms are in [LICENSE](LICENSE).
