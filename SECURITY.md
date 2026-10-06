# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| `main` (latest) | ✅ fixes land here |
| Tagged releases (currently `v0.1.0`) | ✅ best effort |

Older snapshots of this repository are not separately supported.

## Reporting a vulnerability

Please report security issues responsibly and **privately**.

**Preferred: GitHub private vulnerability reporting.**

If it is enabled for this repository, open the **Security** tab → **Report a vulnerability** and fill
in the form. That path is private and reaches only the maintainers.

**If private vulnerability reporting is not enabled:**

1. Open a new issue, but keep it **minimal and non-sensitive**. State only that you have found a
   potential security problem and that you need a private contact path — for example: *"I found a
   possible security issue and would like to report it privately; please enable private reporting or
   share a preferred channel."*
2. Do **not** include the vulnerability details, reproduction steps, affected configuration, or any
   proof-of-concept in that issue.
3. Wait for a maintainer to reply with a private channel, then send the full details there.

This repository does not publish an email address; use one of the two paths above.

## Never post the following publicly

- **Never** post secrets: bridge tokens (`OPENCODE_BRIDGE_TOKEN`), provider/API keys, passwords,
  `OPENCODE_SERVER_PASSWORD`, session files, or the contents of `.env`.
- **Never** post exploit details, proof-of-concept code, payloads, or step-by-step reproduction of an
  exploitable flaw in a public issue, discussion, pull request, or commit.
- **Never** commit real credentials or internal hostnames/paths into the repository.
- Redact tokens in any logs, screenshots, or transcripts you share privately.

If you believe a credential has already been exposed, treat it as compromised: rotate/revoke it
immediately, then notify the maintainers privately.

## Scope notes

ADOS Bridge is a local automation gateway: through OpenCode it can modify files in allowlisted
repositories. Reports about ways to escape the repository allowlist, bypass bearer-token
authentication, exfiltrate `.env` / state files, or reach OpenCode or repositories from outside the
intended path are especially welcome. Please read the `Security model` section of the
[README](README.md) for the current protections before assessing impact.

## What to expect

- Acknowledgement once a private channel is established.
- An assessment of the report and, where confirmed, a fix and credit (if you want it) in the release
  notes.
- Reasonable time for a fix before any public disclosure, coordinated with you.
