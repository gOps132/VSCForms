<#
.SYNOPSIS
    Prepares a Windows guest to run the VSCForms differential oracle and the visual-parity
    capture against the Visual Studio WinForms designer.

.DESCRIPTION
    Runs INSIDE the guest. It is transport-agnostic on purpose: the same script is driven
    over SSH, over the QEMU guest agent (`utmctl exec`), or by hand in a guest terminal.

    It does four things, in order, and each is idempotent so a re-run after a partial
    failure is cheap:

      1. .NET 10 SDK      — the oracle's engine is a .NET 10 console app, and the matrix
                             assembly is `net10.0-windows`.
      2. Visual Studio Code + our win32-x64 .vsix — this is OUR editor, and the README
                             claims the extension "runs natively on macOS, Linux and
                             Windows". Nothing has ever run it on Windows.
      3. The repository    — a directory share (VirtioFS/WebDAV) or a pushed copy.
      4. The engine binary + the matrix run.

    Visual Studio itself (for the WinForms DESIGNER) is optional and off by default: it is
    a ~10 GB install and the designer needs the full IDE — Build Tools does not include
    it. Turn it on with -WithVisualStudio.

.PARAMETER RepoPath
    The repository checkout inside the guest. Default: the first thing that looks like a
    VSCForms checkout on a share, or C:\src\VSCForms.

.PARAMETER ShareRoot
    A directory share's root, e.g. \\MacOS.home\vm. The repo is copied from here when it
    is not already present.

.PARAMETER VsixPath
    The VSCForms .vsix to install. If omitted, the newest one under $ShareRoot is used.

.PARAMETER WithVisualStudio
    Also install Visual Studio Community with the .NET desktop workload, which is what
    carries the WinForms designer.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File bootstrap-guest.ps1 -ShareRoot '\\MacOS.home\vm' -WithVisualStudio
#>
[CmdletBinding()]
param(
    [string] $RepoPath = 'C:\src\VSCForms',
    [string] $ShareRoot = '',
    [string] $VsixPath = '',
    [switch] $WithVisualStudio,
    [switch] $SkipMatrix
)

$ErrorActionPreference = 'Stop'
function Log($m) { Write-Host ("[bootstrap] " + $m) }
function Step($m) { Write-Host ""; Write-Host ("== " + $m); Write-Host "" }

# ---------------------------------------------------------------- identity
Step "who am I"
Log ("OS            : " + (Get-CimInstance Win32_OperatingSystem).Caption)
Log ("Version       : " + [System.Environment]::OSVersion.VersionString)
Log ("Architecture  : " + $env:PROCESSOR_ARCHITECTURE)
Log ("PowerShell    : " + $PSVersionTable.PSVersion)
Log ("Machine       : " + $env:COMPUTERNAME)
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -notlike '127.*' } |
       Select-Object -First 1).IPAddress
Log ("IPv4          : " + $ip)

# ------------------------------------------------------------- winget ready
Step "winget"
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Log "winget not found — App Installer is missing. Install it from the Store, or run:"
    Log "  https://learn.microsoft.com/windows/package-manager/winget/#install"
    throw "winget is required to install the toolchain automatically"
}
winget --version

# ------------------------------------------------------------- .NET 10 SDK
Step ".NET 10 SDK"
$sdk = (dotnet --list-sdks 2>$null | Where-Object { $_ -match '^10\.' })
if ($sdk) {
    Log "already present: $sdk"
} else {
    Log "installing Microsoft.DotNet.SDK.10"
    winget install --id Microsoft.DotNet.SDK.10 --exact --silent `
        --accept-package-agreements --accept-source-agreements
    $sdk = (dotnet --list-sdks 2>$null | Where-Object { $_ -match '^10\.' })
    if (-not $sdk) { throw "the .NET 10 SDK did not install" }
    Log "installed: $sdk"
}

# ------------------------------------------------------------------- VS Code
Step "Visual Studio Code"
if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
    Log "installing Microsoft.VisualStudioCode"
    winget install --id Microsoft.VisualStudioCode --exact --silent `
        --accept-package-agreements --accept-source-agreements
    # The PATH is not refreshed for the current session.
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')
}
$code = (Get-Command code -ErrorAction SilentlyContinue)
if (-not $code) { throw "VS Code is not on PATH" }
Log ("code: " + $code.Source)

# --------------------------------------------------------------- the repository
Step "the repository"
function Find-Repo {
    $candidates = @($RepoPath)
    if ($ShareRoot) {
        $candidates += (Join-Path $ShareRoot 'VSCForms')
        $candidates += (Join-Path $ShareRoot 'dev/projects/VSCForms')
    }
    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c '.git')) { return $c }
    }
    return $null
}

$repo = Find-Repo
if ($repo) {
    Log "found the repository at $repo"
    Push-Location $repo
    try {
        Log "fetching"
        git fetch --all --prune 2>&1 | Out-Null
        git status --short | Out-String | Write-Host
    } finally { Pop-Location }
} else {
    if (-not $ShareRoot) { throw "no repository found and no -ShareRoot given" }
    $src = Join-Path $ShareRoot 'VSCForms'
    if (-not (Test-Path $src)) { $src = Join-Path $ShareRoot 'dev/projects/VSCForms' }
    if (-not (Test-Path $src)) { throw "no VSCForms checkout under $ShareRoot" }
    Log "copying $src -> $RepoPath"
    New-Item -ItemType Directory -Force -Path (Split-Path $RepoPath) | Out-Null
    robocopy $src $RepoPath /E /XD .git node_modules engine\bin engine\obj extension\bin out | Out-Null
    $repo = $RepoPath
}
$RepoPath = $repo

# ------------------------------------------------------------- the extension
Step "the VSCForms extension (win32-x64)"
if (-not $VsixPath) {
    $candidates = Get-ChildItem -Path (Join-Path $ShareRoot 'dist'), (Join-Path $RepoPath 'dist') `
        -Filter 'vscforms-win32-x64.vsix' -Recurse -ErrorAction SilentlyContinue
    if ($candidates) { $VsixPath = $candidates[0].FullName }
}
if (-not $VsixPath -or -not (Test-Path $VsixPath)) {
    Log "no .vsix found — the extension is not what this step is for"
    Log "  (the oracle runs the ENGINE, not the extension; the extension needs the .vsix"
    Log "   from the package job, or scripts/package-all.js)"
} else {
    Log "installing $VsixPath"
    code --install-extension $VsixPath --force
    code --list-extensions | Where-Object { $_ -like '*vscforms*' } | ForEach-Object { Log "installed: $_" }
}

# --------------------------------------------------- Visual Studio (optional)
if ($WithVisualStudio) {
    Step "Visual Studio Community (the WinForms designer lives here)"
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $installed = $false
    if (Test-Path $vswhere) {
        $installed = (& $vswhere -latest -products * `
            -requires Microsoft.VisualStudio.Workload.ManagedDesktop `
            -property productPath) -ne $null
    }
    if ($installed) {
        Log "Visual Studio with the .NET desktop workload is already installed"
    } else {
        Log "installing — this is a big download and a slow install in a VM"
        $installer = "$env:TEMP\vs_community.exe"
        Log "downloading the bootstrapper"
        Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vs_community.exe' -OutFile $installer
        Log "installing with the .NET desktop workload (and nothing else)"
        Start-Process -FilePath $installer -Wait -ArgumentList @(
            '--quiet', '--wait', '--norestart',
            '--add', 'Microsoft.VisualStudio.Workload.ManagedDesktop',
            '--includeRecommended'
        )
        if (Test-Path $vswhere) {
            $installed = (& $vswhere -latest -products * `
                -requires Microsoft.VisualStudio.Workload.ManagedDesktop `
                -property productPath) -ne $null
        }
        if (-not $installed) { throw "Visual Studio did not install" }
        Log "installed"
    }
    & $vswhere -latest -products * -property installationPath | ForEach-Object { Log "VS at $_" }
} else {
    Step "Visual Studio — SKIPPED"
    Log "the WinForms DESIGNER needs the full Visual Studio IDE (Build Tools has no designer)."
    Log "re-run with -WithVisualStudio to install it."
}

# --------------------------------------------------------- the engine binary
Step "the engine (win-x64, self-contained)"
Push-Location $RepoPath
try {
    if (-not (Test-Path 'engine/bin/Release/net10.0/win-x64/publish/vscforms-engine.exe')) {
        Log "publishing the engine for win-x64 (self-contained, single file)"
        dotnet publish engine -c Release -r win-x64 --self-contained true `
            -p:PublishSingleFile=true -p:DebugType=none `
            -p:IncludeNativeLibrariesForSelfExtract=true `
            -o engine/bin/Release/net10.0/win-x64/publish
    } else {
        Log "already published"
    }
    if (-not (Test-Path 'engine/bin/Release/net10.0/win-x64/publish/vscforms-engine.exe')) {
        throw "the engine did not publish"
    }
} finally { Pop-Location }

# --------------------------------------------------------------- the matrix
if (-not $SkipMatrix) {
    Step "the differential matrix (the oracle's runtime half)"
    Push-Location $RepoPath
    try {
        # The script needs Git Bash for the POSIX path handling; fall back to a clear
        # message rather than running a broken tier.
        $bash = (Get-Command bash -ErrorAction SilentlyContinue)
        if (-not $bash) {
            Log "no bash found — run the matrix from a Git Bash prompt instead:"
            Log "  cd /c/src/VSCForms && ./scripts/run-windows-matrix.sh"
        } else {
            $env:VSCFORMS_MATRIX_RENDER = '1'   # the visual reference PNGs
            & $bash.Source -lc "cd '$($RepoPath -replace '\\','/')' && ./scripts/run-windows-matrix.sh"
            Log ("matrix exit code: " + $LASTEXITCODE)
        }
    } finally { Pop-Location }
}

Step "done"
Log "the guest is ready. Next: open the same fixture in the Visual Studio WinForms"
Log "designer and in VS Code, and compare them."
