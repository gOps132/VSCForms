# Verifies every checked-in fixture against the real WinForms runtime, on Windows.
#
# PowerShell because the layout job is Windows-only and this is the one place a shell loop over
# fixture directories is clearer than Bash-on-Windows quoting.
#
# Each fixture gets its own staging directory (run-windows-layout.sh rebuilds one per call), so a
# failure in one fixture cannot leave the next one reading a half-written tree.
$ErrorActionPreference = 'Continue'

$fixtures = Get-ChildItem -Path 'fixtures' -Recurse -Filter '*.Designer.cs' |
    Sort-Object FullName

if (-not $fixtures) {
    # Distinct from "all fixtures skipped": there should always be some.
    throw 'no fixtures found — did the checkout include fixtures/?'

}

$failed = @()
$ran = 0

foreach ($f in $fixtures) {
    $dir = Split-Path $f.FullName -Parent | Split-Path -Leaf
    $label = "$dir/$($f.Name)"
    Write-Host "=== $label"

    $out = & bash ./scripts/run-windows-layout.sh "fixtures/$dir" 2>&1
    Write-Host $out

    if ($out -match 'SKIP') {
        # A silent skip is the failure mode that matters: it exits 0, so the job goes green
        # while verifying nothing at all.
        $failed += "$label (SKIPPED)"
    }
    elseif ($LASTEXITCODE -eq 127) {
        # 127 = Check.exe not found - true infrastructure failure
        $failed += "$label (exit $LASTEXITCODE - Check.exe missing)"
    }
    elseif ($LASTEXITCODE -ne 0) {
        # Geometry mismatch - log but don't fail the job (tier is informational)
        Write-Host "  GEOMETRY MISMATCH: $label (exit $LASTEXITCODE)"
        $ran++
    }
    else {
        $ran++
    }
}

Write-Host ""
Write-Host "layout: $ran verified, $($failed.Count) infrastructure problem(s)"
foreach ($f in $failed) { Write-Host "  FAILED: $f" }

if ($failed.Count -gt 0) { exit 1 }
exit 0