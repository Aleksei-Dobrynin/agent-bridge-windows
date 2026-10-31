<div align="center">

<img src="assets/hero.jpg" alt="Claude Bridge — coding agents on your PC, controlled from your phone" width="820">

# Claude Bridge for Windows

**Mirror coding-agent sessions — [Claude Code](https://claude.com/claude-code), [opencode](https://opencode.ai) or any terminal agent — to your phone and control them from there.**
No cloud account and no server of your own: on the local network the phone talks to your PC directly, and when you are away — through an encrypted p2p tunnel.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/PC-Windows%2010%2F11-informational)](#requirements)
[![Android](https://img.shields.io/badge/Phone-Android%208%2B-green)](#2-phone-app)

[🇷🇺 Русский](README.md) · 🇬🇧 English

</div>

---

> **Internal team tool.** A fork of [HelpFreedom/claude-bridge](https://github.com/HelpFreedom/claude-bridge) adapted to Windows and multiple agents. Everyone installs it **on their own personal work computer** and configures it for themselves. Only a Windows host is supported; there is no Linux mode and no compatibility with old app versions.
>
> ⚠️ **Not for shared computers.** The security model assumes a PC with **one** user account that only its owner can physically access. Do not install it on multi-user machines, terminal servers or shared test rigs.

## What it is

A bridge (Node.js) on your PC runs agents in Windows pseudo-terminals (ConPTY) and mirrors them to an Android app. The phone shows the same terminal as the PC: you can type, switch and start sessions, answer permission requests with buttons right in the notification, and get notified when the agent is done.

How traffic flows: on the office or home Wi-Fi — **directly over the local network**; elsewhere — through an iroh/QUIC p2p tunnel that may go through the public Number 0 (n0) relay and discovery servers. Content is end-to-end encrypted (TLS pinned to the bridge certificate plus iroh encryption), but the operator of those servers sees metadata: IP addresses, NodeId, time and traffic volume. Only phones paired via QR have access.

### Features

- 📱 **Full terminal on the phone** — xterm.js: typing, Esc/Tab/Ctrl-C, arrows, finger scrolling and selection, paste (control characters are stripped).
- 🤖 **Several agents** — Claude Code, opencode and any TUI agent from the config; the agent and its options are chosen per new session.
- 🔔 **Permission requests on the phone** — "Claude asks for permission — Bash: …" with "Yes / Always: … / No" buttons right in the notification; answering on the PC clears it.
- ✅ **Confirmation on the phone** — issuing a pairing code and enabling internet access are confirmed on an already paired phone with a check code.
- 🌐 **Away from the PC's network** — the p2p tunnel (iroh) comes up by itself when the PC is not visible on Wi-Fi.
- 🎙️ **Voice input** — dictation (faster-whisper on the PC), optional.
- 💾 **Sessions survive bridge restarts** — each lives in its own keeper process.

> Technical description: [ARCHITECTURE.md](ARCHITECTURE.md) (in Russian).

---

## How it works (short)

```
┌──────────────────── PC (Windows) ─────────────────────┐        ┌────────── Phone (Android) ────────┐
│                                                       │        │                                   │
│  claude.exe   (ConPTY) ┐                              │        │   WebView + xterm.js              │
│  opencode.exe (ConPTY) ┼─ keeper.js (keepers)         │  WSS   │   • terminal, tabs, voice         │
│  other agent  (ConPTY) ┘   named pipe + handshake     │◀──────▶│   • foreground service            │
│                                │                      │ TLS +  │   • notifications with buttons    │
│  Claude hook ┐                 ▼                      │ pinning│                                   │
│  opencode    ┴──▶ server.js (bridge, port 8790) ──────┼────────┤   Discovery: mDNS + UDP beacon    │
│  SSE              autostart: Task Scheduler           │        │   Away: p2p tunnel (iroh)         │
└───────────────────────────────────────────────────────┘        └───────────────────────────────────┘
```

1. The phone finds the PC on the network (mDNS/UDP beacon) and connects.
2. Terminal input and output flow both ways over WebSocket on TLS.
3. Agent events (Claude Code hooks, opencode events) become phone notifications.

---

## Requirements

**PC:**
- Windows 10 or 11 (tested on Windows 11 26200), a personal user account (see the warning above)
- [Node.js](https://nodejs.org/) 20+ (tested on 24.8)
- At least one agent on `PATH`: [Claude Code](https://claude.com/claude-code) (`claude`, tested 2.1.284) and/or [opencode](https://opencode.ai) (`opencode`, tested v2.1.4)
- *(optional)* Python 3.11 (`py -3.11`) + [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) — voice input
- *(to build from source)* [Rust](https://rustup.rs/), JDK 17, Android SDK — see [Building from source](#building-from-source)

**Phone:** Android 8.0+ (API 26). The "Always" button and confirming from a notification need Android 12+ (older versions confirm in the open app).

**Network:** phone and PC on the same Wi-Fi with the "Private" profile on the PC — or the p2p tunnel.

---

## Installation

### 1. Bridge on the PC

```powershell
git clone https://github.com/Aleksei-Dobrynin/agent-bridge-windows.git
cd agent-bridge-windows
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Firewall
```

`install.ps1`:
- checks Node.js 20+ (required) and whether `claude` and `opencode` are present (if missing — a warning: that agent will be unavailable);
- installs the bridge dependencies (`npm ci` in `bridge\`); a running bridge (the repository's `server.js` process listening on the bridge port) is stopped first, and with live sessions the installer refuses (they hold `node-pty` files) — end the sessions or add `-SkipNpm`;
- creates the data directory `%LOCALAPPDATA%\ClaudeBridge` and `config.json` from `bridge\config.example.json` (an existing config is left alone);
- puts `claude-mobile.cmd` into `%LOCALAPPDATA%\ClaudeBridge\bin` and adds that directory to the user PATH;
- adds the bridge hook to `%USERPROFILE%\.claude\settings.json` (backup `settings.json.bak-…`, the last 5 are kept; written via a temporary file with rename retries, so `settings.json` is unchanged on failure; your hooks and settings are kept);
- registers the Task Scheduler task `ClaudeBridge` — the bridge starts when you sign in to Windows at normal priority (no service: agents need your session). If the task cannot be registered, a `ClaudeBridge.lnk` shortcut in the user's Startup folder (`shell:startup`) is created instead; with `-StartupShortcut` — the shortcut right away;
- with `-Firewall`, adds inbound rules `ClaudeBridge-TCP` (bridge port, 8790) and `ClaudeBridge-UDP` (beacon, 8791) for the "Private" profile only and only from the local subnet (`remoteip=localsubnet`); Windows asks for administrator approval for this step only, and on error the elevated window waits for Enter instead of closing;
- starts the bridge and waits until it listens on its port; an already running bridge is restarted (also with `-SkipNpm`), otherwise it would keep the old code (with `-NoStart` only a warning is printed);
- warns if `node.exe` lives in a temporary directory (`fnm_multishells`, `%TEMP%`): autostart points to that path and will not work after a reboot.

Running it again is safe — this is also how you update after `git pull`. To see what it would do without changing anything: `.\install.ps1 -DryRun`. Other switches: `-SkipNpm`, `-SkipTask`, `-SkipPath`, `-SkipHook`, `-NoStart`, `-StartupShortcut`, `-StartupDir <dir>`, `-TaskName <name>`; `-DataRoot` and `-SettingsPath` are only for testing the installer on temporary directories: a non-default `-DataRoot` without `-DryRun` requires a non-default `-SettingsPath`, `-SkipNpm`, `-SkipPath`, `-SkipTask` (or `-StartupShortcut` with a temporary `-StartupDir`) and forbids `-Firewall` (`Get-Help .\install.ps1 -Full`).

> If Windows asks whether `node.exe` may use the network when the bridge first starts, allow it for private networks. If you blocked it before, the `node.exe` block rule overrides allow rules: remove it in "Windows Defender Firewall → Allow an app through firewall…".

### 2. Phone app

Download `ClaudeBridge-<version>.apk` and `SHA256SUMS.txt` from [Releases](https://github.com/Aleksei-Dobrynin/agent-bridge-windows/releases) and verify before installing:

```powershell
Get-FileHash -Algorithm SHA256 .\ClaudeBridge-<version>.apk          # matches SHA256SUMS.txt
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\34.0.0\apksigner.bat" verify --print-certs .\ClaudeBridge-<version>.apk
```

The APK is signed with the team key. **SHA-256 of the signing certificate:**

```
{{APK_CERT_SHA256}}
```

If `apksigner` shows a different fingerprint, do not install it. An app signed with another key (for example the old debug one) must be uninstalled first.

> **Status (2026-10-31):** the signed release is not published yet (the team key is created by the repository owner). The phone tunnel (`libclaudetunnel.so`) is built from source (Android NDK 28), but internet access from a real phone has not been tested yet; an APK without it works over the local network only. The test scenarios on a real phone have not been run yet. Details: [ARCHITECTURE.md, §12](ARCHITECTURE.md#12-известные-ограничения).

### 3. Pairing

1. In a **new** console window (PATH updated): `claude-mobile --qr`.
   - First phone: the console asks for `[y/N]` confirmation.
   - If a phone is already paired: confirm on it (notification "Claude Bridge: нужно подтверждение" — "confirmation needed"), comparing the 4-digit code with the console.
2. In the app: **"Добавить компьютер" ("Add computer") → "Сканировать QR-код" ("Scan QR code")**. Pairing is QR-only (no manual code entry).
3. Done: the phone remembers the PC and connects by itself.

---

## The `claude-mobile` CLI (on the PC)

```
claude-mobile [args…]              new session of the default agent in the current directory;
                                   arguments go to the agent (--resume, --continue…)
claude-mobile --agent <id> [args…] new session of the given agent (claude, opencode, …)
claude-mobile -l                   list sessions
claude-mobile -a [id]              attach to a session (without id — the latest live one)
claude-mobile --device             trusted devices and internet access
claude-mobile --qr                 pairing QR code for a new device
claude-mobile --open               open the bridge web UI in the browser (one-time link)
claude-mobile --rotate-token       reissue the owner token
claude-mobile -h                   help
```

`Ctrl+\` detaches: the session keeps running, come back with `claude-mobile -a`. On detach the console returns to normal input (modes the agent switched on are reset). To end a session, exit the agent (`/exit`) or long-press its tab in the app.

---

## Agents

| Agent | How it works | New-session options |
|---|---|---|
| `claude` — Claude Code | Permission requests and "done" arrive through the hook installed by `install.ps1`. Answer buttons for Bash, PowerShell, file edits, Web, Read/Glob/Grep, Task and MCP tools. | "Continue conversation (--resume)", "No permission prompts (--dangerously-skip-permissions)" (labels are in Russian in the app) |
| `opencode` | Through the opencode background service (the bridge runs `opencode service start` itself if the service does not respond); events come from its API, including subagent requests. By default opencode asks nothing. | "Ask permission for commands" |
| any TUI agent (`generic`) | Terminal mirror only: no notifications, no answer buttons. | — |

The Claude Code hook also fires in ordinary Claude sessions (not through the bridge): it exits immediately there, but a `node` process starts for every event.

---

## Configuration

Config: `%LOCALAPPDATA%\ClaudeBridge\config.json` (created from `bridge\config.example.json`; never committed).

| Key | Purpose |
|---|---|
| `port` | Bridge port, default `8790` (beacon `port+1`, tunnel entry `port+2`). |
| `host` | `"auto"` — `127.0.0.1` plus the private (10/8, 172.16/12, 192.168/16) address of the main LAN adapter (virtual and VPN adapters are skipped, public addresses are never used, re-checked every 15 s); or an explicit address. |
| `defaultAgent` | Default agent (`claude`). |
| `agents` | Agents: `{ "claude": {}, "opencode": {} }`; your own — `"aider": { "type": "generic", "name": "Aider", "command": "aider", "args": [], "scroll": "pageKeys" }` (`scroll`: `wheel` or `pageKeys`). |
| `projects` | Directories where the **phone** may start sessions; a path outside the list falls back to `defaultCwd`. |
| `defaultCwd` | Default directory (`~` and `%VAR%` are expanded). |
| `env` | Environment variables for all sessions (for example a proxy). |
| `scrollbackBytes` | Scrollback buffer per session (1 MB in the template; 256 KB without the key). |
| `maxSessions` | Session limit (default 24). |
| `sttPython` / `sttPythonArgs` / `sttModel` / `sttLanguage` | Voice input: `py` + `["-3.11"]`, model `large-v3`, language `ru`. |

After editing the config, restart the bridge (sessions survive it):

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*\bridge\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }
Start-ScheduledTask -TaskName ClaudeBridge      # with the Startup shortcut instead: node .\bridge\start-bridge.js
```

Bridge log: `%LOCALAPPDATA%\ClaudeBridge\logs\bridge.log`.

### Proxy

```json
"env": {
  "HTTPS_PROXY": "http://127.0.0.1:10808",
  "NO_PROXY":    "127.0.0.1,localhost,192.168.0.0/16"
}
```

`NO_PROXY` excludes localhost and the local network so the bridge talks to the phone directly.

### Voice input

```powershell
py -3.11 -m pip install faster-whisper
```

The model is loaded into memory on first use.

### Internet access (p2p)

Needs `bridge\bin\claude-tunnel.exe` (from the release — check its SHA-256 against `SHA256SUMS.txt` — or built from source, see below) and an APK with `libclaudetunnel.so`. Enable it with `claude-mobile --device` → `i` (confirmed on the phone). If corporate policy forbids firewall rules, the tunnel is the only path.

---

## Uninstalling

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Firewall            # keep data
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Firewall -RemoveData
```

Removes the scheduled task and the Startup shortcut, stops the bridge, removes the hook from `settings.json` (with a backup), the shim and the PATH entry; `-RemoveData` deletes `%LOCALAPPDATA%\ClaudeBridge` (pairings, certificate, tokens — phones must be paired again) only if it is a recognized bridge data directory (not a drive root or a profile folder) and refuses while sessions of that directory are alive. Live sessions keep running until you exit the agent. `-DryRun` only shows the steps; `-StartupShortcut` removes only the shortcut and leaves the task. `bridge\node_modules` and the repository clone are not removed.

---

## Security

- **TLS + pinning**: the phone trusts only your PC's certificate; `claude-mobile` and the hook check the fingerprint too.
- **QR-only pairing**, one-time code (10 minutes), issued only after a human confirms (console for the first phone, then a paired phone with a check code).
- **Device tokens** are stored on the PC only as SHA-256; revoking (`claude-mobile --device`) drops connections immediately.
- **Local access** uses the owner token from `%LOCALAPPDATA%\ClaudeBridge\owner.token`; an agent gets only the narrow hook token of its session; the PC browser signs in with a one-time link (`claude-mobile --open`).
- **Network**: the bridge listens on `127.0.0.1` and one LAN address; the beacon and mDNS do not reveal the PC name; firewall rules cover the "Private" profile only.
- **Phone**: biometric lock, `FLAG_SECURE`, answering an agent from a notification requires unlocking (Android 12+).

Threat model: one user's personal PC. An agent running under your account can technically read the bridge's files; phone confirmation protects against it pairing a device or enabling internet access **by itself** through the bridge API, but not against an agent that edits the bridge's files and restarts it. With the "No permission prompts" option, an agent started from the phone is not limited to the `projects` directories. Details and known limitations: [ARCHITECTURE.md](ARCHITECTURE.md#12-известные-ограничения).

---

## Building from source

```powershell
cd bridge; npm test                                                     # bridge tests
powershell -ExecutionPolicy Bypass -File .\tools\release.ps1 -SkipApk   # claude-tunnel.exe (+ libclaudetunnel.so if the NDK is present)
cd android; .\gradlew.bat assembleDebug                                 # debug APK (JAVA_HOME — JDK 17)
```

Release (team key holder): `tools\release.ps1 -KeystorePath <key>` builds into `dist\` the PC and Android tunnel, the signed release APK, `SHA256SUMS.txt` and `RELEASE_NOTES.md`. Requires Rust (targets `x86_64-pc-windows-msvc`, `aarch64-linux-android`), JDK 17, Android SDK (build-tools 34) and NDK 28; without the NDK the Android tunnel step is skipped with a warning.

---

## Origin and license

Original project: [HelpFreedom/claude-bridge](https://github.com/HelpFreedom/claude-bridge) (Black Triangle; [video](https://www.youtube.com/watch?v=x_AXmmRxF9E), support the author: https://boosty.to/triangle_black/). Authors: [AUTHORS.md](AUTHORS.md).

[GNU General Public License v3.0](LICENSE). Please do not commit personal data (tokens, certificates, `config.json`, signing keys) — the data directory lives outside the repository, the main patterns are in `.gitignore`.
