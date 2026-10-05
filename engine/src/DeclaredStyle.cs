using System.Text.RegularExpressions;

namespace VSCForms.Engine;

/// <summary>
/// Declared code-style preferences, read from a nearby <c>.editorconfig</c> and the sibling
/// csproj.
///
/// WHY THIS EXISTS, PRECISELY
///   Dialect detection infers <c>UsesThisPrefix</c> from control <i>instantiations</i>. The
///   templated dialect — a freshly <c>dotnet new winforms</c> project — contains none, so the
///   signal there is inferred from <i>absence</i> and is indistinguishable from a genuinely
///   bare file. A user adding their first control to a fresh project therefore gets
///   <c>this.</c>-qualified or bare output based on nothing. Visual Studio decides this from
///   <c>dotnet_style_qualification_for_field</c>, so we can too.
///
/// WHY IT IS ADVISORY AND NEVER OVERRIDES THE FILE
///   ADR 0005 commits us to writing in the file's own dialect. Observation always wins; this
///   only fills gaps the file cannot answer. A file that says <c>this.x = new Button()</c>
///   keeps <c>this.</c> whatever the config says, because the file is the source of truth.
///
/// Only exact <c>true</c>/<c>false</c> are honoured. <c>true:warning</c> and
/// <c>false:suggestion</c> are IDE enforcement severities, not the author's stylistic intent.
/// </summary>
public sealed class DeclaredStyle
{
    /// <summary>Tri-state: true, false, or not declared.</summary>
    public bool? QualifyFields { get; init; }
    public bool? QualifyProperties { get; init; }

    /// <summary>
    /// Whether <c>System.Windows.Forms</c> and <c>System.Drawing</c> are in scope implicitly.
    /// Decides whether an unqualified type name compiles. Null when not declared.
    /// </summary>
    public bool? ImplicitUsings { get; init; }

    /// <summary>Path this was read from, for diagnostics. Null when nothing was declared.</summary>
    public string? Source { get; init; }

    public bool IsEmpty =>
        QualifyFields is null && QualifyProperties is null && ImplicitUsings is null;

    /// <summary>Nothing declared anywhere. Callers fall back to file-derived signals.</summary>
    public static readonly DeclaredStyle None = new();

    /// <summary>
    /// Walk up from <paramref name="designerPath"/> to the nearest <c>.editorconfig</c>, stopping
    /// at a directory that looks like a project root. A <c>.git</c> or <c>.sln</c> above the
    /// file is the boundary: <c>.editorconfig</c> search in the real tooling stops at the repo
    /// root, and walking past it would pick up a parent machine's or organisation's config.
    /// </summary>
    public static DeclaredStyle Discover(string designerPath)
    {
        string? dir;
        try { dir = Path.GetDirectoryName(Path.GetFullPath(designerPath)); }
        catch { return None; }

        string? configPath = null;
        while (!string.IsNullOrEmpty(dir))
        {
            var candidate = Path.Combine(dir, ".editorconfig");
            if (File.Exists(candidate)) { configPath = candidate; break; }

            // Do not walk above the project root.
            if (Directory.Exists(Path.Combine(dir, ".git"))
                || Directory.GetFiles(dir, "*.sln").Length > 0
                || Directory.GetFiles(dir, "*.slnx").Length > 0)
                return FromCsprojOnly(designerPath);

            dir = Path.GetDirectoryName(dir);
        }

        return FromCsprojOnly(designerPath, configPath);
    }

    private static DeclaredStyle FromCsprojOnly(string designerPath, string? configPath = null)
    {
        bool? fields = null, props = null;
        string? source = null;

        if (configPath is not null)
        {
            foreach (var (key, value) in ReadEditorConfig(configPath))
            {
                switch (key)
                {
                    case "dotnet_style_qualification_for_field":
                        if (fields is null) { fields = ParseBool(value); source ??= configPath; }
                        break;
                    case "dotnet_style_qualification_for_property":
                        if (props is null) { props = ParseBool(value); source ??= configPath; }
                        break;
                }
            }
        }

        bool? implicitUsings = ReadImplicitUsings(designerPath);
        source ??= implicitUsings is null ? null : SiblingCsproj(designerPath) ?? "";

        return new DeclaredStyle
        {
            QualifyFields = fields,
            QualifyProperties = props,
            ImplicitUsings = implicitUsings,
            Source = string.IsNullOrEmpty(source) ? null : source,
        };
    }

    /// <summary>
    /// Minimal INI reader. <c>.editorconfig</c> is a documented, stable format, but a malformed
    /// line must never be fatal — the whole point of an advisory input is that it cannot break
    /// the operation it informs.
    /// </summary>
    private static IEnumerable<(string Key, string Value)> ReadEditorConfig(string path)
    {
        string[] lines;
        try { lines = File.ReadAllLines(path); }
        catch { yield break; }

        foreach (var raw in lines)
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#') || line.StartsWith(';')) continue;

            int eq = line.IndexOf('=');
            if (eq <= 0) continue;   // a bare word, or leading '=' — ignore rather than guess

            var key = line[..eq].Trim();
            var value = line[(eq + 1)..].Trim();

            // Section headers look like `[*.cs]`; they have no '=' so they never reach here,
            // but a key containing '[' is one anyway.
            if (key.Length == 0 || key.Contains('[')) continue;

            yield return (key, value);
        }
    }

    /// <summary>
    /// Exact true/false only. <c>true:warning</c>, <c>false:suggestion</c> and the severity
    /// forms are how an IDE decides whether to underline the code, not what the author wants
    /// the code to look like.
    /// </summary>
    private static bool? ParseBool(string value)
    {
        if (value.Equals("true", StringComparison.OrdinalIgnoreCase)) return true;
        if (value.Equals("false", StringComparison.OrdinalIgnoreCase)) return false;
        return null;
    }

    private static string? SiblingCsproj(string designerPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(Path.GetFullPath(designerPath));
            if (dir is null) return null;
            var proj = Directory.GetFiles(dir, "*.csproj").FirstOrDefault()
                    ?? Directory.GetFiles(dir, "*.vbproj").FirstOrDefault();
            return proj;
        }
        catch { return null; }
    }

    private static bool? ReadImplicitUsings(string designerPath)
    {
        var proj = SiblingCsproj(designerPath);
        if (proj is null) return null;
        try
        {
            var text = File.ReadAllText(proj);
            // Default is DISABLED when the element is absent, so absence is a real answer only
            // in combination with a sibling SDK default; we report it as "not declared" instead,
            // because a csproj that omits the element is genuinely ambiguous.
            var m = Regex.Match(text, @"<ImplicitUsings>\s*(\w+)\s*</ImplicitUsings>", RegexOptions.IgnoreCase);
            return m.Success ? ParseBool(m.Groups[1].Value) : null;
        }
        catch { return null; }
    }
}