# Security policy

FundRoom gates investor materials and offering information. We treat security reports as the highest-priority work in the repository.

## Reporting a vulnerability

Please **do not** open a public issue for anything that could be a vulnerability.

- Preferred: GitHub private vulnerability reporting on this repository: <https://github.com/fundroomhq/fundroom/security/advisories/new>.
- Or email `security@fundroom.com`. If you need to encrypt, ask for our current PGP key in your first message.

Include what you found, how to reproduce it, the version or commit, and what impact you believe it has. You will get an acknowledgement within 2 business days and a triage decision within 7 days. We will keep you informed and credit you in the advisory unless you prefer otherwise.

We do not run a paid bounty programme at this time.

## Scope

In scope: the server, web app, embed loader, SDKs, the WordPress plugin, deployment manifests, and this repository's CI configuration.

Out of scope: social engineering, denial of service by volume, findings that require a compromised host or operator, and issues in third-party services we integrate with (please report those upstream; we will help coordinate).

## Safe harbour

Good-faith research that stays within the scope above, avoids privacy violations and data destruction, and does not disrupt other users is welcome. We will not pursue legal action for it.

## Supported versions

Until 1.0 ships, only the latest release and `main` receive fixes. From 1.0, the current major and the previous major receive security fixes for at least 12 months after the newer major's release.

## How we work

- Two reviews are required for changes to authentication, authorization, sessions, crypto, audit, and deployment code (`.github/CODEOWNERS`).
- Every PR runs Opengrep, CodeQL, gitleaks, OSV-Scanner, pnpm audit, and Trivy; images are signed with cosign and ship an SBOM and SLSA provenance.
- Advisories are published as GitHub Security Advisories with a CVE where applicable, and announced on the `security-advisories` list.
- Self-hosters are never auto-updated. Read the advisory, then upgrade on your own schedule.
