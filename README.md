# AI Bench

Standalone AI inference benchmarker. Runs 4 real-world prompts against any local AI provider, saves results locally, and syncs to a shared Google Sheet so you can compare performance across machines.

## Quick Start

```bash
npm install
cp .env.example .env          # fill in your Google OAuth credentials
node src/cli.js run           # benchmark default Ollama provider
node src/cli.js compare       # open browser viewer
```

## Commands

| Command | Description |
|---|---|
| `ai-bench run` | Run benchmark (auto-pushes to sheet) |
| `ai-bench run --provider llamacpp --model phi3` | Specific provider/model |
| `ai-bench run --no-push` | Run without syncing to sheet |
| `ai-bench history` | Show local run history in terminal |
| `ai-bench compare` | Open browser: local results vs. sheet leaderboard |
| `ai-bench push` | Push all unsynced local runs to sheet |
| `ai-bench config` | Interactive setup wizard |
| `ai-bench config --show` | Print current config |

## Supported Providers

- **Ollama** (default) — `http://localhost:11434`
- **llama.cpp** — `http://localhost:8080`
- **Custom** — any OpenAI-compatible `/v1/chat/completions` endpoint

## Google Sheets Setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project → Enable **Google Sheets API**
3. APIs & Services → Credentials → Create → **OAuth client ID** → **Desktop app**
4. Copy the Client ID and Secret into `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
5. First `ai-bench run` will open a browser for one-time Google authorization. The token is cached at `~/.ai-bench/token.json`.

## .env Configuration

```bash
SHEETS_URL=https://docs.google.com/spreadsheets/d/<id>/edit
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
AI_PROVIDER=ollama
AI_MODEL=llama3.2:3b
```

## Build Standalone Executable

```bash
npm run build:win    # → dist/ai-bench-win.exe
npm run build:mac    # → dist/ai-bench-macos
npm run build:linux  # → dist/ai-bench-linux
```

Copy the exe + a `.env` file to any machine. No Node.js installation required.

## Metrics Measured

| Metric | Description |
|---|---|
| **Tok/s** | Output tokens per second (generation throughput) |
| **TTFT** | Time to first token (prefill latency) |
| **Prefill tok/s** | Input token processing speed (stress test) |

Four tests of increasing context size: `short` (~50 tok), `medium` (~300 tok), `long` (~1500 tok), `stress` (~3500 tok).

## Data Location

All local data lives in `~/.ai-bench/`:
- `data.db` — SQLite benchmark history
- `config.json` — user settings
- `token.json` — Google OAuth token
