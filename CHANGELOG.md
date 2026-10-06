# Changelog

All notable changes to VSCForms. Format follows [Keep a Changelog](https://keepachangelog.com/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]


### Added

- **ComboBox and ListBox `Items` collection**: parses `Items.AddRange` and `Items.Add`,
  surgically patches replace, insert, and delete, and adds an interactive list editor
  in the canvas inspector.
- **Four leaf widgets**: `TrackBar`, `ProgressBar`, `NumericUpDown`, `DateTimePicker`. All are
  geometry-only — none renders text, so the canvas disables `Text` for them, and none has its
  value modelled, so the canvas shows no value rather than inventing one. Handled types: 14.
- Canvas QOL: zoom (`Cmd/Ctrl`+wheel, `Cmd/Ctrl` `+`/`-`/`0`, `Fit`), space- and middle-drag
  panning, rulers, a zoom bar, multi-select, marquee select, align, distribute,
  `Cmd/Ctrl+D` duplicate, `Escape` to deselect, and a grid-snap toggle.
- `VSCForms: New Project…` — generates a WinForms project with a classic `.sln` and opens it in
  the canvas.
- Control rename, which also updates the hand-written code-behind when the reference is
  unambiguous and refuses when it is not (ADR 0008).
- Appearance properties that were already in the schema but unreachable: `Enabled`, `Visible`,
  `BackColor`, `Font`.
- Dialect detection reads `dotnet_style_qualification_for_field` from a nearby `.editorconfig` —
  advisory, and consulted only where the file itself carries no evidence.
- A `layout` CI job comparing the Form Schema against real WinForms runtime `Bounds`
  (Windows-only).

### Notes

- **Fixed: setting `BackColor` or `Font` on a control that had neither was silently discarded.**
  The patcher only ever *replaced* those two, so on a fresh project — where no control has a
  `BackColor` — the canvas accepted the colour, showed it, and the engine wrote nothing. Found by
  driving a real `dotnet new winforms` project end to end; no test tier saw it, because every
  fixture used for this had the property already present. Both now have an insert path.

- **The 47.9% per-form coverage ceiling predates the leaf widgets and has NOT been re-measured.**
  It was measured at 10 handled types; it is now 14. The measurement corpus is deliberately not
  committed (GPL-3.0 or unlicensed — see `fixtures/README.md`), so re-measuring needs a fresh
  one. `AGENTS.md` says to re-measure before changing the type table; that was not possible
  here, and the limitation is recorded rather than hidden behind an unchanged number.

## [0.1.0] — 2026-10-05

First working prototype.

### Added

- Roslyn engine (`engine/`) that parses `InitializeComponent()` into a JSON Form Schema and
  writes edits back as surgical `TextChange` patches over the original `SourceText`, preserving
  every untouched byte.
- VS Code `CustomTextEditorProvider` on `*.Designer.cs`, with a fallback text editor and
  explicit "Open as Text" escape hatches.
- Design canvas (`extension/media/`) with a draggable toolbox, 8-handle resize, snapping guides,
  a property inspector, and a mandatory coverage banner.
- Refusals for forms using `Dock`/`Anchor` or `resources.ApplyResources`, each stating its
  reason rather than rendering incorrectly.
- Locked controls for unmodelled types — shown, explained, and never written.
- Platform-targeted self-contained `.vsix` packaging per platform (~35 MB each).
- Five verification tiers: Roslyn invariants, a real WinForms compile of the generated code, a
  canvas DOM harness, end-to-end message-contract tests, and a real-VS Code integration suite.

### Known limitations

- Per-form coverage tops out at 47.9% for the 10 handled control types; only 16.2% of measured
  real forms are fully representable.
- No `TableLayoutPanel`/`FlowLayoutPanel` children — nested layout is out of scope.
- No control renaming: a rename leaves a dangling event hookup unless handlers in `Form1.cs`
  are renamed too.
- Save As refuses deliberately.
- No pixel parity with WinForms rendering; the canvas is a layout view.

[Unreleased]: https://github.com/gOps132/VSCForms/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gOps132/VSCForms/releases/tag/v0.1.0