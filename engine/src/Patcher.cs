using System.Globalization;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace VSCForms.Engine;

/// <summary>
/// Applies a Form Schema back to a Designer File, surgically.
///
/// THE SAFETY INVARIANT: every write is a <see cref="TextChange"/> over a span computed
/// against the ORIGINAL text. We locate syntax to find spans, then throw the tree away and
/// write text. This makes "every other byte is identical" structural rather than something
/// we have to test for.
///
/// A control marked locked is never written to at all. If anything is uncertain, we emit
/// nothing.
/// </summary>
public sealed class Patcher
{
    private readonly SourceText _source;
    private readonly DesignerDocument _doc;
    private readonly List<TextChange> _changes = new();
    private readonly string _eol = "\n";

    private Patcher(SourceText source, DesignerDocument doc)
    {
        _source = source;
        _doc = doc;
        _eol = DetectEol(source.ToString());
    }

    /// <summary>
    /// The file's dominant line ending. Designer files are CRLF, but a hand-edited one may be
    /// LF, and inserting LF lines into a CRLF file produces a mixed-ending file that shows up
    /// as a whole-file diff in every subsequent git operation.
    /// </summary>
    private static string DetectEol(string text)
    {
        int crlf = 0, lf = 0;
        for (int i = 0; i < text.Length; i++)
        {
            if (text[i] != '\n') continue;
            if (i > 0 && text[i - 1] == '\r') crlf++; else lf++;
        }
        return crlf > lf ? "\r\n" : "\n";
    }

    public static PatchResult Apply(SourceText source, FormSchema incoming, string? path = null)
    {
        var doc = DesignerDocument.Parse(source, path);
        var patcher = new Patcher(source, doc);
        return patcher.Run(incoming);
    }

    private PatchResult Run(FormSchema incoming)
    {
        var doc = _doc;

        if (incoming.Analysis?.Refuses is { Count: > 0 } refuses)
            return PatchResult.Refused(string.Join("; ", refuses));

        var incomingById = Flatten(incoming.Controls).ToDictionary(c => c.Id, StringComparer.Ordinal);
        var currentIds = doc.Controls.Keys.ToHashSet(StringComparer.Ordinal);

        // --- modifications and insertions -------------------------------------
        foreach (var node in incomingById.Values)
        {
            if (!doc.Controls.TryGetValue(node.Id, out var current))
            {
                InsertControl(node);
                continue;
            }
            if (node.Locked) continue;   // SAFETY: never touch a locked control
            PatchProperties(node, current);
        }

        // --- deletions --------------------------------------------------------
        foreach (var id in currentIds)
        {
            if (incomingById.ContainsKey(id)) continue;
            var cs = doc.Controls[id];
            if (!TypeTable.IsHandled(cs.Type)) continue;  // SAFETY: never delete unmodelled
            DeleteControl(id, cs);
        }

        // --- form-level -------------------------------------------------------
        if (incoming.Form.Text != doc.Schema.Form.Text)
            PatchFormText(incoming.Form.Text);

        // --- assemble ---------------------------------------------------------
        // Non-overlapping zero-width inserts are allowed to share a position; overlapping
        // replacements are not. Sort by span start, then drop any change that overlaps.
        var ordered = _changes.OrderBy(c => c.Span.Start).ToList();
        var accepted = new List<TextChange>(ordered.Count);
        int cursor = -1;
        foreach (var c in ordered)
        {
            if (c.Span.Start < cursor) continue;
            if (c.NewText.Length == 0 && c.Span.Length == 0) { continue; }
            accepted.Add(c);
            if (c.Span.Length > 0) cursor = c.Span.End;
        }

        // MF_DEBUG=1 prints every emitted span; kept permanently because "what exactly did
        // we change?" is the first question when a surgical patch surprises anyone.
        if (Environment.GetEnvironmentVariable("MF_DEBUG") == "1")
        {
            foreach (var c in accepted)
                Console.Error.WriteLine($"  change [{c.Span.Start}..{c.Span.End}) '{c.NewText.Replace("\n", "\\n")}'");
        }

        var finalSource = _source.WithChanges(accepted);
        var changed = !TextEquals(_source, finalSource);
        return new PatchResult(finalSource.ToString(), accepted, changed);
    }

    /// <summary>Source text, for tests that want to feed the patcher directly.</summary>
    public static string Patch(string original, FormSchema incoming) =>
        Apply(SourceText.From(original), incoming).Text ?? original;

    public sealed record PatchResult(string? Text, List<TextChange> Changes, bool Changed, string? Refusal = null)
    {
        public static PatchResult Refused(string why) => new(null, new(), false, why);
    }

    private static IEnumerable<ControlNode> Flatten(IEnumerable<ControlNode> nodes)
    {
        foreach (var n in nodes)
        {
            yield return n;
            foreach (var c in Flatten(n.Children)) yield return c;
        }
    }

    private static bool TextEquals(SourceText a, SourceText b)
    {
        if (a.Length != b.Length) return false;
        for (int i = 0; i < a.Length; i++)
            if (a[i] != b[i]) return false;
        return true;
    }

    // ------------------------------------------------------- property patching

    private void PatchProperties(ControlNode node, DesignerDocument.ControlSyntax cs)
    {
        var p = node.Properties;

        if (cs.Properties.TryGetValue("Location", out var loc)
            && CurrentPoint(loc) is { } curPoint && curPoint != (p.X, p.Y))
            ReplaceCreationArgs(loc.Right, $"({p.X.ToString(CultureInfo.InvariantCulture)}, {p.Y.ToString(CultureInfo.InvariantCulture)})");

        if (cs.Properties.TryGetValue("Size", out var sz))
        {
            if (CurrentSize(sz) is {} csz && csz != (p.Width, p.Height))
                ReplaceCreationArgs(sz.Right, $"({p.Width.ToString(CultureInfo.InvariantCulture)}, {p.Height.ToString(CultureInfo.InvariantCulture)})");
        }

        if (cs.Properties.TryGetValue("Text", out var t) && t.Right is LiteralExpressionSyntax)
        {
            var cur = CurrentText(t);
            if (cur != p.Text) Replace(t.Right.Span, StringLiteral(p.Text ?? ""));
        }

        if (cs.Properties.TryGetValue("TabIndex", out var ti)
            && ti.Right is LiteralExpressionSyntax { Token.Value: int curTi } && curTi != p.TabIndex)
            Replace(ti.Right.Span, (p.TabIndex ?? curTi).ToString(CultureInfo.InvariantCulture));

        if (cs.Properties.TryGetValue("Visible", out var v) && v.Right is LiteralExpressionSyntax
            && CurrentBool(v) != p.Visible)
            Replace(v.Right.Span, (p.Visible ?? true) ? "true" : "false");

        if (cs.Properties.TryGetValue("Enabled", out var en) && en.Right is LiteralExpressionSyntax
            && CurrentBool(en) != p.Enabled)
            Replace(en.Right.Span, (p.Enabled ?? true) ? "true" : "false");
    }

    private void PatchFormText(string newText)
    {
        foreach (var stmt in _doc.InitializeComponent?.Body?.Statements ?? default)
            if (stmt is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a }
                && TryGetFormProperty(a.Left, out var name) && name == "Text"
                && a.Right is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression))
            {
                if (lit.Token.ValueText != newText) Replace(a.Right.Span, StringLiteral(newText));
                return;
            }
    }

    /// <summary>
    /// Recognises a form-level property assignment in either dialect:
    /// `this.Text = ...` or the template's bare `Text = ...`.
    /// </summary>
    private static bool TryGetFormProperty(ExpressionSyntax left, out string name)
    {
        switch (left)
        {
            case MemberAccessExpressionSyntax m when m.Expression is ThisExpressionSyntax:
                name = m.Name.Identifier.Text;
                return true;
            case IdentifierNameSyntax id:
                name = id.Identifier.Text;
                return true;
            default:
                name = "";
                return false;
        }
    }

    // ------------------------------------------------------- control insertion

    /// <summary>
    /// `this.` or nothing for CONTROL members, matching the file's dialect. A file that writes
    /// `btn = new Button();` must not gain `this.btn = new Button();` just because a control was
    /// added.
    /// </summary>
    private string This => _doc.UsesThisPrefix ? "this." : "";

    /// <summary>
    /// The `this.` prefix for the CONTROLS COLLECTION specifically.
    ///
    /// This is tracked separately from <see cref="This"/> because the dialects disagree about it
    /// independently: Visual Studio writes `this.txt.Location = ...` on controls while leaving
    /// `Controls.Add(...)` bare, so a single prefix for both produces mixed output in exactly
    /// the files a real user has.
    /// </summary>
    private string ControlsThis => _doc.ControlsCollectionIsQualified ? "this." : "";

    private void InsertControl(ControlNode node)
    {
        var ic = _doc.InitializeComponent;
        var formType = _doc.FormType;
        if (ic?.Body is null || formType is null) return;

        var type = node.Type;
        var id = node.Id;
        var stmts = ic.Body.Statements;

        // Which dialect is this? Classic designer output has control property assignments and
        // `Controls.Add` calls to anchor on; a freshly-templated project has NEITHER, so every
        // anchor below has a fallback. Without those fallbacks we emit a `Controls.Add` for an
        // undeclared field, which does not compile.
        bool IsInstantiation(SyntaxNode s) =>
            s is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax { Right: ObjectCreationExpressionSyntax } };

        bool IsFormProperty(SyntaxNode s) =>
            s is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a }
                && TryGetFormProperty(a.Left, out var n)
                && n is not ("components");

        bool IsControlsAdd(SyntaxNode s) =>
            s is ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }
                && inv.Expression.ToString().Contains("Controls.Add", StringComparison.Ordinal);

        // 1. Field declaration — after the last field in the class, whatever it is.
        var fieldAnchor = formType.Members.OfType<FieldDeclarationSyntax>().LastOrDefault();
        if (fieldAnchor is not null)
            InsertLineAfter(fieldAnchor, IndentOf(_source.ToString(), fieldAnchor.SpanStart) + $"private {type} {id};");
        else
            InsertLineBefore(formType.CloseBraceToken, $"private {type} {id};");

        // 2. Instantiation — after the last `this.x = new T();`, else at the top of the body.
        var initAnchor = stmts.LastOrDefault(IsInstantiation);
        if (initAnchor is not null)
            InsertLineAfter(initAnchor, BodyIndent() + $"{This}{id} = new {type}();");
        else if (stmts.Count > 0)
            InsertLineBefore(stmts[0], $"this.{id} = new {type}();");

        // 3/4. Property block and Controls.Add. These often share an anchor in a fresh project,
        // so collect them and merge per anchor — otherwise two zero-width inserts at the same
        // position can land in the wrong order relative to each other.
        var lastControlProp = _doc.Controls.Values
            .SelectMany(c => c.Properties.Values)
            .Select(a => a.FirstAncestorOrSelf<ExpressionStatementSyntax>())
            .Where(a => a is not null)
            .OrderBy(a => a!.SpanStart)
            .LastOrDefault();

        // Anchor the property block on an existing control block if there is one (so the
        // `// name` comment header lands where the designer would put it); otherwise on the
        // last form-level property, which is where a templated project wants it.
        var propAnchor = (SyntaxNode?)lastControlProp
            ?? stmts.LastOrDefault(IsFormProperty)
            ?? initAnchor
            ?? stmts.LastOrDefault();

        var addAnchor = (SyntaxNode?)stmts.LastOrDefault(IsControlsAdd) ?? stmts.LastOrDefault();

        var pending = new Dictionary<int, (SyntaxNode node, List<string> parts)>();

        // Indent every emitted line from the BODY's indent rather than from whichever anchor
        // we picked: an anchor may sit on a continuation line, which inflates its indent and
        // previously produced 16-space properties inside an 8-space body.
        var indent = BodyIndent();

        if (propAnchor is not null)
        {
            var sb = new StringBuilder();
            // Only emit the `// name` header where the file already uses that convention.
            if (lastControlProp is not null)
            {
                sb.Append(indent).Append("//").Append(_eol);
                sb.Append(indent).Append("// ").Append(id).Append(_eol);
                sb.Append(indent).Append("//").Append(_eol);
            }
            sb.Append(indent).Append($"{This}{id}.Location = {PointLiteral(node.Properties.X, node.Properties.Y)};").Append(_eol);
            sb.Append(indent).Append($"{This}{id}.Name = {StringLiteral(id)};").Append(_eol);
            sb.Append(indent).Append($"{This}{id}.Size = {SizeLiteral(node.Properties.Width, node.Properties.Height)};").Append(_eol);
            if (node.Properties.TabIndex is int tbi)
                sb.Append(indent).Append($"{This}{id}.TabIndex = {tbi.ToString(CultureInfo.InvariantCulture)};").Append(_eol);
            if (node.Properties.Text is string txt)
                sb.Append(indent).Append($"{This}{id}.Text = {StringLiteral(txt)};").Append(_eol);
            if (lastControlProp is not null) sb.Append(indent).Append("//").Append(_eol);

            var e = pending.GetValueOrDefault(propAnchor.SpanStart);
            pending[propAnchor.SpanStart] = (propAnchor, [.. e.parts ?? [], sb.ToString()]);
        }

        if (addAnchor is not null)
        {
            var e = pending.GetValueOrDefault(addAnchor.SpanStart);
            pending[addAnchor.SpanStart] =
                (addAnchor, [.. e.parts ?? [], $"{indent}{ControlsThis}Controls.Add({This}{id});{_eol}"]);
        }

        foreach (var (_, entry) in pending.OrderBy(kv => kv.Key))
            InsertLineAfter(entry.node, string.Concat(entry.parts));
    }

    // ------------------------------------------------------- control deletion

    private void DeleteControl(string id, DesignerDocument.ControlSyntax cs)
    {
        // Remove the whole property group: from the `// id` comment header through the
        // last property assignment, if the header is adjacent. Then the individual bits.
        foreach (var p in cs.Properties.Values)
        {
            var stmt = p.FirstAncestorOrSelf<ExpressionStatementSyntax>();
            if (stmt is not null)
            {
                var start = IncludeCommentHeader(stmt.SpanStart);
                Replace(new TextSpan(start, stmt.Span.End - start), "");
            }
        }

        if (cs.AddCall is not null) Replace(WholeLineSpan(cs.AddCall.Span), "");

        // Only remove the `this.x = new T();` line when it is a genuine standalone
        // instantiation. If the same statement node is also serving as the AddCall (a file
        // that only has `this.Controls.Add(this.x);` and no separate init), removing it would
        // delete the Add. In that case AddCall removal above already handled it.
        if (cs.InitAssignment is not null
            && !ReferenceEquals(cs.InitAssignment, cs.AddCall)
            && cs.InitAssignment.Expression is AssignmentExpressionSyntax { Right: ObjectCreationExpressionSyntax })
        {
            Replace(WholeLineSpan(cs.InitAssignment.Span), "");
        }

        var fieldStmt = cs.FieldDeclarator?.Ancestors().OfType<FieldDeclarationSyntax>().FirstOrDefault();
        if (fieldStmt is not null) Replace(WholeLineSpan(fieldStmt.Span), "");
    }

    /// <summary>Walks backwards over an immediately-preceding `// id` comment header.</summary>
    /// <summary>
    /// Given a statement start, walk back over any immediately preceding run of `//`
    /// comment lines (the Visual Studio designer emits a `// name` header before each
    /// control's property block) and return the start of that run.
    ///
    /// Stepping back must begin at the START OF THE CURRENT LINE, not at the statement:
    /// the text between a line start and a statement start is only indentation, which
    /// does not begin with "//" and would stop the walk on the first iteration.
    /// </summary>
    private int IncludeCommentHeader(int statementStart)
    {
        var text = _source.ToString();
        int start = LineStartOf(text, statementStart);

        while (start > 0)
        {
            int prevLineEnd = start - 1;               // the '\n' terminating the previous line
            int prevLineStart = LineStartOf(text, prevLineEnd);
            var line = text[prevLineStart..prevLineEnd].Trim();
            if (line.StartsWith("//", StringComparison.Ordinal)) start = prevLineStart;
            else break;
        }
        return start;
    }

    private static int LineStartOf(string text, int pos)
    {
        int nl = text.LastIndexOf('\n', Math.Min(pos, text.Length - 1) - 1 < 0 ? 0 : Math.Min(pos, text.Length - 1) - 1);
        return nl < 0 ? 0 : nl + 1;
    }

    /// <summary>
    /// Indentation of statements inside InitializeComponent, taken from the body's first
    /// statement. Falls back to one level deeper than the method's own indentation.
    ///
    /// Deliberately NOT derived from the chosen anchor: an anchor may sit on a continuation
    /// line, whose leading whitespace is larger than the block indent, which previously
    /// produced 16-space properties inside an 8-space body.
    /// </summary>
    private string BodyIndent()
    {
        var body = _doc.InitializeComponent?.Body;
        if (body is null) return "        ";
        foreach (var st in body.Statements)
        {
            var ind = LineIndentAt(st.SpanStart);
            if (ind.Length > 0) return ind;
        }
        // Empty body: indent of the closing brace plus one level.
        if (body.CloseBraceToken.SpanStart > 0)
            return LineIndentAt(body.CloseBraceToken.SpanStart) + "    ";
        return "        ";
    }

    // ------------------------------------------------------------- primitives

    private void Replace(TextSpan span, string newText)
    {
        if (span.Start < 0 || span.End > _source.Length || span.Start > span.End) return;
        _changes.Add(new TextChange(span, newText));
    }

    private void InsertAfter(SyntaxNode node, string text) =>
        _changes.Add(new TextChange(new TextSpan(node.Span.End, 0), text));

    private void InsertBefore(SyntaxNode node, string text) =>
        _changes.Add(new TextChange(new TextSpan(node.SpanStart, 0), text));

    private void InsertLineBefore(SyntaxNode node, string line) =>
        _changes.Add(new TextChange(new TextSpan(node.SpanStart, 0),
            IndentOf(_source.ToString(), node.SpanStart) + line + _eol));

    /// <summary>
    /// Same, for a token — a class's closing brace is a token, not a node. Inserts before the
    /// token's LINE (the brace already carries indentation on that line) and copies the indent
    /// from the line above, which holds the last member.
    /// </summary>
    private void InsertLineBefore(SyntaxToken token, string line)
    {
        var text = _source.ToString();
        int at = LineStartOf(text, token.SpanStart);
        string indent = "    ";
        if (at > 0)
        {
            int prevStart = LineStartOf(text, at - 1);
            int i = prevStart;
            while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++;
            if (i > prevStart) indent = text[prevStart..i];
        }
        _changes.Add(new TextChange(new TextSpan(at, 0), indent + line + "\n"));
    }

    /// <summary>
    /// Inserts a whole new line immediately after the line containing <paramref name="node"/>,
    /// copying that line's indentation. Deliberately never rewrites any existing byte — an
    /// earlier version replaced the tail of the anchor line, which silently destroyed its
    /// indentation when the statement was the whole line.
    /// </summary>
    private void InsertLineAfter(SyntaxNode node, string line)
    {
        var text = _source.ToString();
        int end = node.Span.End;
        int nl = text.IndexOf('\n', end);
        if (nl < 0) return; // last line with no newline: nothing safe to do
        // `line` must already carry its own indentation. Prepending it here used to
        // double-indent the first line of any caller that had already indented.
        _changes.Add(new TextChange(new TextSpan(nl + 1, 0), line + _eol));
    }

    private static T? LastOf<T>(IEnumerable<T> xs) { T? last = default; foreach (var x in xs) last = x; return last; }

    private string LineIndentAt(int pos)
    {
        var text = _source.ToString();
        int ls = text.LastIndexOf('\n', Math.Min(pos, text.Length - 1));
        ls = ls < 0 ? 0 : ls + 1;
        int i = ls;
        while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++;
        return text[ls..i];
    }

    private static string IndentOf(string text, int pos)
    {
        int ls = text.LastIndexOf('\n', Math.Min(pos, text.Length - 1));
        ls = ls < 0 ? 0 : ls + 1;
        int i = ls;
        while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++;
        return text[ls..i];
    }

    private TextSpan WholeLineSpan(TextSpan span)
    {
        var text = _source.ToString();
        int start = span.Start;
        while (start > 0 && text[start - 1] != '\n') start--;
        int end = span.End;
        while (end < text.Length && text[end] != '\n') end++;
        if (end < text.Length) end++; // include the newline
        return new TextSpan(start, end - start);
    }

    // --------------------------------------------------------------- literals

    /// <summary>
    /// Replaces only the ARGUMENT LIST of an object creation, leaving the type name untouched.
    ///
    /// This matters for fidelity across dialects: a file that writes `new Point(1, 2)` must not
    /// be rewritten to `new System.Drawing.Point(1, 2)` just because a move happened. Both
    /// compile, but rewriting the type name is a change the user did not ask for, and it is
    /// exactly the kind of incidental churn that makes a surgical patch un-surgical.
    /// Falls back to replacing the whole expression when the shape is not a creation.
    /// </summary>
    private void ReplaceCreationArgs(ExpressionSyntax rhs, string newArgs)
    {
        if (rhs is ObjectCreationExpressionSyntax oce && oce.ArgumentList is { } args)
            Replace(args.Span, newArgs);
        else
            Replace(rhs.Span, newArgs);
    }

    internal static string PointLiteral(int x, int y) =>
        $"new System.Drawing.Point({x.ToString(CultureInfo.InvariantCulture)}, {y.ToString(CultureInfo.InvariantCulture)})";

    internal static string SizeLiteral(int w, int h) =>
        $"new System.Drawing.Size({w.ToString(CultureInfo.InvariantCulture)}, {h.ToString(CultureInfo.InvariantCulture)})";

    internal static string StringLiteral(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (var c in s)
            sb.Append(c switch
            {
                '"' => "\\\"",
                '\\' => "\\\\",
                '\n' => "\\n",
                '\r' => "\\r",
                '\t' => "\\t",
                _ => c.ToString()
            });
        sb.Append('"');
        return sb.ToString();
    }

    // ------------------------------------------------------------ current values

    private static (int, int)? CurrentPoint(AssignmentExpressionSyntax a)
    {
        var args = DesignerDocument.ParseArgs(a.Right);
        if (args is not { Length: 2 }) return null;
        return int.TryParse(args[0], out var x) && int.TryParse(args[1], out var y) ? (x, y) : null;
    }

    private static (int, int)? CurrentSize(AssignmentExpressionSyntax a)
    {
        var args = DesignerDocument.ParseArgs(a.Right);
        if (args is not { Length: 2 }) return null;
        return int.TryParse(args[0], out var w) && int.TryParse(args[1], out var h) ? (w, h) : null;
    }

    private static string? CurrentText(AssignmentExpressionSyntax a) =>
        a.Right is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression)
            ? lit.Token.ValueText : null;

    private static bool? CurrentBool(AssignmentExpressionSyntax a) =>
        a.Right is LiteralExpressionSyntax l ? l.Token.Value is true : null;

    private static bool IsThisReceiver(ExpressionSyntax e) =>
        e is MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax };
}