namespace FixtureThisStyle;

// The state Visual Studio leaves a project in after its designer has rewritten a fresh
// template: `this.` on the CONTROL members, bare identifiers on inherited Form members
// (ClientSize, Name, Text, AutoScaleMode) and on the Controls collection.
//
// This is the shape insertion must follow, and the reason dialect detection keys on control
// instantiations only — `this.` appears here, but a naive "does the text contain this." test
// would also fire on a file that is bare for controls.
partial class ThisStyleForm
{
    private System.ComponentModel.IContainer components = null;

    private void InitializeComponent()
    {
        this.txt = new System.Windows.Forms.TextBox();
        components = new System.ComponentModel.Container();
        this.txt.Location = new System.Drawing.Point(96, 78);
        this.txt.Name = "txt";
        this.txt.Size = new System.Drawing.Size(180, 23);
        this.txt.TabIndex = 0;
        AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        ClientSize = new System.Drawing.Size(292, 196);
        Controls.Add(this.txt);
        Name = "ThisStyleForm";
        Text = "ThisStyle";
    }

    private System.Windows.Forms.TextBox txt;
}