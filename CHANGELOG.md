# Changelog

All notable changes to VSCForms. Format follows [Keep a Changelog](https://keepachangelog.com/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

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