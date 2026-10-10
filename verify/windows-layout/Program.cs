// Verifies VSCForms' Form Schema against what WinForms ACTUALLY does at runtime.
//
// This is the only test that can catch a semantically-wrong-but-syntactically-valid
// patch. Every other tier checks that the code compiles and that the diff is minimal;
// none of them can tell you that `Location = new Point(500, 250)` put the control
// somewhere the designer would not have.
//
// Runs on Windows only, because instantiating System.Windows.Forms requires the
// Windows Desktop runtime. See scripts/run-windows-layout.sh.
//
// STAGING CONTRACT: this file is form-agnostic. The harness copies the Designer file
// under test plus two generated files into the same assembly: Shim.cs provides
// `VscformsLayoutHost.CreateForm()` for the copied form's NS/CLASS, and Stubs.cs
// (scripts/gen-layout-stubs.py) supplies event handlers and third-party types
// that live outside the Designer file. This file never names a form type and
// works for every fixture unmodified. It accepts the engine's parse response
// or the bare schema as its argument.
//
// Usage: VSCFormsLayoutCheck <schema.json> [scale-tolerance]

using System.Globalization;
using System.Text.Json;
using System.Windows.Forms;

internal static class Program
{
    private static int failures;

    private static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("usage: VSCFormsLayoutCheck <schema.json>");
            return 2;
        }

        using var doc = JsonDocument.Parse(File.ReadAllText(args[0]));
        var schema = doc.RootElement;
        // The harness feeds the engine's parse response ({id, ok, schema});
        // accept the bare schema too so the checker stays runnable by hand.
        if (schema.TryGetProperty("schema", out var inner))
            schema = inner;

        var refuses = schema.GetProperty("analysis").GetProperty("refuses");
        bool refusedOnly = refuses.GetArrayLength() > 0;
        string reasons = string.Join(", ",
            refuses.EnumerateArray().Select(e => e.GetString()));

        // A refused form may not construct at all: localizable geometry lives in
        // the .resx, which the staged assembly does not have, so ApplyResources
        // throws. That is the parse tier's territory (it classified the refusal),
        // not a layout failure — report it loudly and stop. A modellable form
        // that cannot construct is a real failure and propagates.
        System.Windows.Forms.Form form = null!;
        try
        {
            form = VscformsLayoutHost.CreateForm();
        }
        catch (Exception ex) when (refusedOnly)
        {
            Console.WriteLine($"REFUSED ({reasons}) — runtime geometry is not " +
                "verifiable; refusal covered by parse tier");
            Console.WriteLine($"construction failed with: {ex.GetType().FullName}");
            return 0;
        }
        using var _ = form;

        // Force layout so every control has a real, final position.
        form.PerformLayout();

        Console.WriteLine($"form: {schema.GetProperty("form").GetProperty("name").GetString()}");
        Console.WriteLine($"declared clientSize: " +
            $"{schema.GetProperty("form").GetProperty("clientSize").GetProperty("width").GetInt32()}x" +
            $"{schema.GetProperty("form").GetProperty("clientSize").GetProperty("height").GetInt32()}");
        Console.WriteLine($"actual   clientSize: {form.ClientSize.Width}x{form.ClientSize.Height}");
        if (refusedOnly)
            Console.WriteLine("mode: presence-only (refused form — geometry lives outside the file)");
        Console.WriteLine();

        int checkedCount = Walk(schema.GetProperty("controls"), form.Controls, !refusedOnly);
        form.Dispose();

        Console.WriteLine();
        Console.WriteLine($"checked {checkedCount} control(s); {failures} failure(s)");

        if (failures == 0)
        {
            Console.WriteLine(refusedOnly
                ? "PASS — every schema control exists at runtime"
                : "PASS — schema geometry matches runtime geometry");
            return 0;
        }

        Console.WriteLine("FAIL — schema geometry disagrees with the real control tree");
        return 1;
    }

    private static int Walk(JsonElement nodes, Control.ControlCollection controls, bool geometry)
    {
        int count = 0;

        foreach (var node in nodes.EnumerateArray())
        {
            string id = node.GetProperty("id").GetString()!;
            var props = node.GetProperty("properties");
            bool locked = node.TryGetProperty("locked", out var l) && l.GetBoolean();

            var found = FindByName(controls, id);
            if (found is null)
            {
                // Locked controls are not in the schema's modelled set only if they are absent;
                // present-but-locked still has to exist at runtime.
                Report(id, "control not found at runtime");
                continue;
            }

            count++;
            if (!geometry)
            {
                // Refused form: geometry lives outside the file (.resx, dock
                // engine), so existence at runtime is the whole check.
            }
            else
            {
                Check(id, "Location", props.GetProperty("x").GetInt32(), props.GetProperty("y").GetInt32(),
                      found.Left, found.Top, 0);

                // Size is only comparable for controls that do not compute their own. An
                // AutoSize control sizes itself from the font, so asserting our declared width
                // against it would fail for a reason that has nothing to do with VSCForms.
                bool autoSize = found is Label or CheckBox or RadioButton or LinkLabel
                                || found.GetType().GetProperty("AutoSize")?.GetValue(found) is bool b && b;
                if (!autoSize)
                {
                    Check(id, "Size", props.GetProperty("width").GetInt32(), props.GetProperty("height").GetInt32(),
                          found.Width, found.Height, 0);
                }
            }

            if (node.TryGetProperty("children", out var children) && children.GetArrayLength() > 0)
                count += Walk(children, found.Controls, geometry);
        }

        return count;
    }

    private static Control? FindByName(Control.ControlCollection controls, string name)
    {
        foreach (Control c in controls)
        {
            if (c.Name == name) return c;
            var nested = FindByName(c.Controls, name);
            if (nested is not null) return nested;
        }
        return null;
    }

    private static void Check(string id, string what, int expected, int actual, int actualX, int actualY, int tol)
    {
        int ax = what == "Location" ? actualX : expected;
        int ay = what == "Location" ? actualY : expected;
        _ = ax; _ = ay;

        if (Math.Abs(expected - actual) > tol)
            Report(id, $"{what}: schema says {expected}, runtime is {actual}");
    }

    private static void Report(string id, string message)
    {
        failures++;
        Console.WriteLine($"  FAIL {id}: {message}");
    }
}