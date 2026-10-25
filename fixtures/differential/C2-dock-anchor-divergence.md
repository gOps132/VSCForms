# C2 — Silent divergence: TableLayoutPanel children shown flat

Per ADR 0003 and tracker C2: children of `TableLayoutPanel` with default
`Dock`/`Anchor` are shown flat (absolutely positioned) in the canvas,
which contradicts the layout semantics. This is a visibility-only
warning (not a refusal), preserved in the file untouched.
The real fix requires either a layout-panel refusal or full simulation —
both deferred to ADR 0003 amendment.
