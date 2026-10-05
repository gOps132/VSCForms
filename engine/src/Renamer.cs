using System.Text;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace VSCForms.Engine;

/// <summary>
/// Renames a control.
///
/// THE BOUNDARY (docs/adr/0008-rename-boundary.md)
///   Every other operation is confined to the Designer File. This one is not, because the
///   control's name also appears in the hand-written code-behind:
///       this.btnCalculate.Click += new EventHandler(this.btnCalculate_Click);
///   Renaming only the Designer File leaves CS1061 in the user's project — and our compile tier
///   would not catch it, because it builds against a generated shim with no handler wiring.
///
/// THE RULE
///   Designer File: every reference, unconditionally. We own that file.
///   Code-behind:   only where the identifier is the RECEIVER of a member access
///                  (`id.Click`, `id.Value = …`) — unambiguously the control, semantics preserved.
///   Anywhere else in the code-behind: REFUSE, naming file and line. Same stance as ADR 0003:
///   a refusal costs one rename in an IDE the user already has open; a wrong guess costs them a
///   build error in their own project.
///
///   Strings and comments are never rewritten, in either file. A control's name in a
///   `/// <summary>` is not a reference, and editing it is churn nobody asked for.
/// </summary>
public static class Renamer
{
    public sealed record Result(
        string DesignerPath,
        string? CodeBehindPath,
        string From,
        string To,
        int ReferenceCount);

    private static readonly Regex Identifier =
        new(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

    public static Result Rename(
        string designerPath,
        string from,
        string to,
        TextWriter stderr)
    {
        if (string.IsNullOrWhiteSpace(from)) throw new DesignException("from is required", "bad-rename");
        if (string.IsNullOrWhiteSpace(to)) throw new DesignException("to is required", "bad-rename");
        if (!Identifier.IsMatch(to))
            throw new DesignException(
                $"'{to}' is not a valid identifier — start with a letter or underscore", "bad-rename");
        if (from == to) throw new DesignException("the new name is the same as the old", "bad-rename");
        if (!File.Exists(designerPath))
            throw new DesignException($"File not found: {designerPath}", "not-found");

        var bytes = File.ReadAllBytes(designerPath);
        bool bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
        var designerText = new UTF8Encoding(false).GetString(bytes, bom ? 3 : 0, bytes.Length - (bom ? 3 : 0));
        var designer = SourceText.From(designerText);

        // Refusals are checked BEFORE any planning, so a refused rename never even parses the
        // code-behind and cannot leave one file written and the other not.
        var doc = DesignerDocument.Parse(designer, designerPath);
        if (doc.Schema.Analysis.Refuses is { Count: > 0 } refuses)
            throw new DesignException(
                $"This form is read-only in VSCForms ({string.Join("; ", refuses)}), so it cannot be "
                + "renamed. Open it as text to rename it.", "refused");

        if (!doc.Controls.TryGetValue(from, out var control))
            throw new DesignException($"No control named '{from}' in this form", "not-found");
        if (!TypeTable.IsHandled(control.Type))
            throw new DesignException(
                $"'{from}' is a Locked Control, so its name is not ours to change. Open the file as "
                + "text to rename it.", "locked");

        if (doc.Controls.ContainsKey(to))
            throw new DesignException(
                $"A control named '{to}' already exists in this form", "conflict");

        // ---- plan the Designer File ------------------------------------------
        int designerRefs = CountDesignerReferences(doc, from);
        if (designerRefs == 0)
            throw new DesignException(
                $"'{from}' has no reference in the Designer File", "not-found");

        // ---- plan the code-behind --------------------------------------------
        var codeBehind = SiblingCodeBehind(designerPath);
        string? codeBehindText = null;
        byte[]? codeBehindBytes = null;
        bool codeBehindBom = false;
        List<TextChange>? codeBehindChanges = null;

        if (codeBehind is not null && File.Exists(codeBehind))
        {
            codeBehindBytes = File.ReadAllBytes(codeBehind);
            codeBehindBom = codeBehindBytes.Length >= 3
                            && codeBehindBytes[0] == 0xEF && codeBehindBytes[1] == 0xBB
                            && codeBehindBytes[2] == 0xBF;
            codeBehindText = new UTF8Encoding(false).GetString(
                codeBehindBytes, codeBehindBom ? 3 : 0, codeBehindBytes.Length - (codeBehindBom ? 3 : 0));

            var tree = CSharpSyntaxTree.ParseText(SourceText.From(codeBehindText));
            var model = tree.GetRoot();

            foreach (var token in model.DescendantTokens())
            {
                if (token.ValueText != from) continue;
                if (!token.IsKind(SyntaxKind.IdentifierToken)) continue;

                // A verbatim identifier is skipped by the rewrite (the `@` would be lost,
                // turning a legal identifier into a keyword). Accepting one here would mean we
                // report success while leaving a dangling reference behind — precisely the
                // CS1061 this whole operation exists to prevent. So refuse it.
                var line = tree.GetLineSpan(token.Span).StartLinePosition.Line + 1;
                if (token.Text.StartsWith('@'))
                    throw new DesignException(
                        $"'{token.Text}' appears in {Path.GetFileName(codeBehind)} on line {line}. "
                        + "VSCForms will not rewrite a verbatim identifier, so it cannot rename "
                        + "this one safely.", "ambiguous-reference");

                if (IsReceiver(token)) continue;

                throw new DesignException(
                    $"'{from}' appears in {Path.GetFileName(codeBehind)} on line {line}, where it "
                    + "is not a reference to the control. Rename it in your IDE instead — VSCForms "
                    + "will not guess what it means.", "ambiguous-reference");
            }

            codeBehindChanges = RenameTokens(model, from, to);
        }

        // ---- both plans are valid; now write ---------------------------------
        // Batching the designer change the same way the patcher does: non-overlapping
        // zero-width inserts may share a position, replacements may not overlap.
        var designerChanges = new List<TextChange>();
        var designerTree = CSharpSyntaxTree.ParseText(designer).GetRoot();
        foreach (var c in Batch(RenameTokens(designerTree, from, to))) designerChanges.Add(c);
        Write(designerPath, designer.WithChanges(designerChanges).ToString(), bom);
        Debug(stderr, "designer", designerChanges);

        if (codeBehind is not null && codeBehindChanges is not null && codeBehindBytes is not null)
        {
            var updated = SourceText.From(codeBehindText!)
                .WithChanges(Batch(codeBehindChanges)).ToString();
            Write(codeBehind, updated, codeBehindBom);
            Debug(stderr, Path.GetFileName(codeBehind), codeBehindChanges);
            Log(stderr, $"renamed {from} -> {to} in {Path.GetFileName(codeBehind)}");
        }

        Log(stderr, $"renamed {from} -> {to}: {designerRefs} reference(s) in the Designer File");
        return new Result(designerPath, codeBehind, from, to, designerRefs);
    }

    /// <summary>
    /// True when the identifier is the RECEIVER of a member access — `id.Click`, and therefore
    /// unambiguously the control. `id` as a method argument is NOT a receiver, and neither is a
    /// declaration, so both are treated as ambiguous and refused.
    /// </summary>
    private static bool IsReceiver(SyntaxToken token)
    {
        if (token.Parent is not IdentifierNameSyntax id) return false;
        return id.Parent is MemberAccessExpressionSyntax ma && ma.Expression == id;
    }

    /// <summary>
    /// Every identifier token equal to <paramref name="from"/>, plus the <c>Name</c> string
    /// literal on the control itself.
    ///
    /// Comments and other string literals are excluded automatically: their tokens are
    /// <c>SingleLineCommentToken</c> / <c>StringLiteralToken</c>, never
    /// <c>IdentifierToken</c>. A control's name in a <c>/// &lt;summary&gt;</c> is text about the
    /// control, not a reference to it, and rewriting it would be churn nobody asked for.
    ///
    /// <see cref="Control.Name"/> is the deliberate exception. Its literal value is not prose —
    /// it is the control's RUNTIME identity, and the schema's <c>id</c> is derived from the field
    /// name. Renaming the field and leaving <c>Name = "old"</c> behind would make the canvas and
    /// WinForms disagree about what the control is called, so a <c>FindControl("old")</c> in the
    /// user's own code would keep working while the canvas shows the new name. Visual Studio
    /// keeps these in sync for the same reason.
    ///
    /// A verbatim identifier (<c>@btnGo</c>) is skipped rather than rewritten: the <c>@</c> would
    /// be lost, turning a legal identifier into a keyword. It cannot occur in Designer output,
    /// and a rename that silently corrupts it would be worse than one that refuses.
    /// </summary>
    private static List<TextChange> RenameTokens(SyntaxNode root, string from, string to)
    {
        var changes = new List<TextChange>();
        foreach (var token in root.DescendantTokens())
        {
            if (token.ValueText != from) continue;
            if (!token.IsKind(SyntaxKind.IdentifierToken)) continue;
            if (token.Parent is null) continue;
            if (token.Text.StartsWith('@')) continue;

            changes.Add(new TextChange(new TextSpan(token.Span.Start, token.Span.Length), to));
        }

        changes.AddRange(NameLiterals(root, from, to));
        return changes;
    }

    /// <summary>
    /// The string literals of <c>&lt;control&gt;.Name = "&lt;old&gt;"</c> assignments belonging to
    /// the control being renamed.
    ///
    /// A separate pass over the assignments rather than a lookup from the identifier token,
    /// because the tree nests the receiver: in <c>this.btnGo.Name = "btnGo"</c> the identifier's
    /// PARENT is the member access <c>this.btnGo</c>, and <c>.Name</c> is one level further out.
    /// Walking assignments matches on the whole statement and cannot get that nesting wrong.
    ///
    /// This literal is rewritten even though other strings are not, because it is the control's
    /// RUNTIME identity rather than prose: <c>Control.Name</c> is what <c>FindControl("...")</c>
    /// matches on, and the schema's <c>id</c> is derived from the field name. Leaving it stale
    /// would make the canvas and WinForms disagree about the control's name. Visual Studio keeps
    /// the two in sync for the same reason.
    /// </summary>
    private static IEnumerable<TextChange> NameLiterals(SyntaxNode root, string from, string to)
    {
        foreach (var assign in root.DescendantNodes().OfType<AssignmentExpressionSyntax>())
        {
            if (assign.Left is not MemberAccessExpressionSyntax ma) continue;
            if (ma.Name.Identifier.Text != "Name") continue;
            if (assign.Right is not LiteralExpressionSyntax lit) continue;
            if (lit.Token.ValueText != from) continue;

            // The receiver chain must bottom out at the control being renamed and nothing else:
            //   btnGo.Name  /  this.btnGo.Name  /  this.pnl.btnGo.Name
            if (!ReceiverEndsWith(ma.Expression, from)) continue;

            yield return new TextChange(
                new TextSpan(lit.Token.Span.Start, lit.Token.Span.Length), $"\"{to}\"");
        }
    }

    private static bool ReceiverEndsWith(ExpressionSyntax receiver, string id)
    {
        while (receiver is MemberAccessExpressionSyntax inner)
        {
            if (inner.Name.Identifier.Text == id) return true;
            receiver = inner.Expression;
        }
        return receiver is IdentifierNameSyntax { Identifier.Text: var t } && t == id;
    }

    private static IEnumerable<TextChange> Batch(List<TextChange> changes)
        => changes.OrderBy(c => c.Span.Start);

    /// <summary>
    /// How many places in the Designer File the name occurs. Used to refuse a rename that would
    /// change nothing, and to report what happened.
    /// </summary>
    private static int CountDesignerReferences(DesignerDocument doc, string from)
    {
        return doc.Root.DescendantTokens()
            .Count(t => t.IsKind(SyntaxKind.IdentifierToken) && t.ValueText == from
                        && !t.Text.StartsWith('@'));
    }

    /// <summary>
    /// `Form1.Designer.cs` -> `Form1.cs`. The code-behind is derived rather than searched for,
    /// because there is exactly one and a directory scan would pick up unrelated project files.
    /// </summary>
    private static string? SiblingCodeBehind(string designerPath)
    {
        const string Suffix = ".Designer.cs";
        if (!designerPath.EndsWith(Suffix, StringComparison.OrdinalIgnoreCase)) return null;
        var dir = Path.GetDirectoryName(designerPath);
        if (dir is null) return null;
        return Path.Combine(dir, designerPath[..^Suffix.Length] + ".cs");
    }

    /// <summary>Write bytes, re-adding the BOM if the file had one.</summary>
    private static void Write(string path, string text, bool bom)
    {
        var body = new UTF8Encoding(false).GetBytes(text);
        File.WriteAllBytes(path, bom ? new byte[] { 0xEF, 0xBB, 0xBF }.Concat(body).ToArray() : body);
    }

    /// <summary>
    /// MF_DEBUG=1 prints every span we emit, to stderr — the same switch the patcher honours,
    /// because "what exactly did you change?" is the first question when a rename surprises
    /// anyone. Kept permanently rather than as a debugging aid to be removed.
    /// </summary>
    private static void Debug(TextWriter w, string file, List<TextChange> changes)
    {
        if (Environment.GetEnvironmentVariable("MF_DEBUG") != "1") return;
        foreach (var c in changes.OrderBy(c => c.Span.Start))
            w.WriteLine($"  change {file} [{c.Span.Start}..{c.Span.End}) '{c.NewText}'");
        w.Flush();
    }

    private static void Log(TextWriter w, string msg)
    {
        w.WriteLine($"[vscforms-engine] {msg}");
        w.Flush();
    }
}