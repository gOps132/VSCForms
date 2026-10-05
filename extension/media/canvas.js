/*
 * VSCForms design canvas.
 *
 * Model ownership: THIS FILE holds the optimistic model. The extension host and the Roslyn
 * engine are a slow validator, not the render source. A drag updates the DOM immediately and
 * only posts a commit once the gesture settles, so dragging feels instant regardless of how
 * long Roslyn takes.
 *
 * Implements SCHEMA.md. See CONTEXT.md for the vocabulary.
 */
(function () {
    'use strict';

    const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
    const post = (type, data) => vscode && vscode.postMessage({ type, data });

    // ---------------------------------------------------------------- state
    /** @type {FormSchema|null} */
    let schema = null;
    let selectedId = null;
    /** Set when the form refuses editing: canvas becomes read-only. */
    let readOnly = false;
    // No local undo stack: undo/redo is delegated to VS Code so the canvas and the text
    // editor share one history. See the keydown handler at the bottom of this file.

    const SNAP = 4;          // px within which an edge snaps
    const GRID = 8;          // movement granularity

    // ---------------------------------------------------------------- toolbox
    const HANDLED = [
        ['Button', 't-button', '#3a3d41'],
        ['Label', 't-label', '#7ec7ff'],
        ['TextBox', 't-textbox', '#1e1e1e'],
        ['CheckBox', 't-checkbox', '#7ec7ff'],
        ['RadioButton', 't-radio', '#7ec7ff'],
        ['ComboBox', 't-combobox', '#2e3134'],
        ['ListBox', 't-listbox', '#2e3134'],
        ['PictureBox', 't-picturebox', '#5a5a5a'],
        ['Panel', 't-panel', '#6b6b6b'],
        ['GroupBox', 't-groupbox', '#6b6b6b'],
    ];
    const PREFIX = {
        Button: 'btn', Label: 'lbl', TextBox: 'txt', CheckBox: 'chk',
        RadioButton: 'rad', ComboBox: 'cbo', ListBox: 'lst', PictureBox: 'pic',
        Panel: 'pnl', GroupBox: 'grp',
    };

    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    };

    // ---------------------------------------------------------------- helpers
    function allControls(list) {
        const out = [];
        (function walk(nodes) {
            for (const n of nodes || []) { out.push(n); walk(n.children); }
        })(list);
        return out;
    }
    function findControl(id) {
        return allControls(schema ? schema.controls : []).find((c) => c.id === id) || null;
    }
    function simpleName(t) { const i = t.lastIndexOf('.'); return i < 0 ? t : t.slice(i + 1); }

    /**
     * Types where an empty caption is meaningless to a user looking at the canvas, so we
     * show a faint type name instead. Everything else renders genuinely empty, because
     * "TextBox" in a text field is a claim about the form that is not true.
     */
    function emptyShowTypeName(simple) {
        return ['Button', 'CheckBox', 'RadioButton', 'ComboBox'].includes(simple);
    }

    /** Append the caption element. Kept separate so containers can reorder it. */
    function addCaption(node, text) {
        const cap = el('div', 'ctl-caption');
        cap.textContent = text;
        node.appendChild(cap);
        return cap;
    }
    function containerTypes() { return new Set(['Panel', 'GroupBox']); }

    /** Allocate an unused designer-style name: btnSubmit -> btnSubmit1, btnSubmit2... */
    function allocateName(simple) {
        const prefix = PREFIX[simple] || 'ctl';
        const used = new Set(allControls(schema.controls).map((c) => c.id));
        let n = used.size + 1;
        let candidate = prefix + n;
        while (used.has(candidate)) { n += 1; candidate = prefix + n; }
        return candidate;
    }

    // ---------------------------------------------------------------- banner
    // Coverage disclosure is mandatory. Never collapsed, never dismissible.
    function renderBanner() {
        const banner = $('banner');
        if (!schema) { banner.classList.add('hidden'); return; }
        const a = schema.analysis;
        const parts = [];
        parts.push(`<b>Coverage ${a.coveragePercent}%</b> &mdash; ${a.modelledCount} of `
            + `${a.modelledCount + a.unmodelledCount} controls are modelled.`);
        if (a.unmodelledCount > 0) {
            parts.push(`${a.unmodelledCount} shown as locked boxes; their code is preserved but never edited.`);
        }
        if (a.refuses.length > 0) {
            banner.classList.add('refusal');
            const why = a.refuses.includes('localizable')
                ? 'This form calls <code>resources.ApplyResources</code>: its text and geometry live in the sibling <code>.resx</code> file, so editing them here would not affect the running form.'
                : 'This form uses <code>Dock</code> or <code>Anchor</code>, which VSCForms does not simulate. Moving these controls would produce code that looks right here and does nothing on Windows.';
            parts.push('<b>Read-only.</b> ' + why);
        }
        if (a.warnings && a.warnings.length) {
            parts.push('<ul>' + a.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('') + '</ul>');
        }
        banner.innerHTML = parts.join('<br>');
        banner.classList.remove('hidden');
        // Layout is done with flexbox (see .workbench.banner-on), so there is no need to
        // measure the banner and set a pixel height — which was both fragile and the reason
        // this function needed requestAnimationFrame.
        document.querySelector('.workbench').classList.add('banner-on');
    }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"]/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    // ---------------------------------------------------------------- render
    function renderToolbox() {
        const box = $('toolbox');
        box.innerHTML = '<h3>Controls</h3>';
        for (const [name, cls, colour] of HANDLED) {
            const t = el('div', 'tool');
            t.title = `Add a ${name}`;
            t.draggable = true;
            t.dataset.simple = name;
            const sw = el('span', 'swatch');
            sw.style.background = colour;
            t.appendChild(sw);
            t.appendChild(el('span', null, name));
            if (readOnly) t.setAttribute('disabled', '');
            t.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/vscforms-control', name);
                e.dataTransfer.effectAllowed = 'copy';
            });
            box.appendChild(t);
        }
        const note = el('div');
        note.style.cssText = 'font-size:10px;color:var(--muted);padding:6px 4px;line-height:1.4;';
        note.textContent = 'Other control types appear as locked boxes. Their code is never touched.';
        box.appendChild(note);
    }

    function renderCanvas() {
        const canvas = $('canvas');
        canvas.innerHTML = '';
        if (!schema) return;

        canvas.style.width = Math.max(schema.form.clientSize.width, 80) + 'px';
        canvas.style.height = Math.max(schema.form.clientSize.height, 60) + 'px';
        $('form-title-text').textContent = schema.form.name;
        $('form-size').textContent = `${schema.form.clientSize.width} x ${schema.form.clientSize.height}`;

        for (const c of schema.controls) renderControl(canvas, c, null);
    }

    function renderControl(parent, c, containerNode) {
        const node = el('div', 'ctl');
        node.dataset.id = c.id;
        node.tabIndex = 0;

        const simple = simpleName(c.type);
        const isContainer = containerTypes().has(simple);
        node.classList.add('t-' + simple.toLowerCase());

        // placement is relative to the containing canvas, so nested controls offset correctly
        node.style.left = c.properties.x + 'px';
        node.style.top = c.properties.y + 'px';
        node.style.width = Math.max(c.properties.width, 2) + 'px';
        node.style.height = Math.max(c.properties.height, 2) + 'px';

        if (c.locked) {
            node.classList.add('locked');
            node.title = c.lockedReason || 'Not modelled.';
            addCaption(node, simple);
        } else {
            // A handled type with empty text is genuinely empty (a TextBox with no value, an
            // unset Label) — showing the type name there would be a lie about the form.
            const caption = c.properties.text || '';
            addCaption(node, caption);
            if (!caption && emptyShowTypeName(simple)) {
                node.classList.add('placeholder');
                node.querySelector('.ctl-caption').textContent = simple;
            }
        }
        if (readOnly) node.classList.add('readonly');

        if (c.id === selectedId) {
            node.classList.add('selected');
            if (!c.locked && !readOnly) renderHandles(node);
        }

        // A container positions its children absolutely, so it must not be a flex/column
        // layout itself or the children would be reflowed. This is true whether or not it
        // currently has children.
        if (isContainer) node.classList.add('t-container');

        node.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('handle')) return;
            select(c.id);
            if (c.locked || readOnly) return;
            beginDrag(e, c, node, containerNode);
        });
        node.addEventListener('dblclick', () => { if (!c.locked) select(c.id); });
        node.addEventListener('keydown', (e) => {
            if (c.locked || readOnly) return;
            const step = e.shiftKey ? 10 : GRID;
            if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteControl(c.id); return; }
            if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(c, -step, 0); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(c, step, 0); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(c, 0, -step); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(c, 0, step); }
        });

        parent.appendChild(node);

        if (isContainer) {
            // GroupBox draws its caption in the border; Panel has none. Caption must be
            // inserted BEFORE children so it sits under them in paint order.
            if (simple === 'GroupBox') {
                const label = el('div', 'ctl-caption');
                label.textContent = c.properties.text || 'GroupBox';
                node.insertBefore(label, node.firstChild);
            }
            for (const child of c.children || []) renderControl(node, child, node);
        }
    }

    function renderHandles(node) {
        for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
            const h = el('div', 'handle ' + dir);
            h.dataset.dir = dir;
            h.addEventListener('mousedown', (e) => {
                const c = findControl(selectedId);
                if (!c || c.locked || readOnly) return;
                e.stopPropagation();
                beginResize(e, c, node, dir);
            });
            node.appendChild(h);
        }
    }

    // ------------------------------------------------------------- selection
    function select(id) {
        selectedId = id;
        renderCanvas();
        renderInspector();
    }

    // ---------------------------------------------------------------- editing
    let commitTimer = null;
    /** Debounced commit: one write per settled gesture, not one per mousemove. */
    function commit() {
        renderAll();
        if (commitTimer) clearTimeout(commitTimer);
        commitTimer = setTimeout(() => {
            commitTimer = null;
            post('commit', schema);
        }, 220);
    }

    function nudge(c, dx, dy) {
        c.properties.x += dx;
        c.properties.y += dy;
        commit();
    }

    // ------------------------------------------------------------------ drag
    function beginDrag(e, c, node, containerNode) {
        e.preventDefault();
        const origin = { mx: e.clientX, my: e.clientY, x: c.properties.x, y: c.properties.y };
        const parentBox = containerNode
            ? containerNode.getBoundingClientRect()
            : $('canvas').getBoundingClientRect();

        function move(ev) {
            const dx = Math.round((ev.clientX - origin.mx) / GRID) * GRID;
            const dy = Math.round((ev.clientY - origin.my) / GRID) * GRID;
            c.properties.x = origin.x + dx;
            c.properties.y = origin.y + dy;
            node.style.left = c.properties.x + 'px';
            node.style.top = c.properties.y + 'px';
            showGuides(c, parentBox);
            updateInspectorValues();
        }
        function up() {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            clearGuides();
            if (c.properties.x !== origin.x || c.properties.y !== origin.y) commit();
        }
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }

    function beginResize(e, c, node, dir) {
        e.preventDefault();
        const o = { x: c.properties.x, y: c.properties.y, w: c.properties.width, h: c.properties.height };
        function move(ev) {
            const dx = ev.clientX - e.clientX;
            const dy = ev.clientY - e.clientY;
            let { x, y, w, h } = o;
            if (dir.includes('e')) w = Math.max(o.w + dx, 2);
            if (dir.includes('s')) h = Math.max(o.h + dy, 2);
            if (dir.includes('w')) { w = Math.max(o.w - dx, 2); x = o.x + (o.w - w); }
            if (dir.includes('n')) { h = Math.max(o.h - dy, 2); y = o.y + (o.h - h); }
            c.properties.x = Math.round(x); c.properties.y = Math.round(y);
            c.properties.width = Math.round(w); c.properties.height = Math.round(h);
            node.style.left = c.properties.x + 'px';
            node.style.top = c.properties.y + 'px';
            node.style.width = Math.max(c.properties.width, 2) + 'px';
            node.style.height = Math.max(c.properties.height, 2) + 'px';
            updateInspectorValues();
        }
        function up() {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            commit();
        }
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }

    // --------------------------------------------------------------- guides
    let guides = [];
    function clearGuides() { for (const g of guides) g.remove(); guides = []; }
    function showGuides(c, parentBox) {
        clearGuides();
        const canvas = $('canvas');
        const cb = canvas.getBoundingClientRect();
        const siblings = allControls(schema.controls).filter((o) => o.id !== c.id && o.properties);
        for (const o of siblings) {
            const oy = cb.top - parentBox.top + o.properties.y;
            if (Math.abs(c.properties.y + c.properties.height - oy) <= SNAP) {
                guides.push(makeGuide('h', oy, canvas.clientWidth));
            }
            const ox = cb.left - parentBox.left + o.properties.x;
            if (Math.abs(c.properties.x + c.properties.width - ox) <= SNAP) {
                guides.push(makeGuide('v', ox, canvas.clientHeight));
            }
        }
    }
    function makeGuide(dir, pos, extent) {
        const g = el('div', 'guide ' + dir);
        if (dir === 'h') { g.style.top = pos + 'px'; g.style.width = extent + 'px'; }
        else { g.style.left = pos + 'px'; g.style.height = extent + 'px'; }
        $('canvas').appendChild(g);
        return g;
    }

    // -------------------------------------------------------------- inspector
    function renderInspector() {
        const box = $('inspector');
        box.innerHTML = '';
        const c = findControl(selectedId);
        if (!c) {
            box.appendChild(el('div', 'empty', 'Select a control to edit its properties.'));
            return;
        }
        const simple = simpleName(c.type);
        box.appendChild(el('h3', null, `${simple} — ${c.id}`));

        if (c.locked) {
            const n = el('div', 'field');
            n.appendChild(el('div', 'note warn', c.lockedReason || 'Not modelled.'));
            box.appendChild(n);
            // Geometry is editable even on a locked control.
        }
        if (readOnly) {
            const n = el('div', 'field');
            n.appendChild(el('div', 'note warn',
                'This form is read-only in VSCForms. Open it as text to edit it.'));
            box.appendChild(n);
        }

        const appearanceBlocked = c.locked || readOnly;

        box.appendChild(numField('X', c.properties.x, appearanceBlocked, (v) => setProp(c, 'x', v)));
        box.appendChild(numField('Y', c.properties.y, appearanceBlocked, (v) => setProp(c, 'y', v)));
        box.appendChild(numField('Width', c.properties.width, appearanceBlocked, (v) => setProp(c, 'width', v)));
        box.appendChild(numField('Height', c.properties.height, appearanceBlocked, (v) => setProp(c, 'height', v)));
        box.appendChild(strField('Text', c.properties.text ?? '', appearanceBlocked || simple === 'Panel',
            (v) => setProp(c, 'text', v)));
        box.appendChild(numField('TabIndex', c.properties.tabIndex ?? 0, appearanceBlocked,
            (v) => setProp(c, 'tabIndex', v)));

        // Rename is its own message, not a schema edit. A schema carrying a new id reads to the
        // engine as "old one deleted, new one inserted" — which would duplicate the control and
        // throw away its properties.
        const nameField = strField('Name', c.id, appearanceBlocked, () => {});
        const nameInput = nameField.querySelector('input');
        if (nameInput) {
            nameInput.title = 'Renaming also updates the hand-written code-behind, and is '
                + 'refused if that reference is not unambiguous.';
            nameInput.addEventListener('change', () => {
                const to = nameInput.value.trim();
                nameInput.value = c.id;          // the file is the source of truth; it will re-post
                if (!to || to === c.id) return;
                post('rename', { id: c.id, to });
            });
        }
        box.appendChild(nameField);

        if (!c.locked && !readOnly) {
            box.appendChild(el('button', 'danger', `Delete ${c.id}`)).addEventListener('click', () => deleteControl(c.id));
        }
    }

    function setProp(c, key, value) { c.properties[key] = value; commit(); }

    function numField(label, value, disabled, onChange) {
        const f = el('div', 'field');
        f.appendChild(el('label', null, label));
        const i = document.createElement('input');
        i.type = 'number'; i.value = String(value); i.disabled = !!disabled;
        i.addEventListener('change', () => {
            const v = parseInt(i.value, 10);
            if (!Number.isNaN(v)) onChange(v);
        });
        f.appendChild(i);
        return f;
    }
    function strField(label, value, disabled, onChange) {
        const f = el('div', 'field');
        f.appendChild(el('label', null, label));
        const i = document.createElement('input');
        i.type = 'text'; i.value = value; i.disabled = !!disabled;
        i.addEventListener('change', () => onChange(i.value));
        f.appendChild(i);
        return f;
    }
    function updateInspectorValues() {
        const c = findControl(selectedId);
        if (!c) return;
        const ins = $('inspector');
        const inputs = ins.querySelectorAll('input');
        if (inputs.length >= 6) {
            inputs[0].value = String(c.properties.x);
            inputs[1].value = String(c.properties.y);
            inputs[2].value = String(c.properties.width);
            inputs[3].value = String(c.properties.height);
        }
    }

    // ------------------------------------------------------------ add/delete
    function addControl(simple, x, y) {
        if (readOnly) return;
        const full = 'System.Windows.Forms.' + simple;
        const defaults = {
            Button: { w: 84, h: 27, text: 'Button' },
            Label: { w: 80, h: 17, text: 'Label' },
            TextBox: { w: 160, h: 23, text: '' },
            CheckBox: { w: 110, h: 19, text: 'CheckBox' },
            RadioButton: { w: 110, h: 19, text: 'RadioButton' },
            ComboBox: { w: 140, h: 23, text: '' },
            ListBox: { w: 140, h: 80, text: '' },
            PictureBox: { w: 100, h: 100, text: '' },
            Panel: { w: 200, h: 120, text: '' },
            GroupBox: { w: 220, h: 160, text: 'GroupBox' },
        }[simple] || { w: 100, h: 30, text: simple };

        const node = {
            id: allocateName(simple),
            type: full,
            children: [],
            locked: false,
            properties: {
                x: Math.max(0, Math.round(x)),
                y: Math.max(0, Math.round(y)),
                width: defaults.w, height: defaults.h,
                text: defaults.text,
                tabIndex: schema.analysis.modelledCount,
            },
        };
        schema.controls.push(node);
        schema.analysis.modelledCount += 1;
        selectedId = node.id;
        commit();
    }

    function deleteControl(id) {
        if (readOnly) return;
        const c = findControl(id);
        if (!c || c.locked) return;
        (function prune(list) {
            for (let i = list.length - 1; i >= 0; i--) {
                if (list[i].id === id) list.splice(i, 1);
                else prune(list[i].children || []);
            }
        })(schema.controls);
        schema.analysis.modelledCount = Math.max(0, schema.analysis.modelledCount - 1);
        const total = schema.analysis.modelledCount + schema.analysis.unmodelledCount;
        schema.analysis.coveragePercent = total ? Math.round(schema.analysis.modelledCount * 10000 / total) / 100 : 100;
        selectedId = null;
        commit();
    }

    // ------------------------------------------------------------ drop / paste
    function setupDrop() {
        const canvasWrap = document.querySelector('.stage');
        canvasWrap.addEventListener('dragover', (e) => {
            if (readOnly) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        canvasWrap.addEventListener('drop', (e) => {
            if (readOnly) return;
            const simple = e.dataTransfer.getData('text/vscforms-control');
            if (!simple) return;
            e.preventDefault();
            const box = $('canvas').getBoundingClientRect();
            addControl(simple, e.clientX - box.left - 20, e.clientY - box.top - 10);
        });
    }

    // ---------------------------------------------------------------- status
    function renderStatus(msg, cls) {
        const s = $('status');
        s.innerHTML = '';
        const left = el('span', cls || null, msg);
        s.appendChild(left);
        s.appendChild(el('span', 'spacer'));
        if (schema) {
            const a = schema.analysis;
            s.appendChild(el('span', null,
                `${schema.form.name} · ${a.modelledCount + a.unmodelledCount} controls · ${a.coveragePercent}% modelled`));
        }
    }

    // ----------------------------------------------------------------- render
    function renderAll() {
        renderBanner();
        renderToolbox();
        renderCanvas();
        renderInspector();
    }

    // ---------------------------------------------------------------- messages
    window.addEventListener('message', (ev) => {
        const msg = ev.data;
        switch (msg.type) {
            case 'load':
            case 'externalChange': {
                schema = msg.data;
                readOnly = schema.analysis.refuses.length > 0;
                selectedId = null;
                renderAll();
                renderStatus(
                    msg.type === 'externalChange'
                        ? 'File changed on disk — canvas reloaded.'
                        : 'Ready.',
                    'ok');
                break;
            }
            case 'undoExternal':
                // VS Code performed undo/redo and rewrote the file. Re-parse so the canvas
                // shows the restored state rather than a stale optimistic model.
                post('requestParse');
                break;
            case 'committed':
                renderStatus(msg.data.changed ? 'Written to the Designer file.' : 'No changes to write.', 'ok');
                break;
            case 'error':
                renderStatus('Error: ' + (msg.data.message || 'unknown'), 'err');
                break;

            // A refused rename leaves the file untouched, so the status line is the only place
            // the reason can go. It is persistent rather than a transient toast precisely because
            // the user just typed a name and got nothing else in response.
            case 'renameRefused':
                renderStatus('Rename refused: ' + (msg.data.message || 'unknown'), 'err');
                break;
        }
    });

    // Undo/redo is handled by VS Code's own undo stack (the extension fires
    // CustomDocumentEditEvent with real undo/redo continuations), so we deliberately do NOT
    // intercept Cmd/Ctrl+Z here. A private model-level undo stack in the canvas would
    // double-apply against the text editor's.
    document.addEventListener('keydown', (e) => {
        if (!(e.metaKey || e.ctrlKey) || e.key !== 's') return;
        e.preventDefault();
        post('requestParse');
    });

    setupDrop();
    renderStatus('Waiting for the engine…');
    post('ready');
})();