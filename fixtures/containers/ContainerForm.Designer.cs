namespace FixtureContainers;

partial class ContainerForm
{
    private System.ComponentModel.IContainer components = null;
    private System.Windows.Forms.TabControl tabMain;
    private System.Windows.Forms.TabPage tabPage1;
    private System.Windows.Forms.TabPage tabPage2;
    private System.Windows.Forms.Button btnInsidePage;
    private System.Windows.Forms.Panel pnlSub;
    private System.Windows.Forms.Label lblInPanel;
    private System.Windows.Forms.DataGridView dgvData;
    private System.Windows.Forms.ListView lvwList;
    private System.Windows.Forms.TreeView tvwTree;

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
        this.tabMain = new System.Windows.Forms.TabControl();
        this.tabPage1 = new System.Windows.Forms.TabPage();
        this.tabPage2 = new System.Windows.Forms.TabPage();
        this.btnInsidePage = new System.Windows.Forms.Button();
        this.pnlSub = new System.Windows.Forms.Panel();
        this.lblInPanel = new System.Windows.Forms.Label();
        this.dgvData = new System.Windows.Forms.DataGridView();
        this.lvwList = new System.Windows.Forms.ListView();
        this.tvwTree = new System.Windows.Forms.TreeView();
        this.tabMain.SuspendLayout();
        this.tabPage1.SuspendLayout();
        this.tabPage2.SuspendLayout();
        this.pnlSub.SuspendLayout();
        ((System.ComponentModel.ISupportInitialize)(this.dgvData)).BeginInit();
        this.SuspendLayout();
        //
        // tabMain
        //
        this.tabMain.Controls.Add(this.tabPage1);
        this.tabMain.Controls.Add(this.tabPage2);
        this.tabMain.Location = new System.Drawing.Point(12, 12);
        this.tabMain.Name = "tabMain";
        this.tabMain.SelectedIndex = 0;
        this.tabMain.Size = new System.Drawing.Size(300, 200);
        this.tabMain.TabIndex = 0;
        //
        // tabPage1
        //
        this.tabPage1.Controls.Add(this.btnInsidePage);
        this.tabPage1.Location = new System.Drawing.Point(4, 24);
        this.tabPage1.Name = "tabPage1";
        this.tabPage1.Padding = new System.Windows.Forms.Padding(3);
        this.tabPage1.Size = new System.Drawing.Size(292, 172);
        this.tabPage1.TabIndex = 0;
        this.tabPage1.Text = "Page 1";
        this.tabPage1.UseVisualStyleBackColor = true;
        //
        // btnInsidePage
        //
        this.btnInsidePage.Location = new System.Drawing.Point(20, 20);
        this.btnInsidePage.Name = "btnInsidePage";
        this.btnInsidePage.Size = new System.Drawing.Size(80, 25);
        this.btnInsidePage.TabIndex = 0;
        this.btnInsidePage.Text = "Inside";
        this.btnInsidePage.UseVisualStyleBackColor = true;
        //
        // tabPage2
        //
        this.tabPage2.Controls.Add(this.pnlSub);
        this.tabPage2.Location = new System.Drawing.Point(4, 24);
        this.tabPage2.Name = "tabPage2";
        this.tabPage2.Padding = new System.Windows.Forms.Padding(3);
        this.tabPage2.Size = new System.Drawing.Size(292, 172);
        this.tabPage2.TabIndex = 1;
        this.tabPage2.Text = "Page 2";
        this.tabPage2.UseVisualStyleBackColor = true;
        //
        // pnlSub
        //
        this.pnlSub.Controls.Add(this.lblInPanel);
        this.pnlSub.Location = new System.Drawing.Point(10, 10);
        this.pnlSub.Name = "pnlSub";
        this.pnlSub.Size = new System.Drawing.Size(150, 100);
        this.pnlSub.TabIndex = 0;
        //
        // lblInPanel
        //
        this.lblInPanel.Location = new System.Drawing.Point(5, 5);
        this.lblInPanel.Name = "lblInPanel";
        this.lblInPanel.Size = new System.Drawing.Size(60, 20);
        this.lblInPanel.TabIndex = 0;
        this.lblInPanel.Text = "Deep";
        //
        // dgvData
        //
        this.dgvData.Location = new System.Drawing.Point(320, 12);
        this.dgvData.Name = "dgvData";
        this.dgvData.Size = new System.Drawing.Size(240, 150);
        this.dgvData.TabIndex = 1;
        //
        // lvwList
        //
        this.lvwList.Location = new System.Drawing.Point(12, 220);
        this.lvwList.Name = "lvwList";
        this.lvwList.Size = new System.Drawing.Size(150, 100);
        this.lvwList.TabIndex = 2;
        //
        // tvwTree
        //
        this.tvwTree.Location = new System.Drawing.Point(180, 220);
        this.tvwTree.Name = "tvwTree";
        this.tvwTree.Size = new System.Drawing.Size(150, 100);
        this.tvwTree.TabIndex = 3;
        //
        // ContainerForm
        //
        this.ClientSize = new System.Drawing.Size(580, 340);
        this.Controls.Add(this.tabMain);
        this.Controls.Add(this.dgvData);
        this.Controls.Add(this.lvwList);
        this.Controls.Add(this.tvwTree);
        this.Name = "ContainerForm";
        this.Text = "Containers & Placeholders";
        ((System.ComponentModel.ISupportInitialize)(this.dgvData)).EndInit();
        this.pnlSub.ResumeLayout(false);
        this.tabPage2.ResumeLayout(false);
        this.tabPage1.ResumeLayout(false);
        this.tabMain.ResumeLayout(false);
        this.ResumeLayout(false);
    }

    #endregion
}
