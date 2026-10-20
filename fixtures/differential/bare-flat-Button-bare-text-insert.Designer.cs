namespace Matrix.BareFlatButtonBare;

partial class BareFlatButtonBareForm
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
        btnSubject = new Button();
        components = new System.ComponentModel.Container();
        //
        // btnSubject
        //
        btnSubject.Location = new Point(40, 40);
        btnSubject.Name = "btnSubject";
        btnSubject.Size = new Size(120, 30);
        btnSubject.TabIndex = 1;
        btnSubject.TextAlign = System.Drawing.ContentAlignment.TopRight;

        AutoScaleMode = AutoScaleMode.Font;
        ClientSize = new Size(400, 300);
        Text = "BareFlatButtonBareForm";
        Controls.Add(btnSubject);
        Name = "BareFlatButtonBareForm";
    }

    private Button btnSubject;
}
