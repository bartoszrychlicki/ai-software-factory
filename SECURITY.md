# Security policy

## Supported version

This experimental repository supports the current `main` branch only.

## Safe local use

- Keep Mastra Studio and its API on a trusted local network.
- Use a disposable target repository for first experiments.
- Never commit `.env`, `*.local.yaml`, `runs/`, databases or credentials.
- Give Linear, GitHub and agent credentials only the scopes needed for the
  configured test project.
- Review dependency reports with `npm audit --omit=dev`; do not apply forced
  major-version upgrades without validating Mastra compatibility.

## Reporting a vulnerability

Do not open a public issue containing secrets or exploit details. Use GitHub's
private vulnerability reporting for this repository. Include the affected
commit, reproduction steps, impact and any proposed mitigation.
