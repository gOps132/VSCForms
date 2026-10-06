namespace FixtureLeafWidgets;

partial class LeafForm
{
    private System.ComponentModel.IContainer components = null;
    private System.Windows.Forms.TrackBar trackVolume;
    private System.Windows.Forms.ProgressBar progressLoad;
    private System.Windows.Forms.NumericUpDown numQuantity;
    private System.Windows.Forms.DateTimePicker dtpDue;

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
        this.components = new System.ComponentModel.Container();
        this.trackVolume = new System.Windows.Forms.TrackBar();
        this.progressLoad = new System.Windows.Forms.ProgressBar();
        this.numQuantity = new System.Windows.Forms.NumericUpDown();
        this.dtpDue = new System.Windows.Forms.DateTimePicker();
        ((System.ComponentModel.ISupportInitialize)(this.numQuantity)).BeginInit();
        ((System.ComponentModel.ISupportInitialize)(this.dtpDue)).BeginInit();
        this.SuspendLayout();
        //
        // trackVolume
        //
        this.trackVolume.Location = new System.Drawing.Point(24, 24);
        this.trackVolume.Name = "trackVolume";
        this.trackVolume.Size = new System.Drawing.Size(120, 56);
        this.Controls.Add(this.trackVolume);
        this.trackVolume.TabIndex = 0;
        //
        // progressLoad
        //
        this.progressLoad.Location = new System.Drawing.Point(24, 100);
        this.progressLoad.Name = "progressLoad";
        this.progressLoad.Size = new System.Drawing.Size(140, 20);
        this.Controls.Add(this.progressLoad);
        this.progressLoad.TabIndex = 1;
        //
        // numQuantity
        //
        this.numQuantity.Location = new System.Drawing.Point(24, 140);
        this.numQuantity.Name = "numQuantity";
        this.numQuantity.Size = new System.Drawing.Size(100, 22);
        this.Controls.Add(this.numQuantity);
        this.numQuantity.TabIndex = 2;
        //
        // dtpDue
        //
        this.dtpDue.Location = new System.Drawing.Point(24, 180);
        this.dtpDue.Name = "dtpDue";
        this.dtpDue.Size = new System.Drawing.Size(120, 23);
        this.Controls.Add(this.dtpDue);
        this.dtpDue.TabIndex = 3;
        this.dtpDue.Value = new DateTime(2026, 10, 6);
        this.dtpDue.Format = System.Windows.Forms.DateTimePickerFormat.Custom;
        this.dtpDue.CustomFormat = "yyyy-MM-dd";
        //
        ((System.ComponentModel.ISupportInitialize)(this.numQuantity)).EndInit();
        ((System.ComponentModel.ISupportInitialize)(this.dtpDue)).EndInit();
        this.ResumeLayout(false);
        //
    }

    #endregion
}