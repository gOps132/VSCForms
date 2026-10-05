namespace VSCForms.Engine;

/// <summary>
/// The Handled Types: control types with modelled rendering and editable appearance.
/// Chosen by measurement over a corpus of 154 real Designer Files (see CONTEXT.md).
///
/// Type resolution is PURELY SYNTACTIC — we match on the type name as written in the
/// file and never load an assembly. A control from the user's own assembly is therefore
/// simply not a handled type, which renders it as a Locked Control.
/// </summary>
public static class TypeTable
{
    private static readonly Dictionary<string, string> Handled = new(StringComparer.Ordinal)
    {
        ["System.Windows.Forms.Button"] = "button",
        ["System.Windows.Forms.Label"] = "label",
        ["System.Windows.Forms.TextBox"] = "textbox",
        ["System.Windows.Forms.CheckBox"] = "checkbox",
        ["System.Windows.Forms.RadioButton"] = "radio",
        ["System.Windows.Forms.ComboBox"] = "combobox",
        ["System.Windows.Forms.ListBox"] = "listbox",
        ["System.Windows.Forms.PictureBox"] = "picturebox",
        ["System.Windows.Forms.Panel"] = "panel",
        ["System.Windows.Forms.GroupBox"] = "groupbox",
    };

    /// <summary>Types whose children we model as a nested tree.</summary>
    private static readonly HashSet<string> Containers = new(StringComparer.Ordinal)
    {
        "System.Windows.Forms.Panel",
        "System.Windows.Forms.GroupBox",
    };

    /// <summary>
    /// Non-visual fields that appear in Designer Files but are NOT controls. `components` is an
    /// IComponentContainer, `componentsModified` is a bool — neither should render as a box.
    /// </summary>
    private static readonly HashSet<string> NonVisualFields = new(StringComparer.Ordinal)
    {
        "components", "componentsModified",
    };

    public static bool IsHandled(string fullTypeName) => Handled.ContainsKey(fullTypeName);

    /// <summary>True for infrastructure fields that must never appear as a control.</summary>
    public static bool IsNonVisual(string id, string fullTypeName)
    {
        if (NonVisualFields.Contains(id)) return true;
        // Anything that is not plausibly a Control subclass: IContainer, bool, string, etc.
        return fullTypeName.StartsWith("System.ComponentModel.", StringComparison.Ordinal)
            || fullTypeName is "bool" or "string" or "int";
    }

    public static bool IsContainer(string fullTypeName) => Containers.Contains(fullTypeName);

    /// <summary>Designer-style two-letter prefix used when auto-allocating names.</summary>
    public static string Prefix(string fullTypeName)
    {
        var simple = SimpleName(fullTypeName);
        return simple switch
        {
            "Button" => "btn",
            "Label" => "lbl",
            "TextBox" => "txt",
            "CheckBox" => "chk",
            "RadioButton" => "rad",
            "ComboBox" => "cbo",
            "ListBox" => "lst",
            "PictureBox" => "pic",
            "Panel" => "pnl",
            "GroupBox" => "grp",
            "Form" => "frm",
            _ => "ctl",
        };
    }

    /// <summary>Human-friendly reason shown when a control is locked.</summary>
    public static string LockedReason(string fullTypeName)
    {
        if (fullTypeName == "System.Windows.Forms.Form")
            return "The form itself is not editable as a control.";
        var simple = SimpleName(fullTypeName);
        return simple.EndsWith("Panel", StringComparison.Ordinal)
            ? $"Nested layout containers ({simple}) are not modelled; its controls are shown but not editable."
            : $"{simple} is not one of the {Handled.Count} handled control types, so its appearance is not modelled. Its code is left untouched.";
    }

    public static string SimpleName(string fullTypeName)
    {
        var i = fullTypeName.LastIndexOf('.');
        return i >= 0 ? fullTypeName[(i + 1)..] : fullTypeName;
    }
}