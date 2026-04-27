# bun-compiled-extractor

[English](#english) | [繁體中文](#繁體中文)

---

## English

A pure-Node, zero-dependency extractor for `bun build --compile` single-file
executables. Works on **Linux (ELF)**, **macOS (Mach-O)** and **Windows (PE)**
with the same code path — no `objcopy`, no `binutils`, no platform branching.

It also ships a build script that takes the official
`@anthropic-ai/claude-code-<platform>` npm package, extracts its JS payload,
unwraps the CJS IIFE, and wires up Node-side dependencies so the CLI runs on
plain `node` — useful when the bun-compiled binary cannot run on your host
(old CPUs without SSE4.2 / POPCNT, exotic libc, etc.).

### Why

`bun build --compile` does not actually compile JS to machine code; it
embeds the JS source as a payload inside a self-extracting binary. Existing
extractors either depend on `objcopy` (Linux-only) or are written in Rust /
Python with bigger surface areas. This repo is ~250 lines of Node, no native
deps, all three platforms.

### How it works

The Bun runtime locates its own payload by scanning for a fixed trailer at
the end of the file:

```
... [bundle: byte_count bytes] [Offsets 32B] [trailer "\n---- Bun! ----\n" 16B] ...
```

So do we. Reading `byte_count` from `Offsets` reveals the start of the
bundle — which is all that matters. The ELF / Mach-O / PE wrapper around
it is irrelevant. Reference:
[`StandaloneModuleGraph.zig`](https://github.com/oven-sh/bun/blob/main/src/StandaloneModuleGraph.zig).

### Install / use

```bash
git clone https://github.com/Sunalamye/bun-compiled-extractor.git
cd bun-compiled-extractor

# Extract any bun --compile binary
node scripts/extract.cjs path/to/your-bun-binary out/

# Build a Node-runnable Claude Code (auto-detects platform)
./scripts/build-claude-code.sh
# or pin a version / platform
./scripts/build-claude-code.sh 2.1.119 darwin-arm64
```

`out/<version>-<platform>/cli.js` is a directly executable Node script.

### Requirements

- Node.js ≥ 18 (uses `Buffer.lastIndexOf`, `readBigUInt64LE`, `TransformStream`)
- `npm` (only for the Claude Code build script)

### Limitations

- The native `.node` modules embedded by Claude Code (image processing, audio
  capture, computer-use bridges) are platform-specific. They extract fine but
  only run on the architecture they were built for, and several still require
  modern CPU instructions. Plain text conversation does not load them.
- The extracted `cli.js` may still reference `Bun.*` / `bun:ffi` / `bun:jsc`
  globals on minor code paths. The hot path has Node fallbacks (Anthropic
  shipped a Node build until 2.1.112), but if you hit `Bun is not defined`,
  add a shim and open an issue.

### Prior art

| Tool | Lang | Notes |
|---|---|---|
| [iivankin/debun](https://github.com/iivankin/debun) | Rust | Most complete; ELF + Mach-O + PE; supports repack/patch |
| [can1357/unbun](https://github.com/can1357/unbun) | Python | Stdlib only, trailer-only — closest equivalent |
| [vicnaum/bun-demincer](https://github.com/vicnaum/bun-demincer) | JS | Heavier: deobfuscation + rebundling |
| [lafkpages/bun-decompile](https://github.com/lafkpages/bun-decompile) | JS | Outdated for Bun 1.3+ |

This repo's niche: pure Node, all three platforms via trailer-scan, plus the
Claude-Code-specific Node-wrapping pipeline.

### License

MIT.

### Acknowledgements

The Claude-Code-specific build pipeline (IIFE unwrap → npm-install externals
→ smoke test) is descended from
[ponzu840w/claude-code-on-node](https://github.com/ponzu840w/claude-code-on-node),
which solved the original "run on a Penryn" problem on Linux. This repo
generalises the extractor to all three platforms via trailer-scan.

---

## 繁體中文

純 Node、零原生依賴的 `bun build --compile` 單檔可執行檔抽取器。**Linux (ELF)**、**macOS (Mach-O)**、**Windows (PE)** 一份程式碼通吃 —— 不需要 `objcopy`、不需要 `binutils`、不分平台分支。

附帶一支 build script：抓官方 `@anthropic-ai/claude-code-<platform>` npm 套件，抽出 JS payload，剝掉 CJS IIFE 包裝，補上 Node 端依賴，讓 CLI 直接在 `node` 上跑。當 bun-compiled binary 在你的機器上跑不起來（老 CPU 沒 SSE4.2 / POPCNT、特殊 libc 等）就有用。

### 為什麼做這個

`bun build --compile` 並不是把 JS 編成機器碼，而是把 JS 原始碼當 payload 塞進自解壓的 binary。現有抽取器要嘛靠 `objcopy`（只能用在 Linux），要嘛是 Rust / Python 寫的、依賴比較重。這個 repo 約 250 行 Node、無原生依賴、三平台通用。

### 原理

Bun runtime 自己也是用「尾端固定 trailer」來定位 payload：

```
... [bundle: byte_count bytes] [Offsets 32B] [trailer "\n---- Bun! ----\n" 16B] ...
```

我們照做：從檔尾倒掃 trailer，往前讀 32 bytes 的 Offsets 拿到 `byte_count`，再往前推 `byte_count` bytes 就是 bundle 起點。外殼是 ELF / Mach-O / PE 都無關緊要。格式參考：[`StandaloneModuleGraph.zig`](https://github.com/oven-sh/bun/blob/main/src/StandaloneModuleGraph.zig)。

### 安裝 / 使用

```bash
git clone https://github.com/Sunalamye/bun-compiled-extractor.git
cd bun-compiled-extractor

# 抽出任意 bun --compile binary
node scripts/extract.cjs path/to/your-bun-binary out/

# 建構可在 Node 上跑的 Claude Code（自動偵測平台）
./scripts/build-claude-code.sh
# 或指定版本 / 平台
./scripts/build-claude-code.sh 2.1.119 darwin-arm64
```

產物 `out/<version>-<platform>/cli.js` 可直接執行。

### 需求

- Node.js ≥ 18
- `npm`（只有 build script 需要）

### 限制

- Claude Code 內嵌的 `.node` 原生模組（影像處理、錄音、computer-use 橋接）是平台/架構特定的；抽得出來但只能在原架構上跑，部分還要新 CPU 指令。純文字對話路徑不會載入。
- 抽出的 `cli.js` 在邊角路徑可能還引用 `Bun.*` / `bun:ffi` / `bun:jsc`。主要路徑因為 2.1.112 前 Anthropic 還有發 Node 版，所以多半有 fallback；遇到 `Bun is not defined` 就加 shim 並回報 issue。

### 先行作品

| 工具 | 語言 | 說明 |
|---|---|---|
| [iivankin/debun](https://github.com/iivankin/debun) | Rust | 功能最齊；三平台齊全；支援 repack/patch |
| [can1357/unbun](https://github.com/can1357/unbun) | Python | 純 stdlib、走 trailer-scan，最接近本 repo 思路 |
| [vicnaum/bun-demincer](https://github.com/vicnaum/bun-demincer) | JS | 較重：含 deobfuscation 與重新打包 |
| [lafkpages/bun-decompile](https://github.com/lafkpages/bun-decompile) | JS | 對 Bun 1.3+ 已失效 |

本 repo 的定位：純 Node、trailer-scan 三平台通用、附 Claude Code 的 Node 化 pipeline。

### 授權

MIT。

### 致謝

Claude Code 的 Node 化 pipeline（剝 IIFE → `npm install` 外部依賴 → smoke test）思路來自 [ponzu840w/claude-code-on-node](https://github.com/ponzu840w/claude-code-on-node)，他原本解決的是 Linux Penryn CPU 的問題。本 repo 把抽取階段推廣到三平台。
