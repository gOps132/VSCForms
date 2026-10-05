namespace FixtureDeclared;

partial class DeclaredForm
{
    private System.ComponentModel.IContainer components = null;
    private System.Windows.Forms.Button btnBare;

    protected override void Dispose(bool disposing)
    {
        if (disposing && (components != null))
        {
            components.Dispose();
        }
        base.Dispose(disposing);
    }

    #region Windows Form Designer generated code

    private void InitializeComponent()
    {
        components = new System.ComponentModel.Container();
        btnBare = new System.Windows.Forms.Button();
        btnBare.Location = new System.Drawing.Point(10, 20);
        btnBare.Name = "btnBare";
        btnBare.Size = new System.Drawing.Size(90, 30);
        btnBare.Text = "Bare";
        Controls.Add(btnBare);
        AutoScaleMode = AutoScaleMode.Font;
        ClientSize = new Size(800, 450);
        Text = "DeclaredForm";
    }

    #endregion
}