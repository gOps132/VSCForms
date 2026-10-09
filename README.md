<!-- Improved compatibility of back to top link: See: https://github.com/othneildrew/Best-README-Template/pull/73 -->
<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/gOps132/VSCForms">
    <img src="https://raw.githubusercontent.com/gOps132/VSCForms/main/extension/media/icon.png" alt="VSCForms Logo" width="80" height="80">
  </a>

  <h3 align="center">VSCForms</h3>

  <p align="center">
    A VS Code extension that opens a WinForms <code>Form.Designer.cs</code> as a visual canvas and edits it —
    running natively on <strong>macOS, Linux, and Windows</strong> with no Wine and no Windows-only dependency.
    <br />
    <a href="https://github.com/gOps132/VSCForms/blob/main/docs/architecture.md"><strong>Explore the architecture »</strong></a>
    <br />
    <br />
    <a href="https://github.com/gOps132/VSCForms/issues/new?labels=bug&template=bug-report.md">Report Bug</a>
    &middot;
    <a href="https://github.com/gOps132/VSCForms/issues/new?labels=enhancement&template=feature-request.md">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
        <li><a href="#key-principles">Key Principles</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#quick-start">Quick Start</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#what-it-does-not-do">What It Does Not Do</a></li>
    <li><a href="#verification--testing">Verification & Testing</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#documentation">Documentation</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
## About The Project

VSCForms parses `InitializeComponent()` with Roslyn, renders it as an interactive canvas in a VS Code webview, and writes changes back as **surgical patches**: only the lines you touched change — every other byte of the file is preserved exactly (line endings, UTF-8 BOM, indentation, dialect).

### Key Principles

| Principle | Description |
|-----------|-------------|
| **Source of Truth** | The `.Designer.cs` file is never regenerated. Surgical patches preserve ~42% of statements the schema cannot model. |
| **Dialect Preservation** | Reads and writes in the file's own dialect (classic, templated, bare, this-style). |
| **Byte-Level Identity** | Preserves CRLF/LF, UTF-8 BOM, and body indentation exactly. |
| **Refusal Over Guessing** | Declines to edit forms with `Dock`/`Anchor` or `ApplyResources` rather than simulating wrongly. |
| **Coverage Transparency** | Always displays modelled vs. locked control count — it's a disclosure, not a score. |

### Built With

* [![Roslyn][Roslyn-badge]][Roslyn-url] — Microsoft.CodeAnalysis for parsing and surgical patching
* [![VS Code Extension][VSCode-badge]][VSCode-url] — Extension host and webview integration
* [![.NET 10][DotNet-badge]][DotNet-url] — Engine runtime target
* [![TypeScript][TypeScript-badge]][TypeScript-url] — Extension host and canvas logic
* [![Vanilla JS/CSS][Vanilla-badge]][Vanilla-url] — Zero-dependency design canvas
* [![xUnit][xUnit-badge]][xUnit-url] — Test framework for engine verification

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

### Prerequisites

* **.NET SDK 10.0+** — [Download](https://dotnet.microsoft.com/download)
* **Node.js 20+** — [Download](https://nodejs.org/)
* **VS Code 1.90+** — [Download](https://code.visualstudio.com/)
* **Git** — [Download](https://git-scm.com/)

<details>
<summary><strong>macOS/Linux: Wine (for running forms)</strong></summary>

```bash
# macOS (Homebrew)
brew install --cask wine-stable

# Ubuntu/Debian
sudo apt install wine64

# Verify
wine --version
```
</details>

### Installation

**From source (development):**

```bash
# 1. Clone the repository
git clone https://github.com/gOps132/VSCForms.git
cd VSCForms

# 2. Build the Roslyn engine (self-contained for your platform)
./scripts/publish-engine.js

# 3. Install extension dependencies and compile
cd extension && npm install && npm run compile && cd ..

# 4. Package the VSIX
node scripts/package-all.js

# 5. Install in VS Code
code --install-extension dist/vscforms-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m).vsix
```

**From release (when available):**

```bash
# Download latest .vsix from GitHub Releases and install
code --install-extension vscforms-<platform>.vsix
```

### Quick Start

```bash
# Open a workspace and create a new WinForms project
# In VS Code: Ctrl+Shift+P → "VSCForms: New Project…"
# Or open an existing *.Designer.cs file directly

# To run the form application:
# • In VS Code: click the ▶ icon in the editor tab bar, or press F5
#   (auto-detects Wine on macOS/Linux, runs natively on Windows)
# • From terminal: ./scripts/run-in-wine.sh [project-path]
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE -->
## Usage

### Opening a Form

1. **New Project**: `Ctrl+Shift+P` → **VSCForms: New Project…** → enter name → creates a `dotnet new winforms` project with classic `.sln` and opens `Form1.Designer.cs` in the canvas.
2. **Existing File**: Double-click any `*.Designer.cs` — VSCForms activates automatically.

### Canvas Interactions

| Action | Mouse | Keyboard |
|--------|-------|----------|
| Select control | Click | Tab / Shift+Tab |
| Move control | Drag | Arrow keys (1px), Shift+Arrow (10px) |
| Resize control | Drag handles | Alt+Arrow |
| Multi-select | Shift+Click / Drag marquee | — |
| Zoom | Ctrl+Scroll / Pinch | Ctrl++ / Ctrl+- / Ctrl+0 |
| Pan | Middle-drag / Space+Drag | — |

### Coverage Banner

The persistent banner shows:
- **Modelled** — controls with editable appearance properties
- **Locked** — controls rendered as grey boxes (type not modelled)
- **Refusal reason** — if the form cannot be edited

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- WHAT IT DOES NOT DO -->
## What It Does Not Do

VSCForms is faithful to the WinForms **design-time serializer**. It does not reproduce the WinForms **renderer** — design-time rendering *is* the real control's `OnPaint` on a real Windows `HWND`, so a webview cannot execute it. See [ADR 0006](docs/adr/0006-serializer-not-renderer.md).

| Limitation | Reason | Status |
|------------|--------|--------|
| **No Dock/Anchor layout** | Stacking/resize algorithm requires real Windows HWND | Refused — read-only with reason |
| **No `.resx` reading** | 41.6% of real forms store geometry/text in resources | Refused — half-reading is worse |
| **No pixel-perfect rendering** | Cannot call `OnPaint` on real controls | Canvas is structural, not visual |
| **No event scaffolding** | `btnSubmit_Click` generation out of scope for v1 | Planned post-v1 |
| **19 handled types only** | Chosen from 154-file corpus measurement | Containers Panel/GroupBox/TabControl/TabPage; DataGridView/ListView/TreeView placeholders display-only |

> **Measured coverage**: 47.9% per-form ceiling was measured at 10 types and is stale (predates leaf 4 + Tab 2 + placeholders 3 — now 19). Do not quote as current; re-measure needs a fresh corpus (corpus not committed). A well-structured real-world form reaches **91.4%**.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- VERIFICATION -->
## Verification & Testing

```bash
# Run all tiers (skip integration with VSCFORMS_SKIP_INTEGRATION=1)
./test/run-all.sh

# Individual tiers
./test/verify.sh                    # Roslyn invariants + real WinForms compile
./test/verify-dialects.sh           # 4 dialects + declared style, each compiles
./test/verify-generator.sh          # Project generation & round-trip read
./test/verify-rename.sh             # Rename including code-behind references
node extension/test/hostHarness.js  # Canvas DOM: rendering, locked boxes, coverage
node test/e2e.js                    # Canvas → host → engine → file
node test/run-integration.js        # Real VS Code (needs display)
./scripts/run-windows-layout.sh     # Layout tier: schema vs runtime Bounds (Windows only)
```

### Test Tiers

| Tier | Proves | Runs On |
|------|--------|---------|
| Roslyn / Dialects / Compile | Code is **valid** | Anywhere |
| Generator / Rename | Read what we write; rename leaves no dangling ref | Anywhere |
| Canvas / E2E / Integration | Plumbing is **correct** | Anywhere |
| **Layout** | **Schema matches real WinForms runtime `Bounds`** | **Windows only** |

> **Why layout tier matters**: A control at wrong coordinates still compiles and looks plausible in a screenshot. Only instantiating `System.Windows.Forms` on Windows proves semantic correctness.

<p align="right">(<a href="#readme-top">back to top</a></p>

<!-- ROADMAP -->
## Roadmap

Two open plans, both drafts, both sequenced. Read them before starting work — they explain *why* the order is what it is.

| Plan | Covers | Depends On |
|------|--------|------------|
| [`docs/spec-canvas-qol.md`](docs/spec-canvas-qol.md) | Zoom, pan, multi-select, align, copy, rulers | Nothing |
| [`docs/spec-features.md`](docs/spec-features.md) | Control types, properties, structural features | Nothing |

**Key findings:**

- **QOL comes before features on purpose.** Zoom touches every coordinate calculation (scaled `getBoundingClientRect()` returns scaled pixels). Doing that audit before 10 new controls exist is strictly cheaper.
- **Refusals matter more than the type table.** 41.6% of real forms use `ApplyResources`, 40.9% use `Dock`/`Anchor` — both refused. Adding types moves editable population far less than it looks. ADR 0003 is the highest-leverage decision.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- DOCUMENTATION -->
## Documentation

| Document | Purpose |
|----------|---------|
| [`AGENTS.md`](AGENTS.md) | Invariants a change must not break, and how to verify |
| [`docs/tracker.md`](docs/tracker.md) | Living feature & compatibility tracker — update it in the same change |
| [`SCHEMA.md`](SCHEMA.md) | Engine ↔ host ↔ canvas contract (authoritative) |
| [`CONTEXT.md`](CONTEXT.md) | Glossary and deliberate non-goals |
| [`docs/architecture.md`](docs/architecture.md) | How the three processes fit together |
| [`docs/adr/`](docs/adr/) | Architecture Decision Records |
| [`docs/agents/`](docs/agents/) | Issue tracker and triage conventions |
| [`docs/spec-leaf-widgets.md`](docs/spec-leaf-widgets.md) | Four geometry-only leaf widgets |
| [`docs/spec-properties.md`](docs/spec-properties.md) | Property modelling specification |
| [`docs/spec-rename.md`](docs/spec-rename.md) | Rename operation design |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->
## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

### Quick Contribution Guide

1. **Read** [`AGENTS.md`](AGENTS.md) — the invariants are load-bearing
2. **Read** [`CONTEXT.md`](CONTEXT.md) — use the vocabulary (Modelled Control, Locked Control, Surgical Patch, etc.)
3. **Check** existing [issues](https://github.com/gOps132/VSCForms/issues) with `ready-for-agent` label
4. **Fork** the Project
5. **Create** your Feature Branch (`git checkout -b feature/AmazingFeature`)
6. **Run** `./test/run-all.sh` before committing
7. **Commit** your Changes (`git commit -m 'Add some AmazingFeature'`)
8. **Push** to the Branch (`git push origin feature/AmazingFeature`)
9. **Open** a Pull Request

### Development Workflow

```bash
# Run engine in debug mode with logging
MF_DEBUG=1 dotnet run --project engine -- parse /path/to/Form.Designer.cs

# Develop extension with live reload
code --extensionDevelopmentPath=extension <workspace>

# Run canvas DOM tests in headless Node
node extension/test/hostHarness.js
```

### Code Style

- **C#**: Roslyn analyzers + `dotnet format` (enforced in CI)
- **TypeScript/JS**: ESLint + Prettier (run `npm run lint` in `extension/`)
- **Commits**: Conventional Commits (`feat:`, `fix:`, `refactor:`, etc.)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- LICENSE -->
## License

Distributed under the MIT License. See `LICENSE` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->
## Contact

**Gian Cedrick** — [@gOps132](https://github.com/gOps132)

Project Link: [https://github.com/gOps132/VSCForms](https://github.com/gOps132/VSCForms)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ACKNOWLEDGMENTS -->
## Acknowledgments

* [Roslyn](https://github.com/dotnet/roslyn) — The compiler platform that makes surgical parsing possible
* [VS Code Extension API](https://code.visualstudio.com/api) — For the custom editor and webview APIs
* [Best-README-Template](https://github.com/othneildrew/Best-README-Template) — This README's structure
* [Shields.io](https://shields.io) — Badge generation
* [Choose an Open Source License](https://choosealicense.com) — License guidance

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/gOps132/VSCForms.svg?style=for-the-badge
[contributors-url]: https://github.com/gOps132/VSCForms/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/gOps132/VSCForms.svg?style=for-the-badge
[forks-url]: https://github.com/gOps132/VSCForms/network/members
[stars-shield]: https://img.shields.io/github/stars/gOps132/VSCForms.svg?style=for-the-badge
[stars-url]: https://github.com/gOps132/VSCForms/stargazers
[issues-shield]: https://img.shields.io/github/issues/gOps132/VSCForms.svg?style=for-the-badge
[issues-url]: https://github.com/gOps132/VSCForms/issues
[license-shield]: https://img.shields.io/github/license/gOps132/VSCForms.svg?style=for-the-badge
[license-url]: https://github.com/gOps132/VSCForms/blob/main/LICENSE

[Roslyn-badge]: https://img.shields.io/badge/Roslyn-512BD4?style=for-the-badge&logo=.net&logoColor=white
[Roslyn-url]: https://github.com/dotnet/roslyn
[VSCode-badge]: https://img.shields.io/badge/VS_Code-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white
[VSCode-url]: https://code.visualstudio.com/api
[DotNet-badge]: https://img.shields.io/badge/.NET_10-512BD4?style=for-the-badge&logo=.net&logoColor=white
[DotNet-url]: https://dotnet.microsoft.com/download/dotnet/10.0
[TypeScript-badge]: https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Vanilla-badge]: https://img.shields.io/badge/Vanilla_JS-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black
[Vanilla-url]: https://developer.mozilla.org/en-US/docs/Web/JavaScript
[xUnit-badge]: https://img.shields.io/badge/xUnit-4A4A55?style=for-the-badge&logo=xunit&logoColor=white
[xUnit-url]: https://xunit.net/