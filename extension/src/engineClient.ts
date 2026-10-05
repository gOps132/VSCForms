import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Client for the Roslyn engine process.
 *
 * The engine is a long-lived stdio process speaking newline-delimited JSON. It is spawned
 * lazily on first use and shared across all editor instances, since spawning a .NET process
 * (and paying Roslyn's JIT cost) per open document would be wasteful.
 *
 * STDOUT IS A PROTOCOL CHANNEL. Anything the child writes there that is not a response
 * would desynchronise the stream, so the client rejects malformed lines loudly rather than
 * silently skipping them.
 */
export class EngineClient implements vscode.Disposable {
    private child: cp.ChildProcessWithoutNullStreams | undefined;
    private buffer = '';
    private nextId = 1;
    private pending = new Map<number, { resolve: (r: EngineResponse) => void; reject: (e: Error) => void }>();
    private log = vscode.window.createOutputChannel('WinForms Designer');

    constructor(private readonly enginePath: string) {}

    dispose(): void {
        this.child?.kill();
        this.child = undefined;
        for (const [, p] of this.pending) p.reject(new Error('engine disposed'));
        this.pending.clear();
        this.log.dispose();
    }

    /** Spawn the engine if needed. Idempotent. */
    private ensure(): cp.ChildProcessWithoutNullStreams {
        if (this.child && !this.child.killed) return this.child;

        if (!fs.existsSync(this.enginePath)) {
            throw new Error(
                `VSCForms design engine not found at ${this.enginePath}.\n` +
                `Build it with:  dotnet publish engine -c Release -r <rid> -p:PublishSingleFile=true`
            );
        }

        // Packaging from Windows loses the POSIX executable bit; restore it if needed.
        try {
            fs.chmodSync(this.enginePath, 0o755);
        } catch { /* not a POSIX host, or already correct */ }

        this.log.appendLine(`starting engine: ${this.enginePath}`);
        const child = cp.spawn(this.enginePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            for (const l of chunk.split('\n')) if (l.trim()) this.log.appendLine(l);
        });

        child.on('exit', (code) => {
            this.log.appendLine(`engine exited with code ${code}`);
            for (const [, p] of this.pending) p.reject(new Error(`engine exited (${code})`));
            this.pending.clear();
            this.child = undefined;
        });

        child.on('error', (e) => {
            for (const [, p] of this.pending) p.reject(e);
            this.pending.clear();
        });

        return child;
    }

    private onStdout(chunk: string): void {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line) continue;
            let msg: EngineResponse;
            try {
                msg = JSON.parse(line) as EngineResponse;
            } catch {
                // Something wrote to stdout that is not a response. Do not guess.
                this.log.appendLine(`[PROTOCOL ERROR] non-JSON on stdout: ${line.slice(0, 200)}`);
                continue;
            }
            const p = this.pending.get(msg.id);
            if (!p) { this.log.appendLine(`[PROTOCOL] response for unknown id ${msg.id}`); continue; }
            this.pending.delete(msg.id);
            p.resolve(msg);
        }
    }

    private send(req: {
        cmd: string; path?: string; schema?: unknown;
        name?: string; parent?: string; template?: string; language?: string;
        from?: string; to?: string;
    }): Promise<EngineResponse> {
        const id = this.nextId++;
        const child = this.ensure();
        return new Promise<EngineResponse>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            child.stdin.write(JSON.stringify({ id, ...req }) + '\n', (err) => {
                if (err) { this.pending.delete(id); reject(err); }
            });
        });
    }

    async parse(filePath: string): Promise<ParsedResult> {
        const res = await this.send({ cmd: 'parse', path: filePath });
        if (!res.ok || !res.schema) {
            return { ok: false, error: res.error ?? 'parse failed', errorKind: res.errorKind ?? 'internal' };
        }
        return { ok: true, schema: res.schema };
    }

    async generate(filePath: string, schema: unknown): Promise<GenerateResult> {
        const res = await this.send({ cmd: 'generate', path: filePath, schema });
        return { ok: res.ok, changed: res.changed === true, error: res.error, errorKind: res.errorKind };
    }

    /**
     * Create a WinForms project. The engine does the work — it is the only component that edits
     * files byte-faithfully, and the csproj's BOM and CRLF have to survive (docs/adr/0007).
     */
    async newProject(opts: NewProjectOptions): Promise<NewProjectResult> {
        const res = await this.send({
            cmd: 'new', name: opts.name, parent: opts.parent,
            template: opts.template ?? 'winforms', language: opts.language ?? 'C#',
        });
        if (!res.ok) {
            return { ok: false, error: res.error ?? 'generation failed', errorKind: res.errorKind ?? 'internal' };
        }
        return {
            ok: true,
            projectDir: res.projectDir ?? '', solution: res.solution ?? '', designer: res.designer ?? '',
            windowsTargetingAdded: res.windowsTargetingAdded === true,
        };
    }

    /**
     * Rename a control. The engine may also edit the hand-written code-behind — see
     * docs/adr/0008-rename-boundary.md — and refuses rather than guessing.
     */
    async rename(filePath: string, from: string, to: string): Promise<RenameResult> {
        const res = await this.send({ cmd: 'rename', path: filePath, from, to });
        if (!res.ok) {
            return { ok: false, error: res.error ?? 'rename refused', errorKind: res.errorKind ?? 'internal' };
        }
        return { ok: true, codeBehind: res.codeBehind, referenceCount: res.referenceCount ?? 0 };
    }

    /** Locate the bundled engine, honouring platform-targeted packaging. */
    static resolveEnginePath(context: vscode.ExtensionContext): string {
        const override = vscode.workspace.getConfiguration('vscforms').get<string>('enginePath');
        if (override && fs.existsSync(override)) return override;

        // Platform-targeted packages put the binary under bin/<vscode-triple>/...
        const triple = EngineClient.vscodeTriple(process.platform, process.arch);
        const candidates = [
            path.join(context.extensionPath, 'bin', triple, 'vscforms-engine'),
            path.join(context.extensionPath, 'bin', triple, 'vscforms-engine.exe'),
            path.join(context.extensionPath, 'bin', 'vscforms-engine'),
            path.join(context.extensionPath, 'bin', 'vscforms-engine.exe'),
        ];
        return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
    }

    /** VS Code platform triples, which differ from .NET RIDs (see docs/adr/0002). */
    private static vscodeTriple(platform: string, arch: string): string {
        const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
        const a = arch === 'arm64' ? 'arm64' : arch === 'arm' ? 'arm' : 'x64';
        return `${os}-${a}`;
    }
}

export interface EngineResponse {
    id: number; ok: boolean;
    schema?: FormSchema;
    error?: string; errorKind?: string; changed?: boolean;
    projectDir?: string; solution?: string; designer?: string; windowsTargetingAdded?: boolean;
    codeBehind?: string; referenceCount?: number;
}

export type ParsedResult = { ok: true; schema: FormSchema } | { ok: false; error: string; errorKind: string };
export interface GenerateResult { ok: boolean; changed: boolean; error?: string; errorKind?: string }

export interface NewProjectOptions { name: string; parent: string; template?: string; language?: string }
export type NewProjectResult = {
    ok: true; projectDir: string; solution: string; designer: string; windowsTargetingAdded: boolean;
} | { ok: false; error: string; errorKind: string };

export type RenameResult =
    | { ok: true; codeBehind?: string; referenceCount: number }
    | { ok: false; error: string; errorKind: string };

// ---------------------------------------------------------------- SCHEMA.md

export interface FormSchema {
    schemaVersion: 1;
    form: FormInfo;
    controls: ControlNode[];
    analysis: Analysis;
}
export interface FormInfo {
    name: string; text: string;
    clientSize: { width: number; height: number };
    className: string;
}
export interface Analysis {
    modelledCount: number; unmodelledCount: number; coveragePercent: number;
    refuses: string[]; warnings: string[];
}
export interface ControlNode {
    id: string; type: string; children: ControlNode[];
    properties: ControlProperties;
    locked: boolean; lockedReason?: string;
}
export interface ControlProperties {
    x: number; y: number; width: number; height: number;
    text?: string; tabIndex?: number; backColor?: string;
    visible?: boolean; enabled?: boolean;
    font?: { size: number; bold: boolean; italic: boolean; family?: string };
}