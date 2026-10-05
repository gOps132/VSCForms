# MacForms

A VS Code extension that opens a WinForms `Form.Designer.cs` as a visual canvas and edits it —
running natively on **macOS, Linux and Windows**, with no Wine and no Windows-only dependency.

Parses `InitializeComponent()` with Roslyn, renders it as a canvas, and writes changes back as
**surgical patches**: only the lines you touched change, every other byte of the file is
preserved exactly.

## Quick start

```bash
node scripts/publish-engine.js   # self-contained engine for this platform
cd extension && npm install && npm run compile && cd ..
node scripts/package-all.js     # dist/macforms-<platform>.vsix

code --install-extension dist/*.vsix
```

Then open any `*.Designer.cs`. To read the generated source instead, use
**WinForms: Open as Text**.

Develop with `code --extensionDevelopmentPath=extension <workspace>`.

## What it does not do

A visual editor for **flat, non-localizable dialogs** — not a Visual Studio replacement. The
limits are measured, and the canvas states them on every open:

- Forms using `Dock`/`Anchor` or `resources.ApplyResources` open **read-only**, with the reason.
- Controls outside 10 types render as **locked boxes**; their code is never touched.
- **No pixel parity.** WinForms is Windows-only and that dependency is in the rendering
  primitive, so this is a *layout* view rather than a *rendering* view.
- **No event scaffolding** in v1.

Measured over 154 real Designer files: **47.9%** per-form coverage ceiling; **16.2%** of forms
fully representable.

## Verify

```bash
./test/run-all.sh
```

Four tiers — Roslyn invariants, a **real WinForms compile** of the generated code, a canvas DOM
harness, and an end-to-end pass; plus a real-VS Code integration suite. The compile tier is the
one that proves the product claim.

## Documentation

| | |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Invariants a change must not break, and how to verify |
| [`SCHEMA.md`](SCHEMA.md) | The engine ↔ host ↔ canvas contract (authoritative) |
| [`CONTEXT.md`](CONTEXT.md) | Glossary and deliberate non-goals |
| [`docs/architecture.md`](docs/architecture.md) | How the three processes fit together |
| [`docs/adr/`](docs/adr/) | Decisions worth remembering, and why |
| [`docs/agents/`](docs/agents/) | Issue tracker and triage conventions |

## License

MIT.