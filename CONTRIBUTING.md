# Contributing to ADOS Bridge

Thanks for helping improve ADOS Bridge. This document is deliberately short: fork, branch, validate,
open a focused pull request.

## Before you start

- Node.js 20+ and pnpm 10+.
- Run `opencode` locally if you intend to exercise runtime behavior end to end (not required for
  typecheck/unit tests).
- Search [existing issues](https://github.com/matiasgonzalovq/ados-bridge/issues) and open
  one for larger changes before writing code.

## Development workflow

```bash
git clone https://github.com/<your-fork>/ados-bridge.git
cd ados-bridge
pnpm install

pnpm run dev        # run from source (tsx)
pnpm run typecheck  # src/ + tests/
pnpm test           # vitest
pnpm run build      # tsc -> dist/
pnpm run validate   # typecheck + test + build (run this before you push)
```

Typical contribution flow:

1. Fork the repository and create a branch from `main`.
   `git checkout -b fix/<short-description>`
2. Make the change. Follow the existing structure and naming conventions in `src/` and `tests/`.
3. Add or update tests in `tests/` for any behavior change — the suite is unit-level and uses fakes,
   so most logic is testable without a live OpenCode server.
4. Update `README.md` when behavior, commands, configuration, or security posture changes.
5. Run `pnpm run validate` and make sure it passes.
6. Open a pull request with a clear description of the problem and the approach.

## Guidelines

- Keep pull requests focused; separate refactors from behavior changes.
- Prefer small, reviewable diffs over broad rewrites.
- Do not expand the tool surface casually: every new MCP tool needs a security review of its
  containment, auth, and checkpoint behavior (see the `Security model` section of the README).
- Preserve the existing error contract: MCP failures return `isError: true` with an actionable,
  structured message.
- Do not rename the npm package, the `opencode-chatgpt-bridge` binary, or import paths without an
  explicit discussion in an issue first.
- Keep the upstream attribution intact: the MIT `LICENSE` (copyright yuga-hashimoto) and `NOTICE`
  must not be removed or rewritten.

## Never commit secrets

- `.env`, `.env.*`, logs, and local state are gitignored; only `.env.example` is tracked.
- Never commit tokens, bridge tokens, API keys, private keys, provider credentials, or real internal
  hostnames/paths from your machine.
- Use placeholders in examples and fixtures (e.g. `<token>`, `/path/to/repo`).
- If you accidentally expose a credential, rotate/revoke it immediately — deleting it from a later
  commit is not enough.

## Reporting security issues

Do **not** open a public issue or pull request for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the MIT License covering this
repository, and that you have read [NOTICE](NOTICE) regarding upstream attribution.
