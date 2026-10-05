# Editor dialects are a first-class concept

Designer files come in four shapes. Treat recognising and preserving them as part of the
parser's job, not as a robustness detail.

## Definition

A **dialect** is the set of syntactic conventions a Designer file uses for the same
information: whether members are `this.`-qualified, whether types are fully qualified, and
which naming the file/collection use. The four in scope are listed in `SCHEMA.md` and in
[ADR 0005](0005-write-back-in-the-files-dialect.md): classic, templated, bare, this-style.

## Why this is in the glossary

Three real bugs came from not naming this:

- The engine reported a freshly-created `dotnet new winforms` project as an **empty form at
  100% coverage** — a fresh template writes `ClientSize = new Size(800, 450);`, with no
  `this.` and no fully qualified type, and the parser only understood
  `this.ClientSize = new System.Drawing.Size(...)`. The coverage banner then actively
  reassured the user that nothing was missing.
- Adding a control to such a file emitted a `Controls.Add` for an undeclared field, because
  every insertion anchor was assumed to be an existing control. It did not compile.
- Patching a bare file rewrote its type names, and inserted lines mixed line endings into a
  CRLF file, so every later `git diff` showed the whole file.

Each was invisible to a test that counted changed lines, because the line count was right and
the *content* was wrong. The glossary entry exists so the next change names the dialect
explicitly instead of rediscovering it.

## Modelling rules

- Parsing must accept **all** dialects; there is no "the" format.
- Writing must emit the dialect **that was found**, per signal. Two signals, not one: the
  `this-style` dialect is genuinely mixed within a single file.
- A dialect is detected from syntax, never from a substring test.
- Formatting invariants outside the edited region (line ending, BOM, indentation) belong to
  the file, not to us.

## Note on coverage figures

Per-form coverage is dialect-independent, but a form we cannot parse at all is reported as
*empty and fully covered* rather than as an error. That is the specific failure this term
exists to prevent: a silent gap that looks like a success.