using System.Collections.Concurrent;

namespace Washing_Machine_Timer_Fuzzy_Logic;

public partial class Form1 : Form
{
    private double[] ruleStrengths = new double[15]; // r1..r15
    private string[] ruleNames = new string[]
    {
        "Low/Light/LowDet",    // r1
        "Low/Med/NormalDet",   // r2
        "Low/Heavy/HighDet",   // r3
        "Med/Light/LowDet",    // r4
        "Med/Med/NormalDet",   // r5
        "Med/Heavy/HighDet",   // r6
        "High/Light/LowDet",   // r7
        "High/Med/NormalDet",  // r8
        "High/Heavy/HighDet",  // r9
        "Low/Heavy/NormalDet", // r10
        "Low/Heavy/LowDet",    // r11
        "Med/Heavy/NormalDet", // r12
        "Med/Heavy/LowDet",    // r13
        "High/Heavy/NormalDet",// r14
        "High/Heavy/LowDet"    // r15
    };

    public Form1()
    {
        InitializeComponent();
        cmbMethod.Items.Add("Sugeno Method");
        cmbMethod.Items.Add("Mamdani Method");
        cmbMethod.SelectedIndex = 0;

        picLoadGraph.Paint += picLoadGraph_Paint;
        picSoilingGraph.Paint += picSoilingGraph_Paint;
        picDetGraph.Paint += picDetGraph_Paint;
        picRulesGraph.Paint += picRulesGraph_Paint;

        picLoadGraph.BackColor = Color.White;
        picSoilingGraph.BackColor = Color.White;
        picDetGraph.BackColor = Color.White;
        picRulesGraph.BackColor = Color.White;
    }

    private void btnCalculate_Click(object sender, EventArgs e)
    {
        double load = (double)numLoad.Value;
        double soiling = (double)numSoiling.Value;
        double detergent = (double)numDetergent.Value;

        double time = 0.0;

        if (cmbMethod.SelectedItem.ToString() == "Sugeno Method")
        {
            time = CalculateSugeno(load, soiling, detergent);
        }
        else
        {
            time = CalculateMamdani(load, soiling, detergent);
        }

        lblResult.Text = $"{time:F2} Minutes";

    }

    private void cbAutoCalc_CheckedChanged(object sender, EventArgs e)
    {
        btnCalculate.Enabled = !cbAutoCalc.Checked;
    }

    private double CalculateSugeno(double load, double soiling, double detergent)
    {
       // 1.Fuzzification(Adjusted to maintain strong partition unity across ranges)
        double loadLow = TriangularMembership(load, 0, 0, 9);
        double loadMed = TriangularMembership(load, 0, 9, 18);
        double loadHigh = TriangularMembership(load, 9, 18, 18);

        double soilLight = TriangularMembership(soiling, 0, 0, 5);
        double soilMed = TriangularMembership(soiling, 0, 5, 10);
        double soilHeavy = TriangularMembership(soiling, 5, 10, 10);

        double detLow = TriangularMembership(detergent, 0, 0, 150);
        double detNormal = TriangularMembership(detergent, 0, 150, 300);
        double detHigh = TriangularMembership(detergent, 150, 300, 300);

        // 2. Rule Evaluation (9 core rules)
        double r1 = Math.Min(loadLow, Math.Min(soilLight, detLow)); double cr1 = 10.0;
        double r2 = Math.Min(loadLow, Math.Min(soilMed, detNormal)); double cr2 = 20.0;
        double r3 = Math.Min(loadLow, Math.Min(soilHeavy, detHigh)); double cr3 = 35.0;

        double r4 = Math.Min(loadMed, Math.Min(soilLight, detLow)); double cr4 = 25.0;
        double r5 = Math.Min(loadMed, Math.Min(soilMed, detNormal)); double cr5 = 35.0;
        double r6 = Math.Min(loadMed, Math.Min(soilHeavy, detHigh)); double cr6 = 50.0;

        double r7 = Math.Min(loadHigh, Math.Min(soilLight, detLow)); double cr7 = 40.0;
        double r8 = Math.Min(loadHigh, Math.Min(soilMed, detNormal)); double cr8 = 50.0;
        double r9 = Math.Min(loadHigh, Math.Min(soilHeavy, detHigh)); double cr9 = 60.0;

        // Additional rules to cover Heavy soil with Normal/Low detergent for each load
        double r10 = Math.Min(loadLow, Math.Min(soilHeavy, detNormal)); double cr10 = 40.0;
        double r11 = Math.Min(loadLow, Math.Min(soilHeavy, detLow)); double cr11 = 45.0;

        double r12 = Math.Min(loadMed, Math.Min(soilHeavy, detNormal)); double cr12 = 55.0;
        double r13 = Math.Min(loadMed, Math.Min(soilHeavy, detLow)); double cr13 = 60.0;

        double r14 = Math.Min(loadHigh, Math.Min(soilHeavy, detNormal)); double cr14 = 65.0;
        double r15 = Math.Min(loadHigh, Math.Min(soilHeavy, detLow)); double cr15 = 70.0;

        // Detergent high should slightly reduce required time (helps cleaning) —
        // apply a gentle reduction to consequents of rules that include detHigh.
        double detReductionFactor = 0.12; // 12% max reduction when detHigh==1.0
        cr3 *= 1.0 - detReductionFactor * detHigh;
        cr6 *= 1.0 - detReductionFactor * detHigh;
        cr9 *= 1.0 - detReductionFactor * detHigh;

        // Strategy 1: Default Safety Rule (used only as a last-resort guard)
        // Use a very small epsilon so it doesn't dominate normal rule firing.
        double rDefault = 1e-6;
        double crDefault = 30.0;

        // 3. Aggregation & Sugeno Defuzzification
        double num = (r1 * cr1) + (r2 * cr2) + (r3 * cr3) +
                     (r4 * cr4) + (r5 * cr5) + (r6 * cr6) +
                     (r7 * cr7) + (r8 * cr8) + (r9 * cr9) +
                     (r10 * cr10) + (r11 * cr11) + (r12 * cr12) +
                     (r13 * cr13) + (r14 * cr14) + (r15 * cr15);

        double den = r1 + r2 + r3 + r4 + r5 + r6 + r7 + r8 + r9 + r10 + r11 + r12 + r13 + r14 + r15;

        // Store current strengths (keeping array bounds safe)
        ruleStrengths[0] = r1;
        ruleStrengths[1] = r2;
        ruleStrengths[2] = r3;
        ruleStrengths[3] = r4;
        ruleStrengths[4] = r5;
        ruleStrengths[5] = r6;
        ruleStrengths[6] = r7;
        ruleStrengths[7] = r8;
        ruleStrengths[8] = r9;
        ruleStrengths[9] = r10;
        ruleStrengths[10] = r11;
        ruleStrengths[11] = r12;
        ruleStrengths[12] = r13;
        ruleStrengths[13] = r14;
        ruleStrengths[14] = r15;

        // Repaint bar chart
        picRulesGraph.Invalidate();

        UpdateFuzzyStatusDisplay(new double[] { loadLow, loadMed, loadHigh, soilLight, soilMed, soilHeavy, detLow, detNormal, detHigh }, ruleStrengths);

        // If nothing fired (den == 0) use the safe default output; otherwise return weighted average
        return den > 0 ? num / den : crDefault;
    }

    private double CalculateMamdani(double load, double soiling, double detergent)
    {
        // 1. Fuzzification (Aligned partition unity)
        double loadLow = TriangularMembership(load, 0, 0, 9);
        double loadMed = TriangularMembership(load, 0, 9, 18);
        double loadHigh = TriangularMembership(load, 9, 18, 18);

        double soilLight = TriangularMembership(soiling, 0, 0, 5);
        double soilMed = TriangularMembership(soiling, 0, 5, 10);
        double soilHeavy = TriangularMembership(soiling, 5, 10, 10);

        double detLow = TriangularMembership(detergent, 0, 0, 150);
        double detNormal = TriangularMembership(detergent, 0, 150, 300);
        double detHigh = TriangularMembership(detergent, 150, 300, 300);

        // 2. Rule Evaluation (9 core rules)
        double r1 = Math.Min(loadLow, Math.Min(soilLight, detLow));
        double r2 = Math.Min(loadLow, Math.Min(soilMed, detNormal));
        double r3 = Math.Min(loadLow, Math.Min(soilHeavy, detHigh));

        double r4 = Math.Min(loadMed, Math.Min(soilLight, detLow));
        double r5 = Math.Min(loadMed, Math.Min(soilMed, detNormal));
        double r6 = Math.Min(loadMed, Math.Min(soilHeavy, detHigh));

        double r7 = Math.Min(loadHigh, Math.Min(soilLight, detLow));
        double r8 = Math.Min(loadHigh, Math.Min(soilMed, detNormal));
        double r9 = Math.Min(loadHigh, Math.Min(soilHeavy, detHigh));

        // Additional Mamdani rules covering Heavy soil with Normal/Low detergent
        double r10 = Math.Min(loadLow, Math.Min(soilHeavy, detNormal));
        double r11 = Math.Min(loadLow, Math.Min(soilHeavy, detLow));

        double r12 = Math.Min(loadMed, Math.Min(soilHeavy, detNormal));
        double r13 = Math.Min(loadMed, Math.Min(soilHeavy, detLow));

        double r14 = Math.Min(loadHigh, Math.Min(soilHeavy, detNormal));
        double r15 = Math.Min(loadHigh, Math.Min(soilHeavy, detLow));

        // Strategy 1: Default Safety Rule Weight (tiny epsilon to avoid dominating aggregation)
        double rDefault = 1e-6;

        double sumNum = 0.0;
        double sumDen = 0.0;
        double step = 1.0;

        for (double t = 0.0; t <= 60.0; t += step)
        {
            double outShort = TriangularMembership(t, 0, 0, 25.0);
            double outMed = TriangularMembership(t, 20.0, 35.0, 50.0);
            double outLong = TriangularMembership(t, 35.0, 50.0, 65.0);
            double outExtra = TriangularMembership(t, 50.0, 60.0, 60.0);

            double clip1 = Math.Min(r1, outShort);
            double clip2 = Math.Min(r2, outShort);
            double clip3 = Math.Min(r3, outMed);
            double clip4 = Math.Min(r4, outMed);
            double clip5 = Math.Min(r5, outMed);
            double clip6 = Math.Min(r6, outLong);
            double clip7 = Math.Min(r7, outLong);
            double clip8 = Math.Min(r8, outExtra);
            double clip9 = Math.Min(r9, outExtra);

            // Clips for the additional heavy-soil rules
            double clip10 = Math.Min(r10, outLong);   // Low load + Heavy + NormalDet -> slightly longer
            double clip11 = Math.Min(r11, outExtra);  // Low load + Heavy + LowDet -> longest

            double clip12 = Math.Min(r12, outExtra);  // Med + Heavy + NormalDet
            double clip13 = Math.Min(r13, outExtra);  // Med + Heavy + LowDet

            double clip14 = Math.Min(r14, outExtra);  // High + Heavy + NormalDet
            double clip15 = Math.Min(r15, outExtra);  // High + Heavy + LowDet

            // If detergent membership is high, slightly reduce the contribution
            // of rules that include detHigh so overall defuzzified time becomes shorter.
            double detReductionFactor = 0.12; // keep consistent with Sugeno
            clip3 *= 1.0 - detReductionFactor * detHigh;
            clip6 *= 1.0 - detReductionFactor * detHigh;
            clip9 *= 1.0 - detReductionFactor * detHigh;

            // Default rule output clips to a steady medium-average baseline time (e.g., outMed)
            double clipDefault = Math.Min(rDefault, outMed);

            double aggregated = Math.Max(clip1, Math.Max(clip2,
                                Math.Max(clip3, Math.Max(clip4,
                                Math.Max(clip5, Math.Max(clip6,
                                Math.Max(clip7, Math.Max(clip8,
                                Math.Max(clip9, clipDefault)))))))));

            sumNum += t * aggregated * step;
            sumDen += aggregated * step;
        }

        // Store current strengths
        ruleStrengths[0] = r1;
        ruleStrengths[1] = r2;
        ruleStrengths[2] = r3;
        ruleStrengths[3] = r4;
        ruleStrengths[4] = r5;
        ruleStrengths[5] = r6;
        ruleStrengths[6] = r7;
        ruleStrengths[7] = r8;
        ruleStrengths[8] = r9;
        ruleStrengths[9] = r10;
        ruleStrengths[10] = r11;
        ruleStrengths[11] = r12;
        ruleStrengths[12] = r13;
        ruleStrengths[13] = r14;
        ruleStrengths[14] = r15;

        // Repaint bar chart
        picRulesGraph.Invalidate();
        UpdateFuzzyStatusDisplay(new double[] { loadLow, loadMed, loadHigh, soilLight, soilMed, soilHeavy, detLow, detNormal, detHigh }, ruleStrengths);

        // Guaranteed safe denominator protection
        return sumDen > 0 ? sumNum / sumDen : 30.0;
    }


    private double TriangularMembership(double x, double a, double b, double c)
    {

        // Handle degenerate cases where the peak equals a or c to avoid division by zero
        if (b == a)
        {
            // Left-shoulder: full membership at and below b, then decreases towards c
            if (x <= b) return 1.0;
            if (x >= c) return 0.0;
            return (c - x) / (c - b);
        }

        if (b == c)
        {
            // Right-shoulder: increases from a up to b and stays 1 at and above b
            if (x >= b) return 1.0;
            if (x <= a) return 0.0;
            return (x - a) / (b - a);
        }

        if (x <= a || x >= c) return 0.0;
        if (x == b) return 1.0;
        if (x > a && x < b) return (x - a) / (b - a);
        return (c - x) / (c - b);
    }

    //private double TrapezoidalMembership(double x, double a, double b, double c, double d)
    //{

    //    // Guard against invalid ranges
    //    if (d <= a) return 0.0;

    //    if (x < a || x > d) return 0.0;

    //    // Flat top
    //    if (b <= x && x <= c) return 1.0;

    //    // Rising edge (handle b==a)
    //    if (x >= a && x < b)
    //    {
    //        if (b == a) return 1.0;
    //        return (x - a) / (b - a);
    //    }

    //    // Falling edge (handle c==d)
    //    if (x > c && x <= d)
    //    {
    //        if (d == c) return 1.0;
    //        return (d - x) / (d - c);
    //    }

    //    return 0.0;
    //}

    

    private void numLoad_Scroll(object sender, EventArgs e)
    {
        lblLoad.Text = $"{numLoad.Value} kg";
        picLoadGraph.Invalidate(); // Triggers repainting of the load graph

        if (cbAutoCalc.Checked)
        {
            btnCalculate_Click(sender, e);
        }
    }

    private void numSoiling_Scroll(object sender, EventArgs e)
    {
        lblSoilingLevel.Text = $"{numSoiling.Value} / 10";
        picSoilingGraph.Invalidate();

        if (cbAutoCalc.Checked)
        {
            btnCalculate_Click(sender, e);
        }
    }

    private void numDetergent_Scroll(object sender, EventArgs e)
    {
        lblDetAmount.Text = $"{numDetergent.Value} ml";
        picDetGraph.Invalidate();

        if (cbAutoCalc.Checked)
        {
            btnCalculate_Click(sender, e);
        }
    }

    private void picLoadGraph_Paint(object sender, PaintEventArgs e)
    {
        PictureBox box = sender as PictureBox;
        var loadShapes = new List<PointF[]>
        {
            new PointF[] { new PointF(0, 1), new PointF(9, 0) },
            new PointF[] { new PointF(0, 0), new PointF(9, 1), new PointF(18, 0) },
            new PointF[] { new PointF(9, 0), new PointF(18, 1), new PointF(18, 1) }
        };
        string[] labels = { "Low", "Med", "High" };

        DrawMembershipGraph(box, e.Graphics, numLoad.Value, 18, "Load Membership (kg)",
            new Color[] { Color.Blue, Color.Green, Color.Goldenrod }, loadShapes, labels);
    }

    private void picSoilingGraph_Paint(object sender, PaintEventArgs e)
    {
        PictureBox box = sender as PictureBox;
        var soilShapes = new List<PointF[]>
        {
            new PointF[] { new PointF(0, 1), new PointF(5, 0) },
            new PointF[] { new PointF(0, 0), new PointF(5, 1), new PointF(10, 0) },
            new PointF[] { new PointF(5, 0), new PointF(10, 1), new PointF(10, 1) }
        };
        string[] labels = { "Light", "Med", "Heavy" };

        DrawMembershipGraph(box, e.Graphics, numSoiling.Value, 10, "Soiling Level Membership",
            new Color[] { Color.Blue, Color.Green, Color.Goldenrod }, soilShapes, labels);
    }

    private void picDetGraph_Paint(object sender, PaintEventArgs e)
    {

        PictureBox box = sender as PictureBox;
        var detShapes = new List<PointF[]>
        {
            new PointF[] { new PointF(0, 1), new PointF(150, 0) },
            new PointF[] { new PointF(0, 0), new PointF(150, 1), new PointF(300, 0) },
            new PointF[] { new PointF(150, 0), new PointF(300, 1), new PointF(300, 1) }
        };
        string[] labels = { "Low", "Normal", "High" };

        DrawMembershipGraph(box, e.Graphics, numDetergent.Value, 300, "Detergent Membership (ml)",
            new Color[] { Color.Blue, Color.Green, Color.Goldenrod }, detShapes, labels);
    }

    private void DrawMembershipGraph(PictureBox box, Graphics g, double currentValue, double maxX, string title, Color[] colors, List<PointF[]> shapes, string[] labels)
    {
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        g.Clear(Color.White);

        int width = box.Width;
        int height = box.Height;

        // Optimized padding to maximize graph drawing space
        int leftPadding = 28;
        int rightPadding = 28;
        int topPadding = 25;
        int bottomPadding = 18;

        int graphWidth = width - leftPadding - rightPadding;
        int graphHeight = height - topPadding - bottomPadding;

        // Draw Title
        g.DrawString(title, new Font("Segoe UI", 9, FontStyle.Bold), Brushes.Black, leftPadding, 2);

        // Axes lines
        int originY = height - bottomPadding;
        g.DrawLine(Pens.Black, leftPadding, originY, leftPadding + graphWidth, originY); // X-axis
        g.DrawLine(Pens.Black, leftPadding, topPadding, leftPadding, originY); // Y-axis

        // Draw Y-Axis Labels
        g.DrawString("1", new Font("Segoe UI", 7), Brushes.Black, leftPadding - 18, topPadding - 2);
        g.DrawString("0", new Font("Segoe UI", 7), Brushes.Black, leftPadding - 15, originY - 8);

        // X-Axis Max Label
        g.DrawString(maxX.ToString(), new Font("Segoe UI", 7), Brushes.Black, leftPadding + graphWidth - 10, originY + 2);

        // Mapping helper functions
        Func<double, double, float> mapX = (val, max) => (float)(leftPadding + (val / max) * graphWidth);
        Func<double, float> mapY = (val) => (float)(originY - (val * graphHeight));

        // Draw Membership Curves (Triangles/Trapezoids)
        for (int i = 0; i < shapes.Count; i++)
        {
            PointF[] dataPoints = shapes[i];
            PointF[] screenPoints = new PointF[dataPoints.Length];

            for (int j = 0; j < dataPoints.Length; j++)
            {
                screenPoints[j] = new PointF(mapX(dataPoints[j].X, maxX), mapY(dataPoints[j].Y));
            }

            using (Pen pen = new Pen(colors[i % colors.Length], 2))
            {
                g.DrawLines(pen, screenPoints);
            }
        }

        // Draw Current Value Vertical Line (Red Line)
        float currentX = mapX(Math.Min(currentValue, maxX), (float)maxX);
        g.DrawLine(new Pen(Color.Red, 2), currentX, topPadding, currentX, originY);
    }

    private void DrawRuleFiringGraph(PictureBox box, Graphics g, double[] strengths, string[] names)
    {
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        g.Clear(Color.White);

        int width = box.Width;
        int height = box.Height;

        int leftPadding = 38;
        int rightPadding = 20;
        int topPadding = 25;
        int bottomPadding = 45; // Room for rotated or angled labels

        int graphWidth = width - leftPadding - rightPadding;
        int graphHeight = height - topPadding - bottomPadding;
        int originY = height - bottomPadding;

        // Title
        g.DrawString("Rule Firing Strengths", new Font("Segoe UI", 8, FontStyle.Bold), Brushes.Black, leftPadding - 10, 5);

        // Y-Axis grid lines & labels (0.0 to 1.0)
        Font labelFont = new Font("Segoe UI", 7);
        for (double v = 0.0; v <= 1.0; v += 0.2)
        {
            float y = (float)(originY - (v * graphHeight));
            // Light grid line
            using (Pen gridPen = new Pen(Color.LightGray, 1))
            {
                g.DrawLine(gridPen, leftPadding, y, leftPadding + graphWidth, y);
            }
            g.DrawString(v.ToString("0.0"), labelFont, Brushes.Black, leftPadding - 28, y - 6);
        }

        // Main Axes
        g.DrawLine(Pens.Black, leftPadding, originY, leftPadding + graphWidth, originY); // X-axis
        g.DrawLine(Pens.Black, leftPadding, topPadding, leftPadding, originY);            // Y-axis

        // Draw Bars
        int barCount = strengths.Length;
        float slotWidth = (float)graphWidth / barCount;
        float barWidth = slotWidth * 0.55f;

        for (int i = 0; i < barCount; i++)
        {
            double val = Math.Clamp(strengths[i], 0.0, 1.0);
            float barH = (float)(val * graphHeight);
            float x = leftPadding + (i * slotWidth) + (slotWidth - barWidth) / 2;
            float y = originY - barH;

            // Fill bar (black or dark navy like the reference)
            using (Brush barBrush = new SolidBrush(Color.Black))
            {
                g.FillRectangle(barBrush, x, y, barWidth, barH);
            }

            // Rule name below the bar
            string label = $"R{i + 1}\n({names[i]})";
            StringFormat sf = new StringFormat
            {
                Alignment = StringAlignment.Center,
                LineAlignment = StringAlignment.Near
            };
            g.DrawString(label, labelFont, Brushes.Black, new RectangleF(leftPadding + (i * slotWidth), originY + 4, slotWidth, bottomPadding - 4), sf);
        }
    }

    private void picRulesGraph_Paint(object sender, PaintEventArgs e)
    {
        DrawRuleFiringGraph(picRulesGraph, e.Graphics, ruleStrengths, ruleNames);
    }

    private void UpdateFuzzyStatusDisplay(double[] inputMemberships, double[] ruleValues)
    {
        // Input Memberships - expect array ordering: loadLow, loadMed, loadHigh, soilLight, soilMed, soilHeavy, detLow, detNormal, detHigh
        if (inputMemberships != null && inputMemberships.Length >= 9)
        {
            lblInLoadLow.Text = $"Load Low: {inputMemberships[0]:F2}";
            lblInLoadMed.Text = $"Load Med: {inputMemberships[1]:F2}";
            lblInLoadHigh.Text = $"Load High: {inputMemberships[2]:F2}";

            lblInSoilLight.Text = $"Soil Light: {inputMemberships[3]:F2}";
            lblInSoilMed.Text = $"Soil Med: {inputMemberships[4]:F2}";
            lblInSoilHeavy.Text = $"Soil Heavy: {inputMemberships[5]:F2}";

            lblInDetLow.Text = $"Det Low: {inputMemberships[6]:F2}";
            lblInDetNorm.Text = $"Det Normal: {inputMemberships[7]:F2}";
            lblInDetHigh.Text = $"Det High: {inputMemberships[8]:F2}";
        }

    }
}
