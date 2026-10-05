# VSCForms

A VS Code extension that opens a WinForms `Form.Designer.cs` as a visual canvas and edits it —
running natively on **macOS, Linux and Windows**, with no Wine and no Windows-only dependency.

Parses `InitializeComponent()` with Roslyn, renders it as a canvas, and writes changes back as
**surgical patches**: only the lines you touched change, every other byte of the file is
preserved exactly.

## Quick start

```bash
./scripts/new-project.sh --name MyDialog    # create a WinForms project + classic .sln
./scripts/publish-engine.js                  # self-contained engine for this platform
cd extension && npm install && npm run compile && cd ..
node scripts/package-all.js     # dist/vscforms-<platform>.vsix

code --install-extension dist/*.vsix
```

Then open any `*.Designer.cs`. To read the generated source instead, use
**WinForms: Open as Text**.

Develop with `code --extensionDevelopmentPath=extension <workspace>`.

## What it does not do

VSCForms is faithful to the WinForms **design-time serializer**. It does not reproduce the
WinForms **renderer**, and cannot — design-time rendering *is* the real control's `OnPaint` on
a real Windows `HWND`, so a webview cannot execute it. See
[ADR 0006](docs/adr/0006-serializer-not-renderer.md).

What that means in practice:

- Forms using `Dock`/`Anchor` or `resources.ApplyResources` open **read-only**, with the reason.
- Controls outside 10 types render as **locked boxes**; their code is never touched.
- The canvas is a **structural diagram** of what the serializer will emit, not a preview of
  what Windows will draw.
- **No event scaffolding** in v1.

Measured over 154 real Designer files: **47.9%** per-form coverage ceiling. A well-structured
real-world form reaches **91.4%**.

## Verify

```bash
./test/run-all.sh
```

Five tiers run anywhere: Roslyn invariants, a **real WinForms compile** of the generated code,
four Designer dialects each with its own compile gate, a canvas DOM harness, and an end-to-end
pass. Plus a real-VS Code integration suite.

A sixth tier runs only on Windows CI — and it is the one that matters most:

| Tier | Proves | Runs on |
|---|---|---|
| Roslyn / dialects / compile | the code is **valid** | anywhere |
| Canvas / e2e / integration | the plumbing is **correct** | anywhere |
| **Layout** | **the schema matches real WinForms runtime `Bounds`** | **Windows only** |

Everything local proves VSCForms writes code that compiles. Only the layout tier proves
`Location = new Point(500, 250)` actually moved the control — a control at the wrong
coordinates still compiles and still looks plausible in a screenshot. It needs Windows because
instantiating `System.Windows.Forms` does.

## What a generated project looks like

```
MyDialog.sln              classic text .sln, not .slnx
MyDialog/
  MyDialog.csproj         + <EnableWindowsTargeting> on non-Windows hosts
  MyDialog.csproj.user    load-bearing on Windows: it is what makes VS show the designer
  Program.cs
  Form1.cs
  Form1.Designer.cs       the templated dialect — VSCForms reads it correctly
```

No `Form1.resx`: the SDK template never emits one, so `InitializeComponent()` has no
`ApplyResources` call and the form is editable rather than refused.

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