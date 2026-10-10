using System.Globalization;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace VSCForms.Engine;

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

    /// <summary>
    /// Whether this file qualifies members with `this.`.
    ///
    /// Used when INSERTING a statement: there is no existing text to copy, so emitting the
    /// canonical `this.` form into a file that consistently omits it produces visibly mixed
    /// style. Matching the file keeps generated code looking like the surrounding code.
    /// </summary>
    public required bool UsesThisPrefix { get; init; }

    /// <summary>
    /// Whether the CONTROLS COLLECTION is `this.`-qualified, tracked separately from
    /// <see cref="UsesThisPrefix"/> because the two disagree independently. Visual Studio writes
    /// `this.txt.Location = ...` on controls yet leaves `Controls.Add(...)` bare.
    /// </summary>
    public required bool ControlsCollectionIsQualified { get; init; }

    /// <summary>
    /// Code style declared by a nearby .editorconfig or sibling csproj. Advisory only: it fills
    /// gaps the file cannot answer (the templated dialect has no instantiations) and is never
    /// allowed to override what the file demonstrates. See <see cref="DeclaredStyle"/>.
    /// </summary>
    public required DeclaredStyle DeclaredStyle { get; init; }

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
        /// <summary>Statements that populate Items (Add/AddRange). Order matters — it IS the list.</summary>
        public List<ExpressionStatementSyntax> ItemsStatements { get; init; } = new();
        /// <summary>True if this control has a field declaration OR an instantiation — i.e. it's
        /// not merely synthesized from an orphaned Controls.Add call.</summary>
        public bool HasRealEvidence { get; set; }
    }

    // ---------------------------------------------------------------- parse

    /// <param name="path">
    /// Absolute path of the file, when known. Used only to discover declared code style
    /// (<c>.editorconfig</c>, sibling csproj) for the templated dialect, which contains no
    /// instantiations and therefore gives the dialect signals nothing to infer from. Pass null
    /// when parsing from a string, and detection falls back to observation alone.
    /// </param>
    public static DesignerDocument Parse(SourceText source, string? path = null)
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

        // Controls instantiated as `this.x = new T();` — the dialect signal for inserts.
        var thisQualifiedInstantiations = new HashSet<string>(StringComparer.Ordinal);

        // Whether ANY instantiation was seen at all, qualified or not. This is the difference
        // between "the file is bare" (observed) and "the file has no controls to observe"
        // (unknown) — the templated dialect is the second, and only the second is a gap that
        // declared style is allowed to fill.
        int instantiationCount = 0;

        // Whether `Controls.Add` is `this.`-qualified, tracked separately from the above.
        // Assigned (not OR-ed) so the LAST add call decides — files are consistent, and
        // OR-ing would let one stray line flip the convention.
        bool qualifiedControlsCollection = false;

        // A single pass resolves instantiations, field declarations, property assignments and
        // `Controls.Add` calls. Order is not assumed: a control's Add call can appear before
        // its instantiation, and a property assignment can appear before the index has an
        // entry for it. Each branch creates the index entry if it does not exist yet.
        foreach (var stmt in statements)
        {
            if (stmt is not ExpressionStatementSyntax es) continue;

            // this.x = new T();   (a direct field initialisation)
            //
            // Note: this branch is entered for `this.x.Prop = new T()` too, because that is
            // also `MemberAccessExpression = ObjectCreationExpression`. So it must NOT
            // `continue` unconditionally, or every property assignment would be skipped.
            // A control instantiation. This branch is entered for `x.Prop = new T()` too — that is also
            // MemberAccess = ObjectCreation — so the receiver must be a BARE name (`this.x` or
            // `x`), never a nested access. Requiring that is what keeps `x.Location = new Point()`
            // from being mistaken for an instantiation.
            bool isDirectInstantiation = false;
            if (es.Expression is AssignmentExpressionSyntax { Left: var li, Right: ObjectCreationExpressionSyntax }
                && (li is MemberAccessExpressionSyntax or IdentifierNameSyntax)
                && TryGetControlName(li, out var liName)
                && FindFieldDeclarator(formType, liName) is not null)
            {
                isDirectInstantiation = true;
            }

            if (isDirectInstantiation
                && es.Expression is AssignmentExpressionSyntax { Left: var lhsInstant,
                                                                 Right: ObjectCreationExpressionSyntax oce }
                && TryGetControlName(lhsInstant, out var instName)
                && FindFieldDeclarator(formType, instName) is { } instField)
            {
                declaredTypes[instName] = QualifiedTypeName(oce.Type);
                // Count only real controls. `components = new System.ComponentModel.Container()`
                // has the same shape as an instantiation and is filtered out later as an
                // infrastructure field — but if it counted here, every templated file would
                // look like it had evidence and declared style would never be consulted.
                if (!TypeTable.IsNonVisual(instName, QualifiedTypeName(oce.Type)))
                    instantiationCount++;
                // Record whether THIS instantiation was `this.`-qualified. Done here, where the
                // syntax is in hand; inferring it later from the statement list is unreliable
                // because the dialect differs in which shape appears where.
                if (IsThisQualified(lhsInstant))
                    thisQualifiedInstantiations.Add(instName);
                if (!index.ContainsKey(instName))
                    index[instName] = NewControlSyntax(instName, QualifiedTypeName(oce.Type), instField, es, es, parent: null);
                index[instName].HasRealEvidence = true;
                continue;
            }

            // this.Controls.Add(this.x);  /  this.pnl.Controls.Add(this.x);
            if (TryParseAddCall(es.Expression, out var container, out var child) && child is not null)
            {
                // `this.Controls.Add(...)` / `this.pnl.Controls.Add(...)` / `Controls.Add(...)`
                //
                // The receiver of `.Controls` is the thing that carries the qualification:
                //   this.Controls.Add  -> receiver is ThisExpressionSyntax
                //   this.pnl.Controls   -> receiver is `this.pnl`, also this-qualified
                //   Controls.Add        -> receiver is an IdentifierName, not qualified
                if (es.Expression is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax addCall }
                    && addCall.Expression is MemberAccessExpressionSyntax controlsAccess)
                    qualifiedControlsCollection = controlsAccess.Expression switch
                    {
                        ThisExpressionSyntax => true,
                        MemberAccessExpressionSyntax => IsThisQualified(controlsAccess.Expression),
                        _ => false,
                    };
                if (!index.TryGetValue(child, out var existing))
                {
                    var field = FindFieldDeclarator(formType, child);
                    var ty = declaredTypes.GetValueOrDefault(child, "System.Windows.Forms.Control");
                    var init = FindInitAssignment(statements, child);
                    existing = NewControlSyntax(child, ty, field, init ?? es, es, parent: container);
                    // Real evidence = field declaration OR instantiation statement found
                    existing.HasRealEvidence = field is not null || init is not null;
                    index[child] = existing;
                }
                else
                {
                    existing.AddCall = es;
                    existing.Parent = container;
                    // If we already had real evidence, keep it; otherwise check if this AddCall
                    // gives us new evidence (it doesn't — AddCall alone isn't evidence)
                }
                continue;
            }

            // x.Items.Add("a") / x.Items.AddRange(new object[] { "a", "b" })
            // The receiver of .Items must be a control name (this.x or bare x).
            if (TryParseItemsCall(es.Expression, out var itemsCtrl, out var itemsStmt))
            {
                if (index.TryGetValue(itemsCtrl, out var itemsTarget))
                {
                    itemsTarget.ItemsStatements.Add(itemsStmt);
                }
                continue;
            }

            // x.Prop = rhs;   The CONTROL is plhs.Expression (either `this.x` or bare `x`) and the
            // PROPERTY is plhs.Name. Both dialects handled by TryGetControlName.
            if (es.Expression is AssignmentExpressionSyntax { Left: MemberAccessExpressionSyntax plhs } assign
                && TryGetControlName(plhs.Expression, out var ctrl)
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

        // Declared style fills a gap; it never overrides observation. Only consulted when the
        // file contains no instantiation and therefore no evidence either way — the templated
        // dialect. A file with controls has been observed, and ADR 0005 says the file wins.
        var declared = path is null ? DeclaredStyle.None : DeclaredStyle.Discover(path);
        bool noEvidence = instantiationCount == 0;

        var usesThisPrefix = thisQualifiedInstantiations.Count > 0
            || (noEvidence && declared.QualifyFields == true);
        var controlsQualified = qualifiedControlsCollection
            || (noEvidence && declared.QualifyFields == true);

        return new DesignerDocument
        {
            Schema = schema,
            Root = root,
            FormType = formType,
            InitializeComponent = ic,
            Controls = index,
            ResourceManagerLocal = analysis.ResourceManagerLocal,
            UsesThisPrefix = usesThisPrefix,
            ControlsCollectionIsQualified = controlsQualified,
            DeclaredStyle = declared,
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
            if (stmt is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a }
                && TryGetFormProperty(a.Left, out var formProp)
                && (formProp is "Dock" or "Anchor"))
            {
                if (!IsDefaultValue(a.Right, "DockStyle.Top") && !docked.Contains("form"))
                    docked.Add("form");
            }
        }
        if (docked.Count > 0)
        {
            r.Refuses.Add("dock-anchor");
            r.Warnings.Add($"This form uses Dock or Anchor on {docked.Count} control(s). VSCForms does not simulate layout, so it is shown read-only.");
        }

        // RightToLeft: non-default on any control, or on the form itself. Mirroring is not
        // simulated — the canvas shows left-to-right — so this is a warning, never a refusal.
        // Anything other than RightToLeft.No counts: Inherit follows the parent, which the
        // canvas cannot resolve without simulating the layout it refuses to simulate.
        var mirrored = new List<string>();
        foreach (var kv in index)
        {
            var cs = kv.Value;
            if (cs.Properties.TryGetValue("RightToLeft", out var rtl) && !IsDefaultValue(rtl.Right, "RightToLeft.No", "System.Windows.Forms.RightToLeft.No"))
                mirrored.Add(kv.Key);
        }
        foreach (var stmt in ic.Body?.Statements ?? default)
        {
            if (stmt is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a }
                && TryGetFormProperty(a.Left, out var formProp)
                && formProp is "RightToLeft")
            {
                if (!IsDefaultValue(a.Right, "RightToLeft.No", "System.Windows.Forms.RightToLeft.No") && !mirrored.Contains("form"))
                    mirrored.Add("form");
            }
        }
        if (mirrored.Count > 0)
        {
            r.Warnings.Add($"This form sets RightToLeft on {mirrored.Count} control(s). VSCForms shows the form left-to-right and does not mirror layout.");
        }

        // Preserved-but-invisible design-time props (C3): warn only on surprises, never on
        // standard files. VS omits default Margin/Padding, writes AutoScaleMode.Font, and
        // always emits ClientSize — so presence (or a non-Font mode, or Size without
        // ClientSize) is the signal. Read-only disclosure; editing any of them is separate.
        var spaced = new List<string>();
        var autosized = new List<string>();
        foreach (var kv in index)
        {
            var cs = kv.Value;
            if (cs.Properties.ContainsKey("Margin") || cs.Properties.ContainsKey("Padding"))
                spaced.Add(kv.Key);
            // AutoSize is modelled only for Label, Button, CheckBox and RadioButton (the
            // inspector's set); elsewhere the canvas shows the designed size while the
            // runtime may resize. Literal `true` only — anything else is refused as a guess.
            if (cs.Properties.TryGetValue("AutoSize", out var asz)
                && asz.Right is LiteralExpressionSyntax { Token.Value: true }
                && TypeTable.SimpleName(cs.Type) is not ("Label" or "Button" or "CheckBox" or "RadioButton"))
                autosized.Add(kv.Key);
        }
        var scalesOddly = false;
        var hasFormSize = false;
        var hasFormClientSize = false;
        foreach (var stmt in ic.Body?.Statements ?? default)
        {
            if (stmt is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a }
                && TryGetFormProperty(a.Left, out var formProp))
            {
                if (formProp is "Margin" or "Padding")
                {
                    if (!spaced.Contains("form")) spaced.Add("form");
                }
                else if (formProp is "AutoSize" && a.Right is LiteralExpressionSyntax { Token.Value: true })
                {
                    if (!autosized.Contains("form")) autosized.Add("form");
                }
                else if (formProp is "AutoScaleMode" && !IsDefaultValue(a.Right, "AutoScaleMode.Font", "System.Windows.Forms.AutoScaleMode.Font"))
                    scalesOddly = true;
                else if (formProp is "Size")
                    hasFormSize = true;
                else if (formProp is "ClientSize")
                    hasFormClientSize = true;
            }
        }
        if (spaced.Count > 0)
        {
            r.Warnings.Add($"This form sets Margin or Padding on {spaced.Count} control(s). Spacing is preserved in the file but not shown on the canvas.");
        }
        if (autosized.Count > 0)
        {
            r.Warnings.Add($"This form sets AutoSize on {autosized.Count} control(s) whose size is not modelled. VSCForms shows the designed size.");
        }
        if (scalesOddly)
        {
            r.Warnings.Add("This form uses a non-Font AutoScaleMode. VSCForms shows design-time geometry and does not rescale.");
        }
        if (hasFormSize && !hasFormClientSize)
        {
            r.Warnings.Add("This form sets Size without ClientSize. VSCForms frames the form from ClientSize.");
        }

        if (index.Count > 0 && index.Values.All(c => !TypeTable.IsHandled(c.Type)))
            r.Warnings.Add("No controls in this form are of a type VSCForms models.");

        // --- integrity check: Controls.Add for controls with no field/instantiation ---
        // A Controls.Add(x) where x has no field declaration or instantiation is a corrupted
        // designer file. VS designer refuses to load in this state; we should too.
        foreach (var kv in index)
        {
            if (kv.Value.AddCall is not null && !kv.Value.HasRealEvidence)
            {
                r.Refuses.Add("orphaned-controls-add");
                r.Warnings.Add($"Controls.Add({kv.Key}) references a control that has no field declaration or instantiation. The designer file is corrupted — fix it manually before editing in VSCForms.");
                break; // one is enough to refuse
            }
        }

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
                BackColor = ReadFormBackColor(ic),
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

        if (cs.Properties.TryGetValue("ForeColor", out var fc))
            p.ForeColor = ParseColor(fc.Right);

        if (cs.Properties.TryGetValue("Checked", out var chk) && chk.Right is LiteralExpressionSyntax chkl)
            p.Checked = chkl.Token.Value is true;

        if (cs.Properties.TryGetValue("TextAlign", out var ta))
            p.TextAlign = ParseMemberName(ta.Right);

        if (cs.Properties.TryGetValue("BorderStyle", out var bs))
            p.BorderStyle = ParseMemberName(bs.Right);

        if (cs.Properties.TryGetValue("AutoSize", out var asz) && asz.Right is LiteralExpressionSyntax aszl)
            p.AutoSize = aszl.Token.Value is true;

        if (cs.Properties.TryGetValue("Font", out var fn))
            p.Font = ParseFont(fn.Right);

        // Items — only for ComboBox and ListBox. Always emit the field (empty array if no items).
        var simpleType = TypeTable.SimpleName(cs.Type);
        if (simpleType == "ComboBox" || simpleType == "ListBox")
        {
            var items = new List<string>();
            if (cs.ItemsStatements.Count > 0)
            {
                foreach (var stmt in cs.ItemsStatements)
                {
                    if (stmt.Expression is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax itemsCall } inv)
                    {
                        var method = itemsCall.Name.Identifier.Text;
                        if (method == "Add")
                        {
                            if (inv.ArgumentList.Arguments.Count == 1
                                && inv.ArgumentList.Arguments[0].Expression is LiteralExpressionSyntax addLit
                                && addLit.IsKind(SyntaxKind.StringLiteralExpression))
                            {
                                items.Add(addLit.Token.ValueText);
                            }
                            else
                            {
                                return p; // unmodelled shape — omit items entirely
                            }
                        }
                        else if (method == "AddRange")
                        {
                            if (inv.ArgumentList.Arguments.Count != 1) return p;
                            var argExpr = inv.ArgumentList.Arguments[0].Expression;
                            // Accept both ArrayCreationExpressionSyntax (new object[] { ... })
                            // and ObjectCreationExpressionSyntax (rare but possible)
                            if (argExpr is ArrayCreationExpressionSyntax ace && ace.Initializer is not null)
                            {
                                foreach (var element in ace.Initializer.Expressions)
                                    if (element is LiteralExpressionSyntax rangeLit
                                        && rangeLit.IsKind(SyntaxKind.StringLiteralExpression))
                                        items.Add(rangeLit.Token.ValueText);
                                    else
                                        return p; // unmodelled element — omit items entirely
                            }
                            else if (argExpr is ObjectCreationExpressionSyntax oce && oce.ArgumentList is not null)
                            {
                                foreach (var arg in oce.ArgumentList.Arguments)
                                    if (arg.Expression is LiteralExpressionSyntax rangeLit
                                        && rangeLit.IsKind(SyntaxKind.StringLiteralExpression))
                                        items.Add(rangeLit.Token.ValueText);
                                    else
                                        return p; // unmodelled element — omit items entirely
                            }
                            else
                            {
                                return p; // unmodelled shape — omit items entirely
                            }
                        }
                        else
                        {
                            return p; // unmodelled method — omit items entirely
                        }
                    }
                    else
                    {
                        return p; // unmodelled statement — omit items entirely
                    }
                }
            }
            // Always set Items, even if empty — so the canvas knows the editor is available
            p.Items = items.ToArray();
        }

        // TextBox-specific properties
        if (simpleType == "TextBox")
        {
            if (cs.Properties.TryGetValue("Multiline", out var ml) && ml.Right is LiteralExpressionSyntax mll)
                p.Multiline = mll.Token.Value is true;

            if (cs.Properties.TryGetValue("ReadOnly", out var ro) && ro.Right is LiteralExpressionSyntax rol)
                p.ReadOnly = rol.Token.Value is true;

            if (cs.Properties.TryGetValue("MaxLength", out var maxL) && maxL.Right is LiteralExpressionSyntax maxLit
                && maxLit.Token.Value is int maxV)
                p.MaxLength = maxV;

            if (cs.Properties.TryGetValue("PasswordChar", out var pc) && pc.Right is LiteralExpressionSyntax pcLit
                && pcLit.Token.Value is char pcChar)
                p.PasswordChar = pcChar.ToString();

            if (cs.Properties.TryGetValue("ScrollBars", out var sb))
                p.ScrollBars = ParseMemberName(sb.Right);
        }

        // Leaf widget values and ranges (TrackBar, ProgressBar, NumericUpDown)
        if (simpleType is "TrackBar" or "ProgressBar" or "NumericUpDown")
        {
            if (cs.Properties.TryGetValue("Minimum", out var min))
                p.Minimum = ParseNumber(min.Right);

            if (cs.Properties.TryGetValue("Maximum", out var max))
                p.Maximum = ParseNumber(max.Right);

            if (cs.Properties.TryGetValue("Value", out var val))
                p.Value = ParseNumber(val.Right);
        }

        return p;
    }

    private static decimal? ParseNumber(ExpressionSyntax e)
    {
        if (e is LiteralExpressionSyntax lit && lit.Token.Value is { } v)
        {
            try { return Convert.ToDecimal(v, CultureInfo.InvariantCulture); } catch { return null; }
        }
        if (e is PrefixUnaryExpressionSyntax { OperatorToken.RawKind: (int)SyntaxKind.MinusToken } pre
            && pre.Operand is LiteralExpressionSyntax negLit && negLit.Token.Value is { } nv)
        {
            try { return -Convert.ToDecimal(nv, CultureInfo.InvariantCulture); } catch { return null; }
        }
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
                    else
                        break;
                }
                if (vals.Count == 4)
                    try { return new decimal(vals.ToArray()); } catch { return null; }
            }
        }
        return null;
    }

    /// <summary>True when the expression is a bare `this` — i.e. a form-level member access.</summary>
    private static bool IsFormReceiver(ExpressionSyntax e) => e is ThisExpressionSyntax;

    /// <summary>
    /// True when the expression is `this.something` — i.e. a control-level access.
    ///
    /// The form-level equivalent is <see cref="TryGetFormProperty"/>, which also accepts the
    /// bare-identifier style. Confusing the two is a real bug: `this.ClientSize` belongs to the
    /// form, `this.lbl.Text` belongs to a control.
    /// </summary>
    private static bool IsThisReceiver(ExpressionSyntax e) =>
        e is MemberAccessExpressionSyntax m && m.Expression is ThisExpressionSyntax;

    /// <summary>
    /// Recognises a form-level property assignment, in either of the two dialects Visual Studio
    /// and the SDK template emit:
    ///
    ///   classic:  this.ClientSize = new System.Drawing.Size(800, 450);
    ///   modern:   ClientSize = new Size(800, 450);          // implicit usings
    ///
    /// The modern form appears in every freshly-created `dotnet new winforms` project, because
    /// `InitializeComponent()` only starts using `this.` once the designer has rewritten it
    /// after a control is added. Reading only the classic style makes a brand-new project parse
    /// as an empty form while still reporting 100% coverage.
    ///
    /// A bare identifier is only accepted for the form, never for a control: inside a Designer
    /// file a bare `Text = ...` is necessarily an inherited Form property.
    /// </summary>
    private static bool TryGetFormProperty(ExpressionSyntax left, out string name)
    {
        return TryGetControlName(left, out name);
    }

    /// <summary>
    /// Resolves an expression to a member or field name, accepting both the qualified form and
    /// the bare-identifier form.
    ///
    /// Designer files come in at least three dialects, all of which appear in real projects:
    ///
    ///   classic    this.btnSubmit.Location = new System.Drawing.Point(x, y);
    ///   templated  this.btnSubmit.Location = new Point(x, y);          // implicit usings
    ///   bare       btnSubmit.Location = new Point(x, y);               // no `this.` anywhere
    ///
    /// The bare dialect is not exotic — it is what a designer file looks like when the `this.`
    /// qualification was never introduced, and reading only the classic form silently reports
    /// such a file as an empty form at 100% coverage.
    /// </summary>
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

    /// <summary>True when `e` is the `this.x` form specifically (not the bare `x`).</summary>
    private static bool IsThisQualified(ExpressionSyntax e) =>
        e is MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax };

    private static string? ReadFormText(MethodDeclarationSyntax ic)
    {
        // Accepts both `this.Text` and the template's bare `Text`.
        foreach (var stmt in ic.Body?.Statements ?? default)
            if (stmt is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a }
                && TryGetFormProperty(a.Left, out var n) && n == "Text"
                && a.Right is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression))
                return lit.Token.ValueText;
        return null;
    }

    private static string? ReadFormBackColor(MethodDeclarationSyntax ic)
    {
        foreach (var stmt in ic.Body?.Statements ?? default)
            if (stmt is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a }
                && TryGetFormProperty(a.Left, out var n) && n == "BackColor")
                return ParseColor(a.Right);
        return null;
    }

    private static SizeDto? ReadSize(MethodDeclarationSyntax ic, string prop)
    {
        foreach (var stmt in ic.Body?.Statements ?? default)
            if (stmt is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a }
                && TryGetFormProperty(a.Left, out var n) && n == prop)
            {
                // Works for both `new System.Drawing.Size(800, 450)` and `new Size(800, 450)` —
                // only the argument expressions matter, not the qualified type name.
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
        // Shape: <recv>.Controls.Add(<child>)   — where <recv> may be `this`, a bare `Controls`,
        // `this.panel1`, or a bare `panel1`.
        if (expr is not InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax add } inv) return false;
        if (add.Name.Identifier.Text != "Add") return false;
        if (add.Expression is not MemberAccessExpressionSyntax controls) return false;
        if (controls.Name.Identifier.Text is not ("Controls" or "TabPages")) return false;

        if (controls.Expression is ThisExpressionSyntax)
        {
            container = "Controls";              // this.Controls.Add(x)
        }
        else if (TryGetControlName(controls.Expression, out var ownerName))
        {
            container = ownerName;               // panel1.Controls.Add(x) / this.panel1.Controls.Add(x)
        }
        else
        {
            return false;
        }

        // The argument is the child: either `this.x` or a bare `x`.
        if (inv.ArgumentList.Arguments.Count == 1
            && TryGetControlName(inv.ArgumentList.Arguments[0].Expression, out var argName))
        {
            child = argName;
        }

        // Returning true with a null child would make the caller skip the statement without
        // recording anything, silently losing the Controls.Add. Report it as unrecognised.
        return child is not null;
    }

    /// <summary>
    /// Recognises `x.Items.Add(...)` and `x.Items.AddRange(...)` where x is a control name.
    /// Returns the control name and the full statement (so we can rewrite/delete it later).
    /// Only literal string arguments (for Add) or array-creation expressions (for AddRange)
    /// with literal string elements are accepted — anything else makes the collection unmodelled.
    /// </summary>
    private static bool TryParseItemsCall(ExpressionSyntax expr, out string controlName, out ExpressionStatementSyntax stmt)
    {
        controlName = "";
        stmt = null!;
        // Shape: <recv>.Items.Add("x")  or  <recv>.Items.AddRange(new object[] { "x", "y" })
        // where <recv> is `this.cbo` or bare `cbo`.
        if (expr is not InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax itemsCall } inv) return false;
        if (itemsCall.Name.Identifier.Text is not ("Add" or "AddRange")) return false;
        if (itemsCall.Expression is not MemberAccessExpressionSyntax itemsAccess) return false;
        if (itemsAccess.Name.Identifier.Text != "Items") return false;

        if (!TryGetControlName(itemsAccess.Expression, out controlName)) return false;

        // For now, only accept literal arrays/strings. Other shapes make the collection unmodelled.
        var method = itemsCall.Name.Identifier.Text;
        if (method == "Add")
        {
            if (inv.ArgumentList.Arguments.Count != 1) return false;
            if (inv.ArgumentList.Arguments[0].Expression is not LiteralExpressionSyntax lit) return false;
            if (!lit.IsKind(SyntaxKind.StringLiteralExpression)) return false;
        }
        else if (method == "AddRange")
        {
            if (inv.ArgumentList.Arguments.Count != 1) return false;
            var argExpr = inv.ArgumentList.Arguments[0].Expression;
            // Accept both: new object[] { ... } (ArrayCreationExpressionSyntax)
            // and: new string[] { ... } (also ArrayCreationExpressionSyntax)
            // as well as ObjectCreationExpressionSyntax for completeness
            bool isArrayCreation = argExpr is ArrayCreationExpressionSyntax ace
                && (ace.Type.ToString() is "object[]" or "string[]");
            bool isObjectCreation = argExpr is ObjectCreationExpressionSyntax oce
                && oce.Type.ToString() is "object[]" or "string[]";
            if (!isArrayCreation && !isObjectCreation) return false;

            if (argExpr is ArrayCreationExpressionSyntax ace2 && ace2.Initializer is not null)
            {
                foreach (var element in ace2.Initializer.Expressions)
                    if (element is not LiteralExpressionSyntax lit || !lit.IsKind(SyntaxKind.StringLiteralExpression))
                        return false;
            }
            else if (argExpr is ObjectCreationExpressionSyntax oce2 && oce2.ArgumentList is not null)
            {
                foreach (var arg in oce2.ArgumentList.Arguments)
                    if (arg.Expression is not LiteralExpressionSyntax lit || !lit.IsKind(SyntaxKind.StringLiteralExpression))
                        return false;
            }
            else
            {
                return false;
            }
        }

        // We need the full statement for rewriting later.
        if (inv.Parent is ExpressionStatementSyntax parentStmt)
        {
            stmt = parentStmt;
            return true;
        }
        else
            return false;
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
                "Olive" => "#808000", "Maroon" => "#800000", "Purple" => "#800080",
                "Aqua" or "Cyan" => "#00FFFF", "Fuchsia" or "Magenta" => "#FF00FF",
                "Transparent" => "", "Control" => "", "Window" => "", "WindowText" => "",
                _ => null
            };
            return name;
        }

        return text switch { _ => null };
    }

    internal static string? ParseMemberName(ExpressionSyntax expr) => expr switch
    {
        MemberAccessExpressionSyntax m => m.Name.Identifier.Text,
        IdentifierNameSyntax id => id.Identifier.Text,
        _ => null,
    };
}

public sealed class DesignException : Exception
{
    public string Kind { get; }
    public DesignException(string message, string kind) : base(message) => Kind = kind;
}