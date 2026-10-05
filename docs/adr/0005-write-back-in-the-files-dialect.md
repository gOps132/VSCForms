# Write back in the file's own dialect, never qualify what was already qualified

When patching or inserting code, preserve the conventions already present in the file: type
qualification, the `this.` prefix, line endings, BOM, and indentation.

## Context

Designer files are not one format. At least four dialects occur in real projects:

| Dialect | Instantiation | `Controls.Add` | Where |
|---|---|---|---|
| classic | `this.x = new System.Windows.Forms.Button();` | `this.Controls.Add(this.x)` | Visual Studio designer output; the whole 154-file corpus |
| templated | none — no controls yet | none | a freshly `dotnet new winforms` project |
| bare | `x = new Button();` | `Controls.Add(x)` | files whose `this.` was never introduced |
| this-style | `this.x = new ...Button();` | `Controls.Add(this.x)` | Visual Studio after it rewrites a fresh template |

Two failure modes were observed, both invisible to a diff-counting test and both real churn:

- Patching `Location` by replacing the whole creation expression rewrote `new Point(1, 2)` as
  `new System.Drawing.Point(1, 2)`. It compiles; it is still a change the user did not ask for.
- Inserting with an unconditional `this.` prefix mixed both conventions inside a single file.

The `this-style` dialect is why one prefix is not enough: it writes `this.txt.Location = ...`
while leaving `Controls.Add(...)` bare. Both appear in the *same file*.

## Decision

Two independent dialect signals, tracked separately:

- **`UsesThisPrefix`** — are control members `this.`-qualified? Detected from control
  *instantiations* only.
- **`ControlsCollectionIsQualified`** — is `Controls.Add` `this.`-qualified? Taken from the
  last `Controls.Add` call.

On insert, emit each prefix per its own signal. When patching `Location`/`Size`, replace only
the **argument list** of the creation expression, never the type name.

Byte-level identity is preserved outside the edit: the file's line ending, its UTF-8 BOM, and
the body indentation.

## Consequences

- Detection keyed on the literal substring `this.` is wrong in both directions — it fires on
  form members, and misses a bare file whose only `this.` is on the form.
- `File.ReadAllText` cannot be used to read a Designer file: it consumes the UTF-8 BOM, which
  alters line 1 of every file on every edit. Read bytes.
- Indentation must come from the method body's first statement, not from whichever node is
  being used as an insertion anchor — an anchor may sit on a continuation line.
- `test/verify-dialects.sh` covers the templated, bare and this-style dialects, including a
  compile gate for each. The classic dialect is covered by `test/verify.sh`.