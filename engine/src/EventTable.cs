namespace VSCForms.Engine;

/// <summary>
/// Static metadata for WinForms events: default events per handled control type,
/// delegate types, and EventArgs parameter types.
/// </summary>
public static class EventTable
{
    public static string DefaultEvent(string fullOrSimpleType)
    {
        var simple = TypeTable.SimpleName(fullOrSimpleType);
        return simple switch
        {
            "Button" => "Click",
            "Label" => "Click",
            "TextBox" => "TextChanged",
            "CheckBox" => "CheckedChanged",
            "RadioButton" => "CheckedChanged",
            "ComboBox" => "SelectedIndexChanged",
            "ListBox" => "SelectedIndexChanged",
            "PictureBox" => "Click",
            "Panel" => "Click",
            "GroupBox" => "Click",
            "TrackBar" => "Scroll",
            "ProgressBar" => "Click",
            "NumericUpDown" => "ValueChanged",
            "DateTimePicker" => "ValueChanged",
            "TabControl" => "SelectedIndexChanged",
            "TabPage" => "Click",
            "DataGridView" => "CellContentClick",
            "ListView" => "SelectedIndexChanged",
            "TreeView" => "AfterSelect",
            "Form" => "Load",
            _ => "Click",
        };
    }

    public static string EventDelegateType(string eventName)
    {
        return eventName switch
        {
            "MouseDown" or "MouseUp" or "MouseMove" or "MouseClick" or "MouseDoubleClick"
                => "System.Windows.Forms.MouseEventHandler",
            "KeyDown" or "KeyUp" => "System.Windows.Forms.KeyEventHandler",
            "KeyPress" => "System.Windows.Forms.KeyPressEventHandler",
            "FormClosing" => "System.Windows.Forms.FormClosingEventHandler",
            "FormClosed" => "System.Windows.Forms.FormClosedEventHandler",
            "Paint" => "System.Windows.Forms.PaintEventHandler",
            "AfterSelect" => "System.Windows.Forms.TreeViewEventHandler",
            "CellContentClick" or "CellClick" => "System.Windows.Forms.DataGridViewCellEventHandler",
            _ => "System.EventHandler",
        };
    }

    public static string EventArgsType(string eventName)
    {
        return eventName switch
        {
            "MouseDown" or "MouseUp" or "MouseMove" or "MouseClick" or "MouseDoubleClick"
                => "MouseEventArgs",
            "KeyDown" or "KeyUp" => "KeyEventArgs",
            "KeyPress" => "KeyPressEventArgs",
            "FormClosing" => "FormClosingEventArgs",
            "FormClosed" => "FormClosedEventArgs",
            "Paint" => "PaintEventArgs",
            "AfterSelect" => "TreeViewEventArgs",
            "CellContentClick" or "CellClick" => "DataGridViewCellEventArgs",
            _ => "EventArgs",
        };
    }
}
