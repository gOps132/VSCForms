# Specific properties: TextBox & Leaf Widgets (TrackBar, ProgressBar, NumericUpDown)

**Status:** ACCEPTED — implementing now. Sibling of `spec-features.md` §3, covering the property gaps on TextBox and the Phase A leaf widgets.

## 0. Scope

Model and wire properties that are specific to individual control types:

### 1. TextBox
| Property | Type | WinForms default | Emitted C# |
|---|---|---|---|
| `Multiline` | `bool` | `false` | `txt.Multiline = true;` |
| `ReadOnly` | `bool` | `false` | `txt.ReadOnly = true;` |
| `MaxLength` | `int` | `32767` | `txt.MaxLength = 50;` |
| `PasswordChar` | `string` (1 char) | `""` (unset) | `txt.PasswordChar = '*';` |

### 2. Leaf Widgets (`TrackBar`, `ProgressBar`, `NumericUpDown`)
| Property | Type | Controls | Emitted C# |
|---|---|---|---|
| `Minimum` | `number` (decimal) | `TrackBar`, `ProgressBar`, `NumericUpDown` | `ctl.Minimum = 0;` |
| `Maximum` | `number` (decimal) | `TrackBar`, `ProgressBar`, `NumericUpDown` | `ctl.Maximum = 100;` |
| `Value` | `number` (decimal) | `TrackBar`, `ProgressBar`, `NumericUpDown` | `ctl.Value = 50;` |

## 1. Patcher Invariants

1. **Insert path required**: Every property offered in the canvas must have an insert path.
   Controls on a fresh project lack these properties by default; editing them must emit a new statement anchored to the control's property block.
2. **Preserve dialect**:
   - For `NumericUpDown` with `new decimal(new int[] { ... })`: update the bits array preserving the creation syntax.
   - For literal numbers (e.g. `10`, `10M`): update the literal token.
   - For `PasswordChar`: emit single-character char literal `'*'`. Clearing it emits `'\0'`.
   - For booleans: replace `true`/`false` literal.
3. **No churn on untouched properties**: Only properties modified by the user produce `TextChange`s.

## 2. Verification

1. Parsing and surgical patching of each property verified via unit tests in `test/verify.sh`.
2. Real WinForms compilation gate (`net10.0-windows`) ensures generated code compiles.
3. Canvas DOM harness tests in `extension/test/hostHarness.js` verify inspector fields render and commit.
4. Full `./test/run-all.sh` remains all green.
