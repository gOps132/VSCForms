namespace FixtureWired;

partial class WiredForm
{
    private System.ComponentModel.IContainer components = null;

    /// <summary>
    ///  Required designer variable.
    /// </summary>
    private System.Windows.Forms.Button btnCalculate;
    private System.Windows.Forms.Label lblResult;
    private System.Windows.Forms.TabControl tabDetails;

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
        this.tabDetails = new System.Windows.Forms.TabControl();
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
        // tabDetails
        //
        this.tabDetails.Location = new System.Drawing.Point(120, 130);
        this.tabDetails.Name = "tabDetails";
        this.tabDetails.Size = new System.Drawing.Size(200, 120);
        this.tabDetails.TabIndex = 2;
        this.tabDetails.SelectedIndexChanged += new System.EventHandler(this.tabDetails_SelectedIndexChanged);
        this.ResumeLayout(false);
        this.PerformLayout();
        //
    }

    #endregion
}