namespace Matrix.BareFlatTextBoxBare;

partial class BareFlatTextBoxBareForm
{
    private System.ComponentModel.IContainer components = null;

    protected override void Dispose(bool disposing)
    {
        if (disposing && (components != null))
        {
            components.Dispose();
        }
        base.Dispose(disposing);
    }

    private void InitializeComponent()
    {
        txtSubject = new TextBox();
        components = new System.ComponentModel.Container();
        //
        // txtSubject
        //
        txtSubject.Location = new Point(40, 40);
        txtSubject.Name = "txtSubject";
        txtSubject.Size = new Size(120, 30);
        txtSubject.TabIndex = 1;
        txtSubject.TextAlign = System.Drawing.ContentAlignment.Center;

        AutoScaleMode = AutoScaleMode.Font;
        ClientSize = new Size(400, 300);
        Text = "BareFlatTextBoxBareForm";
        Controls.Add(txtSubject);
        Name = "BareFlatTextBoxBareForm";
    }

    private TextBox txtSubject;
}
