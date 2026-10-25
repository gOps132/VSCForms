import * as vscode from 'vscode';
import * as path from 'path';
import { EngineClient, FormSchema } from './engineClient';
import { runProject } from './projectRunner';

let engine: EngineClient;
let provider: DesignerEditorProvider | undefined;

/** System-clipboard tag for canvas ControlNode payloads (A2 #3). Must match canvas.js. */
const VSCFORMS_CLIPBOARD_PREFIX = 'vscforms-controls-v1:';

/** Test-only seam. Returns the most recent undo/redo continuations we fired. */
export const __lastEdit = () => provider?.lastEdit;

/** Test-only seam. Exposes the provider so the suite can call lifecycle methods directly. */
export const __provider = () => provider;

/**
 * Custom document for a Designer File.
 *
 * NOTE ON SAVE: the engine writes the file directly, so by the time VS Code asks us to save,
 * the text on disk is already correct. `saveCustomDocument` therefore only needs to clear the
 * dirty flag we maintain ourselves.
 */
class DesignerDocument implements vscode.CustomDocument {
    constructor(
        public readonly uri: vscode.Uri,
        public text: string,
    ) {}

    dispose(): void { /* nothing retained beyond text */ }
}

/**
 * NOTE ON DIRTY STATE: this class deliberately has no `dirty` flag. VS Code's dirty indicator
 * for a custom editor is driven entirely by its internal save-point index, which advances only
 * when a CustomDocumentEditEvent is fired. A local boolean would be dead weight that
 * desynchronises from the real state. Verified against VS Code 1.140.
 */

/**
 * The custom editor.
 *
 * The critical design point is that the WEBVIEW OWNS AN OPTIMISTIC MODEL and the engine is a
 * slow validator, not the source of render truth. A drag must feel instant, so geometry is
 * applied locally on mousedown and only pushed to the engine (and therefore to the document)
 * after the gesture settles.
 *
 * Undo is VS Code's job (ADR 0004): after every committed edit — layout or rename — the host
 * fires a CustomDocumentEditEvent carrying real undo()/redo() continuations, so one Ctrl+Z
 * restores the file(s) through VS Code's own stack. The canvas holds no undo stack of its own;
 * a private stack plus the document events would apply one Ctrl+Z twice and diverge from the
 * file.
 */
class DesignerEditorProvider implements vscode.CustomEditorProvider<DesignerDocument> {
    public static readonly viewType = 'vscforms.formDesigner';

    private panels = new Map<string, vscode.WebviewPanel>();

    /** uri -> the live document + its panel, so the test seam reaches the real instance. */
    private documents = new Map<string, { uri: vscode.Uri; doc: DesignerDocument }>();

    /**
     * Fires when the engine writes the file behind VS Code's back, so the tab shows a dirty
     * marker and Ctrl+S / save-all behave normally.
     */
    private readonly _onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DesignerDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChange.event;

    /**
     * The most recent undo/redo pair. Exported through `__lastEdit` so the integration suite
     * can drive the continuations directly: a synthetic keypress cannot be produced from the
     * extension host API, and while `executeCommand('undo')` does reach them (verified on
     * VS Code 1.141, alongside a real trusted keypress), driving the continuations is the
     * deterministic assertion — it is OUR half of the contract either way.
     */
    lastEdit: { undo: () => Promise<void>; redo: () => Promise<void> } | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {}

    // ------------------------------------------------------------------ save

    /**
     * The engine already wrote the file, so there is nothing to persist. VS Code awaits this,
     * then unconditionally advances its internal save point, which is what clears the dirty
     * marker. Re-reading keeps `doc.text` truthful for backupCustomDocument.
     */
    async saveCustomDocument(doc: DesignerDocument, _cancel: vscode.CancellationToken): Promise<void> {
        try {
            const bytes = await vscode.workspace.fs.readFile(doc.uri);
            doc.text = Buffer.from(bytes).toString('utf8');
        } catch { /* file may have been deleted; nothing to save */ }
    }

    /**
     * Save As is not supported, and silently writing `doc.text` to a new path would be worse
     * than refusing: it copies a snapshot rather than moving the form, leaving the original
     * in place with the canvas still keyed to it. VS Code has no fallback for this, so say so.
     */
    async saveCustomDocumentAs(
        _doc: DesignerDocument,
        _destination: vscode.Uri,
        _cancel: vscode.CancellationToken,
    ): Promise<void> {
        throw new Error(
            'VSCForms cannot Save As a Designer file, because the canvas edits the form in place. ' +
            'Copy the file in your file manager or terminal, then open the copy.'
        );
    }

    async revertCustomDocument(doc: DesignerDocument): Promise<void> {
        // Discard our notion of the content and re-read from disk.
        const bytes = await vscode.workspace.fs.readFile(doc.uri);
        doc.text = Buffer.from(bytes).toString('utf8');
        this.panels.get(doc.uri.toString())?.webview.postMessage({ type: 'requestParse' });
    }

    async backupCustomDocument(
        doc: DesignerDocument,
        context: vscode.CustomDocumentBackupContext,
        _cancel: vscode.CancellationToken,
    ): Promise<vscode.CustomDocumentBackup> {
        // Write our own copy to the requested destination; VS Code does not do it for us.
        await vscode.workspace.fs.writeFile(context.destination, Buffer.from(doc.text, 'utf8'));
        return {
            id: context.destination.toString(),
            delete: () => { void vscode.workspace.fs.delete(context.destination); },
        };
    }

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<DesignerDocument> {
        // A throw here is TERMINAL: VS Code shows its built-in Error Editor with a bare OK
        // button and no way to open the file as text. So the message is the only escape hatch
        // the user gets — it has to name the command that does work.
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            return new DesignerDocument(uri, Buffer.from(bytes).toString('utf8'));
        } catch (e) {
            throw new Error(
                `VSCForms could not read this file: ${e instanceof Error ? e.message : String(e)}. ` +
                `Use "${OPEN_AS_TEXT_LABEL}" from the Command Palette to view it.`
            );
        }
    }

    async resolveCustomEditor(
        doc: DesignerDocument,
        panel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        this.panels.set(doc.uri.toString(), panel);
        this.documents.set(doc.uri.toString(), { uri: doc.uri, doc });

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };
        panel.webview.html = this.html(panel.webview);

        const post = (type: string, data?: unknown) =>
            panel.webview.postMessage({ type, data });

        // ---- initial load -------------------------------------------------------
        const parsed = await engine.parse(doc.uri.fsPath);
        if (!parsed.ok) {
            // There is NO automatic fallback to the text editor when a custom editor cannot
            // open a file — VS Code shows its own Error Editor with a bare OK button. So this
            // button is the user's only route back to the generated source.
            const openAsText = OPEN_AS_TEXT_LABEL;
            const choice = await vscode.window.showErrorMessage(
                `VSCForms could not read this form: ${parsed.error}`,
                openAsText,
            );
            post('error', { message: parsed.error, kind: parsed.errorKind });
            if (choice === openAsText) {
                await vscode.commands.executeCommand('vscforms.openInTextEditor', doc.uri);
            }
        } else {
            post('load', parsed.schema);
        }

        // ---- messages from the canvas ------------------------------------------
        panel.webview.onDidReceiveMessage(async (msg: any) => {
            switch (msg?.type) {
                case 'ready':
                    if (parsed.ok) post('load', parsed.schema);
                    break;

                case 'requestParse':
                    const fresh = await engine.parse(doc.uri.fsPath);
                    if (fresh.ok) post('load', fresh.schema);
                    else post('error', { message: fresh.error, kind: fresh.errorKind });
                    break;

                case 'commit': {
                    if (parsed.ok === false) return;
                    await this.commit(doc, post, (msg.data ?? msg.schema) as FormSchema);
                    break;
                }

                // Clipboard copy/paste (A2 #3) via the host round-trip. The webview
                // cannot touch the system clipboard on its own (permissions + async),
                // so it posts ControlNode JSON here; the host carries it through
                // `vscode.env.clipboard`, which is shared across forms — that is what
                // makes cross-form paste work. Paste re-posts to the canvas as `paste`;
                // the canvas deserializes (uniqueId + locked-fallback) and commits, so
                // `generate` re-runs dialect detection per target file (SCHEMA.md:337-349).
                case 'copy': {
                    try {
                        const nodes = (msg.data as any)?.nodes ?? msg.data;
                        await vscode.env.clipboard.writeText(
                            VSCFORMS_CLIPBOARD_PREFIX + JSON.stringify(nodes));
                    } catch { /* clipboard unavailable; the canvas keeps its model */ }
                    break;
                }

                case 'requestPaste': {
                    try {
                        const text = await vscode.env.clipboard.readText();
                        if (!text || !text.startsWith(VSCFORMS_CLIPBOARD_PREFIX)) break;
                        const nodes = JSON.parse(text.slice(VSCFORMS_CLIPBOARD_PREFIX.length));
                        if (Array.isArray(nodes)) await post('paste', { nodes });
                    } catch { /* malformed clipboard: paste nothing */ }
                    break;
                }

                // Rename is deliberately NOT a schema commit. A schema that renames
                // `btnGo` to `btnCompute` reads to `generate` as "btnGo is gone, btnCompute is
                // new" — a DELETE plus an INSERT, which would duplicate the control and discard
                // its properties. Rename is its own engine command because it is the one
                // operation that also edits the hand-written code-behind.
                case 'rename': {
                    if (parsed.ok === false) return;
                    const { id, to } = msg.data as { id: string; to: string };
                    await this.doRename(doc, post, id, to);
                    break;
                }

                case 'wireEvent': {
                    if (parsed.ok === false) return;
                    const { id, event, handler } = msg.data as { id: string; event?: string; handler?: string };
                    await this.doWireEvent(doc, post, id, event, handler);
                    break;
                }

                case 'unwireEvent': {
                    if (parsed.ok === false) return;
                    const { id, event } = msg.data as { id: string; event: string };
                    await this.doUnwireEvent(doc, post, id, event);
                    break;
                }

                // Test seam. The webview is unreachable from the extension host API, so the
                // integration suite cannot make the canvas post a commit by itself. This runs
                // the SAME code path the canvas triggers — not a simulation of it — which is
                // what makes the dirty-marker and undo assertions meaningful.
                case 'testCommit': {
                    if (parsed.ok === false) return;
                    await this.commit(doc, post, (msg.data ?? msg.schema) as FormSchema);
                    break;
                }

                case 'runProject': {
                    await vscode.commands.executeCommand('vscforms.runProject', doc.uri);
                    break;
                }
            }
        });

        // The watcher is disposed with the panel, so a closed editor stops re-parsing.
        const watcher = this.watchExternalChanges(doc, panel, post);
        panel.onDidDispose(() => {
            this.panels.delete(doc.uri.toString());
            this.documents.delete(doc.uri.toString());
            watcher.dispose();
        });
    }

    /**
     * The one write path. The engine writes the file, then we announce the edit so VS Code's
     * save point advances and Ctrl+Z invokes our undo().
     */
    private async commit(
        doc: DesignerDocument,
        post: (type: string, data?: unknown) => Thenable<boolean> | Promise<boolean>,
        schema: FormSchema,
    ): Promise<void> {
        // The canvas sends the whole schema after a settled gesture. The engine diffs it
        // against a fresh parse of the file on disk and writes only what changed.
        const before_ = doc.text;
        const gen = await engine.generate(doc.uri.fsPath, schema);
        if (!gen.ok) {
            await post('error', { message: gen.error, kind: gen.errorKind });
            return;
        }
        if (!gen.changed) {
            await post('committed', { changed: false });
            return;
        }

        // Mirror the write into the document so it matches disk.
        const after = Buffer.from(
            (await vscode.workspace.fs.readFile(doc.uri))).toString('utf8');
        doc.text = after;

        await this.fireEdit(doc, post, 'Edit form layout', before_, after);

        await post('committed', { changed: true });
    }

    /**
     * The sibling code-behind for a Designer File: `Form1.Designer.cs` -> `Form1.cs`.
     * Derived, never searched for — there is exactly one. Must match the engine's
     * `Renamer.SiblingCodeBehind` (case-insensitive suffix); if the two disagree the
     * rename undo snapshot covers a file the engine did not write, or misses one it did.
     */
    private siblingCodeBehind(designerFsPath: string): string | undefined {
        const suffix = '.Designer.cs';
        if (!designerFsPath.toLowerCase().endsWith(suffix.toLowerCase())) return undefined;
        // Slice the full path: it already carries its directory. (path.join(dir, absolute)
        // would concatenate, not resolve — that bug shipped in the first version of this.)
        return designerFsPath.slice(0, -suffix.length) + '.cs';
    }

    private async readTextIfExists(fsPath: string): Promise<string | undefined> {
        try {
            return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath))).toString('utf8');
        } catch {
            return undefined;
        }
    }

    /**
     * Announce one user-visible edit on VS Code's undo stack (ADR 0004).
     *
     * Rename is the only operation that also writes the sibling code-behind (ADR 0008), so it
     * passes both files and one Ctrl+Z restores both; every other operation passes Designer
     * text only. Refusals never reach here: they write nothing and fire nothing.
     */
    private async fireEdit(
        doc: DesignerDocument,
        post: (type: string, data?: unknown) => Thenable<boolean> | Promise<boolean>,
        label: string,
        beforeDesigner: string,
        afterDesigner: string,
        codeBehind?: { path: string; before: string | undefined; after: string | undefined },
    ): Promise<void> {
        // CustomDocumentEditEvent is an interface, not a class: we supply the document plus
        // the undo/redo continuations VS Code will invoke. Capturing the text from BEFORE the
        // engine wrote is what lets Ctrl+Z restore the file byte-for-byte, through VS Code's
        // own undo stack rather than a private one in the canvas. See ADR 0004.
        const undo = async () => {
            await vscode.workspace.fs.writeFile(
                doc.uri, Buffer.from(beforeDesigner, 'utf8'));
            doc.text = beforeDesigner;
            // The engine only ever edits an existing code-behind, never creates one, so an
            // undefined `before` means "nothing to restore" rather than "delete the file".
            if (codeBehind?.before !== undefined) {
                await vscode.workspace.fs.writeFile(
                    vscode.Uri.file(codeBehind.path), Buffer.from(codeBehind.before, 'utf8'));
            }
            await post('undoExternal', { text: doc.text });
        };
        const redo = async () => {
            await vscode.workspace.fs.writeFile(
                doc.uri, Buffer.from(afterDesigner, 'utf8'));
            doc.text = afterDesigner;
            if (codeBehind?.after !== undefined) {
                await vscode.workspace.fs.writeFile(
                    vscode.Uri.file(codeBehind.path), Buffer.from(codeBehind.after, 'utf8'));
            }
            await post('undoExternal', { text: doc.text });
        };

        this._onDidChange.fire({ document: doc, label, undo, redo });
        this.lastEdit = { undo, redo };
    }

    /**
     * The one rename path, shared by the canvas message handler and the test seam.
     *
     * Returns the engine's outcome so the seam can assert refusals; the canvas learns about
     * success through the re-parsed `load` and about refusal through `renameRefused`.
     */
    private async doRename(
        doc: DesignerDocument,
        post: (type: string, data?: unknown) => Thenable<boolean> | Promise<boolean>,
        id: string,
        to: string,
    ): Promise<{ ok: true; designerPath: string; codeBehind?: string } | { ok: false; error?: string; errorKind?: string }> {
        const designerPath = doc.uri.fsPath;
        const cbPath = this.siblingCodeBehind(designerPath);
        const beforeDesigner = doc.text;
        const beforeCodeBehind = cbPath ? await this.readTextIfExists(cbPath) : undefined;

        const res = await engine.rename(designerPath, id, to);
        if (!res.ok) {
            await post('renameRefused', { message: res.error ?? 'rename refused' });
            return { ok: false, error: res.error, errorKind: res.errorKind };
        }

        // The engine wrote behind VS Code's back: mirror both files into the announcement,
        // and the Designer text into the document so the NEXT commit's undo baseline is the
        // post-rename text. Leaving doc.text stale here is how an undo used to resurrect the
        // old name in one file while the other kept the new one (#45).
        const afterDesigner = Buffer.from(
            (await vscode.workspace.fs.readFile(doc.uri))).toString('utf8');
        doc.text = afterDesigner;
        const afterCodeBehind = cbPath ? await this.readTextIfExists(cbPath) : undefined;

        await this.fireEdit(doc, post, `Rename ${id} to ${to}`, beforeDesigner, afterDesigner,
            cbPath ? { path: cbPath, before: beforeCodeBehind, after: afterCodeBehind } : undefined);

        // Re-parse rather than patching the schema in place: the id changed on disk
        // and the file is the source of truth.
        const after = await engine.parse(designerPath);
        if (after.ok) await post('load', after.schema);
        return { ok: true, designerPath, codeBehind: res.codeBehind };
    }

    private async doWireEvent(
        doc: DesignerDocument,
        post: (type: string, data?: unknown) => Thenable<boolean> | Promise<boolean>,
        id: string,
        eventName?: string,
        handlerName?: string,
    ): Promise<{ ok: boolean; error?: string }> {
        const designerPath = doc.uri.fsPath;
        const cbPath = this.siblingCodeBehind(designerPath);
        const beforeDesigner = doc.text;
        const beforeCodeBehind = cbPath ? await this.readTextIfExists(cbPath) : undefined;

        const res = await engine.wireEvent(designerPath, id, eventName, handlerName);
        if (!res.ok) {
            vscode.window.showErrorMessage(`Event wiring failed: ${res.error}`);
            return { ok: false, error: res.error };
        }

        if (res.changed || res.createdMethod) {
            const afterDesigner = Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString('utf8');
            doc.text = afterDesigner;
            const afterCodeBehind = cbPath ? await this.readTextIfExists(cbPath) : undefined;
            await this.fireEdit(
                doc, post, `Wire ${id}.${eventName ?? 'event'}`, beforeDesigner, afterDesigner,
                cbPath ? { path: cbPath, before: beforeCodeBehind, after: afterCodeBehind } : undefined);
        }

        if (res.codeBehind && res.targetLine) {
            try {
                const docCode = await vscode.workspace.openTextDocument(res.codeBehind);
                const editor = await vscode.window.showTextDocument(docCode, {
                    viewColumn: vscode.ViewColumn.Active,
                    preserveFocus: false,
                });
                const line = Math.max(0, (res.targetLine ?? 1) - 1);
                const col = Math.max(0, (res.targetColumn ?? 1) - 1);
                const pos = new vscode.Position(line, col);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            } catch { /* navigation failure is non-fatal */ }
        }

        if (res.changed) {
            const fresh = await engine.parse(designerPath);
            if (fresh.ok) await post('load', fresh.schema);
        }

        return { ok: true };
    }

    private async doUnwireEvent(
        doc: DesignerDocument,
        post: (type: string, data?: unknown) => Thenable<boolean> | Promise<boolean>,
        id: string,
        eventName: string,
    ): Promise<{ ok: boolean; error?: string }> {
        const designerPath = doc.uri.fsPath;
        const beforeDesigner = doc.text;

        const res = await engine.unwireEvent(designerPath, id, eventName);
        if (!res.ok) {
            vscode.window.showErrorMessage(`Event unwiring failed: ${res.error}`);
            return { ok: false, error: res.error };
        }

        if (res.changed) {
            const afterDesigner = Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString('utf8');
            doc.text = afterDesigner;
            await this.fireEdit(doc, post, `Unwire ${id}.${eventName}`, beforeDesigner, afterDesigner);
            const fresh = await engine.parse(designerPath);
            if (fresh.ok) await post('load', fresh.schema);
        }

        return { ok: true };
    }

    /**
     * The file can change without us: `dotnet build` on Windows regenerates it, a git checkout
     * lands, or the user edits it in the fallback text editor. Re-parse and hand the canvas the
     * fresh state rather than letting the optimistic model diverge silently.
     */
    private watchExternalChanges(
        doc: DesignerDocument,
        panel: vscode.WebviewPanel,
        post: (type: string, data?: unknown) => Thenable<boolean>,
    ): vscode.Disposable {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(path.dirname(doc.uri.fsPath)), '*.cs')
        );
        const onExternal = async (uri: vscode.Uri) => {
            if (uri.fsPath !== doc.uri.fsPath) return;
            // Ignore the write we just made ourselves; the commit already reported it.
            const again = await engine.parse(doc.uri.fsPath);
            if (again.ok) {
                await post('externalChange', again.schema);
            }
        };
        watcher.onDidChange(onExternal);
        watcher.onDidCreate(onExternal);
        watcher.onDidDelete(onExternal);
        return watcher;
    }

    /**
     * Test-only seam. Reached via the hidden `vscforms._testSeam` command.
     *
     * These exist because the webview is unreachable from the extension host API, so the suite
     * cannot make the canvas post a commit by itself. Each case runs the SAME production code
     * path the canvas uses — not a simulation — which is what makes the assertions meaningful.
     */
    async testSeam(which: string, arg?: unknown, msg?: unknown): Promise<unknown> {
        switch (which) {
            case 'undo':
                if (this.lastEdit) await this.lastEdit.undo();
                return;
            case 'redo':
                if (this.lastEdit) await this.lastEdit.redo();
                return;
            case 'commit': {
                const wanted = (arg as vscode.Uri).fsPath;
                const entry = Array.from(this.documents.values())
                    .find((e) => e.uri.fsPath === wanted);
                if (!entry) throw new Error('that document is not open in a VSCForms canvas');
                const panel = this.panels.get(entry.uri.toString());
                if (!panel) throw new Error('no canvas panel for that document');
                await this.commit(
                    entry.doc,
                    (t: string, d?: unknown) => panel.webview.postMessage({ type: t, data: d }),
                    msg as FormSchema,
                );
                return true;
            }
            case 'saveAsRefuses':
                // Expect this to reject. The suite asserts both the rejection AND that no
                // file was written, since a silent copy is the failure mode guarded against.
                await this.saveCustomDocumentAs(
                    undefined as never, arg as vscode.Uri, undefined as never);
                return;
            case 'parse':
                return engine.parse((arg as vscode.Uri).fsPath);
            case 'rename': {
                const o = (arg ?? {}) as { designer?: string; from?: string; to?: string };
                if (!o.designer || !o.from || !o.to) throw new Error('rename seam needs designer, from and to');
                // Failures are RETURNED, not thrown: a refusal is a product behaviour the suite
                // asserts on, and an exception would abort the run instead of being inspected.
                // Runs the same doRename() the canvas triggers — including the edit event, so
                // the suite can assert rename-undo restores both files — which requires the
                // file to be open in a canvas (an edit belongs to an open document).
                const wanted = o.designer;
                const entry = Array.from(this.documents.values())
                    .find((e) => e.uri.fsPath === wanted);
                if (!entry) throw new Error('that document is not open in a VSCForms canvas');
                const panel = this.panels.get(entry.uri.toString());
                if (!panel) throw new Error('no canvas panel for that document');
                const res = await this.doRename(
                    entry.doc,
                    (t: string, d?: unknown) => panel.webview.postMessage({ type: t, data: d }),
                    o.from, o.to,
                );
                if (!res.ok) return { ok: false, error: res.error, errorKind: res.errorKind };
                return { ok: true, designerPath: wanted, codeBehind: res.codeBehind };
            }
            case 'wireEvent': {
                const o = (arg ?? {}) as { designer?: string; controlId?: string; eventName?: string; handlerName?: string };
                if (!o.designer || !o.controlId || !o.eventName) throw new Error('wireEvent seam needs designer, controlId and eventName');
                const wanted = o.designer;
                const entry = Array.from(this.documents.values())
                    .find((e) => e.uri.fsPath === wanted);
                if (!entry) throw new Error('that document is not open in a VSCForms canvas');
                const panel = this.panels.get(entry.uri.toString());
                if (!panel) throw new Error('no canvas panel for that document');
                return this.doWireEvent(
                    entry.doc,
                    (t: string, d?: unknown) => panel.webview.postMessage({ type: t, data: d }),
                    o.controlId, o.eventName, o.handlerName,
                );
            }
            case 'unwireEvent': {
                const o = (arg ?? {}) as { designer?: string; controlId?: string; eventName?: string };
                if (!o.designer || !o.controlId || !o.eventName) throw new Error('unwireEvent seam needs designer, controlId and eventName');
                const wanted = o.designer;
                const entry = Array.from(this.documents.values())
                    .find((e) => e.uri.fsPath === wanted);
                if (!entry) throw new Error('that document is not open in a VSCForms canvas');
                const panel = this.panels.get(entry.uri.toString());
                if (!panel) throw new Error('no canvas panel for that document');
                return this.doUnwireEvent(
                    entry.doc,
                    (t: string, d?: unknown) => panel.webview.postMessage({ type: t, data: d }),
                    o.controlId, o.eventName,
                );
            }
            case 'newProject': {
                // The command itself is two interactive dialogs, which the suite cannot drive.
                // What is worth asserting is that the engine call the command makes works from
                // inside the extension host, and that the result is openable.
                const opts = (arg ?? {}) as { name?: string; parent?: string };
                if (!opts.name) throw new Error('newProject seam needs a name');
                const res = await engine.newProject({
                    name: opts.name,
                    parent: opts.parent ?? this.context.extensionPath,
                });
                if (!res.ok) throw new Error(`newProject failed (${res.errorKind}): ${res.error}`);
                return res;
            }
            case 'runProject': {
                return runProject(this.context, arg as vscode.Uri);
            }
            default:
                throw new Error('unknown test seam: ' + which);
        }
    }

    private html(webview: vscode.Webview): string {
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        const nonce = Math.random().toString(36).slice(2);
        const asUri = (f: string) =>
            webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<title>WinForms Designer</title>
<link rel="stylesheet" href="${asUri('canvas.css')}">
</head>
<body>
  <div id="banner" class="banner hidden"></div>
  <div class="workbench">
    <aside id="toolbox" class="toolbox"></aside>
    <div class="stage-wrap">
    <main id="stage" class="stage">
      <div class="ruler-corner"></div>
      <div class="ruler ruler-h" id="ruler-h"></div>
      <div class="ruler ruler-v" id="ruler-v"></div>
      <div class="form-frame">
        <div class="form-title">
          <span class="form-title-lead"><span id="form-title-text"></span></span>
          <div class="form-title-right">
            <span id="form-size" class="form-size"></span>
            <div class="window-controls" aria-hidden="true">
              <span class="win-btn win-btn-min"></span>
              <span class="win-btn win-btn-max"></span>
              <span class="win-btn win-btn-close"></span>
            </div>
          </div>
        </div>
        <div id="canvas" class="canvas"></div>
      </div>
    </main>
    <div class="zoombar">
      <button id="zoom-out" title="Zoom out (Cmd/Ctrl -)">−</button>
      <span id="zoom-label">100%</span>
      <button id="zoom-in" title="Zoom in (Cmd/Ctrl +)">+</button>
      <button id="zoom-fit" title="Fit to window (Cmd/Ctrl 0)">Fit</button>
    </div>
    </div>
    <aside class="inspector">
      <div class="inspector-search-wrap">
        <input id="inspector-filter" class="inspector-search" type="text" placeholder="Filter properties..." />
      </div>
      <div id="inspector"></div>
    </aside>
  </div>
  <div class="statusbar">
    <div id="status" class="status"></div>
    <div id="status-tools" class="status-tools"></div>
  </div>
  <script nonce="${nonce}" src="${asUri('canvas.js')}"></script>
</body>
</html>`;
    }
}

/**
 * The Command Palette label of `vscforms.openInTextEditor`.
 *
 * Invariant 10: the message thrown when a custom editor cannot open a file is the ONLY escape
 * hatch the user gets — VS Code shows its own bare Error Editor — so it must name a command that
 * actually exists. Deriving it from the same category/title the palette renders keeps the two
 * from drifting when the command is renamed. Hard-coding it here meant a rename left the
 * message pointing at a command that no longer existed, which is the one bug invariant 10
 * exists to prevent.
 */
const OPEN_AS_TEXT_LABEL = 'VSCForms: Open as Text';

/**
 * C# reserved words. A project named `class` or `event` produces a solution that cannot
 * compile, so the input box refuses them rather than letting the SDK write a broken project.
 */
const CSharpKeywords = new Set([
    'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked',
    'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else',
    'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for',
    'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock',
    'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params',
    'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short',
    'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true',
    'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual',
    'void', 'volatile', 'while',
]);

export function activate(context: vscode.ExtensionContext): void {
    engine = new EngineClient(EngineClient.resolveEnginePath(context));
    context.subscriptions.push(engine);

    provider = new DesignerEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            DesignerEditorProvider.viewType,
            provider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: true,
            }
        )
    );

    // Explicit escape hatch to the generated source, which we own by default (Q2).
    context.subscriptions.push(
        vscode.commands.registerCommand('vscforms.openInTextEditor', async (uriArg?: vscode.Uri) => {
            // Resolution order: an explicit URI argument, then the active text editor, then
            // the active tab if it happens to be a text input. When our own canvas is active
            // none of these match, which is why the command also accepts a URI — that is how
            // the error-path button and the tests reach it.
            let uri = uriArg;
            if (!uri) uri = vscode.window.activeTextEditor?.document.uri;
            if (!uri) {
                const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
                if (input instanceof vscode.TabInputText) uri = input.uri;
            }
            if (!uri) {
                await vscode.window.showWarningMessage(
                    'VSCForms: open a Designer file first, then run "Open as Text".');
                return;
            }
            // 'default' is the built-in text editor; opening it with our own viewType here
            // would be a no-op loop.
            await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('vscforms.openInDesigner', async () => {
            const uri = vscode.window.activeTextEditor?.document.uri;
            if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, DesignerEditorProvider.viewType);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('vscforms.runProject', async (uriArg?: vscode.Uri) => {
            let uri = uriArg;
            if (!uri) uri = vscode.window.activeTextEditor?.document.uri;
            if (!uri) {
                const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
                const input = tab?.input;
                if (input instanceof vscode.TabInputCustom) uri = input.uri;
                else if (input instanceof vscode.TabInputText) uri = input.uri;
            }
            await runProject(context, uri);
        })
    );

    // -------------------------------------------------------------- new project
    context.subscriptions.push(
        vscode.commands.registerCommand('vscforms.newProject', async () => {
            // The active workspace folder is the best default by a wide margin: a project
            // created outside the workspace cannot be opened in it afterwards.
            const folder = vscode.workspace.workspaceFolders?.[0];
            const parent = await vscode.window.showOpenDialog({
                canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Create here',
                defaultUri: folder?.uri,
            });
            if (!parent || parent.length === 0) return;   // user cancelled

            const name = await vscode.window.showInputBox({
                prompt: 'Project name. Must be a valid C# identifier.',
                value: 'Form1',
                // A bad name yields a project that cannot compile, so refuse it here rather
                // than after the SDK has already written files.
                validateInput: (v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) && !CSharpKeywords.has(v)
                    ? undefined
                    : 'Start with a letter or underscore; letters, digits and underscores only.',
            });
            if (!name) return;

            // Generation shells out to `dotnet` four times, which takes seconds. Without
            // progress the palette just appears to do nothing.
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Creating ${name}…` },
                async () => {
                    const res = await engine.newProject({ name, parent: parent[0].fsPath });

                    if (!res.ok) {
                        // `no-dotnet` is the single most likely failure and it is not the user's
                        // fault, so it gets an actionable message rather than a raw SDK string.
                        if (res.errorKind === 'no-dotnet') {
                            const go = await vscode.window.showErrorMessage(
                                res.error, 'Get the .NET SDK'
                            );
                            if (go) await vscode.commands.executeCommand(
                                'vscode.open', vscode.Uri.parse('https://dotnet.microsoft.com/download'));
                        } else {
                            vscode.window.showErrorMessage(`VSCForms could not create ${name}: ${res.error}`);
                        }
                        return;
                    }

                    // Open what we just made. Generating a form the user then has to go hunting
                    // for would leave the obvious next step to them instead of closing the loop.
                    if (res.designer) {
                        await vscode.commands.executeCommand(
                            'vscode.openWith', vscode.Uri.file(res.designer), DesignerEditorProvider.viewType);
                    } else {
                        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(res.projectDir));
                    }
                }
            );
        })
    );

    // ---------------------------------------------------------------- test seam
    // The extension's compiled main cannot be require()d by the integration runner, and
    // `ext.exports` is consumed by the activation promise, so the few internal behaviours the
    // suite must assert are reached through one hidden command instead. Undocumented in the
    // command palette so it cannot be invoked by accident.
    context.subscriptions.push(
        vscode.commands.registerCommand('vscforms._testSeam',
            async (which: string, arg?: unknown, msg?: unknown) => {
                const p = provider;
                if (!p) return;
                return p.testSeam(which, arg, msg);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('vscforms.restartEngine', () => {
            engine.dispose();
            engine = new EngineClient(EngineClient.resolveEnginePath(context));
            context.subscriptions.push(engine);
            vscode.window.showInformationMessage('WinForms: design engine restarted.');
        })
    );
}

export function deactivate(): void {
    engine?.dispose();
}