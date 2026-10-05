namespace FixtureBare;

// The BARE dialect: no `this.` qualifier anywhere, and unqualified System.Drawing types.
//   bareForm = new Button();          not  this.bareForm = new System.Windows.Forms.Button();
//   bareForm.Location = new Point(10, 20);   not  this.bareForm.Location = new System.Drawing.Point(...)
//   Controls.Add(bareForm);           not  this.Controls.Add(this.bareForm);
//
// Real example: a Designer file whose `this.` qualification was never introduced. Reading only
// the classic dialect reports such a file as an empty form at 100% coverage.
partial class BareForm
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
        pnlHost = new Panel();
        bareButton = new Button();
        bareLabel = new Label();
        bareGauge = new Acme.Widgets.GaugeControl();
        components = new System.ComponentModel.Container();
        pnlHost.Location = new Point(20, 20);
        pnlHost.Name = "pnlHost";
        pnlHost.Size = new Size(300, 200);
        pnlHost.TabIndex = 0;
        bareButton.Location = new Point(12, 40);
        bareButton.Name = "bareButton";
        bareButton.Size = new Size(100, 30);
        bareButton.TabIndex = 0;
        bareButton.Text = "Bare";
        bareLabel.Location = new Point(12, 80);
        bareLabel.Name = "bareLabel";
        bareLabel.Size = new Size(80, 17);
        bareLabel.TabIndex = 1;
        bareLabel.Text = "Bare label";
        bareGauge.Location = new Point(140, 40);
        bareGauge.Name = "bareGauge";
        bareGauge.Size = new Size(90, 30);
        bareGauge.TabIndex = 2;
        AutoScaleMode = AutoScaleMode.Font;
        ClientSize = new Size(400, 300);
        pnlHost.Controls.Add(bareButton);
        pnlHost.Controls.Add(bareLabel);
        pnlHost.Controls.Add(bareGauge);
        Controls.Add(pnlHost);
        Name = "BareForm";
        Text = "Bare dialect";
    }

    private Panel pnlHost;
    private Button bareButton;
    private Label bareLabel;
    private Acme.Widgets.GaugeControl bareGauge;
}