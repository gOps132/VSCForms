using System.Globalization;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace MacForms.Engine;

/// <summary>
/// Parses a Form Designer File into the Form Schema.
///
/// Read-only: this class never writes. It produces a Syntax Index alongside the schema so
/// the Patcher can compute exact spans without re-finding nodes.
/// </summary>
public sealed class DesignerDocument
{
    public required FormSchema Schema { get; init; }
    public required SyntaxNode Root { get; init; }
    public required TypeDeclarationSyntax? FormType { get; init; }
    public required MethodDeclarationSyntax? InitializeComponent { get; init; }

    /// <summary>Per-control syntax index, keyed by field name.</summary>
    public required Dictionary<string, ControlSyntax> Controls { get; init; }

    /// <summary>Local variable name that holds the form's resource manager, if any.</summary>
    public required string? ResourceManagerLocal { get; init; }

    public sealed class ControlSyntax
    {
        public required string Id { get; init; }
        public required string Type { get; set; }
        /// <summary>
        /// The `private T name;` field declaration, or null when the file has none — some
        /// Designer Files omit it. Optional so a control is still shown and editable when
        /// only its instantiation is present.
        /// </summary>
        public VariableDeclaratorSyntax? FieldDeclarator { get; init; }
        public required ExpressionStatementSyntax InitAssignment { get; init; }
        public ExpressionStatementSyntax? AddCall { get; set; }
        public Dictionary<string, AssignmentExpressionSyntax> Properties { get; init; } = new();
        /// <summary>Container field name this control was added to, or null for top level.</summary>
        public string? Parent { get; set; }
    }

    // ---------------------------------------------------------------- parse

    public static DesignerDocument Parse(SourceText source)
    {
        var tree = CSharpSyntaxTree.ParseText(source);
        var root = tree.GetRoot();

        var formType = root.DescendantNodes()
            .OfType<TypeDeclarationSyntax>()
            .FirstOrDefault(t => t.Members.OfType<MethodDeclarationSyntax>()
                .Any(m => m.Identifier.Text == "InitializeComponent"));

        if (formType is null)
            throw new DesignException("InitializeComponent() not found", "no-initialize-component");

        var ic = formType.Members.OfType<MethodDeclarationSyntax>()
            .First(m => m.Identifier.Text == "InitializeComponent");

        // Map every control field name -> its declared type, from both the field
        // declarations and the `this.x = new T()` initializations.
        var declaredTypes = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var fd in formType.Members.OfType<FieldDeclarationSyntax>())
        {
            var declaredType = QualifiedTypeName(fd.Declaration.Type);
            foreach (var v in fd.Declaration.Variables)
                declaredTypes[v.Identifier.Text] = declaredType;
        }

        var statements = ic.Body?.Statements ?? default;
        var index = new Dictionary<string, ControlSyntax>(StringComparer.Ordinal);

        // Pass 1: instantiations, field decls, property assignments, additions.
        //
        // Two passes over the statements are needed: a control's `Controls.Add` can appear
        // BEFORE its `new T()` instantiation is seen, and its property assignments can
        // appear before we have created any index entry. So pass A collects every
        // instantiation and field declaration; pass B then resolves additions and
        // properties against a complete index.
        foreach (var stmt in statements.OfType<ExpressionStatementSyntax>())
        {
            // Only a DIRECT `this.<name> = ...` counts. Deeper receivers such as
            // `this.btnSubmit.Location` and form-level `this.ClientSize` are handled
            // separately, and must not be mistaken for control instantiations.
            if (stmt.Expression is AssignmentExpressionSyntax
                {
                    Left: MemberAccessExpressionSyntax lhs2,
                    Right: ObjectCreationExpressionSyntax oce2
                }
                && IsFormReceiver(lhs2.Expression)
                && MemberName(lhs2.Expression) is { } nm2
                && FindFieldDeclarator(formType, nm2) is not null)
            {
                declaredTypes[nm2] = QualifiedTypeName(oce2.Type);
                // No field declaration is not a reason to drop the control: index it anyway.
                var fd2 = FindFieldDeclarator(formType, nm2);
                if (!index.ContainsKey(nm2))
                    index[nm2] = NewControlSyntax(nm2, QualifiedTypeName(oce2.Type), fd2, stmt, stmt, parent: null);
            }
        }

        foreach (var stmt in statements)
        {
            if (stmt is not ExpressionStatementSyntax es) continue;

            // this.x = new T();   (a direct field initialisation)
            //
            // Note: this branch is entered for `this.x.Prop = new T()` too, because that is
            // also `MemberAccessExpression = ObjectCreationExpression`. So it must NOT
            // `continue` unconditionally, or every property assignment would be skipped.
            if (es.Expression is AssignmentExpressionSyntax { Left: MemberAccessExpressionSyntax lhs,
                                                             Right: ObjectCreationExpressionSyntax oce }
                && IsFormReceiver(lhs.Expression)
                && MemberName(lhs) is { } instName
                && FindFieldDeclarator(formType, instName) is { } instField)
            {
                declaredTypes[instName] = QualifiedTypeName(oce.Type);
                if (!index.ContainsKey(instName))
                    index[instName] = NewControlSyntax(instName, QualifiedTypeName(oce.Type), instField, es, es, parent: null);
                continue;
            }

            // this.Controls.Add(this.x);  /  this.pnl.Controls.Add(this.x);
            if (TryParseAddCall(es.Expression, out var container, out var child) && child is not null)
            {
                if (!index.TryGetValue(child, out var existing))
                {
                    var field = FindFieldDeclarator(formType, child);
                    var ty = declaredTypes.GetValueOrDefault(child, "System.Windows.Forms.Control");
                    var init = FindInitAssignment(statements, child);
                    existing = NewControlSyntax(child, ty, field, init ?? es, es, parent: container);
                    index[child] = existing;
                }
                else
                {
                    existing.AddCall = es;
                    existing.Parent = container;
                }
                continue;
            }

            // this.x.Prop = rhs;  — plhs.Expression is `this.x`, so the CONTROL name lives in
            // plhs.Expression.Name, and the PROPERTY name is plhs.Name.
            if (es.Expression is AssignmentExpressionSyntax { Left: MemberAccessExpressionSyntax plhs } assign
                && IsThisReceiver(plhs.Expression)
                && MemberName(plhs.Expression) is { } ctrl
                && index.TryGetValue(ctrl, out var target))
            {
                target.Properties[plhs.Name.Identifier.Text] = assign;
            }
        }

        // Drop infrastructure fields (components, componentsModified) before analysis and schema
        // construction, so they never count towards coverage and never render as a control.
        foreach (var nonVisual in index.Keys
                     .Where(k => TypeTable.IsNonVisual(k, index[k].Type)).ToList())
        {
            index.Remove(nonVisual);
        }

        var analysis = Analyse(ic, index);
        var schema = BuildSchema(formType, ic, index, analysis);

        return new DesignerDocument
        {
            Schema = schema,
            Root = root,
            FormType = formType,
            InitializeComponent = ic,
            Controls = index,
            ResourceManagerLocal = analysis.ResourceManagerLocal,
        };
    }

    public static ControlSyntax NewControlSyntax(string id, string type, VariableDeclaratorSyntax? field,
        ExpressionStatementSyntax init, ExpressionStatementSyntax? add, string? parent) => new()
        {
            Id = id,
            Type = type,
            FieldDeclarator = field,
            InitAssignment = init,
            AddCall = add,
            Parent = parent,
        };

    // ------------------------------------------------------------ analysis

    private sealed class AnalysisResult
    {
        public List<string> Refuses = new();
        public List<string> Warnings = new();
        public string? ResourceManagerLocal;
    }

    private static AnalysisResult Analyse(MethodDeclarationSyntax ic, Dictionary<string, ControlSyntax> index)
    {
        var r = new AnalysisResult();

        var applyResources = ic.DescendantNodes().OfType<InvocationExpressionSyntax>()
            .FirstOrDefault(i => i.Expression.ToString().EndsWith("resources.ApplyResources", StringComparison.Ordinal)
                              || i.Expression.ToString().EndsWith(".ApplyResources", StringComparison.Ordinal));

        if (applyResources is not null)
        {
            r.Refuses.Add("localizable");
            r.ResourceManagerLocal = (applyResources.Expression as MemberAccessExpressionSyntax)?.Expression.ToString();
            r.Warnings.Add("This form uses resources.ApplyResources: its text and geometry live in the sibling .resx file, not here.");
        }

        // Dock / Anchor: non-default on any control, or on the form itself.
        var docked = new List<string>();
        foreach (var kv in index)
        {
            var cs = kv.Value;
            if (cs.Properties.TryGetValue("Dock", out var d) && !IsDefaultValue(d.Right, "DockStyle.Top"))
                docked.Add(kv.Key);
            if (cs.Properties.TryGetValue("Anchor", out var a) && !IsDefaultValue(a.Right, "AnchorStyles.Top | AnchorStyles.Left"))
                docked.Add(kv.Key);
        }
        foreach (var stmt in ic.Body?.Statements ?? default)
        {
            if (stmt is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax { Left: MemberAccessExpressionSyntax l } a }
                && IsFormReceiver(l.Expression)
                && (l.Name.Identifier.Text is "Dock" or "Anchor"))
            {
                if (!IsDefaultValue(a.Right, "DockStyle.Top") && !docked.Contains("form"))
                    docked.Add("form");
            }
        }
        if (docked.Count > 0)
        {
            r.Refuses.Add("dock-anchor");
            r.Warnings.Add($"This form uses Dock or Anchor on {docked.Count} control(s). MacForms does not simulate layout, so it is shown read-only.");
        }

        if (index.Count > 0 && index.Values.All(c => !TypeTable.IsHandled(c.Type)))
            r.Warnings.Add("No controls in this form are of a type MacForms models.");

        return r;
    }

    private static bool IsDefaultValue(ExpressionSyntax rhs, params string[] defaults)
    {
        var s = Normalize(rhs.ToString());
        return defaults.Any(d => s == Normalize(d));
    }

    private static string Normalize(string s) =>
        string.Concat(s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    // ------------------------------------------------------------- schema

    private static FormSchema BuildSchema(TypeDeclarationSyntax formType, MethodDeclarationSyntax ic,
        Dictionary<string, ControlSyntax> index, AnalysisResult analysis)
    {
        var modelled = 0;
        var unmodelled = 0;
        var warnings = new List<string>(analysis.Warnings);

        ControlNode BuildNode(string id)
        {
            var cs = index[id];
            // A non-visual field is not a control at all; the caller filters these out before
            // building, so reaching here would be a bug. Guard anyway rather than emit garbage.
            if (TypeTable.IsNonVisual(id, cs.Type))
                throw new InvalidOperationException($"non-visual field '{id}' reached node construction");
            var handled = TypeTable.IsHandled(cs.Type);
            if (handled) modelled++; else unmodelled++;

            var props = ReadProperties(cs, handled, index);

            if (!handled)
                warnings.Add($"{id} ({TypeTable.SimpleName(cs.Type)}) is shown as a locked box.");

            var node = new ControlNode
            {
                Id = id,
                Type = cs.Type,
                Properties = props,
                Locked = !handled,
                LockedReason = handled ? null : TypeTable.LockedReason(cs.Type),
                Children = new List<ControlNode>(),
            };

            if (TypeTable.IsContainer(cs.Type))
            {
                foreach (var child in index.Values.Where(c => c.Parent == id))
                    if (index.ContainsKey(child.Id))
                        node.Children.Add(BuildNode(child.Id));
            }
            return node;
        }

        // Top-level = added to this.Controls, or never explicitly added but not a child.
        var roots = index.Values
            .Where(c => c.Parent is null || c.Parent == "Controls" || !index.ContainsKey(c.Parent))
            .Select(c => c.Id)
            .OrderBy(id => AddCallIndex(ic, id))
            .ToList();

        var controls = new List<ControlNode>();
        foreach (var r in roots) controls.Add(BuildNode(r));

        var total = modelled + unmodelled;
        var clientSize = ReadSize(ic, "ClientSize") ?? new SizeDto { Width = 0, Height = 0 };

        return new FormSchema
        {
            Form = new FormInfo
            {
                Name = formType.Identifier.Text,
                ClassName = formType.Identifier.Text,
                Text = ReadFormText(ic) ?? "",
                ClientSize = clientSize,
            },
            Controls = controls,
            Analysis = new Analysis
            {
                ModelledCount = modelled,
                UnmodelledCount = unmodelled,
                CoveragePercent = total == 0 ? 100 : Math.Round(modelled * 100.0 / total, 2),
                Refuses = analysis.Refuses,
                Warnings = warnings,
            },
        };
    }

    private static int AddCallIndex(MethodDeclarationSyntax ic, string id)
    {
        var i = 0;
        foreach (var stmt in ic.Body?.Statements ?? default)
        {
            if (stmt is ExpressionStatementSyntax es && es.ToString().Contains($"this.{id}", StringComparison.Ordinal))
                return i;
            i++;
        }
        return int.MaxValue;
    }

    private static ControlProperties ReadProperties(ControlSyntax cs, bool handled, Dictionary<string, ControlSyntax> index)
    {
        var p = new ControlProperties();

        if (cs.Properties.TryGetValue("Location", out var loc))
        {
            var pt = ParseArgs(loc.Right);
            if (pt is { Length: 2 } && int.TryParse(pt[0], out var x) && int.TryParse(pt[1], out var y))
            { p.X = x; p.Y = y; }
        }
        if (cs.Properties.TryGetValue("Size", out var sz))
        {
            var a = ParseArgs(sz.Right);
            if (a is { Length: 2 } && int.TryParse(a[0], out var w) && int.TryParse(a[1], out var h))
            { p.Width = w; p.Height = h; }
        }

        if (!handled) return p;   // appearance is only modelled for handled types

        if (cs.Properties.TryGetValue("Text", out var t) && t.Right is LiteralExpressionSyntax lit
            && lit.IsKind(SyntaxKind.StringLiteralExpression))
            p.Text = lit.Token.ValueText;

        if (cs.Properties.TryGetValue("TabIndex", out var ti)
            && ti.Right is LiteralExpressionSyntax til && til.Token.Value is int tiv)
            p.TabIndex = tiv;

        if (cs.Properties.TryGetValue("Visible", out var v) && v.Right is LiteralExpressionSyntax vl)
            p.Visible = vl.Token.Value is true;

        if (cs.Properties.TryGetValue("Enabled", out var en) && en.Right is LiteralExpressionSyntax enl)
            p.Enabled = enl.Token.Value is true;

        if (cs.Properties.TryGetValue("BackColor", out var bc))
            p.BackColor = ParseColor(bc.Right);

        if (cs.Properties.TryGetValue("Font", out var fn))
            p.Font = ParseFont(fn.Right);

        return p;
    }

    /// <summary>True when the expression is a bare `this` — i.e. a form-level member access.</summary>
    private static bool IsFormReceiver(ExpressionSyntax e) => e is ThisExpressionSyntax;

    /// <summary>True when the expression is `this.something` — i.e. a control-level access.</summary>
    private static bool IsThisReceiver(ExpressionSyntax e) =>
        e is MemberAccessExpressionSyntax m && m.Expression is ThisExpressionSyntax;

    private static string? ReadFormText(MethodDeclarationSyntax ic)
    {
        // Must be `this.Text`, not `this.someLabel.Text` — hence the form-level receiver test.
        foreach (var stmt in ic.Body?.Statements ?? default)
            if (stmt is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax { Left: MemberAccessExpressionSyntax l } a }
                && IsFormReceiver(l.Expression) && l.Name.Identifier.Text == "Text"
                && a.Right is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression))
                return lit.Token.ValueText;
        return null;
    }

    private static SizeDto? ReadSize(MethodDeclarationSyntax ic, string prop)
    {
        foreach (var stmt in ic.Body?.Statements ?? default)
            if (stmt is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax { Left: MemberAccessExpressionSyntax l } a }
                && IsFormReceiver(l.Expression) && l.Name.Identifier.Text == prop)
            {
                var args = ParseArgs(a.Right);
                if (args is { Length: 2 } && int.TryParse(args[0], out var w) && int.TryParse(args[1], out var h))
                    return new SizeDto { Width = w, Height = h };
            }
        return null;
    }

    // ------------------------------------------------------------- helpers

    private static string? MemberName(ExpressionSyntax e) =>
        e is MemberAccessExpressionSyntax m ? m.Name.Identifier.Text : null;

    /// <summary>Renders a type name fully qualified, expanding `var`-less shorthand.</summary>
    private static string QualifiedTypeName(TypeSyntax t) => t switch
    {
        IdentifierNameSyntax i => "System.Windows.Forms." + i.Identifier.Text,
        QualifiedNameSyntax q => q.ToString(),
        PredefinedTypeSyntax => t.ToString(),
        NullableTypeSyntax n => QualifiedTypeName(n.ElementType),
        _ => t.ToString(),
    };

    private static VariableDeclaratorSyntax? FindFieldDeclarator(TypeDeclarationSyntax t, string name) =>
        t.Members.OfType<FieldDeclarationSyntax>()
            .SelectMany(f => f.Declaration.Variables)
            .FirstOrDefault(v => v.Identifier.Text == name);

    private static ExpressionStatementSyntax? FindInitAssignment(SyntaxList<StatementSyntax> statements, string name)
    {
        foreach (var s in statements)
            if (s is ExpressionStatementSyntax es
                && es.Expression is AssignmentExpressionSyntax { Left: MemberAccessExpressionSyntax l }
                && IsThisReceiver(l.Expression) && MemberName(l.Expression) == name)
                return es;
        return null;
    }

    private static bool TryParseAddCall(ExpressionSyntax expr, out string? container, out string? child)
    {
        container = null; child = null;
        // Shape: <recv>.Controls.Add(<child>)
        //   InvocationExpression
        //     .Expression = MemberAccess(Name: "Add", Expression: MemberAccess(Name: "Controls", ...))
        if (expr is not InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax add } inv) return false;
        if (add.Name.Identifier.Text != "Add") return false;

        // NOTE: the receiver of `.Add` is the `Controls` access itself, so the container
        // chain starts at add.Expression — not at inv.Expression.
        if (add.Expression is not MemberAccessExpressionSyntax controls) return false;
        if (controls.Name.Identifier.Text != "Controls") return false;

        // `this.Controls.Add(x)` — the Controls access hangs directly off `this`.
        if (controls.Expression is ThisExpressionSyntax)
        {
            container = "Controls";
        }
        // `this.panel1.Controls.Add(x)` — hangs off `this.<container>`.
        else if (controls.Expression is MemberAccessExpressionSyntax owner && IsThisReceiver(owner.Expression))
        {
            container = owner.Name.Identifier.Text;
        }
        else
        {
            return false;
        }

        // The argument IS the `this.<name>` access — test it directly. Testing its inner
        // expression would ask whether `this` itself is a `this.X` access, which it is not.
        if (inv.ArgumentList.Arguments.Count == 1
            && inv.ArgumentList.Arguments[0].Expression is MemberAccessExpressionSyntax arg
            && IsThisReceiver(arg))
        {
            child = arg.Name.Identifier.Text;
        }

        // Returning true with a null child would make the caller skip the statement without
        // recording anything, silently losing the Controls.Add. Report it as unrecognised.
        return child is not null;
    }

    /// <summary>Flattens the integer/whatever arguments of `new Point(a, b)` style calls.</summary>
    internal static string[]? ParseArgs(ExpressionSyntax expr)
    {
        if (expr is not ObjectCreationExpressionSyntax oce) return null;
        if (oce.ArgumentList is null) return null;
        var list = new List<string>();
        foreach (var a in oce.ArgumentList.Arguments) list.Add(a.Expression.ToString());
        return list.ToArray();
    }

    private static FontDto? ParseFont(ExpressionSyntax expr)
    {
        if (expr is not ObjectCreationExpressionSyntax oce) return null;
        var args = oce.ArgumentList?.Arguments;
        if (args is null || args.Value.Count == 0) return null;

        var f = new FontDto();
        if (args.Value[0].Expression is LiteralExpressionSyntax fam && fam.IsKind(SyntaxKind.StringLiteralExpression))
            f.Family = fam.Token.ValueText;

        var raw = args.Value.Count > 1 ? args.Value[1].Expression.ToString() : "9F";
        if (float.TryParse(raw.TrimEnd('F', 'f'), NumberStyles.Float, CultureInfo.InvariantCulture, out var sz))
            f.Size = sz;

        foreach (var a in args.Value.Skip(2))
        {
            var s = a.Expression.ToString();
            if (s.Contains("Bold", StringComparison.Ordinal)) f.Bold = true;
            if (s.Contains("Italic", StringComparison.Ordinal)) f.Italic = true;
        }
        return f;
    }

    /// <summary>
    /// Parses System.Drawing.Color expressions into a CSS colour. Returns null when the
    /// shape is not one we understand — in that case we do not model it and leave the code
    /// alone, rather than guessing.
    /// </summary>
    internal static string? ParseColor(ExpressionSyntax expr)
    {
        var text = expr.ToString();

        if (expr is InvocationExpressionSyntax inv
            && inv.Expression.ToString().EndsWith("FromArgb", StringComparison.Ordinal))
        {
            var a = inv.ArgumentList.Arguments.Select(x => x.Expression.ToString()).ToArray();
            if (a.Length == 1 && int.TryParse(a[0], out var argb))
                return $"#{argb & 0xFF:X2}{(argb >> 8) & 0xFF:X2}{(argb >> 16) & 0xFF:X2}";
            if (a.Length == 3 && a.All(x => int.TryParse(x, out _)))
                return $"#{int.Parse(a[0]):X2}{int.Parse(a[1]):X2}{int.Parse(a[2]):X2}";
            return null;
        }

        if (expr is MemberAccessExpressionSyntax m)
        {
            var name = m.Name.Identifier.Text switch
            {
                "Red" => "#FF0000", "Lime" => "#00FF00", "Blue" => "#0000FF",
                "White" => "#FFFFFF", "Black" => "#000000", "Gray" => "#808080",
                "Silver" => "#C0C0C0", "Yellow" => "#FFFF00", "Orange" => "#FFA500",
                "Green" => "#008000", "Navy" => "#000080", "Teal" => "#008080",
                "Transparent" => "", "Control" => "", "Window" => "", "WindowText" => "",
                _ => null
            };
            return name;
        }

        return text switch { _ => null };
    }
}

public sealed class DesignException : Exception
{
    public string Kind { get; }
    public DesignException(string message, string kind) : base(message) => Kind = kind;
}