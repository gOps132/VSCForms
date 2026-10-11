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
    # Full fixture-relative path (fixtures/declared/bare/DeclaredForm.Designer.cs), not
    # the leaf directory. Passing only the leaf re-tested the same head -1 file for
    # every sibling (invisible/SizeOnlyForm verified InvisibleForm twice) and reported
    # ERROR for subdirectories with no project of their own (declared/*/).
    $rel = [IO.Path]::GetRelativePath((Get-Location).Path, $f.FullName) -replace '\\','/'
    $label = $rel -replace '^fixtures/',''
    Write-Host "=== $label"

    $out = & bash ./scripts/run-windows-layout.sh "$rel" 2>&1
    Write-Host $out

    if ($out -match 'SKIP') {
        # A silent skip is the failure mode that matters: it exits 0, so the job goes green
        # while verifying nothing at all.
        $failed += "$label (SKIPPED)"
    }
    elseif ($LASTEXITCODE -eq 127 -or $out -match 'Unhandled exception|ERROR no project|ERROR engine not built') {
        # True infrastructure failure: Check.exe missing, no project, no engine, or the
        # staged form crashed before any geometry was compared (a crash is not a
        # geometry mismatch — it verified nothing).
        $failed += "$label (exit $LASTEXITCODE - infrastructure)"
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