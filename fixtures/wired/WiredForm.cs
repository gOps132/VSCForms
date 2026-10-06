using System;
using System.Windows.Forms;

namespace FixtureWired;

/// <summary>
/// Hand-written code-behind for the rename tests. This file is the reason the rename tier exists.
///
/// The compile fixture used everywhere else builds a Designer file against a GENERATED shim with
/// no event wiring, so a rename that updated only the Designer File would leave a dangling
/// `CS1061` — in the user's project, after they saved — and every existing test would still pass.
/// Compiling against THIS file is what makes the bug detectable.
///
/// It deliberately contains one of each shape the renamer must reason about:
///   btnCalculate.Enabled = false;   member-access receiver -> REWRITE
///   lblResult.Text = ...;          member-access receiver -> REWRITE
///   btnCalculate_Click(...)        method declaration     -> leave alone
///   tabDetails_SelectedIndexChanged(..) method declaration    -> leave alone
/// The handler name deliberately still contains the control name: the handler is a METHOD, not a
/// control, so rewriting it would break the wiring. A local variable of the same name is injected
/// by the test rather than living here, so this fixture compiles as-is.
/// </summary>
public partial class WiredForm : Form
{
    private double level = 1.0;

    public WiredForm()
    {
        InitializeComponent();
        // A qualified member access from OUTSIDE the Designer File. This is the only shape the
        // renamer is permitted to rewrite outside it, so the fixture needs one or the code-behind
        // path is never exercised.
        btnCalculate.Enabled = false;
        tabDetails.SelectedIndex = 0;
    }

    private void btnCalculate_Click(object sender, EventArgs e)
    {
        lblResult.Text = level.ToString("F2");
    }

    private void tabDetails_SelectedIndexChanged(object sender, EventArgs e)
    {
        level += 1.0;
    }
}