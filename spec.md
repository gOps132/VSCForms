# NOTE: this is the ORIGINAL BRIEF, kept for reference. It is SUPERSEDED.

Several of its proposals were measured and rejected. Where they disagree, these win:

| This brief says | Actually | Why |
|---|---|---|
| .NET 8/9, `Microsoft.CodeAnalysis.CSharp` | .NET 10, Roslyn **5.9.0** | 5.x is the current line; 4.14.0 is the last 4.x |
| `parse` / `update` as one-shot CLI calls | Long-lived process, newline-delimited JSON on stdio | Per-gesture process spawn is untenable |
| "rewrites `InitializeComponent()`" | **Surgical `TextChange` patches only** | Rewriting destroys code the schema cannot model (ADR 0001) |
| Implicit promise of full form modelling | 10 types; **47.9%** per-form coverage ceiling | Measured over 154 real Designer files |
| `Dock`/`Anchor` supported | Forms using them are **refused** | 40.9% of forms; cannot be simulated honestly (ADR 0003) |
| Silent about `.resx` | `ApplyResources` forms are **refused** | 41.6% of forms; the `.Designer.cs` is not the form |
| One universal self-contained binary | Platform-targeted `.vsix` per platform | 176 MB universal vs 35 MB targeted (ADR 0002) |
| Generates event handlers into `Form1.cs` | No event scaffolding in v1 | Requires editing a hand-written file |
| Data contract inline in prose | [`SCHEMA.md`](SCHEMA.md) | Three components share it; it must be authoritative |

Read [`README.md`](README.md) for what it does, [`SCHEMA.md`](SCHEMA.md) for the contract,
[`CONTEXT.md`](CONTEXT.md) for the vocabulary, [`docs/adr/`](docs/adr/) for the decisions.

---

Architecture & Implementation Specification: vscode-winforms-designer
1. Executive Summary & Goals
Target: A VS Code extension running natively on macOS, Linux, and Windows to visually design WinForms applications.
Core Principle: Out-of-process architecture. Zero reliance on Wine or Windows-native UI hooks.
Primary Function: Parse *.Designer.cs into an intermediate JSON schema, render and edit it inside a VS Code CustomTextEditor Webview, and synchronize edits back into syntactically valid C# Roslyn AST.
2. System Architecture
┌────────────────────────────────────────────────────────┐
│                   VS Code Process                      │
│                                                        │
│  ┌──────────────────────┐    postMessage (JSON)       │
│  │ Webview Canvas (UI)  │ ◄────────────────────────┐   │
│  │ (HTML5/Canvas/CSS)   │                          │   │
│  └──────────────────────┘                          ▼   │
│                                           ┌──────────┐ │
│                                           │Extension │ │
│                                           │Host (TS) │ │
│                                           └────┬─────┘ │
└────────────────────────────────────────────────┼───────┘
                                                 │ stdio (JSON-RPC)
┌────────────────────────────────────────────────┼───────┐
│ Background Language Engine (.NET Console)      ▼       │
│                                           ┌──────────┐ │
│  Roslyn AST Engine (Microsoft.CodeAnalysis)            │
│  • C# Parser (InitializeComponent -> JSON) │ Worker   │ │
│  • C# Rewriter (JSON -> AST -> Form.Designer.cs)       │
└────────────────────────────────────────────────────────┘

3. Data Contract: Form Schema JSON
The backend Roslyn tool and the frontend Webview communicate via standard JSON payloads:
{
  "form": {
    "name": "Form1",
    "text": "My Application",
    "clientSize": { "width": 800, "height": 450 }
  },
  "controls": [
    {
      "id": "btnSubmit",
      "type": "System.Windows.Forms.Button",
      "properties": {
        "Text": "Click Me",
        "Location": { "x": 100, "y": 120 },
        "Size": { "width": 120, "height": 36 },
        "TabIndex": 0,
        "UseVisualStyleBackColor": true
      },
      "events": {
        "Click": "btnSubmit_Click"
      }
    }
  ]
}

4. Component 1: Roslyn CLI Parser/Codegen Engine (.NET 8/9 Console App)
Create a cross-platform console tool named WinFormsRoslynBridge:
Dependencies: Microsoft.CodeAnalysis.CSharp, System.Text.Json.
Execution: Spawned over standard input/output by the extension.
Command Handlers:
parse --file <path>:
Reads target Form1.Designer.cs.
Locates void InitializeComponent().
Identifies new ControlType() instantiations.
Walks member assignment expressions:
this.btn.Location = new System.Drawing.Point(x, y);
this.btn.Size = new System.Drawing.Size(w, h);
this.btn.Text = "value";
Extracts hierarchy: this.Controls.Add(this.btn);
Outputs JSON Form Schema to stdout.
update --file <path> (Accepts updated Form Schema via stdin):
Loads existing Form1.Designer.cs syntax tree.
Uses CSharpSyntaxRewriter to update or append:
Control field declarations (private System.Windows.Forms.Button btnSubmit;).
Control initializations and assignments in InitializeComponent().
Control addition (this.Controls.Add(...)).
Preserves standard designer comments (#region Windows Form Designer generated code).
Writes formatted code back to disk with proper indentation.
5. Component 2: VS Code Extension Host (TypeScript)
Registration: Registers a vscode.window.registerCustomEditorProvider targeting *.Designer.cs.
Lifecycle:
User opens Form1.Designer.cs.
Spawns WinFormsRoslynBridge background worker if not already running.
Sends parse command; waits for JSON payload.
Injects JSON payload into Webview via webview.postMessage({ type: 'load', data }).
Listens for webview.onDidReceiveMessage:
Handles edit events by sending update command to the Roslyn engine.
Hooks into VS Code's CustomDocument change tracker to manage dirty flags and Ctrl+Z / Cmd+Z undo/redo.
6. Component 3: Webview Design Canvas (Frontend)
Toolbox Panel:
Displays draggable standard WinForms controls: Button, TextBox, Label, CheckBox, Panel, PictureBox.
Visual Canvas:
Standard WinForms style (Classic/Modern Windows 10 theme).
Absolute positioning coordinates matching WinForms layout system (Location.X, Location.Y).
Bounding boxes with 8 resize handles for selection and resizing.
Drag-and-drop snapping and positioning guides.
Property Grid:
Edits selected control properties (Text, Name, Width, Height, X, Y, BackColor).
Double-clicking a control generates an event hook message (e.g., Click) to scaffold the event handler in Form1.cs.
7. Step-by-Step Implementation Prompt (Copy-Paste Ready)
You are an expert systems engineer and VS Code extension architect. Build a working prototype of a cross-platform Windows Forms designer for VS Code that runs cleanly on macOS, Linux, and Windows without Wine.

Implement the following three modules:

1. Roslyn CLI Engine (C# Console Project - net8.0):
   - Use Microsoft.CodeAnalysis.CSharp.
   - Implement an entry point accepting commands:
     - `parse <path-to-Designer.cs>`: Extract InitializeComponent() control instantiations, property assignments (Location, Size, Text, Name), and output a structured JSON schema.
     - `generate <path-to-Designer.cs>`: Read updated JSON from stdin and rewrite InitializeComponent() while retaining surrounding code and field declarations.

2. VS Code Extension (TypeScript):
   - Create a `CustomTextEditorProvider` targeting `*.Designer.cs`.
   - Manage child_process lifecycle to invoke the .NET CLI tool.
   - Establish two-way communication between the Roslyn engine and the Webview via postMessage.
   - Manage document dirty state and saving.

3. Designer Webview (HTML/CSS/Vanilla JS):
   - A toolbar with draggable controls: Button, Label, TextBox.
   - A canvas representing the Form with coordinate drag-and-drop, bounding-box selection, and resize handles.
   - A property inspector panel updating values (Text, Location, Size) in real time.
   - Send state updates back to the extension host on change.
