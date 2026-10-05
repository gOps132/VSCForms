namespace FixtureWired;

partial class WiredForm
{
    private System.ComponentModel.IContainer components = null;

    /// <summary>
    ///  Required designer variable.
    /// </summary>
    private System.Windows.Forms.Button btnCalculate;
    private System.Windows.Forms.Label lblResult;
    private System.Windows.Forms.TrackBar trackLevel;

    /// <summary>
    ///  Clean up any resources being used.
    /// </summary>
    protected override void Dispose(bool disposing)
    {
        if (disposing && (components != null))
        {
            components.Dispose();
        }
        base.Dispose(disposing);
    }

    #region Windows Form Designer generated code

    /// <summary>
    ///  Required method for Designer support - do not modify
    ///  the contents of this method with the code editor.
    /// </summary>
    private void InitializeComponent()
    {
        this.components = new System.ComponentModel.Container();
        this.btnCalculate = new System.Windows.Forms.Button();
        this.lblResult = new System.Windows.Forms.Label();
        this.trackLevel = new System.Windows.Forms.TrackBar();
        this.trackLevel.BeginInit();
        this.SuspendLayout();
        //
        // btnCalculate
        //
        this.btnCalculate.Location = new System.Drawing.Point(120, 40);
        this.btnCalculate.Name = "btnCalculate";
        this.btnCalculate.Size = new System.Drawing.Size(120, 34);
        this.btnCalculate.TabIndex = 0;
        this.btnCalculate.Text = "Calculate";
        this.btnCalculate.UseVisualStyleBackColor = true;
        this.btnCalculate.Click += new System.EventHandler(this.btnCalculate_Click);
        //
        // lblResult
        //
        this.lblResult.AutoSize = true;
        this.lblResult.Location = new System.Drawing.Point(120, 90);
        this.lblResult.Name = "lblResult";
        this.lblResult.Size = new System.Drawing.Size(47, 17);
        this.lblResult.TabIndex = 1;
        this.lblResult.Text = "0.00";
        //
        // trackLevel
        //
        this.trackLevel.Location = new System.Drawing.Point(120, 130);
        this.trackLevel.Name = "trackLevel";
        this.trackLevel.Size = new System.Drawing.Size(200, 56);
        this.trackLevel.TabIndex = 2;
        this.trackLevel.TickStyle = System.Windows.Forms.TickStyle.None;
        this.trackLevel.Scroll += new System.EventHandler(this.trackLevel_Scroll);
        this.trackLevel.EndInit();
        this.ResumeLayout(false);
        this.PerformLayout();
        //
    }

    #endregion
}