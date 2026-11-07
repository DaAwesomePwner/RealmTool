# RealmTool — agent guide

- Design: `docs/design.md`. Plans: `docs/superpowers/plans/`. Research on the source project: `docs/research/`.
- Node runs our TypeScript directly (type stripping). Use `.ts` import specifiers, no enums,
  no namespaces, no constructor parameter properties. `npm run check` must pass before every commit.
- The network worker (`src/transport/worker.ts`) owns sockets and ciphers. Never route a
  time-critical decision through the main thread; use a worker module.
- RC4 keys live only in `src/protocol/constants.ts`. No hard-coded game-server IPs.
- Ported files keep their `// Ported from realm-engine-client …` header.
- The helper DLL builds with `npm run build:helper` (needs VS 2022 C++ x64 tools).
- GitHub: `daplabs/RealmTool` (public). Branch per task, PR into `main`; CI runs on GitHub-hosted Windows runners.
