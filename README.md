# GSuite to 9Router

Bulk add and manage Google (GSuite) accounts on [9Router](https://www.npmjs.com/package/9router) Antigravity provider — powered by direct API calls for maximum speed.

## Features

### `bot.js` — Bulk Add Accounts
- Adds Google accounts to 9Router's Antigravity provider in bulk
- Uses **9Router API** for authentication and OAuth flow (no UI navigation)
- Browser automation **only** for Google OAuth login (unavoidable — Google blocks programmatic login)
- **Auto-detects** installed browser — Chrome, Edge, Brave, or falls back to bundled Chromium
- Isolated browser contexts per account — no session leakage between accounts
- Automatically removes successfully added accounts from `akun.txt`
- Per-account timing and progress tracking
- Anti-detection: stealth flags to minimize bot detection by Google

### `delete.js` — Smart Cleanup
- Detects and removes exhausted accounts automatically
- **Fast path**: instantly flags accounts with `HTTP 429` + "quota reached" errors — no usage API call needed
- **Deep check**: fetches per-model quota data for ambiguous accounts (`used/total`, `remainingPercentage`)
- Parallel scanning and deletion (batch of 5) for speed
- Resets error status on kept accounts so they show as active in the dashboard
- **Zero browser dependency** — pure HTTP requests

## Requirements

- [Node.js](https://nodejs.org/) v18+
- Chromium-based browser installed — Chrome, Edge, or Brave (for `bot.js` only; auto-detected)
- [9Router](https://www.npmjs.com/package/9router) running on `localhost:20128`

## Installation

```bash
git clone https://github.com/HaikalFadhilah/Gsuiteto9router.git
cd Gsuiteto9router
npm install
```

## Setup

### 1. Create Account List

Create `akun.txt` in the project root with one account per line in `email|password` format:

```
account1@yourdomain.com|password123
account2@yourdomain.com|password456
account3@yourdomain.com|password789
```

### 2. Configure (Optional)

Edit the constants at the top of each script if your setup differs from defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTER_URL` | `http://localhost:20128` | 9Router server address |
| `ROUTER_PASSWORD` | `123456` | 9Router dashboard password — **harus pakai password default** |
| `CONCURRENCY` | `1` | Accounts processed simultaneously |

> **Browser auto-detection**: `bot.js` automatically finds Chrome, Edge, or Brave on your system (Windows, Linux, macOS). If none are found, it falls back to Puppeteer's bundled Chromium.

## Usage

### Add Accounts

```bash
npm run add
# or
node bot.js
```

**Output:**
```
Total akun: 3
Browser: Chrome (C:\Program Files\Google\Chrome\Application\chrome.exe)
Mode: API + Browser (Google OAuth only)

[9Router] Login...
[9Router] ✓ Login berhasil

[1/3] user1@domain.com
  [API] OAuth authorize...
  [Google] Email...
  [Google] Password...
  [Google] Consent...
  [Google] ✓ Auth code didapat
  [API] Exchange token...
[✓] user1@domain.com — 13.8s (uuid-here)

========================================
Selesai dalam 41.2s
Sukses: 3 | Gagal: 0
========================================
```

### Delete Exhausted Accounts

```bash
npm run delete
# or
node delete.js
```

**Output:**
```
[9Router] Login...
[9Router] ✓ Login berhasil

Total connections: 10
Antigravity connections: 8

Scanning quota...

  [✗] user1@domain.com — HAPUS (error 429, quota reached)
  [✗] user2@domain.com — HAPUS (error 429, quota reached)
  [✓] user3@domain.com — KEEP (0 habis, 10 aktif (total 10 model))

-----------------------------------------
Hapus: 2 | Keep: 1
-----------------------------------------

[✓] Deleted: user1@domain.com
[✓] Deleted: user2@domain.com

========================================
Selesai! Deleted: 2 | Failed: 0 | Reset: 1
========================================
```

## How It Works

### Add Flow (`bot.js`)

```
┌─────────────────────────────────────────────────────────┐
│  1. POST /api/auth/login          → Get auth cookie     │
│  2. GET  /api/oauth/.../authorize → Get OAuth URL       │  API
│  3. POST /api/oauth/.../exchange  → Exchange code       │
└─────────────────────────────────────────────────────────┘
                        │
┌─────────────────────────────────────────────────────────┐
│  Open authUrl → Email → Password → Consent → Redirect  │  Browser
│  Capture ?code= from redirect URL                       │  (Google only)
└─────────────────────────────────────────────────────────┘
```

### Delete Flow (`delete.js`)

```
GET /api/providers                  → List all connections
GET /api/usage/{id}                 → Check per-model quota
DELETE /api/providers/{id}          → Remove exhausted accounts
PUT /api/providers/{id}             → Reset status on kept accounts
POST /api/providers/{id}/test       → Re-verify kept accounts
```

## Project Structure

```
Gsuiteto9router/
├── bot.js              # Bulk add accounts (API + browser for Google OAuth)
├── delete.js           # Smart cleanup of exhausted accounts (pure API)
├── akun.txt            # Account list — not tracked by git
├── package.json
├── .gitignore
└── README.md
```

## Notes

- Browser runs in **visible mode** — Google blocks headless automation with CAPTCHAs.
- If the script is interrupted, unprocessed accounts remain in `akun.txt`. Re-run to continue.
- `akun.txt` is excluded from git via `.gitignore` for security.
- The browser stays open after completion by design.

## Disclaimer

This tool is provided for personal use. Use responsibly and in accordance with applicable terms of service.

**DO WITH YOUR OWN RISK**
"# Gsuiteto9router" 
"# Gsuiteto9router" 
