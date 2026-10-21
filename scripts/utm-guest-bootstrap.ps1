<#
.SYNOPSIS
    Prepares a Windows guest to run the VSCForms differential oracle, and (optionally) to
    run the extension itself.

.DESCRIPTION
    Runs INSIDE the guest. It is transport-agnostic on purpose: the same file is driven
    over SSH, over the QEMU guest agent (`utmctl exec`), or by hand in a guest terminal.

    Every step is idempotent, so a re-run after a partial failure is cheap.

    WHAT THIS GUEST ACTUALLY HAS, AND WHAT IT CANNOT HAVE
      dotnet 10.0.401 (RID win-arm64)   present
      Visual Studio 18 Community        present, but WITHOUT the .NET desktop workload
      git, python3, winget, VS Code     absent

    The Windows Installer is BROKEN in this guest: both the x64 and the ARM64 Python
    installers fail with 0x80070003 (ERROR_PATH_NOT_FOUND). That also breaks the Visual
    Studio workload add, so THE WINFORMS DESIGNER CANNOT BE INSTALLED HERE. The
    installers that work are the non-MSI ones, and this script uses only those.

.PARAMETER RepoPath
    The repository checkout inside the guest. Default: C:\Users\Public\vscforms

.PARAMETER MatrixTar
    A matrix tarball to unpack and point the tier at. The tier needs NO python in the
    guest, so the matrix is generated on the host and pushed as one file.

.PARAMETER VsixPath
    The VSCForms .vsix to install into VS Code.

.PARAMETER SkipMatrix
    Provision the toolchain but do not run the matrix.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File utm-guest-bootstrap.ps1 -MatrixTar C:\Users\Public\matrix.tar
#>
[CmdletBinding()]
param(
    [string] $RepoPath = 'C:\Users\Public\vscforms',
    [string] $MatrixTar = 'C:\Users\Public\matrix.tar',
    [string] $VsixPath = '',
    [switch] $SkipMatrix
)

$ErrorActionPreference = 'Stop'
function Log($m) { Write-Host ("[bootstrap] " + $m) }
function Step($m) { Write-Host ""; Write-Host ("== " + $m); Write-Host "" }

# ---------------------------------------------------------------- identity
Step "who am I"
Log ("OS            : " + (Get-CimInstance Win32_OperatingSystem).Caption)
Log ("Architecture  : " + $env:PROCESSOR_ARCHITECTURE)
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -notlike '127.*' } |
       Select-Object -First 1).IPAddress
Log ("IPv4          : " + $ip)

# The RID is the one question that decides which engine build can be LOADED, and only the
# runtime knows the answer. `uname -m` inside Git Bash says x86_64 on an ARM64 guest
# because the shell runs under emulation, and an engine published for the wrong RID fails
# with "Failed to load hostpolicy.dll ... Ensure the library matches the current process
# architecture: arm64".
$rid = (dotnet --info | Select-String 'RID:' | Select-Object -First 1) -replace '.*RID:\s*', ''
$rid = $rid.Trim()
Log ("dotnet RID    : " + $rid)
if (-not $rid) { throw "dotnet did not report a RID" }

# ------------------------------------------------------------------ Git Bash
Step "Git for Windows (Git Bash)"
if (Test-Path 'C:\Program Files\Git\bin\bash.exe') {
    Log "already present"
} else {
    $git = "$env:TEMP\git.exe"
    Log "downloading (the NSIS installer works here; MSI does not)"
    Invoke-WebRequest -Uri 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/Git-2.56.0.2-64-bit.exe' -OutFile $git
    Log "installing silently"
    $p = Start-Process -FilePath $git -Wait -PassThru -ArgumentList @(
        '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES')
    Log ("installer exit code: " + $p.ExitCode)
    if (-not (Test-Path 'C:\Program Files\Git\bin\bash.exe')) {
        throw "Git for Windows did not install"
    }
}
Log "Git Bash: ready"

# ------------------------------------------------------------------- VS Code
Step "Visual Studio Code (the portable archive, not the installer)"
if (Test-Path 'C:\Users\Public\vscode\Code.exe') {
    Log "already installed"
} else {
    $zip = "$env:TEMP\vscode.zip"
    # The -archive suffix is the ZIP. Without it the URL serves a signed .exe and
    # Expand-Archive fails with "End of Central Directory record could not be found".
    Log "downloading the portable ARM64 archive"
    Invoke-WebRequest -Uri 'https://update.code.visualstudio.com/latest/win32-arm64-archive/stable' -OutFile $zip
    Log ("downloaded " + [math]::Round((Get-Item $zip).Length / 1MB) + " MB")
    Expand-Archive -Force $zip 'C:\Users\Public\vscode'
    if (-not (Test-Path 'C:\Users\Public\vscode\Code.exe')) { throw "VS Code did not extract" }
    Log "VS Code: ready"
}

# ------------------------------------------------------------- the repository
Step "the repository"
if (Test-Path (Join-Path $RepoPath 'engine\src\Patcher.cs')) {
    Log "already present at $RepoPath"
} else {
    $zip = "$env:TEMP\repo.zip"
    Log "downloading (no git in this guest, and none is needed)"
    Invoke-WebRequest -Uri 'https://github.com/gOps132/VSCForms/archive/refs/heads/main.zip' -OutFile $zip
    Expand-Archive -Force $zip "$env:TEMP\repo"
    $src = Get-ChildItem "$env:TEMP\repo" -Directory | Select-Object -First 1
    Move-Item $src.FullName $RepoPath
    Log "repository at $RepoPath"
}

# ------------------------------------------------------------------- the engine
Step "the engine ($rid)"
$engine = Join-Path $RepoPath "engine\bin\Release\net10.0\$rid\publish\vscforms-engine.exe"
if (-not (Test-Path $engine)) {
    Log "publishing"
    Push-Location $RepoPath
    try {
        dotnet publish engine -c Release -r $rid --self-contained true `
            -p:PublishSingleFile=true -p:DebugType=none `
            -p:IncludeNativeLibrariesForSelfExtract=true `
            -o "engine/bin/Release/net10.0/$rid/publish" 2>&1 |
            Select-String 'error|->' | ForEach-Object { Log $_.ToString() }
    } finally { Pop-Location }
} else {
    Log "already published"
}
$dll = Join-Path $RepoPath "engine\bin\Release\net10.0\$rid\vscforms-engine.dll"
if (-not (Test-Path $dll)) { throw "the engine did not publish for $rid" }
Log "engine ready: $dll"

# ------------------------------------------------------------------ the matrix
if (-not $SkipMatrix) {
    Step "the matrix"
    if (-not (Test-Path $MatrixTar)) {
        Log "no matrix tarball at $MatrixTar - the tier needs one, because it needs no python"
    } else {
        $dir = 'C:\Users\Public\matrix'
        if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Log "unpacking the matrix"
        tar -xf $MatrixTar -C $dir
        if (-not (Test-Path (Join-Path $dir 'cases.txt'))) { throw "the matrix did not unpack" }
        $count = (Get-Content (Join-Path $dir 'cases.txt') | Measure-Object -Line).Lines
        Log "$count case(s)"

        Log "running the matrix"
        $env:VSCFORMS_MATRIX_DIR = '/c/Users/Public/matrix'
        $env:VSCFORMS_MATRIX_RENDER = '1'
        $bash = 'C:\Program Files\Git\bin\bash.exe'
        & $bash -lc "cd /c/Users/Public/vscforms && VSCFORMS_MATRIX_DIR=/c/Users/Public/matrix VSCFORMS_MATRIX_RENDER=1 ./scripts/run-windows-matrix.sh"
        Log ("matrix exit code: " + $LASTEXITCODE)
    }
}

Step "done"
Log "the guest is ready."
