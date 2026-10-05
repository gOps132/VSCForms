# The target is the serializer, not the renderer

MacForms aims to be faithful to the WinForms **design-time serializer**. It does not, and
cannot, reproduce the WinForms **designer renderer**.

## Context

Design-time rendering in Visual Studio is the *real control's own paint*. The designer does
not draw controls; it replaces each control's window target and lets the control paint itself
into a real `HWND`, then overlays adornments:

```
ControlDesigner swaps Control.WindowTarget   →  ControlDesigner.WndProc(WM_PAINT)
  →  DefWndProc(ref m)                       ←  the control paints itself
  →  OnPaintAdornments(pevent)               ←  the designer adds handles, snap lines, glyphs
```

(`ControlDesigner.cs:2050-2107`, `ChildWindowTarget.cs:34-50`, `Control.cs:12617`)

So a control's appearance is whatever its `OnPaint` draws, executed by a CLR on Windows.
Controls that do not self-paint delegate to native window classes — `ListView`, `TreeView`,
`TextBox`, `ComboBox`, `TrackBar` — which are `comctl32`/`USER32` classes. There is no
portable description of any of it in any file MacForms can read.

This is not a difficulty estimate. `System.Windows.Forms.Primitives` P/Invokes ~700 Win32
entrypoints, `System.Private.Windows.GdiPlus` ~400 `Gdip*` calls, and there is no POSIX
fallback path anywhere in the tree. `System.Drawing.Common` lost non-Windows support in .NET 7
with no switch to restore it.

## Decision

Do not treat visual parity as the goal. Treat the serializer as the goal: given the same form
state, produce the code Visual Studio would produce — correct dialect, correct ordering,
changed properties only — and render the canvas as a *structural diagram* of that serializer
output rather than a preview of the runtime.

## Evidence this is the achievable goal

1. **The serializer's rules are open and fully specified.** `ControlCodeDomSerializer` defines
   `StatementOrdering.{Prepend,Append}`, `OrderedCodeStatementCollection.Order` (which
   preserves ZOrder), the `PerformLayout` condition, and the
   `RootComponent || HasSitedNonReadonlyChildren` gate that decides whether a container gets
   `SuspendLayout`/`ResumeLayout` at all. Nothing there needs an assembly to load.
2. **Visual Studio itself emits only changed properties.** Microsoft's docs: *"It serializes
   only properties that have been modified in order to minimize the output."* Modern VS is a
   surgical patcher, not a regenerator — which is exactly what ADR 0001 concluded before this
   was known.
3. **The dialects are declared, not guessed.** Code-behind generation respects `.editorconfig`:
   `dotnet_style_qualification_for_field`, `..._for_property`, plus `<ImplicitUsings>` from the
   csproj. MacForms infers the dialect from file content, which works, but reading the
   declaration would be more principled.
4. **Every attempt at the renderer has failed.** Mono's `mwf-designer` is archived — blocked on
   `WS_EX_TRANSPARENT` and a GDI+/Cairo model mismatch. Visual Studio for Mac, the only
   shipping cross-platform WinForms designer, was retired 2024-08-31. Asked directly whether
   .NET Core WinForms would reach Linux, the WinForms team lead answered: *"No."*
5. **The surviving competitor is Windows-only.** `salanthreedimension/WSFormsEditor` has nearly
   identical architecture (Roslyn + webview + JSON) and its own README states it requires
   Windows, because its preview is an HTML simulation that does not load the WinForms assembly.

## Consequences

- The Coverage Banner discloses **serializer** coverage, not visual fidelity. The
  `dock-anchor` and `localizable` refusals are refusals of the serializer, which is the honest
  framing: we decline because we cannot produce correct code, not because we cannot draw.
- "Pixel parity" is not a roadmap item. It is not a thing this project can do. Saying so in the
  README is more useful than an aspiration nobody can reach.
- Wine is not a route to the renderer. It would also multiply the packaging problem ADR 0002
  exists to solve, and there is no primary source that the real designer runs under Wine.
- Where rendering fidelity *is* wanted — as ground truth for a human — the answer is a
  `windows-latest` CI job, not a local emulation layer. See
  [the layout verification](scripts/run-windows-layout.sh), which compares our schema against
  real runtime `Bounds` rather than against pixels, because a control at the wrong coordinates
  looks fine in a screenshot and is only wrong if you measure it.