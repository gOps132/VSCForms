namespace Washing_Machine_Timer_Fuzzy_Logic
{
    partial class Form1
    {
        /// <summary>
        /// Required designer variable.
        /// </summary>
        private System.ComponentModel.IContainer components = null;

        /// <summary>
        /// Clean up any resources being used.
        /// </summary>
        /// <param name="disposing">true if managed resources should be disposed; otherwise, false.</param>
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
        /// Required method for Designer support - do not modify
        /// the contents of this method with the code editor.
        /// </summary>
        private void InitializeComponent()
        {
            cmbMethod = new ComboBox();
            btnCalculate = new Button();
            lblResult = new Label();
            lblLoad = new Label();
            lblSoilingLevel = new Label();
            numDetergent = new TrackBar();
            lblDetAmount = new Label();
            numLoad = new TrackBar();
            numSoiling = new TrackBar();
            label1 = new Label();
            label2 = new Label();
            label3 = new Label();
            cbAutoCalc = new CheckBox();
            groupBox1 = new GroupBox();
            label5 = new Label();
            label4 = new Label();
            groupBox2 = new GroupBox();
            groupBox3 = new GroupBox();
            groupBox7 = new GroupBox();
            picRulesGraph = new PictureBox();
            groupBox6 = new GroupBox();
            lblInDetHigh = new Label();
            lblInDetNorm = new Label();
            lblInDetLow = new Label();
            groupBox4 = new GroupBox();
            lblInSoilHeavy = new Label();
            lblInSoilMed = new Label();
            lblInSoilLight = new Label();
            groupBox5 = new GroupBox();
            lblInLoadHigh = new Label();
            lblInLoadMed = new Label();
            lblInLoadLow = new Label();
            picDetGraph = new PictureBox();
            picSoilingGraph = new PictureBox();
            picLoadGraph = new PictureBox();
            btn36 = new System.Windows.Forms.Button();
            lbl37 = new System.Windows.Forms.Label();
            txt38 = new System.Windows.Forms.TextBox();
            chk39 = new System.Windows.Forms.CheckBox();
            rad40 = new System.Windows.Forms.RadioButton();
            cbo41 = new System.Windows.Forms.ComboBox();
            lst42 = new System.Windows.Forms.ListBox();
            pic43 = new System.Windows.Forms.PictureBox();
            pnl44 = new System.Windows.Forms.Panel();
            grp45 = new System.Windows.Forms.GroupBox();
            trk46 = new System.Windows.Forms.TrackBar();
            prg47 = new System.Windows.Forms.ProgressBar();
            dtp48 = new System.Windows.Forms.DateTimePicker();
            ((System.ComponentModel.ISupportInitialize)numDetergent).BeginInit();
            ((System.ComponentModel.ISupportInitialize)numLoad).BeginInit();
            ((System.ComponentModel.ISupportInitialize)numSoiling).BeginInit();
            groupBox1.SuspendLayout();
            groupBox2.SuspendLayout();
            groupBox3.SuspendLayout();
            groupBox7.SuspendLayout();
            ((System.ComponentModel.ISupportInitialize)picRulesGraph).BeginInit();
            groupBox6.SuspendLayout();
            groupBox4.SuspendLayout();
            groupBox5.SuspendLayout();
            ((System.ComponentModel.ISupportInitialize)picDetGraph).BeginInit();
            ((System.ComponentModel.ISupportInitialize)picSoilingGraph).BeginInit();
            ((System.ComponentModel.ISupportInitialize)picLoadGraph).BeginInit();
            SuspendLayout();
            // 
            // cmbMethod
            // 
            cmbMethod.FormattingEnabled = true;
            cmbMethod.Location = new Point(137, 446);
            cmbMethod.Name = "cmbMethod";
            cmbMethod.Size = new Size(124, 23);
            cmbMethod.TabIndex = 3;
            // 
            // btnCalculate
            // 
            btnCalculate.Font = new Font("Segoe UI", 10F, FontStyle.Regular, GraphicsUnit.Point);
            btnCalculate.Location = new Point(293, 190);
            btnCalculate.Name = "btnCalculate";
            btnCalculate.Size = new Size(104, 48);
            btnCalculate.TabIndex = 4;
            btnCalculate.Text = "Start";
            btnCalculate.UseVisualStyleBackColor = true;
            btnCalculate.Click += btnCalculate_Click;
            // 
            // lblResult
            // 
            lblResult.AutoSize = true;
            lblResult.Font = new Font("Segoe UI", 20F, FontStyle.Regular, GraphicsUnit.Point);
            lblResult.Location = new Point(72, 34);
            lblResult.Name = "lblResult";
            lblResult.Size = new Size(237, 37);
            lblResult.TabIndex = 5;
            lblResult.Text = "Please Input stuff...";
            // 
            // lblLoad
            // 
            lblLoad.AutoSize = true;
            lblLoad.Font = new Font("Segoe UI", 10F, FontStyle.Regular, GraphicsUnit.Point);
            lblLoad.Location = new Point(361, 44);
            lblLoad.Name = "lblLoad";
            lblLoad.Size = new Size(36, 19);
            lblLoad.TabIndex = 15;
            lblLoad.Text = "0 kg";
            lblLoad.TextAlign = ContentAlignment.MiddleCenter;
            // 
            // lblSoilingLevel
            // 
            lblSoilingLevel.AutoSize = true;
            lblSoilingLevel.Font = new Font("Segoe UI", 10F, FontStyle.Regular, GraphicsUnit.Point);
            lblSoilingLevel.Location = new Point(361, 92);
            lblSoilingLevel.Name = "lblSoilingLevel";
            lblSoilingLevel.Size = new Size(46, 19);
            lblSoilingLevel.TabIndex = 16;
            lblSoilingLevel.Text = "0 / 10";
            // 
            // numDetergent
            // 
            numDetergent.Location = new Point(15, 140);
            numDetergent.Maximum = 300;
            numDetergent.Name = "numDetergent";
            numDetergent.Size = new Size(340, 45);
            numDetergent.TabIndex = 14;
            numDetergent.Scroll += numDetergent_Scroll;
            // 
            // lblDetAmount
            // 
            lblDetAmount.AutoSize = true;
            lblDetAmount.Font = new Font("Segoe UI", 10F, FontStyle.Regular, GraphicsUnit.Point);
            lblDetAmount.Location = new Point(361, 140);
            lblDetAmount.Name = "lblDetAmount";
            lblDetAmount.Size = new Size(36, 19);
            lblDetAmount.TabIndex = 17;
            lblDetAmount.Text = "0 ml";
            // 
            // numLoad
            // 
            numLoad.Location = new Point(15, 44);
            numLoad.Maximum = 18;
            numLoad.Name = "numLoad";
            numLoad.Size = new Size(340, 45);
            numLoad.TabIndex = 18;
            numLoad.Scroll += numLoad_Scroll;
            // 
            // numSoiling
            // 
            numSoiling.Location = new Point(15, 92);
            numSoiling.Name = "numSoiling";
            numSoiling.Size = new Size(340, 45);
            numSoiling.TabIndex = 19;
            numSoiling.Scroll += numSoiling_Scroll;
            // 
            // label1
            // 
            label1.AutoSize = true;
            label1.Font = new Font("Segoe UI", 12F, FontStyle.Regular, GraphicsUnit.Point);
            label1.Location = new Point(18, 20);
            label1.Name = "label1";
            label1.Size = new Size(75, 21);
            label1.TabIndex = 21;
            label1.Text = "Load (kg)";
            // 
            // label2
            // 
            label2.AutoSize = true;
            label2.Font = new Font("Segoe UI", 12F, FontStyle.Regular, GraphicsUnit.Point);
            label2.Location = new Point(18, 68);
            label2.Name = "label2";
            label2.Size = new Size(98, 21);
            label2.TabIndex = 22;
            label2.Text = "Soiling Level";
            // 
            // label3
            // 
            label3.AutoSize = true;
            label3.Font = new Font("Segoe UI", 12F, FontStyle.Regular, GraphicsUnit.Point);
            label3.Location = new Point(18, 116);
            label3.Name = "label3";
            label3.Size = new Size(111, 21);
            label3.TabIndex = 23;
            label3.Text = "Detergent (ml)";
            // 
            // cbAutoCalc
            // 
            cbAutoCalc.AutoSize = true;
            cbAutoCalc.CheckAlign = ContentAlignment.MiddleRight;
            cbAutoCalc.Location = new Point(18, 219);
            cbAutoCalc.Name = "cbAutoCalc";
            cbAutoCalc.Size = new Size(104, 19);
            cbAutoCalc.TabIndex = 24;
            cbAutoCalc.Text = "Auto Calculate";
            cbAutoCalc.UseVisualStyleBackColor = true;
            cbAutoCalc.CheckedChanged += cbAutoCalc_CheckedChanged;
            // 
            // groupBox1
            // 
            groupBox1.Controls.Add(label5);
            groupBox1.Controls.Add(label4);
            groupBox1.Controls.Add(numSoiling);
            groupBox1.Controls.Add(cbAutoCalc);
            groupBox1.Controls.Add(cmbMethod);
            groupBox1.Controls.Add(label3);
            groupBox1.Controls.Add(btnCalculate);
            groupBox1.Controls.Add(label2);
            groupBox1.Controls.Add(lblSoilingLevel);
            groupBox1.Controls.Add(label1);
            groupBox1.Controls.Add(lblLoad);
            groupBox1.Controls.Add(numDetergent);
            groupBox1.Controls.Add(numLoad);
            groupBox1.Controls.Add(lblDetAmount);
            groupBox1.Location = new Point(20, 156);
            groupBox1.Name = "groupBox1";
            groupBox1.Size = new Size(426, 261);
            groupBox1.TabIndex = 25;
            groupBox1.TabStop = false;
            groupBox1.Text = "Controls";
            // 
            // label5
            // 
            label5.AutoSize = true;
            label5.Font = new Font("Segoe UI", 12F, FontStyle.Regular, GraphicsUnit.Point);
            label5.Location = new Point(18, 116);
            label5.Name = "label5";
            label5.Size = new Size(111, 21);
            label5.TabIndex = 26;
            label5.Text = "Detergent (ml)";
            // 
            // label4
            // 
            label4.AutoSize = true;
            label4.Location = new Point(18, 193);
            label4.Name = "label4";
            label4.Size = new Size(49, 15);
            label4.TabIndex = 25;
            label4.Text = "Method";
            // 
            // groupBox2
            // 
            groupBox2.Controls.Add(lblResult);
            groupBox2.Location = new Point(21, 39);
            groupBox2.Name = "groupBox2";
            groupBox2.Size = new Size(425, 100);
            groupBox2.TabIndex = 26;
            groupBox2.TabStop = false;
            groupBox2.Text = "Calculated Wash Time";
            // 
            // groupBox3
            // 
            groupBox3.Controls.Add(groupBox7);
            groupBox3.Controls.Add(groupBox6);
            groupBox3.Controls.Add(groupBox4);
            groupBox3.Controls.Add(groupBox5);
            groupBox3.Controls.Add(picDetGraph);
            groupBox3.Controls.Add(picSoilingGraph);
            groupBox3.Controls.Add(picLoadGraph);
            groupBox3.Location = new Point(444, 12);
            groupBox3.Name = "groupBox3";
            groupBox3.Size = new Size(854, 490);
            groupBox3.TabIndex = 27;
            groupBox3.TabStop = false;
            groupBox3.Text = "Fuzzy Status";
            // 
            // groupBox7
            // 
            groupBox7.Controls.Add(picRulesGraph);
            groupBox7.Location = new Point(461, 22);
            groupBox7.Name = "groupBox7";
            groupBox7.Size = new Size(376, 446);
            groupBox7.TabIndex = 3;
            groupBox7.TabStop = false;
            groupBox7.Text = "Rule Firing Strengths";
            // 
            // picRulesGraph
            // 
            picRulesGraph.Location = new Point(6, 22);
            picRulesGraph.Name = "picRulesGraph";
            picRulesGraph.Size = new Size(364, 402);
            picRulesGraph.TabIndex = 4;
            picRulesGraph.TabStop = false;
            // 
            // groupBox6
            // 
            groupBox6.Controls.Add(lblInDetHigh);
            groupBox6.Controls.Add(lblInDetNorm);
            groupBox6.Controls.Add(lblInDetLow);
            groupBox6.Location = new Point(316, 319);
            groupBox6.Name = "groupBox6";
            groupBox6.Size = new Size(127, 149);
            groupBox6.TabIndex = 2;
            groupBox6.TabStop = false;
            groupBox6.Text = "Detergent";
            // 
            // lblInDetHigh
            // 
            lblInDetHigh.AutoSize = true;
            lblInDetHigh.ForeColor = Color.Olive;
            lblInDetHigh.Location = new Point(16, 81);
            lblInDetHigh.Name = "lblInDetHigh";
            lblInDetHigh.Size = new Size(81, 15);
            lblInDetHigh.TabIndex = 8;
            lblInDetHigh.Text = "Det High: 0.00";
            // 
            // lblInDetNorm
            // 
            lblInDetNorm.AutoSize = true;
            lblInDetNorm.ForeColor = Color.Green;
            lblInDetNorm.Location = new Point(16, 57);
            lblInDetNorm.Name = "lblInDetNorm";
            lblInDetNorm.Size = new Size(95, 15);
            lblInDetNorm.TabIndex = 7;
            lblInDetNorm.Text = "Det Normal: 0.00";
            // 
            // lblInDetLow
            // 
            lblInDetLow.AutoSize = true;
            lblInDetLow.ForeColor = Color.Blue;
            lblInDetLow.Location = new Point(16, 33);
            lblInDetLow.Name = "lblInDetLow";
            lblInDetLow.Size = new Size(77, 15);
            lblInDetLow.TabIndex = 6;
            lblInDetLow.Text = "Det Low: 0.00";
            // 
            // groupBox4
            // 
            groupBox4.Controls.Add(lblInSoilHeavy);
            groupBox4.Controls.Add(lblInSoilMed);
            groupBox4.Controls.Add(lblInSoilLight);
            groupBox4.Location = new Point(316, 172);
            groupBox4.Name = "groupBox4";
            groupBox4.Size = new Size(127, 149);
            groupBox4.TabIndex = 1;
            groupBox4.TabStop = false;
            groupBox4.Text = "Soiling";
            // 
            // lblInSoilHeavy
            // 
            lblInSoilHeavy.AutoSize = true;
            lblInSoilHeavy.ForeColor = Color.Olive;
            lblInSoilHeavy.Location = new Point(16, 95);
            lblInSoilHeavy.Name = "lblInSoilHeavy";
            lblInSoilHeavy.Size = new Size(89, 15);
            lblInSoilHeavy.TabIndex = 5;
            lblInSoilHeavy.Text = "Soil Heavy: 0.00";
            // 
            // lblInSoilMed
            // 
            lblInSoilMed.AutoSize = true;
            lblInSoilMed.ForeColor = Color.Green;
            lblInSoilMed.Location = new Point(16, 64);
            lblInSoilMed.Name = "lblInSoilMed";
            lblInSoilMed.Size = new Size(80, 15);
            lblInSoilMed.TabIndex = 4;
            lblInSoilMed.Text = "Soil Med: 0.00";
            // 
            // lblInSoilLight
            // 
            lblInSoilLight.AutoSize = true;
            lblInSoilLight.ForeColor = Color.Blue;
            lblInSoilLight.Location = new Point(16, 36);
            lblInSoilLight.Name = "lblInSoilLight";
            lblInSoilLight.Size = new Size(83, 15);
            lblInSoilLight.TabIndex = 3;
            lblInSoilLight.Text = "Soil Light: 0.00";
            // 
            // groupBox5
            // 
            groupBox5.Controls.Add(lblInLoadHigh);
            groupBox5.Controls.Add(lblInLoadMed);
            groupBox5.Controls.Add(lblInLoadLow);
            groupBox5.Location = new Point(316, 22);
            groupBox5.Name = "groupBox5";
            groupBox5.Size = new Size(127, 152);
            groupBox5.TabIndex = 0;
            groupBox5.TabStop = false;
            groupBox5.Text = "Load";
            // 
            // lblInLoadHigh
            // 
            lblInLoadHigh.AutoSize = true;
            lblInLoadHigh.ForeColor = Color.Olive;
            lblInLoadHigh.Location = new Point(16, 94);
            lblInLoadHigh.Name = "lblInLoadHigh";
            lblInLoadHigh.Size = new Size(89, 15);
            lblInLoadHigh.TabIndex = 2;
            lblInLoadHigh.Text = "Load High: 0.00";
            // 
            // lblInLoadMed
            // 
            lblInLoadMed.AutoSize = true;
            lblInLoadMed.ForeColor = Color.Green;
            lblInLoadMed.Location = new Point(16, 70);
            lblInLoadMed.Name = "lblInLoadMed";
            lblInLoadMed.Size = new Size(87, 15);
            lblInLoadMed.TabIndex = 1;
            lblInLoadMed.Text = "Load Med: 0.00";
            // 
            // lblInLoadLow
            // 
            lblInLoadLow.AutoSize = true;
            lblInLoadLow.ForeColor = Color.Blue;
            lblInLoadLow.Location = new Point(16, 44);
            lblInLoadLow.Name = "lblInLoadLow";
            lblInLoadLow.Size = new Size(85, 15);
            lblInLoadLow.TabIndex = 0;
            lblInLoadLow.Text = "Load Low: 0.00";
            // 
            // picDetGraph
            // 
            picDetGraph.Location = new Point(20, 327);
            picDetGraph.Name = "picDetGraph";
            picDetGraph.Size = new Size(290, 141);
            picDetGraph.TabIndex = 2;
            picDetGraph.TabStop = false;
            // 
            // picSoilingGraph
            // 
            picSoilingGraph.Location = new Point(20, 180);
            picSoilingGraph.Name = "picSoilingGraph";
            picSoilingGraph.Size = new Size(290, 141);
            picSoilingGraph.TabIndex = 1;
            picSoilingGraph.TabStop = false;
            // 
            // picLoadGraph
            // 
            picLoadGraph.Location = new Point(20, 33);
            picLoadGraph.Name = "picLoadGraph";
            picLoadGraph.Size = new Size(290, 141);
            picLoadGraph.TabIndex = 0;
            picLoadGraph.TabStop = false;
            //
            // btn36
            //
            btn36.Location = new System.Drawing.Point(51, 444);
            btn36.Name = "btn36";
            btn36.Size = new System.Drawing.Size(84, 27);
            btn36.TabIndex = 35;
            btn36.Text = "Button";
            //
            // lbl37
            //
            lbl37.Location = new System.Drawing.Point(82, 391);
            lbl37.Name = "lbl37";
            lbl37.Size = new System.Drawing.Size(80, 17);
            lbl37.TabIndex = 36;
            lbl37.Text = "Label";
            //
            // txt38
            //
            txt38.Location = new System.Drawing.Point(166, 438);
            txt38.Name = "txt38";
            txt38.Size = new System.Drawing.Size(160, 23);
            txt38.TabIndex = 37;
            txt38.Text = "";
            //
            // chk39
            //
            chk39.Location = new System.Drawing.Point(398, 659);
            chk39.Name = "chk39";
            chk39.Size = new System.Drawing.Size(110, 19);
            chk39.TabIndex = 38;
            chk39.Text = "CheckBox";
            //
            // rad40
            //
            rad40.Location = new System.Drawing.Point(831, 526);
            rad40.Name = "rad40";
            rad40.Size = new System.Drawing.Size(110, 19);
            rad40.TabIndex = 39;
            rad40.Text = "RadioButton";
            //
            // cbo41
            //
            cbo41.Location = new System.Drawing.Point(525, 475);
            cbo41.Name = "cbo41";
            cbo41.Size = new System.Drawing.Size(140, 23);
            cbo41.TabIndex = 40;
            cbo41.Text = "";
            //
            // lst42
            //
            lst42.Location = new System.Drawing.Point(202, 537);
            lst42.Name = "lst42";
            lst42.Size = new System.Drawing.Size(140, 80);
            lst42.TabIndex = 41;
            lst42.Text = "";
            //
            // pic43
            //
            pic43.Location = new System.Drawing.Point(29, 505);
            pic43.Name = "pic43";
            pic43.Size = new System.Drawing.Size(100, 100);
            pic43.TabIndex = 42;
            pic43.Text = "";
            //
            // pnl44
            //
            pnl44.Location = new System.Drawing.Point(154, 399);
            pnl44.Name = "pnl44";
            pnl44.Size = new System.Drawing.Size(200, 120);
            pnl44.TabIndex = 43;
            pnl44.Text = "";
            //
            // grp45
            //
            grp45.Location = new System.Drawing.Point(684, 549);
            grp45.Name = "grp45";
            grp45.Size = new System.Drawing.Size(220, 160);
            grp45.TabIndex = 44;
            grp45.Text = "GroupBox";
            //
            // trk46
            //
            trk46.Location = new System.Drawing.Point(516, 567);
            trk46.Name = "trk46";
            trk46.Size = new System.Drawing.Size(120, 45);
            trk46.TabIndex = 45;
            trk46.Text = "";
            //
            // prg47
            //
            prg47.Location = new System.Drawing.Point(233, 508);
            prg47.Name = "prg47";
            prg47.Size = new System.Drawing.Size(140, 20);
            prg47.TabIndex = 46;
            prg47.Text = "";
            //
            // dtp48
            //
            dtp48.Location = new System.Drawing.Point(369, 559);
            dtp48.Name = "dtp48";
            dtp48.Size = new System.Drawing.Size(120, 23);
            dtp48.TabIndex = 47;
            dtp48.Text = "";
            //

            //

            //

            //

            //

            //

            //

            //

            //

            //

            //

            //

            //






            //






            //

            // 
            // Form1
            // 
            AutoScaleDimensions = new SizeF(7F, 15F);
            AutoScaleMode = AutoScaleMode.Font;
            ClientSize = new Size(1408, 696);
            Controls.Add(groupBox3);
            Controls.Add(groupBox2);
            Controls.Add(groupBox1);
            Controls.Add(btn36);
            Controls.Add(lbl37);
            Controls.Add(txt38);
            Controls.Add(chk39);
            Controls.Add(rad40);
            Controls.Add(cbo41);
            Controls.Add(lst42);
            Controls.Add(pic43);
            Controls.Add(pnl44);
            Controls.Add(grp45);
            Controls.Add(trk46);
            Controls.Add(prg47);
            Controls.Add(dtp48);















            Name = "Form1";
            Text = "Washing Machine Timer Fuzzy Logic  - Team WayVS";
            ((System.ComponentModel.ISupportInitialize)numDetergent).EndInit();
            ((System.ComponentModel.ISupportInitialize)numLoad).EndInit();
            ((System.ComponentModel.ISupportInitialize)numSoiling).EndInit();
            groupBox1.ResumeLayout(false);
            groupBox1.PerformLayout();
            groupBox2.ResumeLayout(false);
            groupBox2.PerformLayout();
            groupBox3.ResumeLayout(false);
            groupBox7.ResumeLayout(false);
            ((System.ComponentModel.ISupportInitialize)picRulesGraph).EndInit();
            groupBox6.ResumeLayout(false);
            groupBox6.PerformLayout();
            groupBox4.ResumeLayout(false);
            groupBox4.PerformLayout();
            groupBox5.ResumeLayout(false);
            groupBox5.PerformLayout();
            ((System.ComponentModel.ISupportInitialize)picDetGraph).EndInit();
            ((System.ComponentModel.ISupportInitialize)picSoilingGraph).EndInit();
            ((System.ComponentModel.ISupportInitialize)picLoadGraph).EndInit();
            ResumeLayout(false);
        }

        #endregion

        private ComboBox cmbMethod;
        private Button btnCalculate;
        private Label lblResult;
        private Label lblSoilingLevel;
        private Label lblLoad;
        private TrackBar numLoad;
        private TrackBar numSoiling;
        private TrackBar numDetergent;
        private Label lblDetAmount;
        private Label label1;
        private Label label2;
        private Label label3;
        private CheckBox cbAutoCalc;
        private GroupBox groupBox1;
        private GroupBox groupBox2;
        private Label label4;
        private Label label5;
        private GroupBox groupBox3;
        private PictureBox picDetGraph;
        private PictureBox picSoilingGraph;
        private PictureBox picLoadGraph;
        private GroupBox groupBox6;
        private GroupBox groupBox4;
        private GroupBox groupBox5;
        private Label label12;
        private Label label13;
        private Label label14;
        private Label label9;
        private Label label10;
        private Label label11;

        private Label lblInLoadLow;
        private Label lblInLoadMed;
        private Label lblInLoadHigh;

        private Label lblInSoilLight;
        private Label lblInSoilMed;
        private Label lblInSoilHeavy;

        private Label lblInDetLow;
        private Label lblInDetNorm;
        private Label lblInDetHigh;
        private GroupBox groupBox7;
        private PictureBox picRulesGraph;
        private System.Windows.Forms.Button btn36;
        private System.Windows.Forms.Label lbl37;
        private System.Windows.Forms.TextBox txt38;
        private System.Windows.Forms.CheckBox chk39;
        private System.Windows.Forms.RadioButton rad40;
        private System.Windows.Forms.ComboBox cbo41;
        private System.Windows.Forms.ListBox lst42;
        private System.Windows.Forms.PictureBox pic43;
        private System.Windows.Forms.Panel pnl44;
        private System.Windows.Forms.GroupBox grp45;
        private System.Windows.Forms.TrackBar trk46;
        private System.Windows.Forms.ProgressBar prg47;
        private System.Windows.Forms.DateTimePicker dtp48;
    }
}