import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Discovers the target .csproj file for a given document URI or workspace.
 */
export async function findProjectFile(documentUri?: vscode.Uri): Promise<string | undefined> {
    // 1. Walk up from the document's directory
    if (documentUri && documentUri.scheme === 'file') {
        let dir = path.dirname(documentUri.fsPath);
        const root = path.parse(dir).root;
        while (dir && dir !== root) {
            try {
                const files = fs.readdirSync(dir);
                const proj = files.find((f) => f.endsWith('.csproj'));
                if (proj) return path.join(dir, proj);
            } catch {
                break;
            }
            dir = path.dirname(dir);
        }
    }

    // 2. Search workspace folders for any .csproj files
    const matches = await vscode.workspace.findFiles('**/*.csproj', '**/bin/**', 10);
    if (matches.length === 1) {
        return matches[0].fsPath;
    }
    if (matches.length > 1) {
        const items = matches.map((m) => ({
            label: path.basename(m.fsPath),
            description: vscode.workspace.asRelativePath(m),
            fsPath: m.fsPath,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a WinForms project (.csproj) to run',
        });
        return picked?.fsPath;
    }

    return undefined;
}

export interface WineResolution {
    wineBin?: string;
    winePrefix?: string;
}

/**
 * Locates Wine on macOS or Linux, checking settings, environment, PATH, and known paths.
 */
export function resolveWine(): WineResolution {
    const config = vscode.workspace.getConfiguration('vscforms');
    const customWine = config.get<string>('winePath');
    const customPrefix = config.get<string>('winePrefix');

    let wineBin: string | undefined;
    if (customWine && fs.existsSync(customWine)) {
        wineBin = customWine;
    } else if (process.env.WINE && fs.existsSync(process.env.WINE)) {
        wineBin = process.env.WINE;
    } else {
        const candidates: string[] = [
            'wine64',
            'wine',
            path.join(os.homedir(), '.local/bin/wine64'),
            path.join(os.homedir(), '.local/bin/wine'),
            path.join(os.homedir(), 'Library/Application Support/com.isaacmarovitz.Whisky/Libraries/Wine/bin/wine64'),
            '/opt/homebrew/bin/wine64',
            '/opt/homebrew/bin/wine',
            '/usr/local/bin/wine64',
            '/usr/local/bin/wine',
            '/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine64',
            '/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine',
            '/Applications/Wine Devel.app/Contents/Resources/wine/bin/wine64',
            '/Applications/Wine Devel.app/Contents/Resources/wine/bin/wine',
            '/Applications/Wine Crossover.app/Contents/Resources/wine/bin/wine64',
            '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine64',
        ];

        // Also check PATH for bare binary names
        const pathDirs = (process.env.PATH || '').split(path.delimiter);
        for (const c of candidates) {
            if (c.includes('/') && fs.existsSync(c)) {
                wineBin = c;
                break;
            }
            if (!c.includes('/')) {
                for (const p of pathDirs) {
                    const full = path.join(p, c);
                    if (fs.existsSync(full)) {
                        wineBin = full;
                        break;
                    }
                }
                if (wineBin) break;
            }
        }
    }

    // Resolve winePrefix (e.g. Whisky bottle or user-configured prefix)
    let winePrefix: string | undefined;
    if (customPrefix && fs.existsSync(customPrefix)) {
        winePrefix = customPrefix;
    } else if (process.env.WINEPREFIX && fs.existsSync(process.env.WINEPREFIX)) {
        winePrefix = process.env.WINEPREFIX;
    } else {
        const whiskyBottlesDir = path.join(
            os.homedir(),
            'Library/Containers/com.isaacmarovitz.Whisky/Bottles'
        );
        if (fs.existsSync(whiskyBottlesDir)) {
            try {
                const bottles = fs.readdirSync(whiskyBottlesDir);
                if (bottles.length > 0) {
                    winePrefix = path.join(whiskyBottlesDir, bottles[0]);
                }
            } catch {
                // ignore
            }
        }
    }

    return { wineBin, winePrefix };
}

/**
 * Displays a helpful prompt when Wine is not found on macOS / Linux.
 */
export async function promptMissingWine(): Promise<void> {
    const isMac = process.platform === 'darwin';
    const isArm = process.arch === 'arm64';

    const msg = isMac
        ? 'Wine is required to run WinForms projects on macOS, but was not found on your system.'
        : 'Wine is required to run WinForms projects on Linux, but was not found on your system.';

    const installWhisky = 'Install Whisky (Recommended for Apple Silicon)';
    const installHomebrew = 'Install via Homebrew';
    const configSettings = 'Configure Wine Path';

    const options = isMac
        ? [installWhisky, installHomebrew, configSettings]
        : [installHomebrew, configSettings];

    const choice = await vscode.window.showErrorMessage(msg, ...options);
    if (!choice) return;

    if (choice === installWhisky) {
        const term = vscode.window.createTerminal({ name: 'Install Whisky' });
        term.show();
        term.sendText('brew install --cask whisky');
    } else if (choice === installHomebrew) {
        const term = vscode.window.createTerminal({ name: 'Install Wine' });
        term.show();
        if (isMac && isArm) {
            term.sendText('brew tap gcenx/wine && brew install --cask wine-crossover || brew install --cask whisky');
        } else if (isMac) {
            term.sendText('brew install --cask --no-quarantine wine-stable');
        } else {
            term.sendText('sudo apt-get update && sudo apt-get install -y wine64 || sudo dnf install -y wine');
        }
    } else if (choice === configSettings) {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'vscforms.winePath');
    }
}

/**
 * Builds and runs the WinForms project in an integrated VS Code terminal.
 */
export async function runProject(
    context: vscode.ExtensionContext,
    documentUri?: vscode.Uri
): Promise<void> {
    // 1. Save any unsaved changes before building
    await vscode.workspace.saveAll(false);

    // 2. Discover the target .csproj
    const csprojPath = await findProjectFile(documentUri);
    if (!csprojPath) {
        vscode.window.showErrorMessage(
            'VSCForms: No WinForms project (.csproj) found. Open a form or project file first.'
        );
        return;
    }

    const projName = path.basename(csprojPath, '.csproj');

    // 3. Platform check
    if (process.platform === 'win32') {
        const term = getOrCreateTerminal('WinForms');
        term.show();
        term.sendText(`dotnet run --project "${csprojPath}"`);
        return;
    }

    // 4. macOS / Linux: Wine resolution
    const { wineBin, winePrefix } = resolveWine();
    if (!wineBin) {
        await promptMissingWine();
        return;
    }

    // 5. Locate runner script
    const scriptCandidates = [
        path.join(context.extensionPath, 'scripts', 'run-in-wine.sh'),
        path.join(context.extensionPath, '..', 'scripts', 'run-in-wine.sh'),
    ];
    const runnerScript = scriptCandidates.find((s) => fs.existsSync(s));

    const term = getOrCreateTerminal(`WinForms: ${projName}`);
    term.show();

    const envPrefix = [
        wineBin ? `WINE="${wineBin}"` : '',
        winePrefix ? `WINEPREFIX="${winePrefix}"` : '',
    ]
        .filter(Boolean)
        .join(' ');

    if (runnerScript) {
        term.sendText(`${envPrefix ? envPrefix + ' ' : ''}bash "${runnerScript}" "${csprojPath}"`);
    } else {
        // Fallback: direct publish & wine execution
        const outDir = path.join(os.tmpdir(), 'vscforms-wine', projName);
        const publishCmd = `dotnet publish "${csprojPath}" -r win-x64 -c Release -p:EnableWindowsTargeting=true --self-contained true -o "${outDir}" --nologo -v q`;
        const runCmd = `DOTNET_EnableWriteXorExecute=0 WINEDEBUG="-all" ${winePrefix ? `WINEPREFIX="${winePrefix}" ` : ''}"${wineBin}" "${path.join(outDir, projName + '.exe')}"`;
        term.sendText(`mkdir -p "${outDir}" && ${publishCmd} && echo "==> Launching in Wine..." && ${runCmd}`);
    }
}

function getOrCreateTerminal(name: string): vscode.Terminal {
    const existing = vscode.window.terminals.find((t) => t.name === name);
    return existing ?? vscode.window.createTerminal({ name });
}
