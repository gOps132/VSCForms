#!/usr/bin/env python3
"""Deterministic differential-matrix generator.

WHY THIS EXISTS
  The layout tier (`scripts/run-windows-layout.sh`) is the only tier that can prove VSCForms
  is *semantically* right rather than merely valid. But it only exercises the hand-authored
  fixtures in `fixtures/`, one hand-picked case at a time. A property that only has a REPLACE
  path is therefore invisible until someone types it into a form by hand — which is exactly how
  `BackColor` and `Font` shipped with no INSERT path, and how the TextBox `TextAlign` bug
  (`System.Drawing.ContentAlignment.Left`, which does not exist) survived every tier.

  The contract in `docs/agents/workflow.md` §3 says the oracle is driven by a DETERMINISTIC
  PERMUTATION MATRIX, not random fuzzing: random property fuzzing generates non-compiling
  rubbish that needs heavy filtering, and it is not reproducible. This generator is that matrix.

WHAT IT PRODUCES
  A directory containing:
    matrix.json  — the manifest: every case, its dialect/hierarchy/type/variant, the file,
                   the subject control, and the properties present in that variant.
    cases/<id>/<Class>.Designer.cs — one Designer file per case.

  The files are NOT committed. Only a DIVERGENCE is committed, as
  `fixtures/differential/<issue>-<name>.Designer.cs` — that is the fixture-first gate. A
  matrix of several hundred generated files in git would be noise, and the repo's rule is that
  fixtures are hand-authored precisely so tests can assert exact diffs.

DETERMINISM
  Same arguments => byte-identical output. No randomness, no timestamps, no dict-order
  dependence, no locale dependence. The axes are iterated in a fixed order and the manifest is
  written with sorted keys. A matrix that changed between two runs of the same commit would
  make every divergence report meaningless.

WHAT THE GENERATOR IS NOT
  It is not Visual Studio. It is a faithful stand-in for the *shape* Visual Studio writes, so
  that the engine's patch can be compared against the file it claims to be editing. The
  generator writes CORRECT C# — including `System.Drawing.HorizontalAlignment` for a TextBox,
  which is the whole point: when the engine rewrites that to `ContentAlignment`, the
  difference is the engine's error, not the generator's.

USAGE
  python3 scripts/gen-differential-matrix.py --out <dir> [--families control,form,encoding]
  python3 scripts/gen-differential-matrix.py --out <dir> --list     # print the case count
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# --------------------------------------------------------------------------- axes

# The four Designer dialects, from SCHEMA.md "Dialects".
#
#   classic   this.x = new System.Windows.Forms.Button();   this.Controls.Add(this.x)
#   templated no controls at all; form members bare and unqualified
#   bare      x = new Button();                               Controls.Add(x)
#   this-style this.x on control members, bare on the Controls collection and form members
#
# `this_prefix` is the `UsesThisPrefix` signal (control members).
# `controls_qualified` is the `ControlsCollectionIsQualified` signal (the Controls collection).
# `qualified_types` / `qualified_drawing` are the type-name spellings.
DIALECTS = [
    dict(
        name="classic",
        this_prefix=True,
        controls_qualified=True,
        qualified_types=True,
        qualified_drawing=True,
        file_scoped_ns=False,
        form_members_bare=False,
    ),
    dict(
        name="bare",
        this_prefix=False,
        controls_qualified=False,
        qualified_types=False,
        qualified_drawing=False,
        file_scoped_ns=True,
        form_members_bare=True,
    ),
    dict(
        name="thisstyle",
        this_prefix=True,
        controls_qualified=False,
        qualified_types=True,
        qualified_drawing=True,
        file_scoped_ns=True,
        form_members_bare=True,
    ),
    dict(
        name="templated",
        this_prefix=False,
        controls_qualified=False,
        qualified_types=False,
        qualified_drawing=False,
        file_scoped_ns=True,
        form_members_bare=True,
    ),
]

# Container chains for the subject control. `tab` is TabControl -> TabPage, the only
# two-level container the schema models.
HIERARCHIES = [
    ("flat", []),
    ("panel", ["Panel"]),
    ("groupbox", ["GroupBox"]),
    ("tab", ["TabControl", "TabPage"]),
]

# The 19 handled types, in engine/src/TypeTable.cs order. The order matters: it is the
# order the manifest lists, so the matrix is reproducible.
TYPES = [
    "Button",
    "Label",
    "TextBox",
    "CheckBox",
    "RadioButton",
    "ComboBox",
    "ListBox",
    "PictureBox",
    "Panel",
    "GroupBox",
    "TrackBar",
    "ProgressBar",
    "NumericUpDown",
    "DateTimePicker",
    "TabControl",
    "TabPage",
    "DataGridView",
    "ListView",
    "TreeView",
]

# Mirrors canvas.js PREFIX — the field-name prefix the designer would use.
PREFIX = {
    "Button": "btn",
    "Label": "lbl",
    "TextBox": "txt",
    "CheckBox": "chk",
    "RadioButton": "rad",
    "ComboBox": "cbo",
    "ListBox": "lst",
    "PictureBox": "pic",
    "Panel": "pnl",
    "GroupBox": "grp",
    "TrackBar": "trk",
    "ProgressBar": "prg",
    "NumericUpDown": "num",
    "DateTimePicker": "dtp",
    "TabControl": "tab",
    "TabPage": "tab",
    "DataGridView": "dgv",
    "ListView": "lvw",
    "TreeView": "tvw",
}

# Mirrors canvas.js NO_TEXT — types whose Text field is disabled.
NO_TEXT = {
    "Panel",
    "TrackBar",
    "ProgressBar",
    "NumericUpDown",
    "DateTimePicker",
    "TabControl",
    "DataGridView",
    "ListView",
    "TreeView",
}

# Mirrors canvas.js HAS_FONT — types whose Font is meaningful.
HAS_FONT = {
    "Button",
    "Label",
    "TextBox",
    "CheckBox",
    "RadioButton",
    "ComboBox",
    "ListBox",
    "GroupBox",
    "TabPage",
}

# The per-type sizes written into matrix Designer files (#65).
# Leaf controls with constrained or font-driven heights (TextBox, ComboBox,
# DateTimePicker, NumericUpDown, TrackBar) MUST declare the exact size the
# WinForms runtime produces (height 23 for single-line text inputs at default
# 9pt font, height 45 for TrackBar) so declared and runtime sizes agree by
# construction.
CONTROL_SIZES = {
    "Button": (120, 30),
    "Label": (120, 30),
    "TextBox": (120, 23),
    "CheckBox": (120, 30),
    "RadioButton": (120, 30),
    "ComboBox": (120, 23),
    "ListBox": (120, 96),
    "PictureBox": (120, 30),
    "Panel": (120, 30),
    "GroupBox": (120, 30),
    "TrackBar": (120, 45),
    "ProgressBar": (120, 30),
    "NumericUpDown": (120, 23),
    "DateTimePicker": (120, 23),
    "TabControl": (120, 30),
    "TabPage": (120, 30),
    "DataGridView": (120, 30),
    "ListView": (120, 30),
    "TreeView": (120, 30),
}

# Form-level properties (the Form is modelled separately from the control table).
FORM_PROPS = ["text", "clientSize", "backColor"]

# Encoding variants: LF/CRLF x BOM/no-BOM. The engine must preserve all four.
ENCODINGS = [
    ("lf", "\n", False),
    ("crlf", "\r\n", False),
    ("lf-bom", "\n", True),
    ("crlf-bom", "\r\n", True),
]

# --------------------------------------------------------------------------- properties

# A property the canvas offers, with the value the "full" variant writes into the file
# (v1) and the value the matrix asks the engine to write instead (v2).
#
# `types` is the set of control types the canvas offers it for; None means every type.
# `insertable` is False for a property a Designer file always states, so only its REPLACE
# path can be tested.
#
# The emitters take (dialect, member, value) and return a C# statement WITHOUT the
# trailing semicolon, because Items is a multi-line block.


def _bool_stmt(d, m, key, v):
    return f"{m}.{key} = {'true' if v else 'false'}"


def _int_stmt(d, m, key, v):
    return f"{m}.{key} = {v}"


def _str_stmt(d, m, key, v):
    return f'{m}.{key} = "{v}"'


def _enum_stmt(d, m, key, v, enum_type):
    return f"{m}.{key} = {d.drawing(enum_type)}.{v}"


def _color_stmt(d, m, key, rgb):
    r, g, b = rgb
    return f"{m}.{key} = {d.drawing('Color')}.FromArgb({r}, {g}, {b})"


def _font_stmt(d, m, font):
    family, size, bold, italic = font
    style = "Bold" if bold else ("Italic" if italic else "Regular")
    return (
        f'{m}.Font = new {d.drawing("Font")}("{family}", {size}F, '
        f"{d.drawing('FontStyle')}.{style})"
    )


def _items_stmt(d, m, items):
    # The designer's shape: an AddRange over an object[] spread over several lines.
    body = ",\n".join(f'"{i}"' for i in items)
    return f"{m}.Items.AddRange(new object[] {{\n{body}}});"


def _textalign_stmt(d, m, v, horizontal):
    enum_type = "HorizontalAlignment" if horizontal else "ContentAlignment"
    return f"{m}.TextAlign = {d.drawing(enum_type)}.{v}"


# The property matrix.
#
# Each entry is a dict:
#   key        the schema property name
#   types      the control types the canvas offers it for (None = every type)
#   insertable whether the property can be ABSENT from a Designer file, i.e. whether it
#              has an INSERT path to test. A property a Designer file always states
#              (geometry, TabIndex) can only be REPLACEd.
#   states     whether the `full` variant writes the property at all. False means the
#              property is INSERT-only — there is no meaningful v1 to state.
#   v1         the SCHEMA value the `full` variant states
#   v2         the SCHEMA value the matrix asks the engine to write instead
#   file       how the FILE states it: (dialect, member, schema_value) -> statement
#
# THE SCHEMA VALUE IS NOT THE FILE VALUE. `backColor` is a CSS string in the schema
# ("#f0f0f0") and a `Color.FromArgb(...)` call in the file; `font` is an object in the
# schema and a `new Font(...)` construction in the file. Keeping the two apart is the
# whole point of the matrix — it is what makes the engine's re-read of the patched file a
# real check rather than a restatement of what we wrote.
#
# The type lists mirror the canvas inspector (extension/media/canvas.js): the properties a
# control offers are exactly the ones a user can edit there, and AGENTS.md requires every
# one of them to have an INSERT path as well as a replace path.


def _hex_to_rgb(css):
    css = css.lstrip("#")
    return int(css[0:2], 16), int(css[2:4], 16), int(css[4:6], 16)


def _color_file(d, m, key, v):
    rgb = ", ".join(str(x) for x in _hex_to_rgb(v))
    return f"{m}.{key} = {d.drawing('Color')}.FromArgb({rgb})"


def _font_file(d, m, v):
    family = v.get("family") or "Microsoft Sans Serif"
    size = v["size"]
    style = (
        "Bold | Italic"
        if v.get("bold") and v.get("italic")
        else "Bold"
        if v.get("bold")
        else "Italic"
        if v.get("italic")
        else "Regular"
    )
    return (
        f'{m}.Font = new {d.drawing("Font")}("{family}", {size}F, '
        f"{d.drawing('FontStyle')}.{style})"
    )


def _enum_file(d, m, key, v, enum_type, ns="System.Drawing"):
    """An enum-valued property.

    The namespace matters: `ContentAlignment` and `HorizontalAlignment` live in
    System.Drawing, but `BorderStyle`, `ComboBoxStyle` and `ScrollBars` live in
    System.Windows.Forms. Writing a Windows.Forms enum under System.Drawing produces
    CS0234 — the file does not compile, and the compiler blames the project.
    """
    spelled = (
        d.forms(enum_type) if ns == "System.Windows.Forms" else d.drawing(enum_type)
    )
    return f"{m}.{key} = {spelled}.{v}"


def _csharp_char(c):
    """A C# char literal for a character.

    The schema value is the DECODED character (a NUL for `\\0`), but the file must
    contain the two-character escape `\\0`. Writing the raw NUL byte into a .cs file
    makes the compiler treat the file as binary.
    """
    return {"\0": "\\0", "'": "\\'", "\\": "\\\\"}.get(c, c)


def _bool_file(d, m, key, v):
    return f"{m}.{key} = {'true' if v else 'false'}"


def _items_file(d, m, v):
    body = ",\n".join(f'"{i}"' for i in v)
    return f"{m}.Items.AddRange(new object[] {{\n{body}}});"


def _textalign_file(d, m, v, horizontal):
    """A TextAlign statement.

    The two TextAligns are DIFFERENT ENUMS IN DIFFERENT NAMESPACES:
      * a Label/Button/CheckBox/RadioButton aligns its text with
        `System.Drawing.ContentAlignment` (TopLeft, MiddleCenter, BottomRight…)
      * a TextBox aligns its text with `System.Windows.Forms.HorizontalAlignment`
        (Left, Center, Right)
    `System.Drawing.HorizontalAlignment` does not exist in modern .NET — it was a .NET
    Framework type — so writing it there is a compile error, not a style choice.
    """
    if horizontal:
        return f"{m}.TextAlign = {d.forms('HorizontalAlignment')}.{v}"
    return f"{m}.TextAlign = {d.drawing('ContentAlignment')}.{v}"


def _datetime_file(d, m, key, iso_str):
    parts = [int(p) for p in iso_str.split("-")]
    return f"{m}.{key} = new {d.system('DateTime')}({parts[0]}, {parts[1]}, {parts[2]}, 0, 0, 0, 0)"


PROPERTIES = [
    dict(
        key="text",
        types=None,
        insertable=True,
        states=True,
        v1="Original",
        v2="Replaced",
        file=lambda d, m, v: f'{m}.Text = "{v}"',
    ),
    dict(
        key="tabIndex",
        types=None,
        insertable=False,
        states=True,
        v1=0,
        v2=3,
        file=lambda d, m, v: f"{m}.TabIndex = {v}",
    ),
    dict(
        key="tabStop",
        types=None,
        insertable=True,
        states=True,
        v1=True,
        v2=False,
        file=lambda d, m, v: _bool_file(d, m, "TabStop", v),
    ),
    dict(
        key="enabled",
        types=None,
        insertable=True,
        states=True,
        v1=True,
        v2=False,
        file=lambda d, m, v: _bool_file(d, m, "Enabled", v),
    ),
    dict(
        key="visible",
        types=None,
        insertable=True,
        states=True,
        v1=True,
        v2=False,
        file=lambda d, m, v: _bool_file(d, m, "Visible", v),
    ),
    dict(
        key="backColor",
        types=None,
        insertable=True,
        states=True,
        v1="#f0f0f0",
        v2="#ff0000",
        file=lambda d, m, v: _color_file(d, m, "BackColor", v),
    ),
    dict(
        key="foreColor",
        types=None,
        insertable=True,
        states=True,
        v1="#000000",
        v2="#008000",
        file=lambda d, m, v: _color_file(d, m, "ForeColor", v),
    ),
    dict(
        key="font",
        types=HAS_FONT,
        insertable=True,
        states=True,
        v1={"size": 9, "bold": False, "italic": False, "family": "Segoe UI"},
        v2={"size": 11, "bold": True, "italic": False, "family": "Segoe UI"},
        file=lambda d, m, v: _font_file(d, m, v),
    ),
    dict(
        key="autoSize",
        types={"Label", "Button", "CheckBox", "RadioButton"},
        insertable=True,
        states=True,
        v1=False,
        v2=True,
        file=lambda d, m, v: _bool_file(d, m, "AutoSize", v),
    ),
    dict(
        key="textAlign",
        types={"Button", "Label", "CheckBox", "RadioButton"},
        insertable=True,
        states=True,
        v1="MiddleLeft",
        v2="TopRight",
        file=lambda d, m, v: _textalign_file(d, m, v, horizontal=False),
    ),
    # A TextBox's TextAlign is a HorizontalAlignment, NOT a ContentAlignment. The engine
    # writes ContentAlignment for every type, which does not compile.
    dict(
        key="textAlign",
        types={"TextBox"},
        insertable=True,
        states=True,
        v1="Left",
        v2="Center",
        file=lambda d, m, v: _textalign_file(d, m, v, horizontal=True),
    ),
    dict(
        key="borderStyle",
        types={
            "Label",
            "TextBox",
            "Panel",
            "PictureBox",
            "DataGridView",
            "ListView",
            "TreeView",
        },
        insertable=True,
        states=True,
        v1="None",
        v2="FixedSingle",
        file=lambda d, m, v: _enum_file(
            d, m, "BorderStyle", v, "BorderStyle", ns="System.Windows.Forms"
        ),
    ),
    dict(
        key="checked",
        types={"CheckBox", "RadioButton"},
        insertable=True,
        states=True,
        v1=False,
        v2=True,
        file=lambda d, m, v: _bool_file(d, m, "Checked", v),
    ),
    dict(
        key="items",
        types={"ComboBox", "ListBox"},
        insertable=True,
        states=True,
        v1=["Alpha"],
        v2=["Alpha", "Beta"],
        file=lambda d, m, v: _items_file(d, m, v),
    ),
    dict(
        key="selectedIndex",
        types={"ComboBox", "ListBox"},
        insertable=True,
        states=True,
        v1=-1,
        v2=0,
        file=lambda d, m, v: f"{m}.SelectedIndex = {v}",
    ),
    dict(
        # The designer writes SelectedItem only when something is selected, so there is no
        # meaningful v1 to state: this property is INSERT-only.
        key="selectedItem",
        types={"ComboBox", "ListBox"},
        insertable=True,
        states=False,
        v1="",
        v2="Alpha",
        file=lambda d, m, v: f'{m}.SelectedItem = "{v}"',
    ),
    dict(
        key="dropDownStyle",
        types={"ComboBox"},
        insertable=True,
        states=True,
        v1="DropDown",
        v2="DropDownList",
        file=lambda d, m, v: _enum_file(
            d, m, "DropDownStyle", v, "ComboBoxStyle", ns="System.Windows.Forms"
        ),
    ),
    dict(
        key="multiline",
        types={"TextBox"},
        insertable=True,
        states=True,
        v1=False,
        v2=True,
        file=lambda d, m, v: _bool_file(d, m, "Multiline", v),
    ),
    dict(
        key="readOnly",
        types={"TextBox"},
        insertable=True,
        states=True,
        v1=False,
        v2=True,
        file=lambda d, m, v: _bool_file(d, m, "ReadOnly", v),
    ),
    dict(
        key="maxLength",
        types={"TextBox"},
        insertable=True,
        states=True,
        v1=32767,
        v2=100,
        file=lambda d, m, v: f"{m}.MaxLength = {v}",
    ),
    dict(
        key="passwordChar",
        types={"TextBox"},
        insertable=True,
        states=True,
        v1="\0",
        v2="*",
        file=lambda d, m, v: f"{m}.PasswordChar = '{_csharp_char(v)}'",
    ),
    dict(
        key="scrollBars",
        types={"TextBox"},
        insertable=True,
        states=True,
        v1="None",
        v2="Vertical",
        file=lambda d, m, v: _enum_file(
            d, m, "ScrollBars", v, "ScrollBars", ns="System.Windows.Forms"
        ),
    ),
    dict(
        key="minimum",
        types={"TrackBar", "ProgressBar", "NumericUpDown"},
        insertable=True,
        states=True,
        v1=0,
        v2=10,
        file=lambda d, m, v: f"{m}.Minimum = {v}",
    ),
    dict(
        key="maximum",
        types={"TrackBar", "ProgressBar", "NumericUpDown"},
        insertable=True,
        states=True,
        v1=100,
        v2=90,
        file=lambda d, m, v: f"{m}.Maximum = {v}",
    ),
    dict(
        key="value",
        types={"TrackBar", "ProgressBar", "NumericUpDown"},
        insertable=True,
        states=True,
        v1=0,
        v2=42,
        file=lambda d, m, v: f"{m}.Value = {v}",
    ),
    dict(
        key="format",
        types={"DateTimePicker"},
        insertable=True,
        states=True,
        v1="Short",
        v2="Custom",
        file=lambda d, m, v: f"{m}.Format = {d.forms('DateTimePickerFormat')}.{v}",
    ),
    dict(
        key="customFormat",
        types={"DateTimePicker"},
        insertable=True,
        states=True,
        v1="yyyy-MM-dd",
        v2="MM/dd/yyyy",
        file=lambda d, m, v: f'{m}.CustomFormat = "{v}"',
    ),
    dict(
        key="value",
        types={"DateTimePicker"},
        insertable=True,
        states=True,
        v1="2026-10-06",
        v2="2026-10-24",
        file=lambda d, m, v: _datetime_file(d, m, "Value", v),
    ),
    dict(
        key="minDate",
        types={"DateTimePicker"},
        insertable=True,
        states=True,
        v1="2020-01-01",
        v2="2021-06-15",
        file=lambda d, m, v: _datetime_file(d, m, "MinDate", v),
    ),
    dict(
        key="maxDate",
        types={"DateTimePicker"},
        insertable=True,
        states=True,
        v1="2030-12-31",
        v2="2029-11-20",
        file=lambda d, m, v: _datetime_file(d, m, "MaxDate", v),
    ),
]

# Form-level property values, in SCHEMA shape: the v1 the file states and the v2 the
# matrix asks the engine to write. The form is modelled separately from the control
# table, so these are not in PROPERTIES.
FORM_PROPERTY_VALUES = {
    "text": ("Original form", "Renamed form"),
    "clientSize": ({"width": 400, "height": 300}, {"width": 640, "height": 480}),
    "backColor": ("#f0f0f0", "#ff0000"),
}

# --------------------------------------------------------------------------- emission


class Dialect:
    """One dialect's spelling rules."""

    def __init__(self, spec: dict):
        self.name = spec["name"]
        self.this_prefix = spec["this_prefix"]
        self.controls_qualified = spec["controls_qualified"]
        self.qualified_types = spec["qualified_types"]
        self.qualified_drawing = spec["qualified_drawing"]
        self.file_scoped_ns = spec["file_scoped_ns"]
        self.form_members_bare = spec["form_members_bare"]

    def member(self, cid: str) -> str:
        """A control member reference: `this.btn1` or `btn1`."""
        return f"this.{cid}" if self.this_prefix else cid

    def form_member(self, name: str) -> str:
        """A form-level member reference: `this.ClientSize` or `ClientSize`."""
        return name if self.form_members_bare else f"this.{name}"

    def controls_add(self, container_id: str | None, child_id: str) -> str:
        """The `Controls.Add` line for a child.

        A nested add is always `{parent}.Controls.Add(...)` — the parent reference follows the
        `this.` signal, but the `Controls` collection is never `this.`-qualified for a nested
        parent (engine/src/Patcher.cs InsertControl).
        """
        if container_id is None:
            prefix = "this.Controls" if self.controls_qualified else "Controls"
        else:
            prefix = f"{self.member(container_id)}.Controls"
        return f"{prefix}.Add({self.member(child_id)})"

    def type_name(self, simple: str) -> str:
        return f"System.Windows.Forms.{simple}" if self.qualified_types else simple

    def drawing(self, simple: str) -> str:
        return f"System.Drawing.{simple}" if self.qualified_drawing else simple

    def forms(self, simple: str) -> str:
        """A System.Windows.Forms type, spelled the dialect's way.

        The Windows.Forms enums (`BorderStyle`, `ComboBoxStyle`, `ScrollBars`) are a
        different namespace from the Drawing ones (`ContentAlignment`,
        `HorizontalAlignment`), and the two must not be conflated.
        """
        return f"System.Windows.Forms.{simple}" if self.qualified_types else simple

    def system(self, simple: str) -> str:
        return f"System.{simple}" if self.qualified_types else simple


def subject_id(type_name: str) -> str:
    return f"{PREFIX.get(type_name, 'ctl')}Subject"


CONTAINER_IDS = {
    "Panel": "pnlHost",
    "GroupBox": "grpHost",
    "TabControl": "tabHost",
    "TabPage": "tabPageHost",
}


def emit_case(
    d: Dialect,
    hierarchy: str,
    type_name: str,
    variant: str,
    encoding: str,
    eol: str,
    bom: bool,
    id_prefix: str = "",
) -> tuple[str, dict]:
    """Emit one Designer file and its manifest record."""
    chain = dict(HIERARCHIES)[hierarchy]
    if type_name == "TabPage":
        # A TabPage's parent is always a TabControl — WinForms THROWS if a TabPage is
        # added to anything else, so a TabPage as a direct child of a Form (the `flat`
        # hierarchy) or of a Panel cannot even be constructed at runtime. The TabPage
        # takes the place of the TabPage in the chain, inside the TabControl.
        chain = ["TabControl"]
    ident = f"{d.name.capitalize()}{hierarchy.capitalize()}{type_name}{variant.capitalize()}"
    if encoding != "lf":
        ident += encoding.replace("-", "").capitalize()
    ident = ("Enc" if id_prefix else "") + ident
    namespace = f"Matrix.{ident}"
    class_name = f"{ident}Form"
    sid = subject_id(type_name)

    # Indentation follows the file's shape: a block-scoped namespace puts the class one
    # level in, a file-scoped one puts it at the left margin. The engine matches the BODY
    # indentation of the file it edits, so the matrix has to be realistic here or the
    # insert path would be measured against a file no designer would ever write.
    class_indent = "" if d.file_scoped_ns else "    "
    member_indent = class_indent + "    "
    body = member_indent + "    "

    lines: list[str] = []

    if d.file_scoped_ns:
        lines.append(f"namespace {namespace};")
        lines.append("")
        lines.append(f"partial class {class_name}")
        lines.append("{")
    else:
        lines.append(f"namespace {namespace}")
        lines.append("{")
        lines.append(f"{class_indent}partial class {class_name}")
        lines.append(f"{class_indent}{{")

    lines.append(
        f"{member_indent}private System.ComponentModel.IContainer components = null;"
    )
    lines.append("")
    lines.append(f"{member_indent}protected override void Dispose(bool disposing)")
    lines.append(f"{member_indent}{{")
    lines.append(f"{member_indent}    if (disposing && (components != null))")
    lines.append(f"{member_indent}    {{")
    lines.append(f"{member_indent}        components.Dispose();")
    lines.append(f"{member_indent}    }}")
    lines.append(f"{member_indent}    base.Dispose(disposing);")
    lines.append(f"{member_indent}}}")
    lines.append("")
    lines.append(f"{member_indent}private void InitializeComponent()")
    lines.append(f"{member_indent}{{")

    # --- instantiations ------------------------------------------------------
    # The templated dialect has NO controls at all: that is what makes it templated.
    if d.name != "templated":
        for ctype in chain:
            cid = CONTAINER_IDS[ctype]
            lines.append(f"{body}{d.member(cid)} = new {d.type_name(ctype)}();")
        lines.append(f"{body}{d.member(sid)} = new {d.type_name(type_name)}();")
        lines.append(f"{body}components = new System.ComponentModel.Container();")

        # --- property blocks --------------------------------------------------
        for ctype in chain:
            cid = CONTAINER_IDS[ctype]
            # A TabPage's Location/Size are the designer's view of the page inside the
            # TabControl's display area, so they are inset rather than coincident with
            # the TabControl's own. At runtime the TabControl owns them — which is why
            # the layout harness checks a TabPage for existence only.
            if ctype == "TabPage":
                loc_x, loc_y, size_w, size_h = 4, 24, 352, 232
            else:
                loc_x, loc_y, size_w, size_h = 20, 20, 360, 260
            lines.append(f"{body}//")
            lines.append(f"{body}// {cid}")
            lines.append(f"{body}//")
            lines.append(
                f"{body}{d.member(cid)}.Location = new {d.drawing('Point')}"
                f"({loc_x}, {loc_y});"
            )
            lines.append(f'{body}{d.member(cid)}.Name = "{cid}";')
            lines.append(
                f"{body}{d.member(cid)}.Size = new {d.drawing('Size')}"
                f"({size_w}, {size_h});"
            )
            lines.append(f"{body}{d.member(cid)}.TabIndex = 0;")

        lines.append(f"{body}//")
        lines.append(f"{body}// {sid}")
        lines.append(f"{body}//")
        lines.append(
            f"{body}{d.member(sid)}.Location = new {d.drawing('Point')}(40, 40);"
        )
        lines.append(f'{body}{d.member(sid)}.Name = "{sid}";')
        sw, sh = CONTROL_SIZES.get(type_name, (120, 30))
        lines.append(f"{body}{d.member(sid)}.Size = new {d.drawing('Size')}({sw}, {sh});")
        lines.append(f"{body}{d.member(sid)}.TabIndex = 1;")

        if variant == "full":
            for stmt in full_property_statements(d, type_name, sid):
                # A statement may span lines (the Items block), so every line of it is
                # indented, not just the first.
                for line in stmt.split("\n"):
                    lines.append(f"{body}{line}" if line else line)

        # --- form properties --------------------------------------------------
        lines.append(
            f"{body}{d.form_member('AutoScaleMode')} = "
            f"{d.type_name('AutoScaleMode')}.Font;"
        )
        lines.append(
            f"{body}{d.form_member('ClientSize')} = new {d.drawing('Size')}(400, 300);"
        )
        if variant == "full":
            lines.append(f'{body}{d.form_member("Text")} = "Original form";')
        else:
            lines.append(f'{body}{d.form_member("Text")} = "{class_name}";')

        # --- Controls.Add -----------------------------------------------------
        # The form's own children are added first, then each container's children, so the
        # `Controls.Add` lines read in the order a designer writes them.
        if chain:
            # The outermost container is a child of the form.
            outer = CONTAINER_IDS[chain[0]]
            lines.append(f"{body}{d.controls_add(None, outer)};")
            parent = outer
            for ctype in chain[1:]:
                cid = CONTAINER_IDS[ctype]
                lines.append(f"{body}{d.controls_add(parent, cid)};")
                parent = cid
            lines.append(f"{body}{d.controls_add(parent, sid)};")
        else:
            lines.append(f"{body}{d.controls_add(None, sid)};")

        lines.append(f'{body}{d.form_member("Name")} = "{class_name}";')
    else:
        # The templated dialect: four statements, no controls.
        lines.append(f"{body}components = new System.ComponentModel.Container();")
        lines.append(
            f"{body}{d.form_member('AutoScaleMode')} = "
            f"{d.type_name('AutoScaleMode')}.Font;"
        )
        lines.append(
            f"{body}{d.form_member('ClientSize')} = new {d.drawing('Size')}(800, 450);"
        )
        lines.append(f'{body}{d.form_member("Text")} = "{class_name}";')

    lines.append(f"{member_indent}}}")

    # Field declarations — inside the class, after the method, the way the designer writes
    # them. A field outside the class would not compile, which would make every case in the
    # matrix fail for a reason that has nothing to do with the engine.
    decls = []
    if d.name != "templated":
        for ctype in chain:
            decls.append((CONTAINER_IDS[ctype], d.type_name(ctype)))
        decls.append((sid, d.type_name(type_name)))
    if decls:
        lines.append("")
        for cid, ctype in decls:
            lines.append(f"{member_indent}private {ctype} {cid};")

    # The class's closing brace. A file-scoped namespace closes the class at the left
    # margin; a block-scoped one closes it one level in. Leaving it out produced files
    # that still PARSED (the engine is lenient about a missing brace) but did not
    # COMPILE — which is exactly the kind of thing the compile phase exists to catch.
    lines.append(f"{class_indent}}}")

    # A block-scoped namespace needs its own closing brace; a file-scoped one does not.
    if not d.file_scoped_ns:
        lines.append("}")

    text = eol.join(lines) + eol
    data = text.encode("utf-8")
    if bom:
        data = b"\xef\xbb\xbf" + data

    present = {}
    if variant == "full" and d.name != "templated":
        for spec in PROPERTIES:
            if spec["types"] is not None and type_name not in spec["types"]:
                continue
            if spec["key"] == "text" and type_name in NO_TEXT:
                continue
            if not spec["states"]:
                continue
            present[spec["key"]] = spec["v1"]

    record = {
        "id": f"{id_prefix}{d.name}__{hierarchy}__{type_name}__{variant}"
        + ("" if encoding == "lf" else f"__{encoding}"),
        "kind": "control",
        "dialect": d.name,
        "hierarchy": hierarchy,
        "type": type_name,
        "variant": variant,
        "encoding": encoding,
        "namespace": namespace,
        "className": class_name,
        "file": f"cases/{ident}/{class_name}.Designer.cs",
        "subjectId": sid,
        "subjectType": d.type_name(type_name),
        "containerPath": [CONTAINER_IDS[c] for c in chain],
        "properties": present,
    }
    return data, record


def full_property_statements(d: Dialect, type_name: str, sid: str) -> list[str]:
    """The property statements the `full` variant writes into the file.

    These are the properties the canvas offers for this type, at their v1 values, written
    the way Visual Studio writes them. The matrix then asks the engine to change each one,
    which exercises the REPLACE path; the `bare` variant omits them, which exercises the
    INSERT path.
    """
    stmts = []
    for spec in PROPERTIES:
        if spec["types"] is not None and type_name not in spec["types"]:
            continue
        if spec["key"] == "text" and type_name in NO_TEXT:
            continue
        if not spec["states"]:
            continue
        stmt = spec["file"](d, d.member(sid), spec["v1"])
        # Every statement ends in a semicolon — except the Items block, whose emitter
        # already closes it. A missing semicolon would make the whole matrix fail to
        # compile for a reason that has nothing to do with the engine.
        if not stmt.rstrip().endswith(";"):
            stmt += ";"
        stmts.append(stmt)
    return stmts


def emit_form_case(d: Dialect, encoding: str, eol: str, bom: bool) -> tuple[str, dict]:
    """A form-only case: no controls, so the form-level properties are the subject.

    The templated dialect lives here — it is the dialect with no controls at all, and it is
    the only one where a form-level INSERT has to accept a BARE identifier on the left.
    """
    ident = f"Form{d.name.capitalize()}{encoding.replace('-', '').capitalize()}"
    namespace = f"Matrix.{ident}"
    class_name = f"{ident}Form"
    class_indent = "" if d.file_scoped_ns else "    "
    member_indent = class_indent + "    "
    body = member_indent + "    "
    lines = []
    if d.file_scoped_ns:
        lines.append(f"namespace {namespace};")
        lines.append("")
        lines.append(f"partial class {class_name}")
        lines.append("{")
    else:
        lines.append(f"namespace {namespace}")
        lines.append("{")
        lines.append(f"{class_indent}partial class {class_name}")
        lines.append(f"{class_indent}{{")
    lines.append(
        f"{member_indent}private System.ComponentModel.IContainer components = null;"
    )
    lines.append("")
    lines.append(f"{member_indent}private void InitializeComponent()")
    lines.append(f"{member_indent}{{")
    lines.append(f"{body}components = new System.ComponentModel.Container();")
    lines.append(
        f"{body}{d.form_member('AutoScaleMode')} = {d.type_name('AutoScaleMode')}.Font;"
    )
    lines.append(
        f"{body}{d.form_member('ClientSize')} = new {d.drawing('Size')}(800, 450);"
    )
    lines.append(f'{body}{d.form_member("Text")} = "{class_name}";')
    lines.append(f"{member_indent}}}")
    lines.append("")
    if not d.file_scoped_ns:
        lines.append(f"{class_indent}}}")
    text = eol.join(lines) + eol
    data = text.encode("utf-8")
    if bom:
        data = b"\xef\xbb\xbf" + data
    record = {
        "id": f"form__{d.name}__{encoding}",
        "kind": "form",
        "dialect": d.name,
        "hierarchy": "none",
        "type": "Form",
        "variant": "none",
        "encoding": encoding,
        "namespace": namespace,
        "className": class_name,
        "file": f"cases/{ident}/{class_name}.Designer.cs",
        "subjectId": None,
        "subjectType": None,
        "containerPath": [],
        "properties": {},
    }
    return data, record


# --------------------------------------------------------------------------- driver


def regenerate_case(case: dict) -> bytes:
    """The exact bytes of a case's file, rebuilt from its record.

    The gate needs the PRISTINE input of a case that a test has already patched, and
    the matrix is deterministic — so the input can be rebuilt rather than kept. Keeping
    the generator as the single source of truth is the point: a fixture that is not
    reproducible from the generator is a fixture that can drift.
    """
    d = Dialect(next(s for s in DIALECTS if s["name"] == case["dialect"]))
    eol, bom = "\n", False
    for name, e, b in ENCODINGS:
        if name == case["encoding"]:
            eol, bom = e, b
            break
    if case["kind"] == "form":
        data, _ = emit_form_case(d, case["encoding"], eol, bom)
        return data
    data, _ = emit_case(
        d,
        case["hierarchy"],
        case["type"],
        case["variant"],
        case["encoding"],
        eol,
        bom,
        id_prefix="enc__" if case["id"].startswith("enc__") else "",
    )
    return data


def build(out_dir: str, families: list[str]) -> dict:
    cases = []
    files: dict[str, bytes] = {}

    if "control" in families:
        for spec in DIALECTS:
            d = Dialect(spec)
            if d.name == "templated":
                # The templated dialect has NO controls at all — that is what makes it
                # templated (SCHEMA.md "Dialects"). A templated file with controls is
                # really a bare file, so the templated dialect is covered by the `form`
                # family instead, where the subject is the Form itself.
                continue
            for hierarchy, _chain in HIERARCHIES:
                for type_name in TYPES:
                    if type_name == "TabPage" and hierarchy != "tab":
                        # A TabPage can only live inside a TabControl, so the only
                        # hierarchy it can be the subject of is the one whose chain
                        # ends in a TabControl.
                        continue
                    for variant in ("bare", "full"):
                        data, record = emit_case(
                            d, hierarchy, type_name, variant, "lf", "\n", False
                        )
                        files[record["file"]] = data
                        cases.append(record)

    if "form" in families:
        for spec in DIALECTS:
            d = Dialect(spec)
            data, record = emit_form_case(d, "lf", "\n", False)
            files[record["file"]] = data
            cases.append(record)

    if "encoding" in families:
        # The encoding family: one case per encoding, on the classic dialect, with a
        # control. Line endings and BOM are the file-level invariants (AGENTS.md #3) and
        # they do not interact with dialect, hierarchy or type, so they get their own
        # small family rather than multiplying the whole matrix.
        #
        # The identity is prefixed so this family can NEVER share a file with the control
        # family. It used to: the LF case here had the same id AND the same file as
        # `classic__flat__Button__full` from the control family, so the second one to run
        # read its baseline from a file the first one had already patched — and the
        # matrix reported a working property as "no change". A shared file between two
        # cases is never legitimate, and the tier now asserts against it.
        d = Dialect(DIALECTS[0])
        for encoding, eol, bom in ENCODINGS:
            data, record = emit_case(
                d, "flat", "Button", "full", encoding, eol, bom, id_prefix="enc__"
            )
            files[record["file"]] = data
            cases.append(record)

    for rel, data in files.items():
        path = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)

    manifest = {
        "version": 1,
        "cases": cases,
        "dialects": [d["name"] for d in DIALECTS],
        "types": TYPES,
        "hierarchies": [h for h, _ in HIERARCHIES],
        "properties": [
            {
                "key": spec["key"],
                "types": sorted(spec["types"]) if spec["types"] else "all",
                "v1": spec["v1"],
                "v2": spec["v2"],
                "insertable": spec["insertable"],
                "states": spec["states"],
            }
            for spec in PROPERTIES
        ],
        "formProperties": {
            k: {"v1": v[0], "v2": v[1]} for k, v in FORM_PROPERTY_VALUES.items()
        },
    }
    with open(
        os.path.join(out_dir, "matrix.json"), "w", encoding="utf-8", newline="\n"
    ) as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
        fh.write("\n")

    # A plain-text index of the same cases: id|namespace|className|relative-file.
    #
    # The Windows tier consumes THIS, not matrix.json, because reading JSON in a shell
    # means either a JSON parser (so python3 or jq, and the guest may have neither) or
    # fragile string munging. One `|`-separated line per case is readable with `read`,
    # and the fields are identifiers, so nothing needs escaping.
    with open(
        os.path.join(out_dir, "cases.txt"), "w", encoding="utf-8", newline="\n"
    ) as fh:
        for case in cases:
            fh.write(
                f"{case['id']}|{case['namespace']}|{case['className']}|{case['file']}\n"
            )
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument(
        "--families",
        default="control,form,encoding",
        help="comma-separated: control,form,encoding",
    )
    ap.add_argument(
        "--list",
        action="store_true",
        help="print the case count and exit without writing",
    )
    args = ap.parse_args()

    families = [f.strip() for f in args.families.split(",") if f.strip()]
    if args.list:
        total = 0
        if "control" in families:
            total += (len(DIALECTS) - 1) * len(HIERARCHIES) * len(TYPES) * 2
        if "form" in families:
            total += len(DIALECTS)
        if "encoding" in families:
            total += len(ENCODINGS)
        print(total)
        return 0

    os.makedirs(args.out, exist_ok=True)
    manifest = build(args.out, families)
    print(f"generated {len(manifest['cases'])} case(s) into {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
