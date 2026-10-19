namespace FixtureEvents;

partial class EventsForm
{
    private System.ComponentModel.IContainer components = null;

    /// <summary>
    ///  Required designer variable.
    /// </summary>
    private System.Windows.Forms.Button btnSave;
    private System.Windows.Forms.TextBox txtInput;
    private System.Windows.Forms.CheckBox chkOption;

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
        this.btnSave = new System.Windows.Forms.Button();
        this.txtInput = new System.Windows.Forms.TextBox();
        this.chkOption = new System.Windows.Forms.CheckBox();
        this.SuspendLayout();
        //
        // btnSave
        //
        this.btnSave.Location = new System.Drawing.Point(30, 30);
        this.btnSave.Name = "btnSave";
        this.btnSave.Size = new System.Drawing.Size(100, 30);
        this.btnSave.TabIndex = 0;
        this.btnSave.Text = "Save";
        this.btnSave.UseVisualStyleBackColor = true;
        this.btnSave.Click += new System.EventHandler(this.btnSave_Click);
        //
        // txtInput
        //
        this.txtInput.Location = new System.Drawing.Point(30, 80);
        this.txtInput.Name = "txtInput";
        this.txtInput.Size = new System.Drawing.Size(200, 23);
        this.txtInput.TabIndex = 1;
        //
        // chkOption
        //
        this.chkOption.AutoSize = true;
        this.chkOption.Location = new System.Drawing.Point(30, 120);
        this.chkOption.Name = "chkOption";
        this.chkOption.Size = new System.Drawing.Size(80, 19);
        this.chkOption.TabIndex = 2;
        this.chkOption.Text = "Enable";
        this.chkOption.UseVisualStyleBackColor = true;
        //
        // EventsForm
        //
        this.ClientSize = new System.Drawing.Size(300, 200);
        this.Controls.Add(this.btnSave);
        this.Controls.Add(this.txtInput);
        this.Controls.Add(this.chkOption);
        this.Name = "EventsForm";
        this.Text = "Events Test Form";
        this.ResumeLayout(false);
        this.PerformLayout();
    }

    #endregion
}
