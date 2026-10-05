using System.Globalization;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace MacForms.Engine;

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

    private Patcher(SourceText source, DesignerDocument doc)
    {
        _source = source;
        _doc = doc;
    }

    public static PatchResult Apply(SourceText source, FormSchema incoming)
    {
        var doc = DesignerDocument.Parse(source);
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
            foreach (var c in accepted)
                Console.Error.WriteLine($"  change [{c.Span.Start}..{c.Span.End}) '{c.NewText.Replace("\n", "\\n")}'");

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
            Replace(loc.Right.Span, PointLiteral(p.X, p.Y));

        if (cs.Properties.TryGetValue("Size", out var sz))
        {
            if (CurrentSize(sz) is {} csz && csz != (p.Width, p.Height))
                Replace(sz.Right.Span, SizeLiteral(p.Width, p.Height));
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
            if (stmt is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax { Left: MemberAccessExpressionSyntax l } a }
                && l.Expression is ThisExpressionSyntax && l.Name.Identifier.Text == "Text"
                && a.Right is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression))
            {
                if (lit.Token.ValueText != newText) Replace(a.Right.Span, StringLiteral(newText));
                return;
            }
    }

    // ------------------------------------------------------- control insertion

    private void InsertControl(ControlNode node)
    {
        var ic = _doc.InitializeComponent;
        var formType = _doc.FormType;
        if (ic?.Body is null || formType is null) return;

        var type = node.Type;
        var id = node.Id;

        // 1. Field declaration: after the last control field declaration.
        var fieldAnchor = LastOf(formType.Members.OfType<FieldDeclarationSyntax>()
            .Where(f => f.Declaration.Variables.Any(v => _doc.Controls.ContainsKey(v.Identifier.Text)
                                                       && _doc.Controls[v.Identifier.Text].FieldDeclarator is not null))
            .OrderBy(f => f.SpanStart));
        if (fieldAnchor is not null)
            InsertLineAfter(fieldAnchor, $"private {type} {id};");

        // 2. Instantiation: after the LAST `this.x = new T();` in file order, else before SuspendLayout().
        //    OrderBy(span) is essential: dictionary enumeration order is not file order.
        var initAnchor = _doc.Controls.Values
            .Select(c => c.InitAssignment)
            .Where(a => a.Expression is AssignmentExpressionSyntax { Right: ObjectCreationExpressionSyntax })
            .OrderBy(a => a.SpanStart)
            .LastOrDefault();
        if (initAnchor is not null)
            InsertLineAfter(initAnchor, $"this.{id} = new {type}();");
        else
        {
            var suspend = ic.Body.Statements.OfType<ExpressionStatementSyntax>()
                .FirstOrDefault(s => s.Expression is InvocationExpressionSyntax iv
                    && iv.Expression.ToString().Contains("SuspendLayout", StringComparison.Ordinal));
            if (suspend is not null)
                InsertLineBefore(suspend, $"this.{id} = new {type}();");
        }

        // 3. Property block, anchored on the last property group inside the method.
        var propAnchor = _doc.Controls.Values
            .SelectMany(c => c.Properties.Values)
            .Select(a => a.FirstAncestorOrSelf<ExpressionStatementSyntax>())
            .Where(a => a is not null)
            .OrderBy(a => a!.SpanStart)
            .LastOrDefault();
        if (propAnchor is not null)
        {
            var indent = LineIndentAt(propAnchor.SpanStart);
            var sb = new StringBuilder();
            sb.Append('\n').Append(indent).Append("//\n");
            sb.Append(indent).Append("// ").Append(id).Append('\n');
            sb.Append(indent).Append("//\n");
            sb.Append(indent).Append($"this.{id}.Location = {PointLiteral(node.Properties.X, node.Properties.Y)};\n");
            sb.Append(indent).Append($"this.{id}.Name = {StringLiteral(id)};\n");
            sb.Append(indent).Append($"this.{id}.Size = {SizeLiteral(node.Properties.Width, node.Properties.Height)};\n");
            if (node.Properties.TabIndex is int tbi)
                sb.Append(indent).Append($"this.{id}.TabIndex = {tbi.ToString(CultureInfo.InvariantCulture)};\n");
            if (node.Properties.Text is string txt)
                sb.Append(indent).Append($"this.{id}.Text = {StringLiteral(txt)};\n");
            sb.Append(indent).Append("//\n");
            InsertAfter(propAnchor, sb.ToString());
        }

        // 4. Add to the container, after the LAST Controls.Add in file order.
        // 4. Add to the container, after the LAST `this.Controls.Add(...)` in file order.
        //    NOTE: this must be a genuine Add call. During parsing, a control that had no
        //    separate instantiation statement can have its AddCall pointed at some other
        //    statement, so re-verify the shape here rather than trusting the index.
        var adds = _doc.Controls.Values
            .Select(c => c.AddCall)
            .Where(a => a is not null
                        && a.Expression is InvocationExpressionSyntax inv
                        && inv.Expression.ToString().Contains("Controls.Add", StringComparison.Ordinal))
            .OrderBy(a => a!.SpanStart)
            .ToList();

        if (adds.Count > 0)
            InsertLineAfter(adds[^1], $"this.Controls.Add(this.{id});");
        else
            InsertLineBefore(_doc.Controls.Values
                .Select(c => c.AddCall)
                .Where(a => a is not null)
                .OrderBy(a => a!.SpanStart)
                .FirstOrDefault() ?? _doc.InitializeComponent!.Body!.Statements[0],
                $"this.Controls.Add(this.{id});");
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
            IndentOf(_source.ToString(), node.SpanStart) + line + "\n"));

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
        _changes.Add(new TextChange(new TextSpan(nl + 1, 0),
            IndentOf(text, node.SpanStart) + line + "\n"));
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