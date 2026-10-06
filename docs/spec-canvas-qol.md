# Canvas QOL — panning, zooming, and the ergonomics that make it usable

**Status:** draft for review — no code changed.
**Depends on:** nothing. This is entirely inside `extension/media/canvas.js` plus CSS, with
**zero engine, schema or protocol change**, which is why it can land before the coverage work in
[`spec-features.md`](spec-features.md).

## 0. Facts this rests on (verified, not assumed)

- The canvas is **602 lines** of vanilla JS in one IIFE. `.stage` is `overflow: auto` with a
  checkerboard background; `.form-frame` is `flex: 0 0 auto` and `.canvas` is
  `position: relative; overflow: hidden`.
- **There is no scale anywhere.** Every measurement is in form pixels: `GRID = 8`,
  `left/top/width/height` set directly from `properties`, and drag math divides by `GRID` with
  no zoom term. Zoom therefore cannot be a CSS afterthought — every one of those sites needs it.
- Pointer maths uses `getBoundingClientRect()` (`beginDrag`, `beginResize`) and divides by
  `GRID` but **not** by any scale. A `transform: scale()` on an ancestor breaks both
  unconditionally, because `getBoundingClientRect` returns *scaled* pixels.
- Two gestures already own the mouse: `mousedown` on a control begins a drag,
  `mousedown` on a `.handle` begins a resize. Both stop propagation.
- Keyboard: arrows nudge by `GRID` (Shift ×10), Delete removes. The only modifier key in use is
  Shift. **Cmd/Ctrl+Z is deliberately NOT intercepted** (ADR 0004).
- The webview gets no mouse-wheel events for free: VS Code owns some, and trackpad pinch
  arrives as `ctrlKey + wheel`.
- One undo step per commit, via `CustomDocumentEditEvent` (ADR 0004). `commit()` is debounced
  220 ms.

## 1. The one decision everything else depends on

**Zoom is a canvas-level transform, never a layout one.**

`.canvas` is already `position: relative` with absolutely-positioned children, so a single
`transform: scale(s)` on `.canvas` moves every control correctly and automatically — no
per-control math, no re-render. `.form-frame` sizes itself from `clientSize`, so the frame
needs `transform-origin: top left` plus explicit scaled dimensions, or the border will not grow
with the content.

The consequence is non-negotiable and must be designed around, not discovered later:

> **A scaled element's `getBoundingClientRect()` returns scaled pixels.** Every existing
> `getBoundingClientRect()` call in `beginDrag` / `beginResize` would be off by exactly the zoom
> factor. So the moment scale ≠ 1, dragging a control to (500, 250) would land it at
> (500 × s, 250 × s).

The fix is one helper used everywhere, not scattered corrections:

```js
/** Form-space delta from a pointer event, divided out of the current zoom. */
function formDelta(ev, origin) {
    return {
        dx: (ev.clientX - origin.mx) / state.scale,
        dy: (ev.clientY - origin.my) / state.scale,
    };
}
```

And a rounding rule that must be stated because it is the difference between snapping and
drift: **round in form space, then multiply by scale.** `Math.round((dx / GRID) * GRID)` is
correct at any zoom; `Math.round((dx * scale) / GRID) * GRID / scale` accumulates error at
fractional zoom and makes a control drift away from the grid it is snapped to.

This is the whole reason QOL comes before features: every drag, resize and nudge already reads
coordinates, and they all get touched by zoom. Doing it once, first, is cheaper than auditing
them after 10 new controls exist.

## 2. Item 1 — zooming (do this first, alone)

**Scope.** Wheel to zoom, `Cmd/Ctrl`+`+` / `-` / `0`, a zoom readout, and correct pointer math.
No pan, no snapping changes.

| Input | Action |
|---|---|
| `Cmd/Ctrl` + wheel | zoom about the **cursor** (VS Code's convention; a trackpad pinch arrives this way) |
| wheel | **scroll**, not zoom — overriding plain wheel would break the muscle memory of every trackpad |
| `Cmd/Ctrl` `+` / `-` | zoom about the canvas centre |
| `Cmd/Ctrl` `0` | reset to 100% |

**Fit-to-window is deliberately not automatic.** It is one line and it is tempting, but it makes
the zoom level move underneath the user on every re-parse, which is disorienting. A
`Fit` affordance is in item 4.

Zoom range clamps to **0.25 – 4.0**. Below 0.25 the type labels are unreadable and the cost is
pure confusion; above 4 the form no longer fits any viewport and panning becomes the only
interaction. Steps are ×1.25, rounded for display (`25%`, `33%`, `50%`, `75%`, `100%`, `133%`…).

Cursor-anchored zoom needs one piece of arithmetic: the form-space point under the cursor must
stay under the cursor.

```js
const r  = canvas.getBoundingClientRect();
const fx = (ev.clientX - r.left) / state.scale;   // form-space point under the pointer
const fy = (ev.clientY - r.top)  / state.scale;
// then after changing scale, shift the scroll so fx*s lands back at the same client offset
```

**Acceptance**
- Dragging a control at 50% and 200% puts it at the coordinates shown in the inspector. Both
  asserted by moving to a known position and reading back `properties.x/y`.
- Resize honours zoom: dragging the SE handle to a client position yields the expected
  `width`/`height`.
- Arrow-key nudge still moves by `GRID` **form** units at any zoom — a nudge must never be
  "8 screen pixels".
- The zoom readout shows the current scale and resets to `100%` on `Cmd/Ctrl+0`.
- No control drifts after 10 nudge steps at 133%.

## 3. Item 2 — panning

**Scope.** Space-drag, middle-mouse drag, and scrollbar scrolling of a now-oversized surface.

| Input | Action |
|---|---|
| hold `Space` + drag | pan (cursor becomes `grab`/`grabbing`) |
| middle-mouse drag | pan |
| `Shift` + wheel | horizontal scroll |
| `Cmd/Ctrl` + wheel | zoom (from item 1) |
| plain wheel | vertical scroll |

Two implementation notes that are the difference between working and not:

- **Space must be tracked on `keydown`/`keyup` on `window`, not on the focused element.** The
  canvas has `tabIndex` on controls, so a node-level listener misses the key when focus moves.
  It also needs a **blur/visibility-change reset**, or a `Space` held while the window loses
  focus leaves the canvas stuck in pan mode — a classic and very annoying bug.
- Panning is a **view** concern. It must not post a commit, must not touch `schema`, and must
  not be undoable. Nothing here may cross the webview boundary.

## 4. Item 3 — selection and precision

The gaps that make the canvas feel imprecise rather than incomplete.

| Feature | Why it matters | Notes |
|---|---|---|
| **Multi-select** | Every alignment operation needs it, and alignment is the single most-used designer feature | `Shift`+click to extend; the schema has no selection concept, so selection is canvas state only. Bounding-box drag moves the group by one delta |
| **Marquee select** | Faster than clicking 12 controls, and it is what users expect from a canvas | Drag on empty canvas. Must not fire when the drag started on a control — the existing `mousedown` handlers already own that |
| **Snap to grid** | Currently movement always snaps to `GRID = 8`. That is a *global* snap, not a choice | Make it toggleable; snap edges to **control** edges too, not just to the grid |
| **Alignment / distribute** | The most-used feature in the VS designer, and it is pure geometry over data we already have | Needs multi-select first. `Align Left/Right/Center/Top/Middle/Bottom`, `Distribute H/V` |
| **Copy / paste / duplicate** | Every designer has it | `Cmd/Ctrl+D` duplicate is the cheap 80%: offset by `GRID`, no clipboard, no system-permissions question in a webview |
| **Escape** | Deselect. Costs one line; its absence is felt | Must also cancel an in-progress drag |
| **Z-order** | `Bring to Front` / `Send to Back` | The schema is an ordered array, so this is a real reorder the patcher must express as a *move*, not delete+insert. **This needs engine work — see below** |

**Z-order is the one item here that is not free**, and it is worth being precise about why.
`generate` diffs by `id`: a control absent from the schema is deleted, and one present but not
in the file is inserted. There is no "same control, different index" case. So a reorder is
currently unrepresentable, and doing it as delete+insert would **destroy and recreate the
control**, losing every property the schema does not model.

That is a genuine protocol gap, so z-order is split out:

> **Requires `SCHEMA.md` change + `Patcher.cs` work + an ADR note.** The patcher must learn to
> move a control's statements to a new index, and the safety question is what happens when two
> controls have identical property sets. Recommendation: refuse a reorder that would make two
> controls textually identical, since the move is then ambiguous. Until that exists, z-order is
> **out of scope** — it is listed here so it is not quietly forgotten, not because it is cheap.

## 5. Item 4 — orientation and discoverability

| Feature | Why |
|---|---|
| **Rulers** | Coordinates are meaningless without a frame of reference. Cheap: CSS repeating gradients on two edges |
| **Zoom / fit controls** | A visible affordance for item 1's state. Without it, zoom is a hidden mode |
| **Status bar shows selection count and scale** | The status line already exists; it is the natural home |
| **`Cmd/Ctrl+S` writes immediately** | Already wired to `requestParse` — but that only *re-reads*. Worth verifying it feels immediate |
| **Tooltips on the canvas** | `title` attributes exist on locked controls; extend to geometry on hover |

## 6. What this deliberately does not include

- **Pixel rendering.** ADR 0006. Zoom does not make the canvas more faithful to what Windows
  draws; it makes the *diagram* easier to read. Conflating those would be dishonest.
- **Touch gestures.** Trackpad wheel and space-drag cover the real cases. A webview in VS Code
  on a touchscreen is a poor experience regardless.
- **A local undo stack.** ADR 0004. Every one of these features routes through the existing
  debounced `commit()`, so undo keeps working through VS Code for free — as long as none of them
  writes the schema outside `commit()`. That constraint is the reason panning and zoom are
  specified as view-only.
- **Collapsible panels, tabbed documents, docking.** Those belong to VS Code, not to us.

## 7. Test plan

The canvas harness (`extension/test/hostHarness.js`) runs the real canvas code against a tiny
DOM. That is enough for most of this, and the parts it cannot reach need saying out loud.

| Feature | Covered by |
|---|---|
| zoom applies a transform; readout correct; clamp at both ends | harness: assert `canvas.style.transform` |
| drag maths divides out the scale | harness: synthetic pointer at a known client offset, assert `properties.x` |
| nudge is in form units at any zoom | harness: set scale, press arrow, assert delta is `GRID` not `GRID * s` |
| `Space` released on blur | harness: dispatch `blur`, assert pan mode cleared |
| pan posts no commit | harness: assert `__sent` empty after a pan gesture |
| marquee does not hijack a control drag | harness: mousedown on a control, assert one control selected not a marquee |
| wheel without `ctrlKey` scrolls, does not zoom | harness |

**Not coverable here, and must be verified by hand once:** real trackpad pinch, real
`Cmd/Ctrl+0`, and whether zoom-about-cursor feels right. A synthetic `ctrlKey + wheel` proves the
arithmetic, not the feel.

## 8. Open decisions

1. **Plain wheel scrolls; only `Cmd/Ctrl`+wheel zooms** (recommended). The alternative — wheel
   always zooms — is what some canvas apps do and it breaks trackpad muscle memory.
2. **No auto-fit on load** (recommended). Auto-fit moves the zoom level under the user on every
   re-parse. A `Fit` button instead.
3. **Grid snap stays the default but becomes toggleable** (recommended). Turning snapping off by
   default would change how every existing movement behaves, for no gain.
4. **Z-order is deferred** pending a patcher move + an ADR (see §4). Shipping it as
   delete+insert would destroy unmodelled properties — a data-loss bug, not a missing feature.
5. **`Cmd/Ctrl+D` duplicates** rather than clipboard copy/paste (recommended for now). Clipboard
   in a webview needs permissions; duplicate gets most of the value for none of the risk.