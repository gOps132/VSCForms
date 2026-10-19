using System;
using System.Windows.Forms;

namespace FixtureEvents;

/// <summary>
/// Hand-written code-behind fixture for event wiring and handler scaffolding tests.
/// Mirrors Visual Studio's dual-file partial class architecture.
/// </summary>
public partial class EventsForm : Form
{
    public EventsForm()
    {
        InitializeComponent();
    }

    private void btnSave_Click(object sender, EventArgs e)
    {
        txtInput.Text = "Saved";
    }
}
