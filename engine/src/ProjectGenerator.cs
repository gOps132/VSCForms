using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace VSCForms.Engine;

/// <summary>
/// Creates a WinForms project by shelling out to `dotnet new`, plus a classic .sln.
///
/// WHY THIS LIVES IN THE ENGINE AND NOT THE EXTENSION HOST
///   Editing a csproj has to preserve its UTF-8 BOM and its CRLF line endings. The engine is the
///   only component that already does byte-faithful file editing; the extension host does none.
///   The shell script this replaces did the edit with a Python heredoc and silently rewrote the
///   SDK's CRLF as LF — caught only because the test asserted the bytes. A second implementation
///   in TypeScript would inherit that bug in a language with no assertion covering it.
///
/// See docs/adr/0007 for why we delegate to the SDK instead of owning templates.
/// </summary>
public static class ProjectGenerator
{
    public sealed record Result(
        string ProjectDir,
        string Solution,
        string Designer,
        bool WindowsTargetingAdded);

    /// <summary>
    /// Three traps this exists to avoid. None of them fails loudly.
    ///   1. `dotnet new sln` DEFAULTS TO .slnx in SDK 10 — a 23-byte XML file that VS 17.0-17.9
    ///      cannot open at all (needs 17.13+ for MSBuild, 17.14 GA), and `dotnet sln migrate` is
    ///      one-way. The file exists and looks like a solution either way.
    ///   2. `dotnet new winforms` runs an implicit restore that FAILS on macOS/Linux with
    ///      NETSDK1100 while STILL EXITING 0, because the post-action sets continueOnError. The
    ///      project reports success and cannot restore. `--no-restore` avoids it, and
    ///      <EnableWindowsTargeting> is injected afterwards.
    ///   3. A .sln without .Build.0 entries builds NOTHING and exits 0. No error, no warning.
    /// </summary>
    public static Result Generate(
        string name,
        string parent,
        string template,
        string language,
        TextWriter stderr)
    {
        ValidateName(name);

        if (language is not ("C#" or "VB"))
            throw new DesignException($"Only C# and VB are supported (got '{language}')", "bad-language");

        string dotnet = ResolveDotnet(stderr);
        RequireTemplate(dotnet, template, stderr);

        var projectDir = Path.GetFullPath(Path.Combine(parent, name));
        if (Directory.Exists(projectDir) || File.Exists(projectDir))
            throw new DesignException($"'{projectDir}' already exists", "exists");

        // Everything that can be rejected is rejected before a single byte is written, so a
        // failed generation never leaves a half-made project behind.
        Directory.CreateDirectory(parent);

        string proj = Run(dotnet, stderr, "new", template,
            "--name", name,
            "--output", projectDir,
            "--language", language,
            "--no-restore") ? projectDir : throw new DesignException(
                $"'dotnet new {template}' failed", "sdk");

        string solution = Path.Combine(Path.GetFullPath(parent), $"{name}.sln");
        Run(dotnet, stderr, "new", "sln", "--name", name, "--format", "sln", "--output", parent);

        if (!File.Exists(solution))
            throw new DesignException($"Expected a .sln at {solution} but none was produced", "sdk");

        var csproj = Directory.GetFiles(projectDir, "*.csproj").FirstOrDefault()
                  ?? Directory.GetFiles(projectDir, "*.vbproj").FirstOrDefault()
                  ?? throw new DesignException($"No project file under {projectDir}", "sdk");

        // Writes the ProjectConfigurationPlatforms matrix (Any CPU/x64/x86 across Debug/Release).
        // This is trap 3: without it the solution is decorative.
        Run(dotnet, stderr, "sln", solution, "add", csproj);

        bool injected = false;
        if (!OperatingSystem.IsWindows())
        {
            InjectWindowsTargeting(csproj);
            injected = true;
            Log(stderr, $"added <EnableWindowsTargeting> to {Path.GetFileName(csproj)}");
        }

        var slnText = File.ReadAllText(solution);
        if (!slnText.Contains("Build.0", StringComparison.Ordinal))
            throw new DesignException(
                "The generated .sln has no Build.0 entries — it would build nothing and still exit 0",
                "sdk");

        var designer = Directory.GetFiles(projectDir, "*.Designer.cs").FirstOrDefault() ?? "";

        return new Result(projectDir, solution, designer, injected);
    }

    /// <summary>
    /// Insert the property while preserving the BOM and the exact line endings the SDK wrote.
    /// Reading with StreamReader would normalise CRLF to LF on the way in; we go through bytes.
    /// </summary>
    private static void InjectWindowsTargeting(string path)
    {
        var bytes = File.ReadAllBytes(path);
        bool bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
        var text = new UTF8Encoding(false).GetString(bytes, bom ? 3 : 0, bytes.Length - (bom ? 3 : 0));

        if (text.Contains("EnableWindowsTargeting", StringComparison.Ordinal)) return;

        // Insert after <OutputType> so the property order reads the way a human would write it;
        // else after <TargetFramework>; else at the end of the first PropertyGroup.
        int? at = AfterLine(text, "<OutputType>")
               ?? AfterLine(text, "<TargetFramework>");

        var eol = text.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        const string Prop = "    <EnableWindowsTargeting>true</EnableWindowsTargeting>";

        string updated;
        if (at is int pos)
        {
            updated = text[..pos] + Prop + eol + text[pos..];
        }
        else
        {
            var close = Regex.Match(text, @"([ \t]*)</PropertyGroup>");
            if (!close.Success)
                throw new DesignException(
                    $"Could not locate a PropertyGroup in {Path.GetFileName(path)}", "sdk");
            updated = text[..close.Index] + close.Groups[1].Value + Prop + eol + text[close.Index..];
        }

        var body = new UTF8Encoding(false).GetBytes(updated);
        File.WriteAllBytes(path, bom ? new byte[] { 0xEF, 0xBB, 0xBF }.Concat(body).ToArray() : body);
    }

    /// <summary>Offset just past the end of the first line containing <paramref name="tag"/>.</summary>
    private static int? AfterLine(string text, string tag)
    {
        foreach (Match line in Regex.Matches(text, @"^[^\n]*\n", RegexOptions.Multiline))
        {
            if (line.Value.Contains(tag, StringComparison.Ordinal))
                return line.Index + line.Length;
        }
        return null;
    }

    private static readonly Regex Identifier =
        new(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

    /// <summary>Reserved words that would produce a project which cannot compile.</summary>
    private static readonly HashSet<string> Keywords = new(StringComparer.Ordinal)
    {
        "abstract","as","base","bool","break","byte","case","catch","char","checked","class","const",
        "continue","decimal","default","delegate","do","double","else","enum","event","explicit",
        "extern","false","finally","fixed","float","for","foreach","goto","if","implicit","in",
        "int","interface","internal","is","lock","long","namespace","new","null","object",
        "operator","out","override","params","private","protected","public","readonly","ref",
        "return","sbyte","sealed","short","sizeof","stackalloc","static","string","struct","switch",
        "this","throw","true","try","typeof","uint","ulong","unchecked","unsafe","ushort","using",
        "virtual","void","volatile","while",
    };

    private static void ValidateName(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new DesignException("A project name is required", "bad-name");
        if (!Identifier.IsMatch(name))
            throw new DesignException(
                $"'{name}' is not a valid identifier — start with a letter or underscore, no spaces "
                + "or punctuation", "bad-name");
        if (Keywords.Contains(name))
            throw new DesignException(
                $"'{name}' is a C# keyword and would produce a project that cannot compile",
                "bad-name");
    }

    private static string ResolveDotnet(TextWriter stderr)
    {
        // NOTE: stdout MUST be redirected here. The engine's stdout is the protocol channel
        // (invariant 6), and an inherited stdout means `dotnet --version`'s "10.0.400" lands in
        // the middle of the JSON stream and corrupts the response.
        foreach (var candidate in new[] { "dotnet", "/usr/local/share/dotnet/dotnet", "/opt/homebrew/bin/dotnet" })
        {
            if (Capture(candidate, stderr, new[] { "--version" }, 20_000).Ok) return candidate;
        }

        Log(stderr, "no working `dotnet` found");
        throw new DesignException(
            "The .NET SDK is required to create a WinForms project. Install it from "
            + "https://dotnet.microsoft.com/download", "no-dotnet");
    }

    private static void RequireTemplate(string dotnet, string template, TextWriter stderr)
    {
        var (ok, output) = Capture(dotnet, stderr, "new", "list");
        if (!ok) throw new DesignException("Could not run `dotnet new list`", "no-dotnet");

        // The short name is a COLUMN in the output, padded with spaces, not at line start.
        var pattern = $@"(^|[^\w.-]){Regex.Escape(template)}([\s]|$)";
        if (!Regex.IsMatch(output, pattern, RegexOptions.Multiline))
            throw new DesignException(
                $"The '{template}' template is not available in this SDK", "no-template");

        Log(stderr, $"template '{template}' is available");
    }

    /// <summary>Run a command, throwing if it fails. Output is suppressed; it goes to stderr.</summary>
    private static bool Run(string exe, TextWriter stderr, params string[] args)
    {
        var (ok, _) = Capture(exe, stderr, args);
        return ok;
    }

    private static (bool Ok, string Output) Capture(string exe, TextWriter stderr, params string[] args)
        => Capture(exe, stderr, args, 180_000);

    /// <summary>
    /// Runs a child process with BOTH streams captured. Inheriting stdout is the bug this exists
    /// to prevent: the engine's stdout is the protocol channel, so an uncaptured `dotnet` line
    /// lands in the JSON stream and corrupts the response.
    /// </summary>
    private static (bool Ok, string Output) Capture(string exe, TextWriter stderr, string[] args, int timeoutMs)
    {
        var psi = new ProcessStartInfo(exe, args)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // Never a TTY: some `dotnet` subcommands switch to interactive or paginated output
            // when they think a human is watching, and we parse what they print.
            RedirectStandardInput = true,
        };
        try
        {
            using var p = Process.Start(psi);
            if (p is null) return (false, "");
            // Read both streams before waiting: a full pipe buffer deadlocks the child.
            var stdout = p.StandardOutput.ReadToEnd();
            var stderrText = p.StandardError.ReadToEnd();
            p.StandardInput.Close();
            if (!p.WaitForExit(timeoutMs)) return (false, stdout);
            if (stderrText.Length > 0) Log(stderr, $"$ {exe} {string.Join(' ', args)}\n{stderrText.TrimEnd()}");
            return (p.ExitCode == 0, stdout);
        }
        catch (Exception ex)
        {
            Log(stderr, $"$ {exe} {string.Join(' ', args)}\n  failed: {ex.Message}");
            return (false, "");
        }
    }

    private static void Log(TextWriter w, string msg)
    {
        w.WriteLine($"[vscforms-engine] {msg}");
        w.Flush();
    }
}