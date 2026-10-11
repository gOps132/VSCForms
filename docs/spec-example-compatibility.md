# Example Demo + WinForms Compatibility Spec

**Status:** draft for review — no code changed.
**Scope:** (A) make `example/` an open-in-designer + compile-check demo, (B) record the full WinForms compatibility picture and phased roadmap. Part A is committable now; Part B is sequenced work, not a single change.

## 0. Facts (verified, not assumed)

- `example/` is a full clone of `flurgerburger/Washing_Machine_Timer-Fuzzy_Logic` with a nested `example/.git/` (not a submodule), plus committed `bin/`, `obj/`, `.DS_Store`. Root `.gitignore` ignores none of it. `example/.gitignore` (VS standard) ignores `bin/`/`obj/`, but the nested repo means parent git sees the whole directory as untracked (`?? example/`).
- `example/Form1.Designer.cs`: 48 instantiations → 48 **Modelled Controls**, 0 **Locked Controls**. **Coverage 100%**, no **Refusal** (no `ApplyResources`, no `Dock`/`Anchor`; the sibling `Form1.resx` is headers-only and never called from `InitializeComponent()`). Composition at flatten time (`parse`, 11 Oct 2026): 19 `Label`, 8 `GroupBox`, 5 `PictureBox`, 4 `TrackBar`, 2 each `ComboBox`/`Button`/`CheckBox`, 1 each `TextBox`/`RadioButton`/`ListBox`/`Panel`/`ProgressBar`/`DateTimePicker`. The snapshot carries local additions over upstream (one of each handled type), which is why it reads 48 and not the upstream count.
- `csproj` is `net7.0-windows` + `UseWindowsForms=true`, no `EnableWindowsTargeting` → `dotnet build` fails on macOS as-is. Solution is `.slnx`-only (VS 17.13+ XML). A `WinExe` cannot execute on macOS regardless; the extension never builds or launches apps — it emits a **Surgical Patch** over the Designer File only.
- Engine handles 19 widget types + `Form` (`engine/src/TypeTable.cs:13-43`); canvas mirrors them (`extension/media/canvas.js` `HANDLED:145-171`). Full .NET 7–10 surface is 77 controls (9 legacy Framework-only excluded). Containers modelled today: `Panel`, `GroupBox`, `TabControl`, `TabPage`; `DataGridView`, `ListView`, `TreeView` are read-only placeholders (labelled boxes, no interior).

## 1. Part A — `example/` demo workspace

**Role: manual demo only.** Explicitly excluded from `test/run-all.sh`, `test/verify.sh`, and the `.vsix`. It is a real-world messy form (good for showing Locked Controls + Coverage Banner), not a pinned fixture. `fixtures/` stays hand-authored per `AGENTS.md`.

### A1. Hygiene

- Flatten to plain files: delete `example/.git/`, `example/bin/`, `example/obj/`, `example/.DS_Store`.
- Append to root `.gitignore`:
  ```
  example/bin/
  example/obj/
  ```
- Do NOT convert to submodule. Do NOT add to `fixtures/`.

### A2. Toolchain (demo copy diverges from upstream on purpose)

- Retarget demo copy to `net10.0-windows`, add `<EnableWindowsTargeting>true</EnableWindowsTargeting>` (same trick as `test/verify.sh:142-189`), keep `UseWindowsForms=true`, `OutputType=WinExe`.
- Keep the `.slnx`; add a classic `Washing_Machine_Timer-Fuzzy_Logic.sln` beside it so the VS Code C# extension and older SDKs open it.
- Keep `Form1.resx` as-is (empty). Do not introduce `ApplyResources` calls.

### A3. Acceptance

1. `code --extensionDevelopmentPath=$PWD/extension example` → open `Form1.Designer.cs` → designer opens editable, Coverage Banner reads 48/48 modelled, 0 locked, no refusal.
2. Move a `Label`, edit `btnCalculate` `Text` → file diff touches only those statements (`MF_DEBUG=1` shows spans); `Click +=` / `Scroll +=` wirings, `BeginInit`/`EndInit`, `SuspendLayout`/`ResumeLayout` preserved byte-identical.
3. `dotnet build example/Washing_Machine_Timer-Fuzzy_Logic.csproj` passes on macOS (compile-check via ref pack; offline skips cleanly) — after the A2 retarget only. The #30 hygiene change does not retarget, so this check rides with the retarget work, not the flatten. Running the app is explicitly out of scope (requires Windows).

## 2. Part B — compatibility picture + roadmap

### B1. Control catalog (.NET 7–10, 77 total)

- T1 core inputs (21): we model 12 (`Button`, `Label`, `TextBox`, `CheckBox`, `RadioButton`, `ComboBox`, `ListBox`, `PictureBox`, `TrackBar`, `ProgressBar`, `NumericUpDown`, `DateTimePicker`). Still missing: `LinkLabel`, `RichTextBox`, `MaskedTextBox`, `CheckedListBox`, `MonthCalendar`, `H/VScrollBar`, `DomainUpDown` (tracker B5).
- T2 containers/layout (~12): we model `Panel`, `GroupBox`, `TabControl`/`TabPage`. Still missing: `SplitContainer`, `FlowLayoutPanel`, `TableLayoutPanel`, `ToolStripContainer/Panel`, `Splitter`, `UserControl`.
- T3 menus/toolstrips (5 hosts + 13 item types): `MenuStrip`, `ToolStrip`, `StatusStrip`, `ContextMenuStrip`, `BindingNavigator`. Items are not `Control`s (no `Location`/`Size`) — unmodellable by construction without a new schema shape.
- T4 data/complex: `DataGridView` (+6 column types), `ListView`, `TreeView`, `PropertyGrid`, `WebBrowser`, `BindingSource`. The first three render as read-only placeholders (columns/nodes/items preserved but invisible, `Text` disabled); the rest are unmodelled. Column/node editing stays out (tracker B4 partial).
- T5 dialogs / T6 tray (`OpenFileDialog`, `Timer`, `NotifyIcon`, `ImageList`, `ToolTip`, `ErrorProvider`, …): non-visual by design — belong in `NonVisualFields`, never the handled table.

### B2. Features beyond controls

`Dock`/`Anchor` → whole-form **Refusal** (40.9% of corpus). `ApplyResources` → **Refusal** (41.6%). Both deliberate per ADR 0003. Preserved-but-invisible: `AutoScaleMode/Dimensions`, `AutoSize`, `Margin/Padding`, `ClientSize` vs `Size`, `Items.AddRange` on handled `ComboBox`/`ListBox`, `+=` wiring, `SuspendLayout/ResumeLayout`, `BeginInit/EndInit`. Former silent-divergence risks now warn read-only via `analysis.warnings`: `RightToLeft` mirroring (C1 #16), surprising `Margin`/`Padding`/`AutoSize`/scale/`Size`-without-`ClientSize` (C3 #18). Still zero handling: `TableLayoutPanel` children with default `Dock`/`Anchor` shown flat (C2 #17).

### B3. Phased roadmap (ranked by frequency × editable-context ÷ cost)

- **Shipped since (no longer roadmap): Phase 1** leaf widgets `DateTimePicker`, `NumericUpDown`, `TrackBar`, `ProgressBar` (geometry + shared min/max/value; `example/` now parses 100%); **Phase 2** `TabControl + TabPage` (containers, tab-strip, `Controls.Add` parenting); **Phase 3** `DataGridView`, `ListView`, `TreeView` as read-only placeholders; **`ComboBox`/`ListBox.Items`** (`Add`/`AddRange`, items list editor). Remaining follow-ups are tracker rows, not phases: A5 (`SelectedIndex`/`DropDownStyle`/drag-reorder), B5 (T1 leaves by corpus frequency), B7 (DTP value/format), B4 interiors (visibility only).
- **Deferred (needs ADR work):** `SplitContainer` (M/L — `Panel1/Panel2.Controls.Add` parser mapping + optional `SplitterDistance` schema addition); `MenuStrip/ToolStrip/StatusStrip` (M — cosmetic, hosts refuse anyway); `TableLayoutPanel/FlowLayoutPanel` (L — _contradicts ADR 0003's "second layout language" stance if rendered absolutely; only honest options are a new `layout-panel` refusal or full simulation. Do not start without an ADR amendment._).

Cheapest high-value schema extensions outside types are done (`Items`, `tabIndex`); the open follow-ups are per-row work (A5, B5, B7), not phases.

## 3. Verification

- Part A: the three acceptance checks in A3. No new test tiers; `fixtures/` untouched.
- Phase 1+: per-type fixture + exact-diff test in `test/verify.sh` style, canvas DOM case in `extension/test/hostHarness.js`, and a real-compile pass (`net10.0-windows` + `EnableWindowsTargeting`) proving the patched file still builds.

## 4. Open decisions (grill frontier, recommendations as defaults)

1. Role = demo-only, excluded from tests/vsix (recommended) vs wired fixture.
2. "Run" = Mac compile-check (recommended) — actual execution needs Windows; extension never runs apps.
3. ~~`TrackBar` locked acceptable for the demo (recommended) vs pulling it into Phase 1 scope.~~ Moot — leaf widgets shipped, `example/` parses 100% with no locked controls.
4. Flatten + ignore (recommended) vs submodule vs as-is. (#30 implements flatten.)
5. Retarget demo to `net10` + flag + classic `.sln` (recommended) vs faithful-to-upstream `net7` + `.slnx`-only. (Open — #30 is hygiene-only; A3.3 rides with the retarget.)

Confirm or override per line; Part A implements as specified on confirmation.
