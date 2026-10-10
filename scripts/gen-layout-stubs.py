#!/usr/bin/env python3
"""Generate Stubs.cs for the Windows layout harness (scripts/run-windows-layout.sh).

The harness copies the Designer file VERBATIM and therefore cannot compile it
standalone when the file references code that lives outside it:

- event handlers defined in the hand-written Form1.cs
  (`Click += new System.EventHandler(this.btnGo_Click)`), and
- third-party control types from assemblies we do not reference
  (`new Acme.Widgets.GaugeControl()`).

This script emits the missing halves the same way Shim.cs supplies the Form
base class and constructor: handler methods on the form partial, and
Control-derived stub classes for unknown types (with stub properties inferred
from the assignments in the file). The Designer copy itself is never rewritten.

Anything without a mechanical rule is LEFT OUT so the staged build fails loudly
instead of testing a guess:

- a delegate shape that is neither `EventHandler<T>` nor `<X>EventHandler`
  (plus the `MethodInvoker` special case) gets no handler stub;
- an unqualified unknown type (no namespace to put the stub in) gets no stub;
- events on stub-typed controls get no stub (the delegate is unknowable).

Usage:
    gen-layout-stubs.py <Designer.cs> <schema.json> <NS> <CLASS> <Stubs.cs>

`<schema.json>` is the engine's parse response (`{"ok": true, "schema": {...}}`)
or the bare schema — both are accepted. NS may be empty (no namespace in file).
"""

import json
import re
import sys

DESIGNER_PATH, SCHEMA_PATH, NS, CLASS, OUT_PATH = sys.argv[1:6]

# Members a System.Windows.Forms.Control already provides. Assignments to these
# on a stub-typed field resolve through inheritance and need no stub property.
# Anything missed here still compiles: the fallback emits `public new object`,
# which hides the inherited member with at most a warning, never an error.
CONTROL_MEMBERS = {
    "Anchor",
    "AutoScroll",
    "AutoSize",
    "AutoSizeMode",
    "BackColor",
    "BackgroundImage",
    "BackgroundImageLayout",
    "Bounds",
    "ClientSize",
    "ContextMenuStrip",
    "Cursor",
    "Dock",
    "Enabled",
    "FlatStyle",
    "Font",
    "ForeColor",
    "ImeMode",
    "Image",
    "ImageAlign",
    "ImageIndex",
    "ImageKey",
    "Location",
    "Margin",
    "MaximumSize",
    "MinimumSize",
    "Name",
    "Padding",
    "RightToLeft",
    "Size",
    "TabIndex",
    "TabStop",
    "Tag",
    "Text",
    "TextAlign",
    "TextImageRelation",
    "UseVisualStyleBackColor",
    "UseWaitCursor",
    "Visible",
}


def infer_type(value):
    """C# type for a stub property from its assigned literal. Writes must compile;
    reads never occur in InitializeComponent, so `object` is always a safe fallback."""
    v = value.strip()
    if re.fullmatch(r"[+-]?\d+", v):
        return "int"
    if re.fullmatch(r"[+-]?[\d.]+[mM]", v):
        return "decimal"
    if re.fullmatch(r"[+-]?[\d.]+[fF]", v):
        return "float"
    if re.fullmatch(r"[+-]?(\d+\.\d*|\.\d+)", v):
        return "double"
    if v.startswith('"'):
        return "string"
    if re.fullmatch(r"'.'", v):
        return "char"
    if v in ("true", "false"):
        return "bool"
    return "object"


def main():
    text = open(DESIGNER_PATH, encoding="utf-8-sig").read()
    doc = json.load(open(SCHEMA_PATH))
    schema = doc.get("schema", doc)

    def walk(nodes):
        for n in nodes:
            yield n
            yield from walk(n.get("children", []))

    # Unknown types: locked controls outside the System.* assemblies. Locked
    # System.Windows.Forms types (MenuStrip, …) come from the real assembly and
    # must NOT be stubbed — a duplicate declaration is a compile error.
    unknown_types = sorted(
        {
            n["type"]
            for n in walk(schema.get("controls", []))
            if n.get("locked")
            and "." in n.get("type", "")
            and not n["type"].startswith("System.")
        }
    )

    # Field declarations: `private <Type> <name>;`
    fields = dict(
        (name, typ) for typ, name in re.findall(r"private\s+([\w.]+)\s+(\w+)\s*;", text)
    )

    lines = [
        "// Generated staging stubs for the copied Designer file.",
        "// See scripts/gen-layout-stubs.py: the Designer copy stays verbatim;",
        "// this file supplies the halves that live outside it (handlers,",
        "// third-party types). Anything unshaped is left out on purpose —",
        "// a missing stub fails the staged build loudly instead of testing a guess.",
        "",
    ]

    # Third-party type stubs, grouped by namespace.
    by_ns = {}
    for t in unknown_types:
        ns2, _, name = t.rpartition(".")
        by_ns.setdefault(ns2, []).append(name)

    assign_re = re.compile(r"(?:this\.)?(\w+)\.(\w+)\s*=\s*(.+?);")
    isi_re = re.compile(
        r"\(\s*System\.ComponentModel\.ISupportInitialize\s*\)"
        r"\s*\(\s*(?:this\.)?(\w+)\s*\)"
    )

    isi_fields = {
        m.group(1)
        for m in isi_re.finditer(text)
        if fields.get(m.group(1)) in unknown_types
    }

    assigned = {}
    for m in assign_re.finditer(text):
        recv, member, value = m.group(1), m.group(2), m.group(3)
        if fields.get(recv) in unknown_types:
            assigned.setdefault((fields[recv], member), value.strip())

    for ns2 in sorted(by_ns):
        lines += [f"namespace {ns2}", "{"]
        for name in sorted(by_ns[ns2]):
            full = f"{ns2}.{name}"
            isi = (
                ", System.ComponentModel.ISupportInitialize"
                if full in {fields[f] for f in isi_fields}
                else ""
            )
            lines += [f"    class {name} : System.Windows.Forms.Control{isi}", "    {"]
            if isi:
                lines += [
                    "        public void BeginInit() {}",
                    "        public void EndInit() {}",
                ]
            for t, member in sorted(assigned):
                if t != full or member in CONTROL_MEMBERS:
                    continue
                lines += [
                    f"        [System.ComponentModel.DesignerSerializationVisibility("
                    f"System.ComponentModel.DesignerSerializationVisibility.Hidden)]",
                    f"        public new {infer_type(assigned[(t, member)])} "
                    f"{member} {{ get; set; }}",
                ]
            lines += ["    }"]
        lines += ["}"]

    # Handler stubs on the form partial. `this.M` resolves in the same class,
    # so private is correct. A method the Designer already defines is skipped;
    # a delegate without a mechanical rule gets no stub (loud compile error).
    wire_re = re.compile(r"\+=\s*new\s+([\w.]+)(?:<([^>]+)>)?\s*\(\s*this\.(\w+)\s*\)")
    defined = set(re.findall(r"void\s+(\w+)\s*\(", text))
    handlers = []
    seen = set()
    for m in wire_re.finditer(text):
        deleg, targ, method = m.group(1), m.group(2), m.group(3)
        if method in defined or method in seen:
            continue
        if targ:
            args = targ.strip()
        elif deleg.endswith("MethodInvoker"):
            args = "()"
        elif deleg.endswith("Handler"):
            args = deleg[: -len("Handler")] + "Args"
        else:
            continue
        seen.add(method)
        handlers.append((method, args))

    if handlers:
        if NS:
            lines += [f"namespace {NS}", "{"]
        lines += [f"    partial class {CLASS}", "    {"]
        for method, args in handlers:
            if args == "()":
                lines.append(f"        private void {method}() {{}}")
            else:
                lines.append(
                    f"        private void {method}(object sender, {args} e) {{}}"
                )
        lines += ["    }"]
        if NS:
            lines.append("}")

    open(OUT_PATH, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    n_types = sum(len(v) for v in by_ns.values())
    print(f"stubs: {n_types} type(s), {len(handlers)} handler(s)")


main()
