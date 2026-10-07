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
    /** Selected ids. A Set, not a string: multi-select is the base case, not a mode. */
    let selection = new Set();
    /** Set when the form refuses editing: canvas becomes read-only. */
    let readOnly = false;
    /** The container we have "drilled into" via double-click. When set, only its
     *  children are selectable. Click outside or Escape to exit. */
    let activeContainer = null;
    // No local undo stack: undo/redo is delegated to VS Code so the canvas and the text
    // editor share one history. See the keydown handler at the bottom of this file.

    const SNAP = 4;          // px within which an edge snaps
    const GRID = 8;          // movement granularity

    // ------------------------------------------------------------- view state
    // Zoom and pan are VIEW state: they never touch `schema`, never post a commit, and are
    // never undoable. That is why they need no protocol change and no engine work.
    //
    // Zoom is a transform, so every control moves for free. The cost is that
    // `getBoundingClientRect()` on a transformed element returns SCALED pixels — so every
    // pointer delta must be divided by the scale. `formDelta()` is the single place that
    // happens; see docs/spec-canvas-qol.md §1.
    const ZOOM_MIN = 0.25;
    const ZOOM_MAX = 4;
    const ZOOM_STEP = 1.25;
    const view = { scale: 1, panning: false, snap: true };

    /** Pointer delta in FORM units. The only place the scale is divided out. */
    function formDelta(ev, origin) {
        const k = view.scale || 1;
        return { dx: (ev.clientX - origin.mx) / k, dy: (ev.clientY - origin.my) / k };
    }

    /** Round to the grid in FORM space, never in screen space — screen rounding drifts at
     *  fractional zoom and pulls controls off the grid they are snapped to. */
    function snapTo(v) {
        return view.snap ? Math.round(v / GRID) * GRID : Math.round(v);
    }

    function frameEl() { return document.querySelector('.form-frame') || $('canvas'); }

    function applyZoom() {
        const k = view.scale;
        // Transform the outer frame container (or canvas fallback if no frame exists).
        // Since #canvas is a child of .form-frame, scaling both would multiply the scale
        // (effective scale = k * k), causing the form window to appear disproportionately
        // larger than its child elements at low zoom levels.
        const frame = frameEl();
        const canvas = $('canvas');
        if (frame) {
            frame.style.transformOrigin = '0 0';
            frame.style.transform = `scale(${k})`;
            if (canvas && canvas !== frame) {
                canvas.style.transform = '';
            }
        }
        const label = $('zoom-label');
        if (label) label.textContent = Math.round(k * 100) + '%';
        renderRulers();
    }

    /** Zoom about the cursor, keeping the form-space point under it under it. */
    function zoomAt(cx, cy, factor) {
        const host = frameEl();
        if (!host) return;
        const k0 = view.scale || 1;
        const k1 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k0 * factor));
        if (k1 === k0) return;

        const rect = host.getBoundingClientRect();
        // Form-space point currently under the pointer.
        const fx = (cx - rect.left) / k0;
        const fy = (cy - rect.top) / k0;

        view.scale = k1;
        applyZoom();

        // Without re-scrolling, zooming about the cursor slides the form out from under the
        // user's hand — the classic reason "zoom to cursor" feels broken.
        host.scrollLeft = (host.scrollLeft || 0) + (cx - rect.left) - fx * k1;
        host.scrollTop = (host.scrollTop || 0) + (cy - rect.top) - fy * k1;
    }

    function zoomBy(factor) {
        const host = frameEl();
        if (!host) return;
        const r = host.getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    }

    function setZoom(k) {
        view.scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));
        applyZoom();
    }

    function zoomToFit() {
        const host = frameEl();
        const canvas = $('canvas');
        if (!host || !canvas || !schema) return;
        const stage = document.querySelector('.stage');
        const availW = (stage && stage.clientWidth) || 0;
        const availH = (stage && stage.clientHeight) || 0;
        if (!availW || !availH) return;
        // 40px of chrome for the frame border and title bar.
        setZoom(Math.min(availW / (schema.form.clientSize.width + 40),
                         availH / (schema.form.clientSize.height + 60)));
    }

    /** Cheap orientation, not a measuring instrument: a tick every 5 grid units, scaled with
     *  the canvas so a tick keeps meaning the same form distance at any zoom. */
    function renderRulers() {
        const major = GRID * 5 * view.scale;
        for (const id of ['ruler-h', 'ruler-v']) {
            const r = $(id);
            if (!r) continue;
            r.style.backgroundSize = (id === 'ruler-h' ? `${major}px 100%` : `100% ${major}px`);
        }
    }

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
        // Leaf widgets — docs/spec-leaf-widgets.md. Every row here needs a matching row in
        // engine/src/TypeTable.cs: a type the engine knows but the canvas does not renders as a
        // locked box with no stated reason, and one the canvas knows but the engine does not
        // accepts input the patcher then silently discards.
        ['TrackBar', 't-trackbar', '#7ec7ff'],
        ['ProgressBar', 't-progressbar', '#3a3d41'],
        ['NumericUpDown', 't-numericupdown', '#2a2a2a'],
        ['DateTimePicker', 't-datetimepicker', '#2a2a2a'],
        // Phase B — TabControl & TabPage
        ['TabControl', 't-tabcontrol', '#3a3d41'],
        ['TabPage', 't-tabpage', '#2d2d2d'],
        // Phase C — Placeholders
        ['DataGridView', 't-datagridview', '#252526'],
        ['ListView', 't-listview', '#252526'],
        ['TreeView', 't-treeview', '#252526'],
    ];
    const PREFIX = {
        Button: 'btn', Label: 'lbl', TextBox: 'txt', CheckBox: 'chk',
        RadioButton: 'rad', ComboBox: 'cbo', ListBox: 'lst', PictureBox: 'pic',
        Panel: 'pnl', GroupBox: 'grp',
        TrackBar: 'trk', ProgressBar: 'prg', NumericUpDown: 'num', DateTimePicker: 'dtp',
        TabControl: 'tab', TabPage: 'tab',
        DataGridView: 'dgv', ListView: 'lvw', TreeView: 'tvw',
    };

    /**
     * Types that render NO text. `Text` is disabled for these rather than wired to a property
     * that does not exist on the control — an editable field that goes nowhere is worse than no
     * field, because it looks like it works.
     */
    const NO_TEXT = new Set(['Panel', 'TrackBar', 'ProgressBar', 'NumericUpDown', 'DateTimePicker',
        'TabControl', 'DataGridView', 'ListView', 'TreeView']);

    /** Types whose Font is meaningful. A Panel has no text to render, so a font on it is noise. */
    const HAS_FONT = new Set(['Button', 'Label', 'TextBox', 'CheckBox', 'RadioButton',
        'ComboBox', 'ListBox', 'GroupBox', 'Form', 'TabPage']);

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

    /** Returns the container control that directly contains `id`, or null if top-level. */
    function findContainer(id) {
        if (!schema) return null;
        function walk(nodes, parent) {
            for (const n of nodes || []) {
                if (n.id === id) return parent;
                const found = walk(n.children, n);
                if (found) return found;
            }
            return null;
        }
        return walk(schema.controls, null);
    }

    /** Returns true if `id` is inside `activeContainer` (or is the activeContainer itself). */
    function inActiveContainer(id) {
        if (!activeContainer) return true; // no drill-down = everything selectable
        if (id === activeContainer.id) return true;
        let c = findControl(id);
        while (c) {
            if (c.id === activeContainer.id) return true;
            c = findContainer(c.id);
        }
        return false;
    }

    /** Selected controls, in schema order so alignment output is deterministic. */
    function selected() {
        return allControls(schema ? schema.controls : []).filter((c) => selection.has(c.id));
    }

    /** The selection can be edited only when it is non-empty, not refused, and fully modelled. */
    function selectionEditable() {
        const s = selected();
        return s.length > 0 && !readOnly && s.every((c) => !c.locked);
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
    function containerTypes() { return new Set(['Panel', 'GroupBox', 'TabControl', 'TabPage']); }

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
    let bannerDismissed = false;
    function renderBanner() {
        const banner = $('banner');
        if (!schema || (bannerDismissed && (!schema.analysis.refuses || schema.analysis.refuses.length === 0))) {
            banner.classList.add('hidden');
            return;
        }
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

        const closeBtn = el('button', 'banner-close', '✕');
        closeBtn.title = 'Dismiss banner';
        closeBtn.setAttribute('aria-label', 'Dismiss banner');
        closeBtn.addEventListener('click', () => {
            bannerDismissed = true;
            banner.classList.add('hidden');
        });
        banner.appendChild(closeBtn);

        banner.classList.remove('hidden');
        // Layout is done with flexbox (see .workbench.banner-on), so there is no need to
        // measure the banner and set a pixel height — which was both fragile and the reason
        // this function needed requestAnimationFrame.
        const wb = document.querySelector('.workbench');
        if (wb) wb.classList.add('banner-on');
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
            } else if (['DataGridView', 'ListView', 'TreeView'].includes(simple)) {
                node.classList.add('t-placeholder-ctl');
                node.querySelector('.ctl-caption').textContent = `${c.id} (${simple})`;
            }
        }
        if (readOnly) node.classList.add('readonly');

        // Active container (drill-down) gets a distinct ring so the user knows the scope.
        if (activeContainer && c.id === activeContainer.id) {
            node.classList.add('active-container');
        }

        if (selection.has(c.id)) {
            node.classList.add('selected');
            // Handles only make sense for a single selection; on a group they would imply the
            // group can be resized, which is not what a drag does.
            if (selection.size === 1 && !c.locked && !readOnly) renderHandles(node);
        }

        // A container positions its children absolutely, so it must not be a flex/column
        // layout itself or the children would be reflowed. This is true whether or not it
        // currently has children.
        if (isContainer) node.classList.add('t-container');

        node.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('handle')) return;
            // Shift+click extends rather than replaces; a plain click always collapses, so the
            // selection can never contain a control the user cannot see selected.
            // A Locked Control must never enter the selection. Not merely because it cannot be
            // dragged: `selection` is what a group drag iterates, so a locked member would be
            // MOVED by dragging a sibling — writing a control we have promised never to write
            // (AGENTS.md invariant 4). The guard has to be before select(), not after it.
            if (c.locked) { select(c.id); return; }
            if (readOnly) return;

            const extend = e.shiftKey;
            if (extend) select(c.id, true); else if (!selection.has(c.id) || selection.size > 1) select(c.id);
            beginDrag(e, c, node, containerNode);
        });
        node.addEventListener('dblclick', (e) => {
            if (c.locked || readOnly) return;
            const simple = simpleName(c.type);
            if (containerTypes().has(simple)) {
                // Enter container: double-click a GroupBox, Panel, TabControl, TabPage
                activeContainer = c;
                selection = new Set();
                renderCanvas();
                renderInspector();
                renderStatus('Entered ' + c.id + ' — double-click outside or press Escape to exit', 'ok');
            } else {
                select(c.id);
            }
        });
        node.addEventListener('keydown', (e) => {
            if (c.locked || readOnly) return;
            // GRID is FORM units. A nudge must never be "8 screen pixels" — at 50% zoom that
            // would be a 16px move, and the control would drift off its grid.
            const step = e.shiftKey ? GRID * 2 : GRID;
            const many = selected();
            const nudgeTarget = many.length > 1 && many.some((m) => m.id === c.id) ? many : [c];
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                for (const t of nudgeTarget) deleteControl(t.id);
                return;
            }
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
            if (!d) return;
            e.preventDefault();
            for (const t of nudgeTarget) nudge(t, d[0], d[1]);
        });

        parent.appendChild(node);

        if (isContainer) {
            // GroupBox draws its caption in the border; Panel has none. Caption must be
            // inserted BEFORE children so it sits under them in paint order.
            if (simple === 'GroupBox') {
                const label = el('div', 'ctl-caption');
                label.textContent = c.properties.text || 'GroupBox';
                node.insertBefore(label, node.firstChild);
            } else if (simple === 'TabControl') {
                const strip = el('div', 'tab-strip');
                const pages = (c.children || []).filter((ch) => simpleName(ch.type) === 'TabPage');
                let activeId = pages.length > 0 ? pages[0].id : null;
                for (const p of pages) {
                    if (selection.has(p.id) || allControls(p.children).some((g) => selection.has(g.id))) {
                        activeId = p.id;
                        break;
                    }
                }
                for (const p of pages) {
                    const tabBtn = el('div', 'tab-item' + (p.id === activeId ? ' active' : ''));
                    tabBtn.textContent = p.properties.text || p.id;
                    tabBtn.addEventListener('mousedown', (e) => {
                        e.stopPropagation();
                        select(p.id);
                    });
                    strip.appendChild(tabBtn);
                }
                node.insertBefore(strip, node.firstChild);

                for (const child of c.children || []) renderControl(node, child, node);

                if (pages.length > 1) {
                    for (const ch of node.children) {
                        if (ch.classList && ch.classList.contains('t-tabpage') && ch.dataset.id !== activeId) {
                            ch.classList.add('tabpage-hidden');
                        }
                    }
                }
                return;
            }
            for (const child of c.children || []) renderControl(node, child, node);
        }
    }

    function renderHandles(node) {
        for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
            const h = el('div', 'handle ' + dir);
            h.dataset.dir = dir;
            h.addEventListener('mousedown', (e) => {
                const c = findControl(node.dataset.id);
                if (!c || c.locked || readOnly) return;
                e.stopPropagation();
                beginResize(e, c, node, dir);
            });
            node.appendChild(h);
        }
    }

    // ------------------------------------------------------------- selection
    function select(id, extend) {
        if (id && !inActiveContainer(id)) return; // ignore clicks outside active container
        if (extend) {
            if (selection.has(id)) selection.delete(id); else selection.add(id);
        } else {
            selection = new Set(id ? [id] : []);
        }
        renderCanvas();
        renderInspector();
        renderStatusForSelection();
    }

    /** Select everything in a rectangle. Marquee selection is view state — it posts nothing. */
    function selectInRect(a, b) {
        const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
        const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
        selection = new Set(
            allControls(schema ? schema.controls : [])
                .filter((c) => !c.locked
                    && c.properties.x < x2 && c.properties.x + c.properties.width > x1
                    && c.properties.y < y2 && c.properties.y + c.properties.height > y1
                    && inActiveContainer(c.id))
                .map((c) => c.id));
        renderCanvas();
        renderInspector();
        renderStatusForSelection();
    }

    function renderStatusForSelection() {
        const n = selection.size;
        if (n === 0) return;
        const el = $('status');
        if (el) el.textContent = `${n} control${n > 1 ? 's' : ''} selected.`;
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

    // ------------------------------------------------------- align / distribute
    /**
     * Alignment is pure geometry over data the schema already holds, so it needs no protocol
     * change. One commit covers the whole group: N controls moved is one user action and must
     * be one undo step.
     */
    function align(kind) {
        const s = selected();
        if (s.length < 2 || !selectionEditable()) return;

        // Distribute evens the GAPS between the extremes, which is what every designer means
        // by it. Distributing the control centres would be a different, rarer operation.
        //
        // It is a GROUP operation and therefore sits OUTSIDE the per-control loop below. The
        // first version put it inside as a `case` with a `return`, which exited align() before
        // commit() — so it mutated the optimistic model, posted nothing, and never wrote the
        // file. The canvas harness had no distribute case, so nothing caught it.
        if (kind === 'dist-v' || kind === 'dist-h') {
            distribute(kind === 'dist-h' ? 'x' : 'y', kind === 'dist-h' ? 'width' : 'height', s);
            commit();
            renderCanvas();
            return;
        }

        const left = Math.min(...s.map((c) => c.properties.x));
        const right = Math.max(...s.map((c) => c.properties.x + c.properties.width));
        const top = Math.min(...s.map((c) => c.properties.y));
        const bottom = Math.max(...s.map((c) => c.properties.y + c.properties.height));

        for (const c of s) {
            const p = c.properties;
            switch (kind) {
                case 'left': p.x = left; break;
                case 'right': p.x = right - p.width; break;
                case 'hcenter': p.x = Math.round((left + right - p.width) / 2); break;
                case 'top': p.y = top; break;
                case 'bottom': p.y = bottom - p.height; break;
                case 'vcenter': p.y = Math.round((top + bottom - p.height) / 2); break;
            }
        }
        commit();
        renderCanvas();
    }

    /**
     * Even out the gaps between the extremes along one axis. The two outermost controls stay
     * put; everything between them is repositioned so each gap is the same size.
     */
    function distribute(axis, extentAxis, group) {
        const sorted = [...group].sort((a, b) => a.properties[axis] - b.properties[axis]);
        const gaps = sorted.length - 1;
        if (gaps < 1) return;

        const first = sorted[0].properties;
        const last = sorted[sorted.length - 1].properties;
        const span = last[axis] + last[extentAxis] - first[axis];
        const used = sorted.reduce((n, c) => n + c.properties[extentAxis], 0);
        const slack = span - used;
        if (slack <= 0) return;   // no room to distribute into; leave the layout alone

        const step = slack / gaps;
        let cursor = first[axis] + sorted[0].properties[extentAxis];
        for (let i = 1; i < sorted.length - 1; i++) {
            cursor += step;
            sorted[i].properties[axis] = Math.round(cursor);
            cursor += sorted[i].properties[extentAxis];
        }
    }

    /** The operations a multi-selection offers, also bound to keyboard shortcuts. */
    function alignActions() {
        return [
            ['Align Left', () => align('left')],
            ['Align Center', () => align('hcenter')],
            ['Align Right', () => align('right')],
            ['Align Top', () => align('top')],
            ['Align Middle', () => align('vcenter')],
            ['Align Bottom', () => align('bottom')],
            ['Distribute Horizontally', () => align('dist-h')],
            ['Distribute Vertically', () => align('dist-v')],
        ];
    }

    /**
     * Align shortcuts, matching the VS designer: Cmd/Ctrl + L/R/T/B/M/C. Distribution is
     * bound to Cmd/Ctrl + Shift + the same keys, which is what the VS designer uses.
     */
    const ALIGN_KEYS = { l: 'left', c: 'hcenter', r: 'right', t: 'top', m: 'vcenter', b: 'bottom' };
    const DISTRIBUTE_KEYS = { h: 'dist-h', v: 'dist-v' };

    // ------------------------------------------------------------- duplicate
    /**
     * Ctrl/Cmd+D rather than clipboard copy/paste. Clipboard in a webview needs permissions and
     * an async round-trip through the extension host; duplicate gets most of the value for none
     * of the risk, and can grow into real copy/paste later without a schema change.
     */
    function duplicateSelected() {
        if (readOnly) return;
        const s = selected().filter((c) => !c.locked);
        if (!s.length) return;

        const used = new Set(allControls(schema.controls).map((c) => c.id));
        const copies = s.map((src) => {
            const copy = JSON.parse(JSON.stringify(src));
            copy.id = uniqueId(used, src.id);
            // Offset by one grid unit so the copy does not sit exactly under the original.
            copy.properties.x += GRID;
            copy.properties.y += GRID;
            schema.analysis.modelledCount += 1;
            return copy;
        });
        schema.controls.push(...copies);
        selection = new Set(copies.map((c) => c.id));
        recomputeCoverage();
        commit();
        renderCanvas();
        renderInspector();
    }

    /** btnSubmit -> btnSubmit2, btnSubmit3 … never colliding with an existing name. */
    function uniqueId(used, base) {
        let n = 2;
        let candidate = base + n;
        while (used.has(candidate)) { n += 1; candidate = base + n; }
        used.add(candidate);
        return candidate;
    }

    /** The live DOM node for a control id. Re-resolved per frame: a selection change
     *  re-renders the canvas and replaces every node, so a captured node can be detached. */
    function nodeFor(id) {
        const canvas = $('canvas');
        if (!canvas) return null;
        return Array.from(canvas.querySelectorAll('.ctl')).find((n) => n.dataset.id === id) || null;
    }

    // ------------------------------------------------------------------ drag
    function beginDrag(e, c, node, containerNode) {
        e.preventDefault();
        const origin = { mx: e.clientX, my: e.clientY, x: c.properties.x, y: c.properties.y };
        const parentBox = containerNode
            ? containerNode.getBoundingClientRect()
            : $('canvas').getBoundingClientRect();

        // Dragging any member of a multi-selection moves the WHOLE selection by one delta,
        // which is what makes group positioning possible at all.
        const group = selection.size > 1 ? selected() : [c];
        const groupStart = group.map((g) => ({ g, x: g.properties.x, y: g.properties.y }));

        function move(ev) {
            // Divide the scale out FIRST, then snap in form space. Snapping in screen space
            // drifts at fractional zoom and pulls controls off the grid.
            const { dx, dy } = formDelta(ev, origin);
            const stepX = snapTo(dx);
            const stepY = snapTo(dy);
            for (const s of groupStart) {
                s.g.properties.x = s.x + stepX;
                s.g.properties.y = s.y + stepY;
                const n = nodeFor(s.g.id);
                if (n) {
                    n.style.left = s.g.properties.x + 'px';
                    n.style.top = s.g.properties.y + 'px';
                }
            }
            showGuides(c, parentBox);
            updateInspectorValues();
        }
        function up() {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            clearGuides();
            const moved = groupStart.some((s) => s.g.properties.x !== s.x || s.g.properties.y !== s.y);
            if (moved) commit();
        }
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }

    function beginResize(e, c, node, dir) {
        e.preventDefault();
        const o = { x: c.properties.x, y: c.properties.y, w: c.properties.width, h: c.properties.height };
        function move(ev) {
            // Same rule as drag: form units in, form units out.
            const { dx, dy } = formDelta(ev, { mx: e.clientX, my: e.clientY });
            let { x, y, w, h } = o;
            if (dir.includes('e')) w = Math.max(o.w + dx, 2);
            if (dir.includes('s')) h = Math.max(o.h + dy, 2);
            if (dir.includes('w')) { w = Math.max(o.w - dx, 2); x = o.x + (o.w - w); }
            if (dir.includes('n')) { h = Math.max(o.h - dy, 2); y = o.y + (o.h - h); }
            c.properties.x = Math.round(x); c.properties.y = Math.round(y);
            c.properties.width = Math.round(w); c.properties.height = Math.round(h);
            const live = nodeFor(c.id);
            if (live) {
                live.style.left = c.properties.x + 'px';
                live.style.top = c.properties.y + 'px';
                live.style.width = Math.max(c.properties.width, 2) + 'px';
                live.style.height = Math.max(c.properties.height, 2) + 'px';
            }
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
        if (!canvas) return;
        const cb = canvas.getBoundingClientRect();
        const k = view.scale || 1;
        const siblings = allControls(schema.controls).filter((o) => o.id !== c.id && o.properties);
        for (const o of siblings) {
            const oy = (cb.top - parentBox.top) / k + o.properties.y;
            if (Math.abs(c.properties.y + c.properties.height - oy) <= SNAP) {
                guides.push(makeGuide('h', oy, canvas.clientWidth));
            }
            const ox = (cb.left - parentBox.left) / k + o.properties.x;
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
        const sel = selected();
        if (sel.length === 0) {
            box.appendChild(el('div', 'empty', 'Select a control to edit its properties.'));
            return;
        }
        if (sel.length > 1) {
            // A shared X/Y/Width/Height would be a lie unless every selected control happens
            // to agree, so a multi-selection shows only what is genuinely common plus the
            // operations that act on the group.
            box.appendChild(el('h3', null, `${sel.length} controls selected`));
            for (const [label, fn] of alignActions()) {
                box.appendChild(el('button', null, label)).addEventListener('click', fn);
            }
            return;
        }
        const c = sel[0];
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
        box.appendChild(strField('Text', c.properties.text ?? '',
            appearanceBlocked || NO_TEXT.has(simple),
            (v) => setProp(c, 'text', v)));
        box.appendChild(numField('TabIndex', c.properties.tabIndex ?? 0, appearanceBlocked,
            (v) => setProp(c, 'tabIndex', v)));

        // ---------------------------------------------------------------- appearance
        // These are already in the schema and were already parsed by the engine for all of
        // them. Wiring the inspector is what makes them reachable at all
        // (docs/spec-features.md §3: cheapest real capability in the project — no schema
        // change, no ADR).
        box.appendChild(el('h4', null, 'Appearance'));

        // Booleans are CHECKBOXES, not text fields: "false" typed as a string is a typo that
        // silently produces a different property value.
        box.appendChild(boolField('Enabled', c.properties.enabled !== false,
            appearanceBlocked, (v) => setProp(c, 'enabled', v)));
        box.appendChild(boolField('Visible', c.properties.visible !== false,
            appearanceBlocked, (v) => setProp(c, 'visible', v)));

        box.appendChild(colorField('BackColor', c.properties.backColor ?? '',
            appearanceBlocked, (v) => setProp(c, 'backColor', v)));

        if (HAS_FONT.has(simple)) {
            const f = c.properties.font || { size: 9, bold: false, italic: false };
            box.appendChild(numField('Font size', f.size ?? 9, appearanceBlocked,
                (v) => setProp(c, 'font', Object.assign({}, f, { size: v }))));
            box.appendChild(boolField('Bold', !!f.bold, appearanceBlocked,
                (v) => setProp(c, 'font', Object.assign({}, f, { bold: v }))));
            box.appendChild(boolField('Italic', !!f.italic, appearanceBlocked,
                (v) => setProp(c, 'font', Object.assign({}, f, { italic: v }))));
        }

        // Items list editor — only for ComboBox and ListBox (they have Items in the schema)
        if ((simple === 'ComboBox' || simple === 'ListBox') && !appearanceBlocked) {
            box.appendChild(el('h4', null, 'Items'));
            const itemsContainer = el('div', 'items-editor');
            if (!c.properties.items) c.properties.items = [];
            const items = c.properties.items;

            function renderItems() {
                itemsContainer.innerHTML = '';
                items.forEach((item, idx) => {
                    const row = el('div', 'item-row');
                    const input = el('input', null, '');
                    input.type = 'text';
                    input.value = item;
                    input.addEventListener('change', () => {
                        items[idx] = input.value;
                        commit();
                    });
                    const removeBtn = el('button', 'small danger', '×');
                    removeBtn.addEventListener('click', () => {
                        items.splice(idx, 1);
                        commit();
                    });
                    row.appendChild(input);
                    row.appendChild(removeBtn);
                    itemsContainer.appendChild(row);
                });
                const addRow = el('div', 'item-row');
                const addInput = el('input', null, '');
                addInput.type = 'text';
                addInput.placeholder = 'New item…';
                const addBtn = el('button', 'small', '+');
                addBtn.addEventListener('click', () => {
                    const v = addInput.value.trim();
                    if (v) {
                        items.push(v);
                        addInput.value = '';
                        commit();
                    }
                });
                addRow.appendChild(addInput);
                addRow.appendChild(addBtn);
                itemsContainer.appendChild(addRow);
            }

            renderItems();
            box.appendChild(itemsContainer);
        }

        // TextBox-specific properties
        if (simple === 'TextBox' && !appearanceBlocked) {
            box.appendChild(el('h4', null, 'TextBox'));
            box.appendChild(boolField('Multiline', !!c.properties.multiline, appearanceBlocked,
                (v) => setProp(c, 'multiline', v)));
            box.appendChild(boolField('ReadOnly', !!c.properties.readOnly, appearanceBlocked,
                (v) => setProp(c, 'readOnly', v)));
            box.appendChild(numField('MaxLength', c.properties.maxLength ?? 32767, appearanceBlocked,
                (v) => setProp(c, 'maxLength', v)));
            box.appendChild(strField('PasswordChar', c.properties.passwordChar ?? '', appearanceBlocked,
                (v) => setProp(c, 'passwordChar', v ? v.slice(0, 1) : '')));
        }

        // Leaf widget values and ranges (TrackBar, ProgressBar, NumericUpDown)
        if (['TrackBar', 'ProgressBar', 'NumericUpDown'].includes(simple) && !appearanceBlocked) {
            box.appendChild(el('h4', null, 'Range'));
            box.appendChild(numField('Minimum', c.properties.minimum ?? 0, appearanceBlocked,
                (v) => setProp(c, 'minimum', v)));
            box.appendChild(numField('Maximum', c.properties.maximum ?? 100, appearanceBlocked,
                (v) => setProp(c, 'maximum', v)));
            box.appendChild(numField('Value', c.properties.value ?? 0, appearanceBlocked,
                (v) => setProp(c, 'value', v)));
        }

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

    function boolField(label, value, disabled, onChange) {
        const f = el('div', 'field');
        const id = 'f' + label;
        const row = el('div', 'row');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.id = id;
        box.checked = !!value;
        box.disabled = !!disabled;
        const lab = el('label', null, label);
        lab.setAttribute('for', id);
        row.appendChild(box);
        row.appendChild(lab);
        f.appendChild(row);
        box.addEventListener('change', () => onChange(!!box.checked));
        return f;
    }

    /**
     * A colour swatch. Empty means "the system default", which is why clearing it is a real
     * operation and not just a text edit — and why the swatch has a visible "no colour" state
     * rather than pretending to be white.
     */
    function colorField(label, value, disabled, onChange) {
        const f = el('div', 'field');
        f.appendChild(el('label', null, label));
        const row = el('div', 'row');
        const sw = document.createElement('input');
        sw.type = 'color';
        sw.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff';
        sw.disabled = !!disabled;
        sw.title = 'Background colour. Clear to use the system default.';
        const clear = el('button', null, 'Default');
        clear.title = 'Use the system default colour';
        clear.disabled = !!disabled;
        row.appendChild(sw);
        row.appendChild(clear);
        f.appendChild(row);
        sw.addEventListener('change', () => onChange(sw.value));
        clear.addEventListener('click', () => { sw.value = '#ffffff'; onChange(''); });
        return f;
    }

    function numField(label, value, disabled, onChange) {
        const f = el('div', 'field');
        const id = 'f' + label.replace(/\s+/g, '');
        const lab = el('label', null, label);
        lab.setAttribute('for', id);
        f.appendChild(lab);
        const i = document.createElement('input');
        i.id = id;
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
        const id = 'f' + label.replace(/\s+/g, '');
        const lab = el('label', null, label);
        lab.setAttribute('for', id);
        f.appendChild(lab);
        const i = document.createElement('input');
        i.id = id;
        i.type = 'text'; i.value = value; i.disabled = !!disabled;
        i.addEventListener('change', () => onChange(i.value));
        f.appendChild(i);
        return f;
    }
    function updateInspectorValues() {
        const sel = selected();
        if (sel.length !== 1) return;
        const c = sel[0];
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
            // WinForms design-time defaults. A control dropped at an arbitrary size is one the
            // user immediately resizes — and every resize is a real write to their file.
            TrackBar: { w: 120, h: 56, text: '' },
            ProgressBar: { w: 140, h: 20, text: '' },
            NumericUpDown: { w: 100, h: 22, text: '' },
            DateTimePicker: { w: 120, h: 23, text: '' },
            TabControl: { w: 200, h: 100, text: '' },
            TabPage: { w: 192, h: 74, text: 'TabPage' },
            DataGridView: { w: 240, h: 150, text: '' },
            ListView: { w: 120, h: 97, text: '' },
            TreeView: { w: 120, h: 97, text: '' },
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
        selection = new Set([node.id]);
        commit();
    }

    /**
     * Recompute coverage from the counts. Done in ONE place because duplicate and delete both
     * change `modelledCount`, and duplicating the formula in two places is how the Coverage
     * Banner starts disagreeing with the form it describes.
     */
    function recomputeCoverage() {
        const total = schema.analysis.modelledCount + schema.analysis.unmodelledCount;
        schema.analysis.coveragePercent = total
            ? Math.round(schema.analysis.modelledCount * 10000 / total) / 100
            : 100;
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
        recomputeCoverage();
        selection = new Set();
        commit();
    }

    // ------------------------------------------------------------ drop / paste
    // ------------------------------------------------- view gestures (zoom / pan / marquee)
    //
    // Everything in this section is VIEW state. It must never touch `schema`, never post a
    // commit, and must not be undoable — that is what lets it be added with no protocol change
    // and no engine work. If any of it ever needs to write the model, it belongs in the
    // editing section above instead.
    function setupViewGestures() {
        const stage = document.querySelector('.stage');
        const canvas = $('canvas');
        if (!stage) return;

        // --- wheel. Plain wheel SCROLLS; only Cmd/Ctrl+wheel zooms, because a trackpad pinch
        // arrives as ctrlKey+wheel and overriding plain wheel breaks every trackpad's muscle
        // memory. Shift+wheel scrolls horizontally.
        stage.addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
            }
        }, { passive: false });

        // --- Space to pan. Tracked on the stage (which covers the canvas) rather than on a
        // focused control, because focus moves between controls as the user clicks around.
        const panHost = () => document.querySelector('.form-frame') || canvas;

        stage.addEventListener('keydown', (e) => {
            if (e.code === 'Space' || e.key === ' ') {
                view.panning = true;
                stage.classList.add('panning');
                e.preventDefault();
            }
        });
        // Losing focus with Space held would otherwise leave the canvas stuck panning, which is
        // one of the most annoying states a canvas can get into.
        const releasePan = () => {
            view.panning = false;
            stage.classList.remove('panning');
        };
        stage.addEventListener('keyup', releasePan);
        stage.addEventListener('blur', releasePan);

        stage.addEventListener('mousedown', (e) => {
            // Middle mouse pans from anywhere, which is the one panning gesture that needs no
            // modifier and so cannot collide with anything.
            if (e.button === 1) { e.preventDefault(); beginPan(e, panHost()); return; }
            if (!view.panning) return;
            e.preventDefault();
            beginPan(e, panHost());
        });

        // --- marquee. Only from empty canvas: a drag that starts on a control is a move, and
        // stealing it would make every control unmovable.
        canvas.addEventListener('mousedown', (e) => {
            if (e.target !== canvas) return;      // started on a control
            if (e.button !== 0) return;
            // Click on empty canvas exits active container
            if (activeContainer) {
                activeContainer = null;
                selection = new Set();
                renderCanvas();
                renderInspector();
                renderStatus('Exited container', 'ok');
                return;
            }
            e.preventDefault();
            beginMarquee(e);
        });
    }

    function beginPan(e, host) {
        const origin = { x: e.clientX, y: e.clientY, sl: host.scrollLeft, st: host.scrollTop };
        function move(ev) {
            host.scrollLeft = origin.sl - (ev.clientX - origin.x);
            host.scrollTop = origin.st - (ev.clientY - origin.y);
        }
        function up() {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        }
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }

    function beginMarquee(e) {
        const box = el('div', 'marquee');
        $('canvas').appendChild(box);
        // Form-space origin, so the rectangle tracks the pointer at any zoom.
        const r = $('canvas').getBoundingClientRect();
        const start = { x: (e.clientX - r.left) / view.scale, y: (e.clientY - r.top) / view.scale };

        function move(ev) {
            const cur = { x: (ev.clientX - r.left) / view.scale, y: (ev.clientY - r.top) / view.scale };
            const x = Math.min(start.x, cur.x), y = Math.min(start.y, cur.y);
            const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y);
            box.style.left = x + 'px'; box.style.top = y + 'px';
            box.style.width = w + 'px'; box.style.height = h + 'px';
            selectInRect(start, cur);
        }
        function up() {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            box.remove();
        }
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }

    // ------------------------------------------------------------- zoom controls
    function setupZoomControls() {
        const bind = (id, fn) => { const n = $(id); if (n) n.addEventListener('click', fn); };
        bind('zoom-in', () => zoomBy(ZOOM_STEP));
        bind('zoom-out', () => zoomBy(1 / ZOOM_STEP));
        bind('zoom-fit', () => zoomToFit());
        applyZoom();
    }

    /**
     * The snap toggle lives in its own element, not appended to the status LINE: renderStatus
     * rewrites that element wholesale, so a control appended to it is destroyed by the first
     * status message.
     */
    function setupStatusBar() {
        const s = $('status-tools');
        if (!s) return;
        const toggle = el('button', 'snap-toggle', view.snap ? 'Snap: on' : 'Snap: off');
        toggle.title = 'Snap to the 8px grid and to other controls\' edges';
        toggle.addEventListener('click', () => {
            view.snap = !view.snap;
            toggle.textContent = view.snap ? 'Snap: on' : 'Snap: off';
        });
        s.appendChild(toggle);
    }

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
                if (msg.type === 'load') bannerDismissed = false;
                readOnly = schema.analysis.refuses.length > 0;
                selection = new Set();
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

    // Canvas shortcuts. Cmd/Ctrl+Z is deliberately absent: undo belongs to VS Code (ADR 0004).
    stageKeys();
    setupViewGestures();
    setupZoomControls();
    setupStatusBar();
    setupDrop();
    renderStatus('Waiting for the engine…');
    post('ready');

    function stageKeys() {
        const stage = document.querySelector('.stage');
        if (!stage) return;
        stage.addEventListener('keydown', (e) => {
            if (e.metaKey || e.ctrlKey) {
                switch (e.key) {
                    case '+': case '=': zoomBy(ZOOM_STEP); return;
                    case '-': zoomBy(1 / ZOOM_STEP); return;
                    case '0': setZoom(1); return;
                    case 'd': case 'D': e.preventDefault(); duplicateSelected(); return;
                    default: {
                        // Shift + the same key distributes along that axis, which is what the
                        // VS designer does. Without it, dist-v had no shortcut at all and
                        // dist-h did not exist.
                        const spread = DISTRIBUTE_KEYS[e.key.toLowerCase()];
                        if (e.shiftKey && spread) { e.preventDefault(); align(spread); return; }
                        const kind = ALIGN_KEYS[e.key.toLowerCase()];
                        if (kind) { e.preventDefault(); align(kind); }
                        return;
                    }
                }
            }
            // Escape clears the selection and cancels any in-progress gesture. Its absence is
            // felt: without it there is no way out of a selection short of clicking again.
            if (e.key === 'Escape') {
                if (activeContainer) {
                    activeContainer = null;
                    selection = new Set();
                    renderCanvas();
                    renderInspector();
                    renderStatus('Exited container', 'ok');
                } else {
                    select(null);
                }
            }
        });
    }
})();