using System.Text;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace VSCForms.Engine;

/// <summary>
/// Scaffolds and unwires event handlers (ADR 0011).
/// Coordinates surgical edits across Form.Designer.cs (+= wiring in InitializeComponent)
/// and Form.cs (handler method stub before the class closing brace).
/// </summary>
public static class EventScaffolder
{
    public sealed record WireResult(
        string DesignerPath,
        string CodeBehindPath,
        int TargetLine,
        int TargetColumn,
        bool CreatedMethod,
        bool ChangedDesigner);

    public sealed record UnwireResult(
        string DesignerPath,
        string? CodeBehindPath,
        bool ChangedDesigner);

    private static readonly Regex Identifier =
        new(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

    public static WireResult Wire(
        string designerPath,
        string controlId,
        string? eventName,
        string? handlerName,
        TextWriter stderr)
    {
        if (string.IsNullOrWhiteSpace(controlId))
            throw new DesignException("controlId is required", "bad-request");
        if (!File.Exists(designerPath))
            throw new DesignException($"File not found: {designerPath}", "not-found");

        // ---- Read and parse Designer File -------------------------------------
        var designerBytes = File.ReadAllBytes(designerPath);
        bool designerBom = designerBytes.Length >= 3
                           && designerBytes[0] == 0xEF && designerBytes[1] == 0xBB && designerBytes[2] == 0xBF;
        var designerText = new UTF8Encoding(false).GetString(
            designerBytes, designerBom ? 3 : 0, designerBytes.Length - (designerBom ? 3 : 0));
        var designerSource = SourceText.From(designerText);

        var doc = DesignerDocument.Parse(designerSource, designerPath);
        if (doc.Schema.Analysis.Refuses is { Count: > 0 } refuses)
        {
            throw new DesignException(
                $"This form is read-only in VSCForms ({string.Join("; ", refuses)}), so events cannot be wired.",
                "refused");
        }

        bool isForm = controlId == doc.Schema.Form.Name || controlId == doc.Schema.Form.ClassName;
        string controlType = isForm ? "System.Windows.Forms.Form" : "";

        if (!isForm)
        {
            if (!doc.Controls.TryGetValue(controlId, out var control))
                throw new DesignException($"No control named '{controlId}' in this form", "not-found");
            if (!TypeTable.IsHandled(control.Type))
                throw new DesignException($"'{controlId}' is a Locked Control, so its events cannot be wired.", "locked");
            controlType = control.Type;
        }

        string resolvedEvent = string.IsNullOrWhiteSpace(eventName)
            ? EventTable.DefaultEvent(controlType)
            : eventName.Trim();

        string resolvedHandler = string.IsNullOrWhiteSpace(handlerName)
            ? $"{controlId}_{resolvedEvent}"
            : handlerName.Trim();

        if (!Identifier.IsMatch(resolvedHandler))
            throw new DesignException($"'{resolvedHandler}' is not a valid identifier", "bad-event");

        // ---- Read and parse sibling code-behind --------------------------------
        var codeBehind = SiblingCodeBehind(designerPath);
        if (codeBehind is null || !File.Exists(codeBehind))
            throw new DesignException($"Code-behind file not found: {codeBehind ?? "null"}", "no-code-behind");

        var cbBytes = File.ReadAllBytes(codeBehind);
        bool cbBom = cbBytes.Length >= 3 && cbBytes[0] == 0xEF && cbBytes[1] == 0xBB && cbBytes[2] == 0xBF;
        var cbText = new UTF8Encoding(false).GetString(cbBytes, cbBom ? 3 : 0, cbBytes.Length - (cbBom ? 3 : 0));
        var cbSource = SourceText.From(cbText);
        var cbTree = CSharpSyntaxTree.ParseText(cbSource);

        if (cbTree.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error))
            throw new DesignException("Code-behind file contains syntax errors", "unparsable-code-behind");

        var formClass = cbTree.GetRoot().DescendantNodes()
            .OfType<ClassDeclarationSyntax>()
            .FirstOrDefault(c => c.Identifier.Text == doc.Schema.Form.ClassName);
        if (formClass is null)
            throw new DesignException($"Class '{doc.Schema.Form.ClassName}' not found in code-behind", "unparsable-code-behind");

        // ---- Plan code-behind edit --------------------------------------------
        var existingMethod = formClass.Members
            .OfType<MethodDeclarationSyntax>()
            .FirstOrDefault(m => m.Identifier.Text == resolvedHandler);

        bool createdMethod = false;
        int targetLine = 1;
        int targetColumn = 1;
        SourceText newCbSource = cbSource;

        if (existingMethod is not null)
        {
            if (existingMethod.Body is not null)
            {
                var span = existingMethod.Body.OpenBraceToken.Span;
                var lp = cbSource.Lines.GetLinePosition(span.End);
                targetLine = lp.Line + 1;
                targetColumn = lp.Character + 1;
            }
            else
            {
                var lp = cbSource.Lines.GetLinePosition(existingMethod.SpanStart);
                targetLine = lp.Line + 1;
                targetColumn = lp.Character + 1;
            }
        }
        else
        {
            createdMethod = true;
            string cbNl = cbText.Contains("\r\n") ? "\r\n" : "\n";
            string indent = "    ";
            if (formClass.Members.Count > 0)
            {
                var trivia = formClass.Members[0].GetLeadingTrivia();
                var ws = trivia.LastOrDefault(t => t.IsKind(SyntaxKind.WhitespaceTrivia));
                if (ws != default) indent = ws.ToFullString();
            }

            string eventArgsType = EventTable.EventArgsType(resolvedEvent);
            string paramList = $"(object sender, {eventArgsType} e)";
            string stub = $"{cbNl}{cbNl}{indent}private void {resolvedHandler}{paramList}{cbNl}{indent}{{{cbNl}{indent}    {cbNl}{indent}}}";

            var closeBracePos = formClass.CloseBraceToken.SpanStart;
            newCbSource = cbSource.WithChanges(new TextChange(new TextSpan(closeBracePos, 0), stub));

            // Compute target line & column inside the new body
            var reTree = CSharpSyntaxTree.ParseText(newCbSource);
            var reClass = reTree.GetRoot().DescendantNodes()
                .OfType<ClassDeclarationSyntax>()
                .FirstOrDefault(c => c.Identifier.Text == doc.Schema.Form.ClassName);
            var reMethod = reClass?.Members.OfType<MethodDeclarationSyntax>()
                .FirstOrDefault(m => m.Identifier.Text == resolvedHandler);
            if (reMethod?.Body is not null)
            {
                var openBraceLp = newCbSource.Lines.GetLinePosition(reMethod.Body.OpenBraceToken.Span.End);
                targetLine = openBraceLp.Line + 2; // the empty line inside braces
                targetColumn = indent.Length + 5;
            }
        }

        // ---- Plan Designer.cs edit --------------------------------------------
        var ic = doc.InitializeComponent
            ?? throw new DesignException("InitializeComponent() not found", "no-initialize-component");
        var existingWiring = FindEventWiring(ic, controlId, resolvedEvent, isForm);
        bool changedDesigner = false;
        SourceText newDesignerSource = designerSource;

        if (existingWiring.Statement is not null && existingWiring.Assign is not null)
        {
            // Existing wiring: check if RHS needs to be updated
            var assign = existingWiring.Assign;
            var currentHandlerId = ExtractHandlerIdentifier(assign.Right);
            if (currentHandlerId != resolvedHandler)
            {
                // Replace handler identifier in RHS
                if (currentHandlerId is not null)
                {
                    var idToken = assign.Right.DescendantTokens()
                        .FirstOrDefault(t => t.IsKind(SyntaxKind.IdentifierToken) && t.ValueText == currentHandlerId);
                    if (idToken != default)
                    {
                        newDesignerSource = designerSource.WithChanges(
                            new TextChange(idToken.Span, resolvedHandler));
                        changedDesigner = true;
                    }
                }
            }
        }
        else
        {
            // Insert new wiring line
            var (anchorStmt, leadingIndent, newline) = FindAnchorForInsert(doc, ic, controlId, isForm, designerText);
            string wiringLine = FormatWiringStatement(doc, ic, controlId, resolvedEvent, resolvedHandler, isForm);
            string insertText = $"{leadingIndent}{wiringLine};{newline}";

            int insertPos = anchorStmt.Span.End + newline.Length;
            if (insertPos > designerSource.Length) insertPos = anchorStmt.Span.End;

            newDesignerSource = designerSource.WithChanges(
                new TextChange(new TextSpan(anchorStmt.Span.End, 0), newline + leadingIndent + wiringLine + ";"));
            changedDesigner = true;
        }

        // ---- Write both files atomically --------------------------------------
        if (createdMethod)
        {
            Write(codeBehind, newCbSource.ToString(), cbBom);
        }
        if (changedDesigner)
        {
            Write(designerPath, newDesignerSource.ToString(), designerBom);
        }

        return new WireResult(
            DesignerPath: designerPath,
            CodeBehindPath: codeBehind,
            TargetLine: targetLine,
            TargetColumn: targetColumn,
            CreatedMethod: createdMethod,
            ChangedDesigner: changedDesigner);
    }

    public static UnwireResult Unwire(
        string designerPath,
        string controlId,
        string eventName,
        TextWriter stderr)
    {
        if (string.IsNullOrWhiteSpace(controlId))
            throw new DesignException("controlId is required", "bad-request");
        if (string.IsNullOrWhiteSpace(eventName))
            throw new DesignException("eventName is required", "bad-request");
        if (!File.Exists(designerPath))
            throw new DesignException($"File not found: {designerPath}", "not-found");

        var designerBytes = File.ReadAllBytes(designerPath);
        bool designerBom = designerBytes.Length >= 3
                           && designerBytes[0] == 0xEF && designerBytes[1] == 0xBB && designerBytes[2] == 0xBF;
        var designerText = new UTF8Encoding(false).GetString(
            designerBytes, designerBom ? 3 : 0, designerBytes.Length - (designerBom ? 3 : 0));
        var designerSource = SourceText.From(designerText);

        var doc = DesignerDocument.Parse(designerSource, designerPath);
        if (doc.Schema.Analysis.Refuses is { Count: > 0 } refuses)
            throw new DesignException("Form is refused", "refused");

        bool isForm = controlId == doc.Schema.Form.Name || controlId == doc.Schema.Form.ClassName;
        var ic = doc.InitializeComponent
            ?? throw new DesignException("InitializeComponent() not found", "no-initialize-component");
        var wiring = FindEventWiring(ic, controlId, eventName, isForm);

        if (wiring.Statement is null)
        {
            // Nothing to unwire
            return new UnwireResult(designerPath, SiblingCodeBehind(designerPath), ChangedDesigner: false);
        }

        // Surgically remove the wiring statement including its leading or trailing line ending
        var stmt = wiring.Statement;
        var fullSpan = stmt.FullSpan;
        var newDesignerSource = designerSource.WithChanges(new TextChange(fullSpan, ""));
        Write(designerPath, newDesignerSource.ToString(), designerBom);

        return new UnwireResult(designerPath, SiblingCodeBehind(designerPath), ChangedDesigner: true);
    }

    // ---------------------------------------------------------------- helpers

    private static (StatementSyntax? Statement, AssignmentExpressionSyntax? Assign) FindEventWiring(
        MethodDeclarationSyntax ic,
        string controlId,
        string eventName,
        bool isForm)
    {
        foreach (var stmt in ic.Body?.Statements ?? default)
        {
            if (stmt is ExpressionStatementSyntax es
                && es.Expression is AssignmentExpressionSyntax assign
                && assign.IsKind(SyntaxKind.AddAssignmentExpression)
                && assign.Left is MemberAccessExpressionSyntax memberAccess
                && memberAccess.Name.Identifier.Text == eventName)
            {
                if (isForm)
                {
                    if (memberAccess.Expression is ThisExpressionSyntax)
                        return (stmt, assign);
                }
                else if (TryGetControlName(memberAccess.Expression, out var ctrl) && ctrl == controlId)
                {
                    return (stmt, assign);
                }
            }
        }
        return (null, null);
    }

    private static string? ExtractHandlerIdentifier(ExpressionSyntax rhs)
    {
        return rhs switch
        {
            ObjectCreationExpressionSyntax oce => oce.ArgumentList?.Arguments.FirstOrDefault()?.Expression switch
            {
                MemberAccessExpressionSyntax ma => ma.Name.Identifier.Text,
                IdentifierNameSyntax id => id.Identifier.Text,
                _ => null,
            },
            MemberAccessExpressionSyntax ma => ma.Name.Identifier.Text,
            IdentifierNameSyntax id => id.Identifier.Text,
            _ => null,
        };
    }

    private static (StatementSyntax AnchorStmt, string Indent, string Newline) FindAnchorForInsert(
        DesignerDocument doc,
        MethodDeclarationSyntax ic,
        string controlId,
        bool isForm,
        string designerText)
    {
        string nl = designerText.Contains("\r\n") ? "\r\n" : "\n";
        StatementSyntax? lastStmt = null;

        if (isForm)
        {
            // Form properties usually live at the end of InitializeComponent
            foreach (var stmt in ic.Body?.Statements ?? default)
            {
                if (stmt is ExpressionStatementSyntax es
                    && es.Expression is AssignmentExpressionSyntax assign
                    && TryGetControlName(assign.Left, out var prop)
                    && (assign.Left is MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax }
                        || assign.Left is IdentifierNameSyntax))
                {
                    lastStmt = stmt;
                }
            }
        }
        else if (doc.Controls.TryGetValue(controlId, out var cs))
        {
            var stmts = new List<StatementSyntax>();
            if (cs.InitAssignment is not null) stmts.Add(cs.InitAssignment);
            stmts.AddRange(cs.Properties.Values.Select(p => (StatementSyntax)p.Parent!));
            stmts.AddRange(cs.ItemsStatements);

            // Also check any other event wirings for this control
            foreach (var stmt in ic.Body?.Statements ?? default)
            {
                if (stmt is ExpressionStatementSyntax es
                    && es.Expression is AssignmentExpressionSyntax assign
                    && assign.IsKind(SyntaxKind.AddAssignmentExpression)
                    && assign.Left is MemberAccessExpressionSyntax ma
                    && TryGetControlName(ma.Expression, out var c) && c == controlId)
                {
                    stmts.Add(stmt);
                }
            }

            if (stmts.Count > 0)
            {
                lastStmt = stmts.OrderBy(s => s.SpanStart).Last();
            }
        }

        if (lastStmt is null)
        {
            lastStmt = ic.Body?.Statements.LastOrDefault()
                ?? throw new DesignException("InitializeComponent has no statements", "unparsable");
        }

        string indent = "            ";
        var trivia = lastStmt.GetLeadingTrivia();
        var ws = trivia.LastOrDefault(t => t.IsKind(SyntaxKind.WhitespaceTrivia));
        if (ws != default) indent = ws.ToFullString();

        return (lastStmt, indent, nl);
    }

    private static string FormatWiringStatement(
        DesignerDocument doc,
        MethodDeclarationSyntax ic,
        string controlId,
        string eventName,
        string handlerName,
        bool isForm)
    {
        // Detect delegate instantiation style from existing wirings
        bool hasDelegateCtor = false;
        bool hasQualifiedDelegate = false;
        bool hasThisOnHandler = false;
        int wiringsSeen = 0;

        foreach (var stmt in ic.Body?.Statements ?? default)
        {
            if (stmt is ExpressionStatementSyntax es
                && es.Expression is AssignmentExpressionSyntax assign
                && assign.IsKind(SyntaxKind.AddAssignmentExpression))
            {
                wiringsSeen++;
                if (assign.Right is ObjectCreationExpressionSyntax oce)
                {
                    hasDelegateCtor = true;
                    if (oce.Type.ToString().StartsWith("System.")) hasQualifiedDelegate = true;
                    if (oce.ArgumentList?.Arguments.FirstOrDefault()?.Expression is MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax })
                        hasThisOnHandler = true;
                }
                else if (assign.Right is MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax })
                {
                    hasThisOnHandler = true;
                }
            }
        }

        string controlPrefix = doc.UsesThisPrefix ? "this." : "";
        string controlPart = isForm ? (doc.UsesThisPrefix ? "this" : "") : $"{controlPrefix}{controlId}";
        if (isForm && !doc.UsesThisPrefix) controlPart = "";

        string target = string.IsNullOrEmpty(controlPart) ? eventName : $"{controlPart}.{eventName}";

        // If no wirings seen, decide based on dialect
        if (wiringsSeen == 0)
        {
            hasDelegateCtor = doc.UsesThisPrefix;
            hasQualifiedDelegate = doc.UsesThisPrefix;
            hasThisOnHandler = doc.UsesThisPrefix;
        }

        string handlerArg = hasThisOnHandler ? $"this.{handlerName}" : handlerName;

        if (hasDelegateCtor)
        {
            string delType = EventTable.EventDelegateType(eventName);
            if (!hasQualifiedDelegate && delType.StartsWith("System."))
            {
                delType = delType.Substring(delType.LastIndexOf('.') + 1);
            }
            return $"{target} += new {delType}({handlerArg})";
        }
        else
        {
            return $"{target} += {handlerArg}";
        }
    }

    private static bool TryGetControlName(ExpressionSyntax e, out string name)
    {
        switch (e)
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

    private static string? SiblingCodeBehind(string designerPath)
    {
        const string Suffix = ".Designer.cs";
        if (!designerPath.EndsWith(Suffix, StringComparison.OrdinalIgnoreCase)) return null;
        var dir = Path.GetDirectoryName(designerPath);
        if (dir is null) return null;
        return Path.Combine(dir, Path.GetFileName(designerPath)[..^Suffix.Length] + ".cs");
    }

    private static void Write(string path, string text, bool bom)
    {
        var body = new UTF8Encoding(false).GetBytes(text);
        File.WriteAllBytes(path, bom ? new byte[] { 0xEF, 0xBB, 0xBF }.Concat(body).ToArray() : body);
    }
}
