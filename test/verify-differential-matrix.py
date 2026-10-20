#!/usr/bin/env python3
"""The differential-matrix tier: drives the engine over the generated permutation matrix.

WHAT IT CHECKS
  Three things the hand-authored fixtures cannot cover, because they cover a handful of
  hand-picked shapes rather than the cross-product:

    1. STRUCTURE — every case parses, refuses nothing, models 100% of its controls, nests
       its children where the file says they are, and round-trips byte-identically when
       nothing is changed. A no-op generate that rewrites a byte is a violation of
       AGENTS.md invariant 3.

    2. PROPERTIES — for every property the canvas offers, for every type, in every
       dialect, in BOTH directions:
         INSERT  the property is absent from the file, the schema sets it, the engine must
                 write it — in the file's own dialect, with the file's own indentation, and
                 touching nothing else. (AGENTS.md: "Every property the canvas offers must
                 have an INSERT path, not only a replace path.")
         REPLACE the property is already in the file, the schema changes it, the engine must
                 change exactly that value and nothing else.

    3. COMPILATION — the patched files must build as a real WinForms project. This is the
       tier that catches a patch that is valid C# but not valid C#: `TextAlign` on a TextBox
       written as `System.Drawing.ContentAlignment.Left` compiles as a string and fails as
       a program.

WHY IT IS A SEPARATE TIER
  Every other tier tests the fixtures someone thought to write. This one tests the
  CROSS-PRODUCT, so a property the fixtures forgot is still measured. That is how
  `BackColor` and `Font` shipped without an INSERT path, and how the TextBox `TextAlign`
  bug survived: no fixture set a TextBox's TextAlign.

THE FIXTURE-FIRST GATE
  A divergence is not fixed here. It is REPORTED, with the exact expected-vs-actual diff
  and the `gh issue create` command to file it, and the offending Designer file is copied
  to `fixtures/differential/` so the fix can be driven from a committed reproduction. The
  gate never commits and never opens the issue itself: CI has no push authority, and a
  bot-written issue is harder to trust than a bot-printed one.

USAGE
  python3 test/verify-differential-matrix.py --engine <path-to-vscforms-engine> \\
      --work <scratch-dir> [--no-compile] [--report <path>]
"""

from __future__ import annotations

import argparse
import difflib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# The generator owns the property table. Importing it (rather than copying it) is the
# point: the matrix's idea of "which property does the canvas offer for this type" must
# have exactly one definition, or the tier measures a table nobody ships.
_spec = importlib.util.spec_from_file_location(
    "gen_differential_matrix",
    os.path.join(ROOT, "scripts", "gen-differential-matrix.py"),
)
GEN = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(GEN)

# The engine writes `this.<id>.` for classic/this-style and `<id>.` for bare. This is the
# `UsesThisPrefix` signal from SCHEMA.md, and the write-back must follow it — a file that
# mixes conventions is exactly the churn ADR 0005 forbids.
MEMBER_PREFIX = {"classic": "this.", "bare": "", "thisstyle": "this."}

# An Items block spans several lines and the literal lines do not name the control. They
# are the only lines allowed to differ without mentioning the subject's id. The trailing
# `}` / `});` belongs to the block, so the pattern allows it.
ITEM_LITERAL = re.compile(r'^\s*"[^"]*"(,)?\s*\}?\)?;?\s*$')


class Engine:
    """A long-lived engine process, spoken to over the real NDJSON protocol.

    One process for the whole tier: the engine is designed to be long-lived, and starting
    one per case would dominate the runtime of a 600-case matrix.
    """

    def __init__(self, exe: str):
        self.proc = subprocess.Popen(
            [exe],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self._id = 0

    def request(self, payload: dict) -> dict:
        self._id += 1
        payload = dict(payload)
        payload["id"] = self._id
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("engine closed the stream (stderr was suppressed)")
        return json.loads(line)

    def request_guarded(self, payload: dict, timeout: float = 20.0) -> dict:
        """A request that must answer.

        The engine is a long-lived process, so a request that never gets a response
        would hang the whole tier instead of failing one case. A tier that hangs is
        worse than a tier that fails: it looks like slow CI rather than a broken
        engine, and nothing gets reported.
        """
        self._id += 1
        payload = dict(payload)
        payload["id"] = self._id
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        result: list = []

        def read():
            result.append(self.proc.stdout.readline())

        t = threading.Thread(target=read, daemon=True)
        t.start()
        t.join(timeout)
        if t.is_alive() or not result:
            raise TimeoutError(
                f"the engine did not answer {payload.get('cmd')!r} within {timeout}s"
            )
        line = result[0]
        if not line:
            raise RuntimeError("engine closed the stream (stderr was suppressed)")
        return json.loads(line)

    def parse(self, path: str) -> dict:
        res = self.request_guarded({"cmd": "parse", "path": path})
        if not res.get("ok"):
            raise RuntimeError(f"parse failed for {path}: {res.get('error')}")
        return res["schema"]

    def generate(self, path: str, schema: dict) -> dict:
        return self.request_guarded({"cmd": "generate", "path": path, "schema": schema})

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


class Report:
    def __init__(self):
        self.failures: list[dict] = []
        self.passed = 0
        self.divergences: list[dict] = []

    def ok(self):
        self.passed += 1

    def fail(self, case: str, kind: str, detail: str, **extra):
        entry = {"case": case, "kind": kind, "detail": detail}
        entry.update(extra)
        self.failures.append(entry)

    def divergence(self, case: str, kind: str, detail: str, **extra):
        """A divergence is a failure AND a candidate fixture — it goes through the gate."""
        entry = {"case": case, "kind": kind, "detail": detail}
        entry.update(extra)
        self.divergences.append(entry)
        self.failures.append(entry)


def find_node(schema: dict, control_id: str):
    def walk(nodes):
        for n in nodes or []:
            if n["id"] == control_id:
                return n
            found = walk(n.get("children"))
            if found is not None:
                return found
        return None

    return walk(schema.get("controls"))


def changed_lines(before: bytes, after: bytes) -> list[str]:
    """The lines that differ between two versions of a file.

    Returns the removed and added lines, so a caller can assert that every one of them
    belongs to the control it was supposed to change.
    """
    a = before.decode("utf-8-sig").splitlines()
    b = after.decode("utf-8-sig").splitlines()
    out = []
    for line in difflib.unified_diff(a, b, lineterm="", n=0):
        if line.startswith("---") or line.startswith("+++") or line.startswith("@@"):
            continue
        if line.startswith("-"):
            out.append(line[1:])
        elif line.startswith("+"):
            out.append(line[1:])
    return out


def values_equal(got, want) -> bool:
    """Compare a value the engine read back with the value the matrix asked for.

    Not a plain `==`: the engine normalises what it reads. A colour comes back
    uppercased ("#FF0000" for "#ff0000"), a font size comes back as a float, and a
    decimal comes back as a number. Comparing the raw JSON would report a divergence
    for a value that is in fact correct.
    """
    if isinstance(want, str) and isinstance(got, str):
        return got.lower() == want.lower()
    if isinstance(want, bool) or isinstance(got, bool):
        return got is want
    if isinstance(want, (int, float)) and isinstance(got, (int, float)):
        return abs(float(got) - float(want)) < 1e-9
    if isinstance(want, dict) and isinstance(got, dict):
        if set(want) != set(got):
            return False
        return all(values_equal(got[k], want[k]) for k in want)
    if isinstance(want, list) and isinstance(got, list):
        return len(want) == len(got) and all(
            values_equal(g, w) for g, w in zip(got, want)
        )
    return got == want


def assert_confined(diff_lines: list[str], subject_id: str, case: str, report: Report):
    """Every changed line must belong to the control that was changed.

    This is the assertion that makes the matrix a *surgical* patch test rather than a
    smoke test. A patcher that rewrote the whole block, or touched a sibling control,
    would still parse and would still compile — it would just be the churn the whole
    project exists to prevent.

    Two kinds of line are exempt:
      * a BLANK line — the engine's insert path emits a blank separator after each
        inserted property. That is asserted behaviour (test/verify.sh: "plus their
        blank separators"), so it is not a divergence here.
      * an item LITERAL — the Items block spans several lines and the literals do not
        name the control.
    """
    offenders = [
        line
        for line in diff_lines
        if subject_id not in line
        and not ITEM_LITERAL.match(line)
        and line.strip() != ""
    ]
    if offenders:
        report.fail(
            case,
            "diff-not-confined",
            f"{len(offenders)} changed line(s) do not name {subject_id}",
            offenders=offenders[:6],
        )
        return False
    return True


def assert_dialect(
    diff_lines: list[str], dialect: str, subject_id: str, case: str, report: Report
):
    """The written line must use the file's own spelling of the control member.

    ADR 0005: write back in the file's own dialect. A `this.`-qualified member in a bare
    file (or the reverse) is churn the user did not ask for.
    """
    prefix = MEMBER_PREFIX.get(dialect)
    if prefix is None:
        return True
    want = f"{prefix}{subject_id}."
    for line in diff_lines:
        if subject_id not in line or ITEM_LITERAL.match(line):
            continue
        # A line that mentions the subject must spell the member the file's way.
        if want not in line:
            other = f"{'this.' if prefix == '' else ''}{subject_id}."
            if other in line:
                report.fail(
                    case,
                    "dialect-violation",
                    f"wrote '{other}' where the file uses '{want}'",
                    line=line,
                )
                return False
    return True


# --------------------------------------------------------------------------- phases


def phase_structure(engine: Engine, matrix: dict, work: str, report: Report) -> None:
    """Every case parses, models everything, nests correctly, and round-trips byte-identically."""
    # Two cases sharing a file is never legitimate: the property phase restores a
    # baseline before each test, so the second case to touch a shared file would read
    # its baseline from a file the first one had already patched — and a working
    # property would be reported as "no change". It happened once; this makes it loud.
    seen_files: dict[str, str] = {}
    for case in matrix["cases"]:
        prior = seen_files.get(case["file"])
        if prior is not None:
            report.fail(
                case["id"],
                "shared-file",
                f"this file is also used by case '{prior}' — two cases must not share a file",
            )
            continue
        seen_files[case["file"]] = case["id"]

    for case in matrix["cases"]:
        if case["kind"] != "control" or case["variant"] != "bare":
            # The `full` variant differs only in which properties it states; the structure
            # is identical, and the property phase covers it.
            continue
        path = os.path.join(work, case["file"])
        original = open(path, "rb").read()
        try:
            schema = engine.parse(path)
        except Exception as exc:
            report.fail(case["id"], "parse-error", str(exc))
            continue

        analysis = schema["analysis"]
        if analysis["refuses"]:
            report.fail(
                case["id"],
                "unexpected-refusal",
                f"the matrix file refuses: {analysis['refuses']}",
            )
            continue
        if analysis["coveragePercent"] != 100.0:
            report.fail(
                case["id"],
                "coverage",
                f"coverage {analysis['coveragePercent']}% — the matrix files must be fully modelled",
            )
            continue

        node = find_node(schema, case["subjectId"])
        if node is None:
            report.fail(
                case["id"],
                "missing-subject",
                f"{case['subjectId']} is not in the schema",
            )
            continue
        if node["locked"]:
            report.fail(
                case["id"], "locked-subject", f"{case['subjectId']} came back locked"
            )
            continue

        # The subject must sit at the depth the file says it does.
        depth = 0
        cur = node
        parent = find_parent(schema, case["subjectId"])
        while parent is not None:
            depth += 1
            parent = find_parent(schema, parent["id"])
        want_depth = len(case["containerPath"])
        if depth != want_depth:
            report.fail(
                case["id"],
                "nesting",
                f"subject is at depth {depth}, the file puts it at {want_depth}",
            )
            continue

        # A no-op generate must not write a single byte.
        res = engine.generate(path, schema)
        if not res.get("ok"):
            report.fail(
                case["id"], "noop-generate", f"engine refused: {res.get('error')}"
            )
            continue
        if res.get("changed"):
            report.divergence(
                case["id"],
                "noop-not-byte-identical",
                "a no-op generate rewrote the file",
                file=case["file"],
            )
            continue
        after = open(path, "rb").read()
        if after != original:
            report.divergence(
                case["id"],
                "noop-not-byte-identical",
                "a no-op generate changed the bytes on disk",
                file=case["file"],
                diff=changed_lines(original, after),
            )
            continue
        report.ok()


def find_parent(schema: dict, control_id: str):
    def walk(nodes, parent):
        for n in nodes or []:
            if n["id"] == control_id:
                return parent
            found = walk(n.get("children"), n)
            if found is not None:
                return found
        return None

    return walk(schema.get("controls"), None)


def phase_properties(
    engine: Engine, matrix: dict, work: str, report: Report, patched: dict
) -> None:
    """Every property, in both directions, in every dialect.

    `patched` collects the patched files so the compile phase can build them.
    """
    # Keyed by the case's own id, NOT by (dialect, type, variant): the encoding family
    # reuses the same dialect/type/variant triple with a different file, and keying on
    # the triple made one of them silently overwrite the other.
    cases = [c for c in matrix["cases"] if c["kind"] == "control"]

    for case in sorted(cases, key=lambda c: c["id"]):
        dialect = case["dialect"]
        type_name = case["type"]
        variant = case["variant"]
        if dialect == "templated":
            # The templated dialect has no controls at all, so it has no control-level
            # properties. Its form-level properties are covered by phase_form.
            continue
        path = os.path.join(work, case["file"])
        original = open(path, "rb").read()

        for spec in GEN.PROPERTIES:
            key = spec["key"]
            if spec["types"] is not None and type_name not in spec["types"]:
                continue
            if key == "text" and type_name in GEN.NO_TEXT:
                continue
            if variant == "bare" and not spec["insertable"]:
                # A property the file always states has no INSERT path to test.
                continue
            if variant == "full" and not spec["states"]:
                # The property is INSERT-only: there is no v1 for the file to state, so
                # there is nothing to REPLACE.
                continue
            v2 = spec["v2"]

            mode = "insert" if variant == "bare" else "replace"
            case_id = f"{case['id']}__{key}__{mode}"
            if os.environ.get("MATRIX_TRACE"):
                print(f"    {case_id}", flush=True)
            # The engine writes in place, so the file must be restored before every
            # test. Otherwise the second property of a case would be tested against a
            # file the first property already patched, and the diff would be measured
            # against the wrong baseline.
            with open(path, "wb") as fh:
                fh.write(original)
            try:
                schema = engine.parse(path)
            except Exception as exc:
                report.fail(case_id, "parse-error", str(exc))
                continue

            node = find_node(schema, case["subjectId"])
            if node is None:
                report.fail(case_id, "missing-subject", case["subjectId"])
                continue

            node["properties"][key] = v2
            res = engine.generate(path, schema)
            if not res.get("ok"):
                report.fail(
                    case_id,
                    "generate-refused",
                    f"{res.get('error')} ({res.get('errorKind')})",
                )
                continue
            if not res.get("changed"):
                # The schema asked for a change and the engine made none. That is the
                # "the control looks editable and nothing happens" failure — the exact
                # bug class AGENTS.md's two-list rule warns about. It is a DIVERGENCE,
                # not a test artefact: it goes through the fixture-first gate.
                report.divergence(
                    case_id,
                    "change-discarded",
                    f"the engine made no change for {key} (mode: {mode}) — "
                    f"the property has no working path",
                    file=case["file"],
                    property=key,
                    value=v2,
                )
                continue

            after = open(path, "rb").read()
            diff = changed_lines(original, after)
            if not diff:
                report.fail(case_id, "no-diff", "changed but the bytes are identical")
                continue

            if not assert_confined(diff, case["subjectId"], case_id, report):
                continue
            if not assert_dialect(diff, dialect, case["subjectId"], case_id, report):
                continue

            # The value must read back. This is the assertion that the patch means what
            # the schema said, not merely that a byte moved.
            try:
                reread = engine.parse(path)
            except Exception as exc:
                report.fail(case_id, "reparse-error", str(exc))
                continue
            rnode = find_node(reread, case["subjectId"])
            if rnode is None:
                report.fail(case_id, "missing-after-write", case["subjectId"])
                continue
            got = rnode["properties"].get(key)
            if not values_equal(got, v2):
                report.divergence(
                    case_id,
                    "value-not-written",
                    f"{key} reads back as {got!r}, expected {v2!r}",
                    file=case["file"],
                    diff=diff,
                )
                continue

            # In the INSERT mode the file must not have had the property at all.
            if mode == "insert" and key in case.get("properties", {}):
                report.fail(
                    case_id,
                    "insert-but-present",
                    "the case file already stated the property",
                )

            patched[case_id] = {"content": after, "case": case}
            report.ok()


def phase_form(engine: Engine, matrix: dict, work: str, report: Report) -> None:
    """The form-level properties, in every dialect — including the templated one.

    The templated dialect is the only dialect with no controls, and the only one where a
    form-level INSERT has to accept a BARE identifier on the left.
    """
    for case in matrix["cases"]:
        if case["kind"] != "form":
            continue
        path = os.path.join(work, case["file"])
        original = open(path, "rb").read()
        for key, spec in matrix["formProperties"].items():
            v1, v2 = spec["v1"], spec["v2"]
            case_id = f"{case['id']}__{key}"
            with open(path, "wb") as fh:
                fh.write(original)
            try:
                schema = engine.parse(path)
            except Exception as exc:
                report.fail(case_id, "parse-error", str(exc))
                continue
            # The form's properties are modelled separately from the control table, so
            # each one lands in its own place on the schema.
            if key == "clientSize":
                schema["form"]["clientSize"] = v2
            else:
                schema["form"][key] = v2
            res = engine.generate(path, schema)
            if not res.get("ok"):
                report.fail(
                    case_id,
                    "generate-refused",
                    f"{res.get('error')} ({res.get('errorKind')})",
                )
                continue
            if not res.get("changed"):
                report.divergence(
                    case_id,
                    "change-discarded",
                    f"the engine made no change for the form's {key}",
                    file=case["file"],
                )
                continue
            after = open(path, "rb").read()
            diff = changed_lines(original, after)
            reread = engine.parse(path)
            got = reread["form"].get(key)
            if not values_equal(got, v2):
                report.divergence(
                    case_id,
                    "value-not-written",
                    f"form {key} reads back as {got!r}, expected {v2!r}",
                    file=case["file"],
                    diff=diff,
                )
                continue
            report.ok()


def phase_compile(
    engine: Engine, matrix: dict, work: str, report: Report, patched: dict
) -> None:
    """The patched files must build as a real WinForms project.

    One assembly for the whole matrix: a build per case would take longer than the rest
    of the tier put together, and a single build proves the same thing.

    Every patched file gets its OWN class and namespace. Two property tests against the
    same case produce two different files with the same class name, and a single assembly
    cannot hold both — so each snapshot is renamed to a unique identity before it is
    written. The rename touches only the generator's own labels, never the code under
    test.
    """
    if not patched:
        return
    proj = os.path.join(work, "compile")
    if os.path.isdir(proj):
        shutil.rmtree(proj)
    os.makedirs(proj)

    shim = []
    compile_targets: dict[str, str] = {}
    for case_id, entry in sorted(patched.items()):
        case = entry["case"]
        content = entry["content"]
        ident = re.sub(r"[^A-Za-z0-9_]", "_", case_id)
        new_ns = f"Matrix.Patched{ident}"
        new_cls = f"{ident}Form"
        text = content.decode("utf-8")
        text = text.replace(f"namespace {case['namespace']}", f"namespace {new_ns}")
        text = text.replace(f"class {case['className']}", f"class {new_cls}")
        with open(
            os.path.join(proj, f"{ident}.Designer.cs"), "w", encoding="utf-8"
        ) as fh:
            fh.write(text)
        # The compiled file's name IS the case id, so a compile error can be traced back
        # to the matrix case that produced it — and the gate can then emit the
        # reproduction fixture for it.
        compile_targets[f"{ident}.Designer.cs"] = case_id
        shim.append(
            f"namespace {new_ns} {{ public partial class {new_cls} "
            f": System.Windows.Forms.Form {{ public {new_cls}() "
            f"{{ InitializeComponent(); }} }} }}"
        )

    with open(os.path.join(proj, "Shim.cs"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(shim) + "\n")
    with open(os.path.join(proj, "Matrix.csproj"), "w", encoding="utf-8") as fh:
        fh.write(
            '<Project Sdk="Microsoft.NET.Sdk">\n'
            "  <PropertyGroup>\n"
            "    <TargetFramework>net10.0-windows</TargetFramework>\n"
            "    <UseWindowsForms>true</UseWindowsForms>\n"
            "    <EnableWindowsTargeting>true</EnableWindowsTargeting>\n"
            "    <OutputType>Library</OutputType>\n"
            "    <Nullable>disable</Nullable>\n"
            "    <ImplicitUsings>enable</ImplicitUsings>\n"
            "    <NoWarn>CS0108;CS0114;CS0109;CS0169;CS0649</NoWarn>\n"
            "  </PropertyGroup>\n"
            "</Project>\n"
        )

    proc = subprocess.run(
        ["dotnet", "build", "-v", "q", "--nologo", os.path.join(proj, "Matrix.csproj")],
        capture_output=True,
        text=True,
    )
    if proc.returncode == 0:
        report.ok()
        return
    errors = [ln for ln in (proc.stdout + proc.stderr).splitlines() if ": error " in ln]
    # Every compile error names the file it is in, which is the case that failed. Group
    # them so one broken case is one report, not one report per error line.
    by_file: dict[str, list[str]] = {}
    for line in errors:
        m = re.match(
            r"^(.*?)\((\d+),(\d+)\): error (CS\d+): (.*?)(?:\s*\[.*\])?$", line
        )
        if not m:
            continue
        by_file.setdefault(os.path.basename(m.group(1)), []).append(
            f"line {m.group(2)}: {m.group(4)}: {m.group(5)}"
        )
    for base, errs in sorted(by_file.items()):
        target = compile_targets.get(base, f"compile::{base}")
        prop, value = property_of(target)
        report.divergence(
            target,
            "does-not-compile",
            f"{len(errs)} compile error(s)",
            compileErrors=errs[:8],
            property=prop,
            value=value,
        )
    if not by_file:
        report.fail("compile", "build-failed", "the build failed but named no file")


def case_by_id(matrix: dict, case_id: str):
    """The case a `case_id` came from. Case ids are `<case id>__<property>__<mode>`."""
    base = case_id.rsplit("__", 2)[0] if case_id.count("__") >= 2 else case_id
    for case in matrix["cases"]:
        if case["id"] == base:
            return case
    return None


def property_of(case_id: str):
    """The property and the value a property-case id refers to.

    A property case id is `<case id>__<property>__<mode>`, and the property's new value
    comes from the generator's table — the same table the tier set it from, so a
    regression fixture records the value it must reproduce.
    """
    parts = case_id.split("__")
    if len(parts) < 3:
        return None, None
    key = parts[-2]
    for spec in GEN.PROPERTIES:
        if spec["key"] == key:
            return key, spec["v2"]
    return key, None


# --------------------------------------------------------------------------- regression


def phase_regression(engine: Engine, fixtures_dir: str, report: Report) -> None:
    """Replay the committed differential fixtures.

    A fixture in `fixtures/differential/` is a REGRESSION fixture: the pristine input
    that made the engine misbehave, plus a manifest saying what the change was. The
    matrix generates hundreds of files on every run and commits none of them; the ones
    that ARE committed are the ones that reproduce a bug, and they are replayed here so
    the fix cannot silently regress.

    Without this phase the committed fixtures are documentation. With it, they are a
    guard — which is the whole point of committing a reproduction.
    """
    if not os.path.isdir(fixtures_dir):
        return
    manifests = sorted(f for f in os.listdir(fixtures_dir) if f.endswith(".json"))
    if not manifests:
        return

    for name in manifests:
        manifest_path = os.path.join(fixtures_dir, name)
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
        designer = manifest_path.replace(".json", ".Designer.cs")
        if not os.path.exists(designer):
            report.fail(
                manifest.get("case", name),
                "missing-fixture",
                f"{designer} is referenced by {name} but does not exist",
            )
            continue

        case_id = manifest.get("case", name)
        prop = manifest.get("property")
        value = manifest.get("value")
        if not prop or value is None:
            report.fail(
                case_id,
                "fixture-without-property",
                f"{name} does not say which property to set — it cannot guard a fix",
            )
            continue

        # The engine writes in place, so the committed fixture is restored on every exit
        # path. A tier that dirties the repository is a tier nobody runs, and a second
        # run against an already-patched fixture would test nothing.
        original = open(designer, "rb").read()
        try:
            replay_fixture(
                engine, designer, original, manifest, case_id, prop, value, report
            )
        finally:
            with open(designer, "wb") as fh:
                fh.write(original)


def replay_fixture(
    engine: Engine,
    designer: str,
    original: bytes,
    manifest: dict,
    case_id: str,
    prop: str,
    value,
    report: Report,
) -> None:
    """Apply the recorded change to a committed fixture and assert it lands."""
    try:
        schema = engine.parse(designer)
    except Exception as exc:
        report.fail(case_id, "regression-parse", str(exc))
        return

    subject = manifest.get("subjectId")
    node = find_node(schema, subject) if subject else None
    if node is None:
        # A form-level fixture: the change lands on the form, not on a control.
        if prop in ("text", "clientSize", "backColor"):
            if prop == "clientSize":
                schema["form"]["clientSize"] = value
            else:
                schema["form"][prop] = value
        else:
            report.fail(
                case_id, "regression-subject", f"cannot find the subject '{subject}'"
            )
            return
    else:
        node["properties"][prop] = value

    res = engine.generate(designer, schema)
    if not res.get("ok"):
        report.fail(
            case_id, "regression-refused", f"{res.get('error')} ({res.get('errorKind')})"
        )
        return
    if not res.get("changed"):
        report.divergence(
            case_id,
            "regression-discarded",
            f"the committed fixture's {prop} change was discarded — the bug is back",
            property=prop,
            value=value,
        )
        return
    after = open(designer, "rb").read()
    diff = changed_lines(original, after)
    reread = engine.parse(designer)
    if subject:
        rnode = find_node(reread, subject)
        got = rnode["properties"].get(prop) if rnode else None
    else:
        got = reread["form"].get(prop)
    if not values_equal(got, value):
        report.divergence(
            case_id,
            "regression-value",
            f"{prop} reads back as {got!r}, expected {value!r}",
            property=prop,
            value=value,
            diff=diff,
        )
        return
    report.ok()

# --------------------------------------------------------------------------- gate


def divergence_signature(div: dict) -> str:
    """The ROOT CAUSE of a divergence, as a grouping key.

    One bug shows up once per permutation it affects — a missing INSERT path for `Text`
    is 121 separate matrix cases and ONE bug. Emitting 121 fixtures would bury the
    signal in noise, so the gate groups by root cause and emits ONE reproduction per
    group, listing the permutations it covers.
    """
    case_id = div["case"]
    if div["kind"] == "does-not-compile":
        # The compile error IS the root cause: the same error text in many files is one
        # bug, not many.
        errors = div.get("compileErrors", [])
        msg = errors[0].split(":", 2)[-1].strip() if errors else div["detail"]
        return f"compile::{msg[:120]}"
    if div["kind"] == "change-discarded":
        # `<case>__<property>__<mode>` — the property and the mode are the root cause;
        # the dialect, hierarchy and type are the permutations.
        parts = case_id.split("__")
        if len(parts) >= 2:
            return f"change-discarded::{parts[-2]}"
    return f"{div['kind']}::{case_id}"


def write_fixture(
    matrix: dict,
    case: dict,
    prop: str,
    value,
    kind: str,
    detail: str,
    root_cause: str,
    fixtures_dir: str,
    compile_errors=None,
) -> str:
    """Write one committed regression fixture and its manifest.

    The fixture is the PRISTINE INPUT plus a manifest saying what the change was, so
    the regression phase can replay it. The matrix is deterministic, so the input is
    REBUILT from the generator rather than copied out of a work directory a test has
    already written to — a fixture that cannot be reproduced from the generator is a
    fixture that can drift.

    Returns the fixture's path.
    """
    os.makedirs(fixtures_dir, exist_ok=True)
    name = f"{case['id']}__{prop}__insert".replace("__", "-")
    dest = os.path.join(fixtures_dir, f"{name}.Designer.cs")
    pristine = GEN.regenerate_case(case)
    with open(dest, "wb") as fh:
        fh.write(pristine)

    manifest = {
        "case": case["id"],
        "dialect": case["dialect"],
        "type": case["type"],
        "kind": kind,
        "rootCause": root_cause,
        "detail": detail,
        "subjectId": case.get("subjectId"),
        "property": prop,
        "value": value,
        "compileErrors": compile_errors or [],
    }
    with open(dest.replace(".Designer.cs", ".json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
        fh.write("\n")
    return dest


def emit_gate(
    matrix: dict, work: str, report: Report, fixtures_dir: str, patched: dict
) -> None:
    """The fixture-first gate.

    A divergence must land as a committed reproduction BEFORE a patcher change is
    attempted. So the gate writes the offending Designer file into
    `fixtures/differential/` and prints the issue body and the `gh issue create`
    command. It does not commit and it does not open the issue: CI has no push
    authority, and a printed command a human can read is worth more than a bot-written
    issue.

    Divergences are GROUPED BY ROOT CAUSE first. One bug across 121 permutations is one
    fixture and one issue, not 121 of each.
    """
    if not report.divergences:
        return
    os.makedirs(fixtures_dir, exist_ok=True)

    groups: dict[str, list[dict]] = {}
    for div in report.divergences:
        groups.setdefault(divergence_signature(div), []).append(div)

    print()
    print("=" * 72)
    print(
        f"FIXTURE-FIRST GATE — {len(report.divergences)} divergence(s) in "
        f"{len(groups)} root cause(s)"
    )
    print("=" * 72)

    for signature, divs in sorted(groups.items()):
        div = divs[0]
        case = case_by_id(matrix, div["case"])
        if case is None:
            continue
        prop = div.get("property")
        value = div.get("value")
        if not prop or value is None:
            # Nothing to replay — a divergence with no property behind it (a byte-level
            # churn, say) cannot become a regression fixture. Report it and move on.
            print()
            print(f"--- root cause: {signature} ---")
            print(f"    {div['detail']}")
            print(
                "    (no property recorded — this divergence has no replayable fixture)"
            )
            continue
        dest = write_fixture(
            matrix,
            case,
            prop,
            value,
            div["kind"],
            div["detail"],
            signature,
            fixtures_dir,
            div.get("compileErrors", []),
        )

        print()
        print(f"--- root cause: {signature} ---")
        print(f"    {div['detail']}")
        print(f"    affected permutations: {len(divs)}")
        for other in divs[1:6]:
            print(f"      - {other['case']}")
        if len(divs) > 6:
            print(f"      ... and {len(divs) - 6} more")
        for line in div.get("diff", [])[:20]:
            print(f"    {line}")
        for line in div.get("compileErrors", [])[:8]:
            print(f"    {line}")
        print(f"    fixture: {os.path.relpath(dest, ROOT)}")
        print()
        print(
            '    gh issue create --title "[E1] differential: '
            f'{div["kind"]} — {signature.split("::")[-1]}" --label wayfinder:task \\'
        )
        print(
            f'      --body "Part of #1 · tracker row E1\n\n'
            f"Found by the differential matrix tier (`test/verify-differential-matrix.sh`).\n\n"
            f"- root cause: `{signature}`\n"
            f"- example case: `{div['case']}`\n"
            f"- affected permutations: {len(divs)}\n"
            f"- dialect: `{case['dialect']}`\n"
            f"- type: `{case['type']}`\n"
            f"- kind: `{div['kind']}`\n"
            f"- detail: {div['detail']}\n\n"
            f"Reproduction fixture: `{os.path.relpath(dest, ROOT)}`\n\n"
            f'    {chr(10).join(div.get("diff", [])[:20])}\n"'
        )


# --------------------------------------------------------------------------- driver


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--engine", required=True, help="path to the vscforms-engine binary"
    )
    ap.add_argument("--work", required=True, help="scratch directory for the matrix")
    ap.add_argument("--families", default="control,form,encoding")
    ap.add_argument(
        "--no-compile",
        action="store_true",
        help="skip the compile phase (the slow one)",
    )
    ap.add_argument("--report", default="", help="write a JSON report here")
    ap.add_argument(
        "--emit-fixture",
        default="",
        metavar="CASE:PROPERTY",
        help=(
            "write a committed regression fixture for a matrix case and exit. The "
            "fixture is rebuilt from the generator, so it is reproducible rather than "
            "a copy of whatever happened to be on disk."
        ),
    )
    args = ap.parse_args()

    work = os.path.abspath(args.work)
    if os.path.isdir(work):
        shutil.rmtree(work)
    os.makedirs(work, exist_ok=True)

    families = [f.strip() for f in args.families.split(",") if f.strip()]
    matrix = GEN.build(work, families)
    print(f"matrix: {len(matrix['cases'])} case(s)")

    if args.emit_fixture:
        case_id, _, prop = args.emit_fixture.partition(":")
        case = next((c for c in matrix["cases"] if c["id"] == case_id), None)
        if case is None:
            print(f"no such case: {case_id}", file=sys.stderr)
            return 2
        value = None
        for spec in GEN.PROPERTIES:
            if spec["key"] == prop:
                value = spec["v2"]
                break
        if value is None:
            print(f"no such property: {prop}", file=sys.stderr)
            return 2
        dest = write_fixture(
            matrix,
            case,
            prop,
            value,
            "regression",
            f"committed regression fixture for {case_id} / {prop}",
            f"regression::{prop}",
            os.path.join(ROOT, "fixtures", "differential"),
        )
        print(f"wrote {os.path.relpath(dest, ROOT)}")
        return 0

    report = Report()
    engine = Engine(args.engine)
    patched: dict[str, str] = {}
    try:
        phase_structure(engine, matrix, work, report)
        print(f"  structure: {report.passed} passed, {len(report.failures)} failed")

        before = report.passed
        phase_properties(engine, matrix, work, report, patched)
        print(
            f"  properties: {report.passed - before} passed, {len(report.failures)} failed"
        )

        before = report.passed
        phase_form(engine, matrix, work, report)
        print(f"  form: {report.passed - before} passed, {len(report.failures)} failed")

        if not args.no_compile:
            before = report.passed
            phase_compile(engine, matrix, work, report, patched)
            print(
                f"  compile: {report.passed - before} passed, {len(report.failures)} failed"
            )

        before = report.passed
        phase_regression(engine, os.path.join(ROOT, "fixtures", "differential"), report)
        print(
            f"  regression: {report.passed - before} passed, {len(report.failures)} failed"
        )
    finally:
        engine.close()

    emit_gate(
        matrix, work, report, os.path.join(ROOT, "fixtures", "differential"), patched
    )

    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "passed": report.passed,
                    "failures": report.failures,
                    "divergences": report.divergences,
                },
                fh,
                indent=2,
                sort_keys=True,
            )

    print()
    if report.failures:
        print(
            f"differential matrix: {report.passed} passed, {len(report.failures)} FAILED"
        )
        for f in report.failures[:40]:
            print(f"  FAIL {f['case']}: {f['kind']}: {f['detail']}")
        if len(report.failures) > 40:
            print(f"  ... and {len(report.failures) - 40} more")
        return 1
    print(f"differential matrix: {report.passed} passed, ALL GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
