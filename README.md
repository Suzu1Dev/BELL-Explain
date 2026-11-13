# BELL Explain

**English** · [繁體中文](./README.zh-TW.md)

Local-first interactive learning workspace for code, concepts, articles, PDFs/Office documents, and GitHub repositories. Paste source material or upload a document to generate step-by-step explanations, worked examples, KaTeX math, interactive diagrams, inline annotations, and FSRS spaced-repetition review cards — stored locally in SQLite on your machine.

Runs out-of-the-box as an **independent Standalone App** (zero environment variables required; includes three curated offline demos) or alongside Personal, BELL PR, Web Reader, and Campaign as part of **[BELL Suite](https://github.com/Suzu1Dev/bell-suite)**.

## Quick Start

### Install in One Line (macOS / Linux / WSL)

```bash
curl -fsSL https://raw.githubusercontent.com/Suzu1Dev/BELL-Explain/main/install.sh | sh
bell-explain
```

The installer checks npm first and automatically falls back to building from GitHub (`~/.local/share/bell-explain/app`) and symlinking `~/.local/bin/bell-explain`, bootstrapping a private Node.js 24 runtime if needed.

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/Suzu1Dev/BELL-Explain/main/install.ps1 | iex
bell-explain
```

### Run via `npx` or From Source

```bash
# Run directly with npx
npx bell-explain

# Or clone and run from source
git clone https://github.com/Suzu1Dev/BELL-Explain.git
cd BELL-Explain
npm install && npm run build
./bin/bell-explain.mjs start
```

## CLI Usage

```text
bell-explain [start] [--port <n>] [--host <h>] [--no-open] [--suite]
bell-explain doctor [--json]
bell-explain --version | --help
```

- **Standalone Edition (default)**: listens on `http://127.0.0.1:3001` with local data in `./data/` (checkout) or `~/.bell-explain/data/` (global install).
- **BELL Suite Edition (`--suite` or `bell-suite start`)**: listens on `http://127.0.0.1:4602` and enables two-way Suite handoffs with BELL Personal, BELL PR (`#/discover`), BELL Web Reader (`#/read`), and BELL Campaign, plus `/api/suite/manifest` and `/api/suite/today`.

## AI Providers

Three curated interactive lessons (Closures, Event Loop, Debounce) work immediately offline without an AI login. To generate new lessons, connect any of:

1. **Codex CLI** (default): run `codex login` locally, then refresh Model Settings in the web UI.
2. **Claude Code CLI**: run `claude auth login` locally, then select Claude Code in Model Settings.
3. **OpenAI-Compatible API**: set `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` in `.env`, then select OpenAI-compatible API in Settings.

Each lesson runs a three-stage isolated pipeline (Analyze → Teach → Organize) without granting shell/network/MCP execution privileges to untrusted source material.

## Architecture Overview

```text
bin/bell-explain.mjs   Standalone & Suite CLI (start, doctor, --version, --help)
src/                   React 19 UI, step-by-step reader, KaTeX math, diagrams, FSRS review
shared/                TypeScript data schemas, Lesson v3 contract, curated offline demos
server/                Express 5 local API, SQLite stores (node:sqlite), PDF/Office parser,
                       Git commit indexer, multilingual embeddings, Suite contract v1
cloud/                 Optional self-hosted multi-device note sync server
Formula/               Homebrew formula template
```

## Development & Verification

Requires **Node.js 22.13+** (Node.js 24 LTS recommended) for built-in `node:sqlite`.

```bash
npm install
npm run dev        # Vite frontend (5173) + API watch (3001)
npm test           # Full unit & integration test suite
npm run build      # TypeScript check + production Vite bundle
```

## License

[Apache-2.0](./LICENSE) · [Trademarks](./TRADEMARKS.md)
