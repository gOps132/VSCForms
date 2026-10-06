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

        var parentMap = BuildParentMap(incoming.Controls);
        var incomingById = Flatten(incoming.Controls).ToDictionary(c => c.Id, StringComparer.Ordinal);
        var currentIds = doc.Controls.Keys.ToHashSet(StringComparer.Ordinal);

        // --- modifications and insertions -------------------------------------
        foreach (var node in incomingById.Values)
        {
            if (!doc.Controls.TryGetValue(node.Id, out var current))
            {
                InsertControl(node, parentMap.GetValueOrDefault(node.Id));
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

    private static Dictionary<string, string> BuildParentMap(IEnumerable<ControlNode> roots)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        void Walk(IEnumerable<ControlNode> nodes, string? parentId)
        {
            foreach (var n in nodes)
            {
                if (parentId is not null)
                    map[n.Id] = parentId;
                Walk(n.Children, n.Id);
            }
        }
        Walk(roots, null);
        return map;
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
        var id = node.Id;

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
        else if (p.Visible is false && !cs.Properties.ContainsKey("Visible"))
            InsertProperty(cs, id, "Visible", "false");

        if (cs.Properties.TryGetValue("Enabled", out var en) && en.Right is LiteralExpressionSyntax
            && CurrentBool(en) != p.Enabled)
            Replace(en.Right.Span, (p.Enabled ?? true) ? "true" : "false");
        else if (p.Enabled is false && !cs.Properties.ContainsKey("Enabled"))
            InsertProperty(cs, id, "Enabled", "false");

        // BackColor. Only the VALUES are replaced, never the type name: a file that writes
        // `Color.FromArgb(...)` must keep writing `Color.FromArgb(...)`. Rewriting it to a
        // different Color spelling is exactly the churn ADR 0005 forbids, and it is silent.
        if (cs.Properties.TryGetValue("BackColor", out var bc) && p.BackColor is string colour)
        {
            if (ColorArgs(bc.Right, colour) is { } args && args != SourceTextFor(bc.Right))
            {
                // A Color static call is not an object creation, and the span to replace is
                // `Arguments.Span` — NOT `ArgumentList.Span`, whose text INCLUDES the
                // parentheses. Using the latter emits `FromArgb0, 255, 0`: the closing paren
                // is inside the replaced range. Both this and reusing ReplaceCreationArgs
                // (which emitted `BackColor = Color.Lime, 240, 240`) were caught by the
                // exact-diff assertion rather than by reading the code.
                if (InvocationArgs(bc.Right)?.Arguments is { } argNodes) Replace(argNodes.Span, args);
                else ReplaceCreationArgs(bc.Right, args);
            }
        }
        else if (p.BackColor is string fresh && !cs.Properties.ContainsKey("BackColor"))
        {
            if (RgbTriplet(fresh) is { } freshArgs)
                InsertProperty(cs, id, "BackColor", $"System.Drawing.Color.FromArgb({freshArgs})");
        }

        // Font is a CONSTRUCTION, not a plain value: `Font = new Font(family, size, style)`.
        if (cs.Properties.TryGetValue("Font", out var fn) && p.Font is { } font)
            foreach (var change in FontChanges(fn.Right, font)) Replace(change.Span, change.NewText);
        else if (p.Font is { } wanted && !cs.Properties.ContainsKey("Font"))
            InsertProperty(cs, id, "Font", FontLiteral(wanted));

        // BackColor and Font need an INSERT path as well as a replace path. Without it, setting
        // a colour on a control that has none is accepted by the canvas and silently discarded
        // by the engine — precisely the "the control appears editable and nothing happens"
        // failure the two-list rule in AGENTS.md warns about, one level down.
        //
        // For an INSERT there is no existing spelling to preserve, so the fully qualified form
        // is emitted: it compiles in every dialect, including the templated one with implicit
        // usings, which is the only dialect where a short name would also work.

        // Items — replace/insert/delete the entire Items block.
        // The incoming items are in node.Properties.Items (string[] or null).
        // The current items statements are in cs.ItemsStatements (List<ExpressionStatementSyntax>).
        // We only handle this for ComboBox/ListBox (handled types with Items).
        var simpleType = TypeTable.SimpleName(cs.Type);
        var incomingItems = node.Properties.Items;
        if ((simpleType == "ComboBox" || simpleType == "ListBox") && (incomingItems is { } || cs.ItemsStatements.Count > 0))
        {
            var currentItems = ExtractItemsFromStatements(cs.ItemsStatements);
            var incomingArray = incomingItems ?? Array.Empty<string>();

            if (incomingArray.Length == 0)
            {
                if (currentItems.Count > 0)
                {
                    // DELETE: remove the items statements
                    DeleteItemsBlock(cs);
                }
                // else: both empty → no change
            }
            else if (currentItems.Count > 0)
            {
                if (!currentItems.SequenceEqual(incomingArray))
                {
                    // REPLACE: rewrite the entire items block as a single AddRange
                    ReplaceItemsBlock(cs, incomingArray);
                }
                // else: items equal → no change
            }
            else
            {
                // INSERT: control has no items, add an AddRange
                InsertItemsBlock(cs, id, incomingArray);
            }
        }

        // TextBox properties
        if (simpleType == "TextBox")
        {
            if (cs.Properties.TryGetValue("Multiline", out var ml) && ml.Right is LiteralExpressionSyntax)
            {
                if (CurrentBool(ml) != p.Multiline)
                    Replace(ml.Right.Span, (p.Multiline ?? false) ? "true" : "false");
            }
            else if (p.Multiline is true && !cs.Properties.ContainsKey("Multiline"))
            {
                InsertProperty(cs, id, "Multiline", "true");
            }

            if (cs.Properties.TryGetValue("ReadOnly", out var ro) && ro.Right is LiteralExpressionSyntax)
            {
                if (CurrentBool(ro) != p.ReadOnly)
                    Replace(ro.Right.Span, (p.ReadOnly ?? false) ? "true" : "false");
            }
            else if (p.ReadOnly is true && !cs.Properties.ContainsKey("ReadOnly"))
            {
                InsertProperty(cs, id, "ReadOnly", "true");
            }

            if (cs.Properties.TryGetValue("MaxLength", out var maxL))
            {
                if (CurrentInt(maxL) is { } curMax && curMax != p.MaxLength && p.MaxLength is int newMax)
                    Replace(maxL.Right.Span, newMax.ToString(CultureInfo.InvariantCulture));
            }
            else if (p.MaxLength is int freshMax && !cs.Properties.ContainsKey("MaxLength"))
            {
                InsertProperty(cs, id, "MaxLength", freshMax.ToString(CultureInfo.InvariantCulture));
            }

            if (cs.Properties.TryGetValue("PasswordChar", out var pc))
            {
                var curPc = CurrentChar(pc);
                if (p.PasswordChar is { Length: > 0 } newPc && (curPc == null || curPc.ToString() != newPc))
                    Replace(pc.Right.Span, $"'{EscapeChar(newPc[0])}'");
                else if (string.IsNullOrEmpty(p.PasswordChar) && curPc != null)
                    Replace(pc.Right.Span, "'\\0'");
            }
            else if (!string.IsNullOrEmpty(p.PasswordChar) && !cs.Properties.ContainsKey("PasswordChar"))
            {
                InsertProperty(cs, id, "PasswordChar", $"'{EscapeChar(p.PasswordChar![0])}'");
            }
        }

        // Leaf widget values and ranges
        if (simpleType is "TrackBar" or "ProgressBar" or "NumericUpDown")
        {
            PatchRangeProperty(cs, id, "Minimum", p.Minimum, simpleType);
            PatchRangeProperty(cs, id, "Maximum", p.Maximum, simpleType);
            PatchRangeProperty(cs, id, "Value", p.Value, simpleType);
        }
    }

    /// <summary>
    /// A `new Font(...)` argument list for a control that has none yet. The family defaults to
    /// "Microsoft Sans Serif" because that is the WinForms default font, and omitting it would
    /// select a different overload.
    /// </summary>
    private static string FontLiteral(FontDto font)
    {
        var family = string.IsNullOrEmpty(font.Family) ? "Microsoft Sans Serif" : font.Family;
        var size = font.Size.ToString("0.##", CultureInfo.InvariantCulture) + "F";
        // The COMMA is part of the style argument, and FontStyleLiteral returns the flag text
        // alone. Concatenating without it emitted `11FSystem.Drawing.FontStyle.Bold)` — a
        // syntax error. Caught by the compile gate, which is the only tier that sees it.
        var style = (font.Bold || font.Italic)
            ? ", " + FontStyleLiteral(font.Bold, font.Italic)
            : string.Empty;
        return $"new System.Drawing.Font(\"{family}\", {size}{style})";
    }

    /// <summary>Exact source text of an expression, for a no-op comparison.</summary>
    private string SourceTextFor(SyntaxNode node) => _source.ToString(node.Span);

    /// <summary>
    /// New argument list for a Color expression, preserving its SPELLING.
    ///
    /// `System.Drawing.Color.FromArgb(240, 240, 240)` and `Color.Red` are both legal and both
    /// appear in real files. We keep whichever the file used and change only the values, so a
    /// colour edit never rewrites the type name. When the shape is not one we recognise we
    /// return null and write NOTHING — guessing at a Color expression would be worse than
    /// declining.
    /// </summary>
    private static string? ColorArgs(ExpressionSyntax rhs, string css)
    {
        var rgb = RgbTriplet(css);
        if (rgb is null) return null;   // '' means a system colour; not editable yet

        // `System.Drawing.Color.FromArgb(...)` parses as a MemberAccess whose EXPRESSION is the
        // invocation — `System.Drawing.Color` . `FromArgb(...)`. Unwrap before deciding, or every
        // fully qualified FromArgb is mistaken for a named colour and becomes `Color.Lime`.
        if (InvocationArgs(rhs) is { } argList && MethodName(rhs) == "FromArgb")
        {
            // Only the 3-argument form is rewritten: a 1-argument FromArgb(int) means something
            // different, and changing the arity would change the meaning.
            //
            // The returned text is the BARE argument list, because a static call's ArgumentList
            // carries no parentheses. An object creation's DOES — hence the two shapes.
            return argList.Arguments.Count == 3 ? rgb : null;
        }

        // A named constant: map back only when the target IS a named colour. Otherwise we cannot
        // express it as a name, so decline and write nothing.
        if (rhs is MemberAccessExpressionSyntax) return NamedColor(css);

        return null;
    }

    /// <summary>
    /// The ArgumentList of a static call, whether or not it is wrapped in the type's member
    /// access. Returns null when the expression is not a call.
    ///
    /// This exists because unwrapping appeared in two places and disagreed, which produced
    /// `BackColor = Color.Lime, 240, 240`. One helper, used by both the shape test and the
    /// replacement, cannot drift.
    /// </summary>
    private static BaseArgumentListSyntax? InvocationArgs(ExpressionSyntax rhs) =>
        rhs is InvocationExpressionSyntax i ? i.ArgumentList
        : rhs is MemberAccessExpressionSyntax { Expression: InvocationExpressionSyntax inner } ? inner.ArgumentList
        : null;

    /// <summary>
    /// The invoked method's TRAILING name. For `System.Drawing.Color.FromArgb(...)` the
    /// invocation's Expression text is the whole dotted path, so comparing it to "FromArgb"
    /// never matched and the colour was silently never written.
    /// </summary>
    private static string MethodName(ExpressionSyntax rhs)
    {
        ExpressionSyntax? target = rhs switch
        {
            InvocationExpressionSyntax i => i.Expression,
            MemberAccessExpressionSyntax m => m.Name,
            _ => null,
        };
        if (target is null) return "";
        var text = target.ToString();
        var dot = text.LastIndexOf('.');
        return dot < 0 ? text : text.Substring(dot + 1);
    }

    /// <summary>
    /// `#RRGGBB` -> `"r, g, b"`, or null when the string is not a plain RGB hex colour.
    /// Shared by the REPLACE path and the INSERT path, because the two must agree on what a
    /// colour means or a colour set on a control that has none would come out different from
    /// the same colour set on one that does.
    /// </summary>
    private static string? RgbTriplet(string css)
    {
        if (string.IsNullOrEmpty(css)) return null;
        if (css.Length != 7 || css[0] != '#') return null;
        if (!int.TryParse(css.AsSpan(1, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var r)
            || !int.TryParse(css.AsSpan(3, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var g)
            || !int.TryParse(css.AsSpan(5, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var b))
            return null;
        return $"{r.ToString(CultureInfo.InvariantCulture)}, {g.ToString(CultureInfo.InvariantCulture)}, {b.ToString(CultureInfo.InvariantCulture)}";
    }

    private static string? NamedColor(string css) => css.ToUpperInvariant() switch
    {
        "#FF0000" => "Color.Red", "#00FF00" => "Color.Lime", "#0000FF" => "Color.Blue",
        "#FFFFFF" => "Color.White", "#000000" => "Color.Black", "#808080" => "Color.Gray",
        "#C0C0C0" => "Color.Silver", "#FFFF00" => "Color.Yellow", "#FFA500" => "Color.Orange",
        "#008000" => "Color.Green", "#000080" => "Color.Navy", "#008080" => "Color.Teal",
        _ => null,
    };

    /// <summary>
    /// The TextChanges for a `new Font(family, size, style)`, one per argument that actually
    /// DIFFERS from what the file already has.
    ///
    /// Deliberately not "rebuild the whole argument list". Doing that rewrote a file whose font
    /// was already correct — `FontStyle.Regular` is written explicitly by the designer, so
    /// rebuilding dropped it and turned a no-op generate into a real edit. That broke byte-level
    /// identity on every untouched form, which is the invariant the whole patcher exists to keep.
    ///
    /// The type name is never touched (ADR 0005): only the argument values change, and only the
    /// ones that differ.
    /// </summary>
    private static IEnumerable<TextChange> FontChanges(ExpressionSyntax rhs, FontDto font)
    {
        if (rhs is not ObjectCreationExpressionSyntax oce || oce.ArgumentList is null) yield break;
        var args = oce.ArgumentList.Arguments;

        // 1- and 4-argument Font overloads are not what Designer output emits, and rewriting
        // across them would change which overload compiles. Decline rather than guess.
        if (args.Count is < 2 or > 3) yield break;

        // --- family
        if (args[0].Expression is LiteralExpressionSyntax fam && fam.IsKind(SyntaxKind.StringLiteralExpression))
        {
            var want = string.IsNullOrEmpty(font.Family) ? fam.Token.ValueText : font.Family;
            if (want != fam.Token.ValueText)
                yield return new TextChange(new TextSpan(fam.Token.Span.Start, fam.Token.Span.Length),
                    $"\"{want}\"");
        }

        // --- size. WinForms writes the `F` suffix; a double literal changes overload resolution.
        if (args[1].Expression is LiteralExpressionSyntax num && num.Token.Value is float cur)
        {
            if (Math.Abs(cur - font.Size) > 0.001f)
                yield return new TextChange(new TextSpan(num.Token.Span.Start, num.Token.Span.Length),
                    font.Size.ToString("0.##", CultureInfo.InvariantCulture) + "F");
        }

        // --- style
        var wantBold = font.Bold;
        var wantItalic = font.Italic;
        bool haveBold = false, haveItalic = false;

        if (args.Count == 3)
        {
            var styleText = args[2].Expression.ToString();
            haveBold = styleText.Contains("Bold", StringComparison.Ordinal);
            haveItalic = styleText.Contains("Italic", StringComparison.Ordinal);
            if (haveBold == wantBold && haveItalic == wantItalic) yield break;   // already correct
            yield return new TextChange(args[2].Expression.Span, FontStyleLiteral(wantBold, wantItalic));
        }
        else if (wantBold || wantItalic)
        {
            // No style argument to replace, so this is an INSERT rather than a replacement.
            yield return new TextChange(args[1].Expression.Span, args[1].Expression is LiteralExpressionSyntax
                ? $"{args[1].Expression}, {FontStyleLiteral(wantBold, wantItalic)}"
                : args[1].Expression.ToString());
        }
    }

    private static string FontStyleLiteral(bool bold, bool italic) => (bold, italic) switch
    {
        (true, true) => "System.Drawing.FontStyle.Bold | System.Drawing.FontStyle.Italic",
        (true, false) => "System.Drawing.FontStyle.Bold",
        (false, true) => "System.Drawing.FontStyle.Italic",
        _ => "System.Drawing.FontStyle.Regular",
    };

    /// <summary>
    /// Insert a property statement the file does not yet have.
    ///
    /// Needed because `Visible = false` and `Enabled = false` are MEANINGFUL when absent (the
    /// defaults are true), so there is no existing text to replace. The anchor is the control's
    /// last existing property assignment, which keeps the statement inside the control's own
    /// block rather than after its `Controls.Add`.
    /// </summary>
    private void InsertProperty(DesignerDocument.ControlSyntax cs, string id, string name, string value)
    {
        var indent = BodyIndent();
        var anchor = cs.Properties.Values
            .OrderByDescending(a => a.SpanStart)
            .FirstOrDefault();
        var line = $"{indent}{This}{id}.{name} = {value};{_eol}";

        if (anchor is not null) InsertLineAfter(anchor, line);
        else if (cs.InitAssignment is not null) InsertLineAfter(cs.InitAssignment, line);
        else if (cs.AddCall is not null) InsertLineAfter(cs.AddCall, line);
    }

    // ----------------------------------------------------------- Items patching

    /// <summary>Extracts items from a list of Items.Add / Items.AddRange statements.</summary>
    private static List<string> ExtractItemsFromStatements(List<ExpressionStatementSyntax> stmts)
    {
        var items = new List<string>();
        foreach (var stmt in stmts)
        {
            if (stmt.Expression is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax itemsCall } inv)
            {
                var method = itemsCall.Name.Identifier.Text;
                if (method == "Add")
                {
                    if (inv.ArgumentList.Arguments.Count == 1
                        && inv.ArgumentList.Arguments[0].Expression is LiteralExpressionSyntax lit
                        && lit.IsKind(SyntaxKind.StringLiteralExpression))
                        items.Add(lit.Token.ValueText);
                }
                else if (method == "AddRange")
                {
                    if (inv.ArgumentList.Arguments.Count == 1)
                    {
                        var argExpr = inv.ArgumentList.Arguments[0].Expression;
                        if (argExpr is ArrayCreationExpressionSyntax ace && ace.Initializer is not null)
                        {
                            foreach (var element in ace.Initializer.Expressions)
                                if (element is LiteralExpressionSyntax rangeLit
                                    && rangeLit.IsKind(SyntaxKind.StringLiteralExpression))
                                    items.Add(rangeLit.Token.ValueText);
                        }
                        else if (argExpr is ObjectCreationExpressionSyntax oce && oce.ArgumentList is not null)
                        {
                            foreach (var arg in oce.ArgumentList.Arguments)
                                if (arg.Expression is LiteralExpressionSyntax rangeLit
                                    && rangeLit.IsKind(SyntaxKind.StringLiteralExpression))
                                    items.Add(rangeLit.Token.ValueText);
                        }
                    }
                }
            }
        }
        return items;
    }

    /// <summary>Replaces the entire items block (first to last statement) with a single AddRange.</summary>
    private void ReplaceItemsBlock(DesignerDocument.ControlSyntax cs, string[] newItems)
    {
        if (cs.ItemsStatements.Count == 0) return;

        // Safety: ensure no non-items statements lie between the first and last items statement.
        var first = cs.ItemsStatements.First().SpanStart;
        var last = cs.ItemsStatements.Last().Span.End;
        var body = _doc.InitializeComponent?.Body;
        if (body is not null)
        {
            foreach (var stmt in body.Statements)
            {
                if (stmt.SpanStart > first && stmt.Span.End < last && !cs.ItemsStatements.Contains(stmt))
                    return; // another statement in between — bail out
            }
        }

        var indent = BodyIndent();
        var thisPrefix = This;
        var id = cs.Id;
        var line = $"{indent}{thisPrefix}{id}.Items.AddRange(new object[] {{ {FormatItemsArray(newItems)} }});{_eol}";

        // Replace the span from first to last items statement
        var span = new TextSpan(first, last - first);
        Replace(span, line);
    }

    /// <summary>Deletes all items statements.</summary>
    private void DeleteItemsBlock(DesignerDocument.ControlSyntax cs)
    {
        if (cs.ItemsStatements.Count == 0) return;

        var first = cs.ItemsStatements.First().SpanStart;
        var last = cs.ItemsStatements.Last().Span.End;

        // Safety check: no other statements in between
        var body = _doc.InitializeComponent?.Body;
        if (body is not null)
        {
            foreach (var stmt in body.Statements)
            {
                if (stmt.SpanStart > first && stmt.Span.End < last && !cs.ItemsStatements.Contains(stmt))
                    return;
            }
        }

        var span = new TextSpan(first, last - first);
        Replace(span, "");
    }

    /// <summary>Inserts an Items.AddRange for a control that has no items yet.</summary>
    private void InsertItemsBlock(DesignerDocument.ControlSyntax cs, string id, string[] items)
    {
        var indent = BodyIndent();
        var thisPrefix = This;
        var line = $"{indent}{thisPrefix}{id}.Items.AddRange(new object[] {{ {FormatItemsArray(items)} }});{_eol}";

        // Anchor after the last property assignment, or init, or add call — same as InsertProperty
        var anchor = cs.Properties.Values
            .OrderByDescending(a => a.SpanStart)
            .FirstOrDefault();
        if (anchor is not null) InsertLineAfter(anchor, line);
        else if (cs.InitAssignment is not null) InsertLineAfter(cs.InitAssignment, line);
        else if (cs.AddCall is not null) InsertLineAfter(cs.AddCall, line);
    }

    /// <summary>Formats items as C# string literals: "a", "b", "c" (without braces).</summary>
    private static string FormatItemsArray(string[] items)
    {
        return string.Join(", ", items.Select(s => $"\"{s}\""));
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

    private void InsertControl(ControlNode node, string? parentId = null)
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

        var addAnchor = (parentId is not null
            ? stmts.LastOrDefault(s => s is ExpressionStatementSyntax es && es.ToString().Contains($"{parentId}.Controls.Add", StringComparison.Ordinal))
            : null)
            ?? (SyntaxNode?)stmts.LastOrDefault(IsControlsAdd)
            ?? stmts.LastOrDefault();

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
            var addLine = parentId is not null
                ? $"{indent}{This}{parentId}.Controls.Add({This}{id});{_eol}"
                : $"{indent}{ControlsThis}Controls.Add({This}{id});{_eol}";

            var e = pending.GetValueOrDefault(addAnchor.SpanStart);
            pending[addAnchor.SpanStart] =
                (addAnchor, [.. e.parts ?? [], addLine]);
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

    private static int? CurrentInt(AssignmentExpressionSyntax a) =>
        a.Right is LiteralExpressionSyntax l && l.Token.Value is int i ? i : null;

    private static char? CurrentChar(AssignmentExpressionSyntax a) =>
        a.Right is LiteralExpressionSyntax l && l.Token.Value is char c ? c : null;

    private static string EscapeChar(char c) => c switch
    {
        '\'' => "\\'",
        '\\' => "\\\\",
        '\0' => "\\0",
        '\n' => "\\n",
        '\r' => "\\r",
        '\t' => "\\t",
        _ => c.ToString(),
    };

    private void PatchRangeProperty(DesignerDocument.ControlSyntax cs, string id, string propName, decimal? targetVal, string simpleType)
    {
        if (targetVal is not { } val) return;

        if (cs.Properties.TryGetValue(propName, out var propAssign))
        {
            var curVal = CurrentDecimal(propAssign.Right);
            if (curVal == val) return;

            if (propAssign.Right is ObjectCreationExpressionSyntax oce && oce.ArgumentList is { } args)
            {
                if (args.Arguments.Count == 1 && args.Arguments[0].Expression is ArrayCreationExpressionSyntax ace && ace.Initializer is { } init && init.Expressions.Count == 4)
                {
                    var bits = decimal.GetBits(val);
                    var indent = BodyIndent();
                    var newArr = $"new int[] {{\n{indent}    {bits[0]},\n{indent}    {bits[1]},\n{indent}    {bits[2]},\n{indent}    {bits[3]}}}";
                    Replace(ace.Span, newArr);
                }
                else
                {
                    ReplaceCreationArgs(propAssign.Right, $"({val.ToString(CultureInfo.InvariantCulture)})");
                }
            }
            else
            {
                var formatted = simpleType == "NumericUpDown" && propAssign.Right.ToString().EndsWith("M", StringComparison.OrdinalIgnoreCase)
                    ? val.ToString(CultureInfo.InvariantCulture) + "M"
                    : ((int)val).ToString(CultureInfo.InvariantCulture);
                Replace(propAssign.Right.Span, formatted);
            }
        }
        else
        {
            var formatted = simpleType == "NumericUpDown"
                ? $"{val.ToString(CultureInfo.InvariantCulture)}"
                : $"{((int)val).ToString(CultureInfo.InvariantCulture)}";
            InsertProperty(cs, id, propName, formatted);
        }
    }

    private static decimal? CurrentDecimal(ExpressionSyntax e)
    {
        if (e is LiteralExpressionSyntax lit && lit.Token.Value is { } v)
            try { return Convert.ToDecimal(v, CultureInfo.InvariantCulture); } catch { return null; }
        if (e is PrefixUnaryExpressionSyntax { OperatorToken.RawKind: (int)SyntaxKind.MinusToken } pre
            && pre.Operand is LiteralExpressionSyntax negLit && negLit.Token.Value is { } nv)
            try { return -Convert.ToDecimal(nv, CultureInfo.InvariantCulture); } catch { return null; }
        if (e is ObjectCreationExpressionSyntax oce && oce.ArgumentList?.Arguments.Count == 1)
        {
            var arg = oce.ArgumentList.Arguments[0].Expression;
            if (arg is LiteralExpressionSyntax alit && alit.Token.Value is { } av)
                try { return Convert.ToDecimal(av, CultureInfo.InvariantCulture); } catch { return null; }
            if (arg is ArrayCreationExpressionSyntax ace && ace.Initializer is { } init)
            {
                var vals = new List<int>();
                foreach (var expr in init.Expressions)
                {
                    if (expr is LiteralExpressionSyntax elit && elit.Token.Value is int iv)
                        vals.Add(iv);
                    else if (expr is PrefixUnaryExpressionSyntax { OperatorToken.RawKind: (int)SyntaxKind.MinusToken } neg
                        && neg.Operand is LiteralExpressionSyntax nlit && nlit.Token.Value is int niv)
                        vals.Add(-niv);
                    else break;
                }
                if (vals.Count == 4)
                    try { return new decimal(vals.ToArray()); } catch { return null; }
            }
        }
        return null;
    }

    private static bool IsThisReceiver(ExpressionSyntax e) =>
        e is MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax };
}