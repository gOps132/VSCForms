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
    /**
     * Click order of the selection: the first entry is the dominant (VS primary)
     * control that align/same-size reference. A Set alone cannot hold this — its
     * iteration order is insertion order only until a delete/re-add, and marquee
     * selection never "clicks" at all. Every site that replaces `selection`
     * replaces this in the same statement.
     */
    let clickOrder = [];
    /** Set when the form refuses editing: canvas becomes read-only. */
    let readOnly = false;
    /** The container we have "drilled into" via double-click. When set, only its
     *  children are selectable. Click outside or Escape to exit. */
    let activeContainer = null;
    /** Tab-order mode: badges show each control's TabIndex and mousedown assigns the next
     *  one in click order, instead of selecting/dragging. Escape or the toggle exits. */
    let tabOrderMode = false;
    let tabOrderNext = 0;
    /** Filter text for properties in inspector. */
    let inspectorFilter = '';
    /**
     * Task 5 (#51) edited-since-load keys per control id. VS bolds non-default
     * values; the canvas holds no per-type WinForms default table (Label
     * AutoSize defaults true, Button TextAlign MiddleCenter, …), so `changed`
     * marks edit recency instead — never defaultness. Marked in setProp and
     * the geometry gesture paths, cleared on every load/externalChange.
     */
    let changedProps = new Map();
    /** Task 5 (#51) description pane: the last focused property label, so a
     *  re-render (every commit re-renders) keeps the pane text. */
    let describedProp = null;
    /**
     * Inspector sort mode. Pure VIEW state like the toolbox filter: switching views
     * re-renders the inspector only, never touches `schema` and never posts a commit
     * (renderInspector builds DOM; commit happens only on field change). Same change
     * class as shipped D1 readout — no ADR, no engine work. The engine has no category
     * table because categories never cross the protocol; the table below is the single
     * source, mirroring VS `[Category]` values (spec-property-tabs §§1–2).
     */
    let inspectorView = 'flat'; // 'flat' | 'categorized' | 'alphabetical'
    /** Filter text for the Controls toolbox. View state: never committed, never undoable. */
    let toolboxFilter = '';
    /**
     * Task 4 (#50) sticky draw-to-create tool: the simple type name armed by a
     * single toolbox click, or null when the pointer is plain. View state — arming
     * posts nothing, renders the `armed` class + crosshair, and reroutes the next
     * canvas mousedown into beginDraw (click places, drag sizes). Sticky: placing
     * keeps the arm so several controls land in a row; Escape or a second click
     * on the same tool disarms. Cleared on document load like tab-order mode.
     */
    let armedTool = null;
    // No local undo stack: undo/redo is delegated to VS Code so the canvas and the text
    // editor share one history. See the keydown handler at the bottom of this file.

    const SNAP = 4;          // px within which an edge snaps
    const GRID = 8;          // default movement granularity (view.gridSize overrides)

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
    // snapMode 'lines' is VS SnapLines (edges + centers + baselines with magnetic
    // pull, plus grid quantize); 'grid' is grid quantize only (no guides, no pull).
    // gridSize and snapMode are VIEW state like zoom and the master snap toggle:
    // they never touch `schema`, never post a commit, and need no protocol change.
    const view = { scale: 1, panning: false, snap: true, gridSize: GRID, snapMode: 'lines' };

    /** Pointer delta in FORM units. The only place the scale is divided out. */
    function formDelta(ev, origin) {
        const k = view.scale || 1;
        return { dx: (ev.clientX - origin.mx) / k, dy: (ev.clientY - origin.my) / k };
    }

    /** Round to the grid in FORM space, never in screen space — screen rounding drifts at
     *  fractional zoom and pulls controls off the grid they are snapped to. */
    function snapTo(v) {
        const g = view.gridSize > 0 ? view.gridSize : GRID;
        return view.snap ? Math.round(v / g) * g : Math.round(v);
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
        const major = (view.gridSize > 0 ? view.gridSize : GRID) * 5 * view.scale;
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

    /**
     * D10 inspector views. Hardcoded per-property category table mirroring VS
     * `[Category]` values (docs/spec-property-tabs.md §§1–2): the engine cannot load
     * .NET attributes (type resolution is purely syntactic), so categories live here,
     * next to HANDLED, as the single source. Every offered property label must have
     * an entry; anything without one falls in Misc. Labels are the inspector field
     * labels (the `label` argument to the *Field constructors below), NOT schema keys,
     * because views regroup rendered rows. Action surfaces (object selector, Arrange
     * buttons, Delete, Font dialog button is Appearance) are not properties: the
     * selector and actions stay outside the groups in every view.
     */
    const PROP_CATEGORIES = {
        'X': 'Layout', 'Y': 'Layout', 'Width': 'Layout', 'Height': 'Layout',
        'AutoSize': 'Layout',
        'Text': 'Appearance', 'Title (Text)': 'Appearance',
        'BackColor': 'Appearance', 'ForeColor': 'Appearance',
        'Font size': 'Appearance', 'Bold': 'Appearance', 'Italic': 'Appearance',
        'Font editor': 'Appearance',
        'TextAlign': 'Appearance', 'BorderStyle': 'Appearance', 'Checked': 'Appearance',
        'Enabled': 'Behavior', 'Visible': 'Behavior', 'TabIndex': 'Behavior',
        'TabStop': 'Behavior',
        'Multiline': 'Behavior', 'ReadOnly': 'Behavior', 'MaxLength': 'Behavior',
        'PasswordChar': 'Behavior', 'ScrollBars': 'Behavior',
        'Minimum': 'Behavior', 'Maximum': 'Behavior', 'Value': 'Behavior',
        'SelectedIndex': 'Behavior', 'SelectedItem': 'Behavior',
        'DropDownStyle': 'Behavior',
        'Items': 'Data',
        'Name': 'Design',
    };
    function propCategory(label) { return PROP_CATEGORIES[label] || 'Misc'; }

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

    /**
     * Click-order primary (VS "dominant" control): the first-clicked member of the
     * selection. `selected()` stays schema order for compat; align/same-size
     * reference THIS. Falls back to schema-first when the order is unknown, and to
     * null when the selection is empty.
     */
    function dominant() {
        for (const id of clickOrder) {
            if (!selection.has(id)) continue;
            const c = findControl(id);
            if (c) return c;
        }
        const s = selected();
        return s.length ? s[0] : null;
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
        // The header (title + search) is built ONCE and kept across renders: renderToolbox
        // runs on every renderAll (i.e. after every commit), and rebuilding the input each
        // time would drop focus mid-typing and lose the filter. Only the list is rebuilt.
        let search = box.querySelector('.toolbox-search');
        let list = box.querySelector('.toolbox-list');
        if (!search || !list) {
            box.innerHTML = '';
            box.appendChild(el('h3', null, 'Controls'));
            search = document.createElement('input');
            search.type = 'search';
            search.className = 'toolbox-search';
            search.placeholder = 'Filter controls…';
            search.setAttribute('aria-label', 'Filter toolbox controls');
            search.title = 'Filter controls (Ctrl+Alt+X)';
            search.style.cssText = 'width:100%;box-sizing:border-box;margin:2px 0 6px;padding:4px 6px;font-size:12px;';
            search.addEventListener('input', () => {
                toolboxFilter = search.value;
                applyToolboxFilter();
            });
            // Typing in the toolbox must not drive the canvas: without this, Delete would
            // delete the selection and arrows would nudge it mid-search.
            search.addEventListener('keydown', (e) => e.stopPropagation());
            box.appendChild(search);
            list = el('div', 'toolbox-list');
            box.appendChild(list);
            const note = el('div');
            note.style.cssText = 'font-size:10px;color:var(--muted);padding:6px 4px;line-height:1.4;';
            note.textContent = 'Other control types appear as locked boxes. Their code is never touched.';
            box.appendChild(note);
        }
        // A render triggered by something else (e.g. a commit) must not clobber typing in
        // progress. The value only differs after a fresh document load resets the filter.
        if (search.value !== toolboxFilter) search.value = toolboxFilter;
        list.innerHTML = '';
        for (const [name, cls, colour] of HANDLED) {
            const t = el('div', 'tool');
            t.title = `Add a ${name}`;
            t.draggable = true;
            t.dataset.simple = name;
            // Keyboard access to the dblclick/Enter populate path below.
            t.tabIndex = 0;
            const sw = el('span', 'swatch');
            sw.style.background = colour;
            t.appendChild(sw);
            t.appendChild(el('span', null, name));
            if (readOnly) t.setAttribute('disabled', '');
            if (armedTool === name) t.classList.add('armed');
            t.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/vscforms-control', name);
                e.dataTransfer.effectAllowed = 'copy';
            });
            // Task 4 (#50) sticky tool: a single click arms the pointer (crosshair),
            // a second click on the same tool disarms. Arming is view state — it
            // posts nothing. Refused forms never arm (read-only when refused).
            t.addEventListener('click', () => {
                if (readOnly) return;
                setArmedTool(armedTool === name ? null : name);
            });
            // Task 4 (#50) dblclick populates the active container at a cascade
            // slot through the existing addControl commit path — never a drag.
            t.addEventListener('dblclick', (e) => {
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                if (readOnly) return;
                populateTarget(name);
            });
            // Keyboard twin of dblclick: Enter on a focused tool populates.
            // stopPropagation keeps the key from reaching the stage shortcuts.
            t.addEventListener('keydown', (e) => {
                if (typeof e.stopPropagation === 'function') e.stopPropagation();
                if (readOnly) return;
                if (e.key === 'Enter') {
                    if (typeof e.preventDefault === 'function') e.preventDefault();
                    populateTarget(name);
                } else if (e.key === 'Escape') {
                    setArmedTool(null);
                }
            });
            list.appendChild(t);
        }
        applyToolboxFilter();
    }

    /** Show only the toolbox entries matching the filter. Filtering is view state: the
     *  hidden entries keep their dragstart data, so drag-to-add is untouched. */
    function applyToolboxFilter() {
        const box = $('toolbox');
        if (!box) return;
        const q = (toolboxFilter || '').trim().toLowerCase();
        for (const t of box.querySelectorAll('.tool')) {
            const name = String(t.dataset.simple || '').toLowerCase();
            t.style.display = (!q || name.includes(q)) ? '' : 'none';
        }
    }

    /** Focus the toolbox search, creating the toolbox DOM first if needed. */
    function focusToolboxSearch() {
        const box = $('toolbox');
        if (!box) return;
        let search = box.querySelector('.toolbox-search');
        if (!search) {
            renderToolbox();
            search = box.querySelector('.toolbox-search');
        }
        if (search) {
            search.focus();
            if (typeof search.select === 'function') search.select();
        }
    }

    // Choose Items / custom-control loading is deliberately NOT here. A custom type the
    // engine does not model arrives `locked`, and locked means never written — so a
    // toolbox entry for one could only ever produce controls the patcher must refuse.
    // Loading one honestly needs a protocol addition (type discovery) plus a schema shape
    // for unknown types, which is a separate, ADR-sized change. See the D5 report.

    function renderCanvas() {
        const canvas = $('canvas');
        canvas.innerHTML = '';
        if (!schema) return;

        canvas.style.width = Math.max(schema.form.clientSize.width, 80) + 'px';
        canvas.style.height = Math.max(schema.form.clientSize.height, 60) + 'px';
        canvas.style.backgroundColor = schema.form.backColor || '';
        // Task 4 (#50) sticky pointer: the crosshair is how the armed tool is
        // visible. Class for CSS, inline cursor for the harness stand-in (which
        // reads style, not stylesheets). View state only.
        if (armedTool && !readOnly) {
            canvas.classList.add('armed');
            canvas.style.cursor = 'crosshair';
        } else {
            canvas.classList.remove('armed');
            canvas.style.cursor = '';
        }
        $('form-title-text').textContent = schema.form.name;
        $('form-size').textContent = `${schema.form.clientSize.width} x ${schema.form.clientSize.height}`;

        const title = document.querySelector('.form-title');
        if (title && !title.__wired) {
            title.__wired = true;
            title.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                select(null);
            });
        }

        renderFormHandles();

        for (const c of schema.controls) renderControl(canvas, c, null);
    }

    function renderFormHandles() {
        const frame = frameEl();
        if (!frame || readOnly) return;
        for (const old of frame.querySelectorAll('.form-handle')) old.remove();
        for (const dir of ['e', 's', 'se']) {
            const h = el('div', 'form-handle ' + dir);
            h.dataset.dir = dir;
            h.addEventListener('mousedown', (e) => {
                if (readOnly) return;
                e.stopPropagation();
                beginResizeForm(e, dir);
            });
            frame.appendChild(h);
        }
    }

    function beginResizeForm(e, dir) {
        e.preventDefault();
        const o = { w: schema.form.clientSize.width, h: schema.form.clientSize.height };
        const origin = { mx: e.clientX, my: e.clientY };
        const canvas = $('canvas');
        function move(ev) {
            const { dx, dy } = formDelta(ev, origin);
            let w = o.w;
            let h = o.h;
            if (dir.includes('e')) w = Math.max(snapTo(o.w + dx), 80);
            if (dir.includes('s')) h = Math.max(snapTo(o.h + dy), 60);
            schema.form.clientSize.width = Math.round(w);
            schema.form.clientSize.height = Math.round(h);
            if (canvas) {
                canvas.style.width = schema.form.clientSize.width + 'px';
                canvas.style.height = schema.form.clientSize.height + 'px';
            }
            updateFormInspectorValues();
        }
        function up() {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            commit();
        }
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }

    function updateFormInspectorValues() {
        const sizeEl = $('form-size');
        if (sizeEl) sizeEl.textContent = `${schema.form.clientSize.width} x ${schema.form.clientSize.height}`;
        const ins = $('inspector');
        if (!ins || selected().length !== 0) return;
        // Id-based: flat-index lookup breaks outside flat view, where rows move.
        const w = inspectorInputById('fWidth');
        const h = inspectorInputById('fHeight');
        if (w) w.value = String(schema.form.clientSize.width);
        if (h) h.value = String(schema.form.clientSize.height);
    }

    function applyTextAlign(captionEl, align) {
        if (!captionEl || !align) return;
        const a = String(align).toLowerCase();
        if (a === 'left') {
            captionEl.style.justifyContent = 'flex-start';
        } else if (a === 'center') {
            captionEl.style.justifyContent = 'center';
        } else if (a === 'right') {
            captionEl.style.justifyContent = 'flex-end';
        } else if (a.startsWith('top')) {
            captionEl.style.alignItems = 'flex-start';
            if (a.endsWith('left')) captionEl.style.justifyContent = 'flex-start';
            else if (a.endsWith('right')) captionEl.style.justifyContent = 'flex-end';
            else captionEl.style.justifyContent = 'center';
        } else if (a.startsWith('bottom')) {
            captionEl.style.alignItems = 'flex-end';
            if (a.endsWith('left')) captionEl.style.justifyContent = 'flex-start';
            else if (a.endsWith('right')) captionEl.style.justifyContent = 'flex-end';
            else captionEl.style.justifyContent = 'center';
        } else if (a.startsWith('middle')) {
            captionEl.style.alignItems = 'center';
            if (a.endsWith('left')) captionEl.style.justifyContent = 'flex-start';
            else if (a.endsWith('right')) captionEl.style.justifyContent = 'flex-end';
            else captionEl.style.justifyContent = 'center';
        }
    }

    function renderControl(parent, c, containerNode) {
        const node = el('div', 'ctl');
        node.dataset.id = c.id;
        node.tabIndex = 0;

        const simple = simpleName(c.type);
        const isContainer = containerTypes().has(simple);
        node.classList.add('t-' + simple.toLowerCase());

        // placement is relative to the containing canvas, so nested controls offset correctly
        // Z-order (A1, ADR 0009): the schema array is front-first (index 0 paints on top,
        // matching the Controls collection), while DOM siblings paint last-on-top. An explicit
        // z-index reconciles the two without disturbing DOM order. Every node gets one, so each
        // control is its own stacking context and nested children can never leak above an
        // uncle: paint order stays inside the parent.
        const zParent = parentOf(c.id);
        const zSibs = zParent ? zParent.children : (schema ? schema.controls : []);
        const zAt = zSibs.findIndex((n) => n.id === c.id);
        if (zAt >= 0) node.style.zIndex = String(zSibs.length - zAt);
        node.style.left = c.properties.x + 'px';
        node.style.top = c.properties.y + 'px';
        node.style.width = Math.max(c.properties.width, 2) + 'px';
        node.style.height = Math.max(c.properties.height, 2) + 'px';

        if (c.properties.foreColor) node.style.color = c.properties.foreColor;
        if (c.properties.backColor) node.style.backgroundColor = c.properties.backColor;
        if (c.properties.font) {
            if (c.properties.font.size) node.style.fontSize = c.properties.font.size + 'pt';
            if (c.properties.font.bold) node.style.fontWeight = 'bold';
            if (c.properties.font.italic) node.style.fontStyle = 'italic';
        }
        if (c.properties.checked) node.classList.add('checked');
        if (c.properties.borderStyle) node.classList.add('border-' + c.properties.borderStyle.toLowerCase());

        if (c.locked) {
            node.classList.add('locked');
            node.title = c.lockedReason || 'Not modelled.';
            addCaption(node, simple);
        } else {
            // A handled type with empty text is genuinely empty (a TextBox with no value, an
            // unset Label) — showing the type name there would be a lie about the form.
            const caption = c.properties.text || '';
            const capNode = addCaption(node, caption);
            if (!caption && emptyShowTypeName(simple)) {
                node.classList.add('placeholder');
                capNode.textContent = simple;
            } else if (['DataGridView', 'ListView', 'TreeView'].includes(simple)) {
                node.classList.add('t-placeholder-ctl');
                capNode.textContent = `${c.id} (${simple})`;
            }
            if (c.properties.textAlign) {
                applyTextAlign(capNode, c.properties.textAlign);
            }
        }
        if (readOnly) node.classList.add('readonly');

        // Active container (drill-down) gets a distinct ring so the user knows the scope.
        if (activeContainer && c.id === activeContainer.id) {
            node.classList.add('active-container');
        }

        if (selection.has(c.id)) {
            node.classList.add('selected');
            // The click-order primary wears the `dominant` class (white handles in a
            // group, like VS — that is how the align/same-size reference is visible).
            // Handles stay off non-dominant members: they would imply the group can
            // be resized, which is not what a drag does.
            const dom = dominant();
            const isDom = !!dom && dom.id === c.id;
            if (isDom) node.classList.add('dominant');
            if (!c.locked && !readOnly && (selection.size === 1 || isDom)) renderHandles(node);
        }

        // A container positions its children absolutely, so it must not be a flex/column
        // layout itself or the children would be reflowed. This is true whether or not it
        // currently has children.
        if (isContainer) node.classList.add('t-container');

        node.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('handle')) return;
            // A mousedown on a nested control bubbles to every ancestor container's
            // node. Without this guard the ancestor collapses the selection to itself
            // and starts a SECOND drag, so one gesture drives two drags and the child
            // moves twice, or the container steals a drag meant for the child.
            const originNode = e.target && typeof e.target.closest === 'function'
                ? e.target.closest('.ctl') : null;
            if (originNode && originNode !== node) return;
            // Shift+click extends rather than replaces, and so does Ctrl/Cmd+click (VS
            // parity: toggle the member, first click wins the dominant); a plain click
            // always collapses, so the selection can never contain a control the user
            // cannot see selected.
            // A Locked Control must never enter the selection. Not merely because it cannot be
            // dragged: `selection` is what a group drag iterates, so a locked member would be
            // MOVED by dragging a sibling — writing a control we have promised never to write
            // (AGENTS.md invariant 4). The guard has to be before select(), not after it.
            if (c.locked) { select(c.id); return; }
            if (readOnly) return;

            // Tab-order mode: assign the next TabIndex instead of selecting or dragging.
            // Locked and refused never reach here (guarded above).
            if (tabOrderMode) { setProp(c, 'tabIndex', tabOrderNext++); return; }

            // Task 4 (#50) sticky draw-to-create: with a tool armed, mousedown
            // anywhere — empty canvas or atop a control — starts a draw, never a
            // select or a move. The clicked control only hints the target frame:
            // a container means "draw inside it", a leaf means "draw beside it".
            // The ancestor bubble guard above still applies, so one gesture draws once.
            if (armedTool) {
                e.preventDefault();
                beginDraw(e, armedTool, c);
                return;
            }

            const extend = e.shiftKey || e.ctrlKey || e.metaKey;
            if (extend) {
                // Toggling OFF starts no drag: the control just left the selection,
                // so there is nothing to move.
                const wasMember = selection.has(c.id);
                select(c.id, true);
                if (wasMember) return;
            } else if (!selection.has(c.id) || selection.size > 1) select(c.id);
            beginDrag(e, c, node, containerNode);
        });
        node.addEventListener('dblclick', (e) => {
            // Same bubbling as mousedown: a dblclick on a nested control reaches the
            // ancestor's listener, which would drill into the container instead of
            // editing the child's text.
            const dblOrigin = e.target && typeof e.target.closest === 'function'
                ? e.target.closest('.ctl') : null;
            if (dblOrigin && dblOrigin !== node) return;
            if (c.locked || readOnly) return;
            // In tab-order mode clicks assign; dblclick neither drills in nor edits text.
            if (tabOrderMode) return;
            const simple = simpleName(c.type);
            if (containerTypes().has(simple)) {
                // Enter container: double-click a GroupBox, Panel, TabControl, TabPage
                activeContainer = c;
                selection = new Set();
                clickOrder = [];
                renderCanvas();
                renderInspector();
                renderStatus('Entered ' + c.id + ' — double-click outside or press Escape to exit', 'ok');
            } else {
                select(c.id);
                beginTextEdit(c, node);
            }
        });
        node.addEventListener('keydown', (e) => {
            if (c.locked || readOnly) return;
            // GRID is FORM units. A nudge must never be "8 screen pixels" — at 50% zoom that
            // would be a 16px move, and the control would drift off its grid.
            // VS parity (SizeControl commands, #48): plain arrows move by GRID; Ctrl/Cmd is
            // the 1px fine step (the old GRID*5 jump was inverted). The plain step follows
            // the grid-size setting (#49); the fine step stays 1px. Shift resizes with the
            // same step — Right/Down grow, Left/Up shrink, top-left anchored. Ctrl+Shift
            // resizes by the fine step.
            const step = (e.ctrlKey || e.metaKey) ? 1 : (view.gridSize > 0 ? view.gridSize : GRID);
            const many = selected();
            // dragRoots, like a drag: nudging a container already carries its children.
            const nudgeTarget = dragRoots(many.length > 1 && many.some((m) => m.id === c.id) ? many : [c]);
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                for (const t of nudgeTarget) deleteControl(t.id);
                return;
            }
            const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
            if (!d) return;
            e.preventDefault();
            if (e.shiftKey) for (const t of nudgeTarget) keyResize(t, d[0] * step, d[1] * step);
            else nudgeGroup(nudgeTarget, d[0] * step, d[1] * step);
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
                const pages = tabPagesOf(c);
                const active = activeTabPage(c);
                const activeId = active ? active.id : (pages.length > 0 ? pages[0].id : null);
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
                appendTabBadge(node, c);
                return;
            }
            for (const child of c.children || []) renderControl(node, child, node);
        }
        appendTabBadge(node, c);
    }

    /**
     * Tab-order badge: the control's current TabIndex, shown only in tab-order mode and
     * only where a click could assign one (unlocked, editable). Pointer-events none, like
     * captions, so the assignment click lands on the node. '?' marks an unset TabIndex,
     * which the first click fills in through the normal INSERT path.
     */
    function appendTabBadge(node, c) {
        if (!tabOrderMode || c.locked || readOnly) return;
        node.appendChild(el('div', 'tab-badge', String(c.properties.tabIndex ?? '?')));
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

    /**
     * In-place Text edit: a dblclick overlay committing through the same setProp('text')
     * path (and INSERT path) the inspector uses. No new patcher surface, no ADR.
     *
     * The gates mirror the inspector's Text field exactly: locked/refused never gets an
     * overlay (a write we promised never to make), containers keep dblclick for drill-down,
     * and NO_TEXT types have no Text to edit. Escape cancels with no generate; Enter commits
     * only when the value actually changed, so a no-op edit never dirties the file.
     * Keydown/mousedown stop here — without that, arrow keys would nudge the control and
     * Delete would delete it mid-edit.
     */
    function beginTextEdit(c, node) {
        const simple = simpleName(c.type);
        if (c.locked || readOnly) return;
        if (containerTypes().has(simple) || NO_TEXT.has(simple)) return;
        if (node.querySelector('.text-edit')) return;
        select(c.id);
        const input = el('input', 'text-edit');
        input.type = 'text';
        input.value = c.properties.text ?? '';
        input.setAttribute('aria-label', 'Edit text for ' + c.id);
        let done = false;
        const finish = (commitIt) => {
            if (done) return;
            done = true;
            const v = input.value;
            input.remove();
            if (commitIt && v !== (c.properties.text ?? '')) setProp(c, 'text', v);
        };
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('dblclick', (e) => e.stopPropagation());
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        node.appendChild(input);
        input.focus();
        if (typeof input.select === 'function') input.select();
    }

    /**
     * D8 modal Font editor — an alternative input surface over the already-modelled
     * `font` schema property (spec-vs-parity.md §1). Every value commits through the
     * existing setProp('font') path the inline rows use, so the engine's per-argument
     * patch — and its INSERT for controls that have no Font yet — applies unchanged.
     * Locked controls, refused forms and types outside HAS_FONT never get a dialog.
     * Cancel, Escape and backdrop clicks close with no generate.
     */
    function closeFontDialog() {
        const hosts = [];
        const wb = (typeof document !== 'undefined' && document.querySelector)
            ? document.querySelector('.workbench') : null;
        if (wb) hosts.push(wb);
        if (typeof document !== 'undefined' && document.body && document.body !== wb) hosts.push(document.body);
        for (const h of hosts) {
            if (!h || typeof h.querySelectorAll !== 'function') continue;
            for (const n of Array.from(h.querySelectorAll('.font-modal-overlay'))) {
                if (typeof n.remove === 'function') n.remove();
            }
        }
    }

    function openFontDialog(c) {
        const fsimple = simpleName(c.type);
        if (!c || c.locked || readOnly || !HAS_FONT.has(fsimple)) return;
        closeFontDialog();
        const cur = c.properties.font || {};
        const curSize = typeof cur.size === 'number' ? cur.size : 9;
        const curBold = !!cur.bold;
        const curItalic = !!cur.italic;
        const curFamily = typeof cur.family === 'string' ? cur.family : '';

        const host = (typeof document !== 'undefined' && document.querySelector
            && document.querySelector('.workbench'))
            || (typeof document !== 'undefined' ? document.body : null)
            || $('inspector');
        if (!host) return;

        const overlay = el('div', 'font-modal-overlay');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);';
        const dlg = el('div', 'font-modal');
        dlg.style.cssText = 'min-width:260px;max-width:320px;padding:12px;border:1px solid var(--border);border-radius:4px;background:var(--vscode-editor-background,#1e1e1e);';
        dlg.appendChild(el('h3', null, 'Font — ' + c.id));

        const famLabel = el('label', null, 'Family (blank keeps the default)');
        const fam = document.createElement('input');
        fam.type = 'text'; fam.id = 'fFontFamily'; fam.value = curFamily;
        fam.placeholder = 'Default';
        dlg.appendChild(famLabel); dlg.appendChild(fam);

        const sizeLabel = el('label', null, 'Size');
        const size = document.createElement('input');
        size.type = 'number'; size.id = 'fFontSize'; size.value = String(curSize);
        dlg.appendChild(sizeLabel); dlg.appendChild(size);

        const styleRow = el('div', 'row');
        const bold = document.createElement('input');
        bold.type = 'checkbox'; bold.id = 'fFontBold'; bold.checked = curBold;
        styleRow.appendChild(bold); styleRow.appendChild(el('label', null, 'Bold'));
        const italic = document.createElement('input');
        italic.type = 'checkbox'; italic.id = 'fFontItalic'; italic.checked = curItalic;
        styleRow.appendChild(italic); styleRow.appendChild(el('label', null, 'Italic'));
        dlg.appendChild(styleRow);

        const preview = el('div', 'font-preview', 'Ag');
        preview.title = 'Preview';
        preview.style.cssText = 'margin:8px 0;padding:6px;border:1px solid var(--border);text-align:center;';
        dlg.appendChild(preview);
        const updatePreview = () => {
            const s = parseFloat(size.value);
            preview.style.fontSize = (Number.isNaN(s) ? curSize : s) + 'pt';
            preview.style.fontWeight = bold.checked ? 'bold' : 'normal';
            preview.style.fontStyle = italic.checked ? 'italic' : 'normal';
            preview.style.fontFamily = fam.value.trim() ? fam.value.trim() : '';
        };
        for (const n of [fam, size, bold, italic]) {
            n.addEventListener('change', updatePreview);
            n.addEventListener('input', updatePreview);
        }
        updatePreview();

        const btnRow = el('div', 'row');
        const ok = el('button', 'font-ok', 'OK');
        const cancel = el('button', 'font-cancel', 'Cancel');
        btnRow.appendChild(ok); btnRow.appendChild(cancel);
        dlg.appendChild(btnRow);
        overlay.appendChild(dlg);
        host.appendChild(overlay);

        let done = false;
        const finish = (commitIt) => {
            if (done) return;
            done = true;
            const famV = fam.value.trim();
            let sizeV = parseFloat(size.value);
            if (Number.isNaN(sizeV) || sizeV <= 0) sizeV = curSize;
            const next = { size: sizeV, bold: !!bold.checked, italic: !!italic.checked };
            if (famV) next.family = famV;
            const same = Math.abs(sizeV - curSize) <= 0.001
                && !!bold.checked === curBold && !!italic.checked === curItalic
                && famV === curFamily;
            closeFontDialog();
            // The document may have reloaded while the dialog was open; committing a
            // detached control would post a stale model, so just close.
            if (commitIt && !same && findControl(c.id) === c) setProp(c, 'font', next);
        };
        ok.addEventListener('click', () => finish(true));
        cancel.addEventListener('click', () => finish(false));
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(false); });
        // Escape closes from anywhere in the dialog (it bubbles here in a real browser).
        // Enter commits only from the text/number fields: on a focused button the native
        // click decides, or one keypress would both commit AND cancel.
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
        });
        const editKeys = (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
            else if (e.key === 'Enter') { e.stopPropagation(); finish(true); }
        };
        for (const n of [fam, size]) n.addEventListener('keydown', editKeys);
        if (typeof fam.focus === 'function') fam.focus();
    }

    // ------------------------------------------------------------- selection
    function select(id, extend) {
        if (id && !inActiveContainer(id)) return; // ignore clicks outside active container
        if (extend) {
            if (!id) return;
            if (selection.has(id)) {
                selection.delete(id);
                clickOrder = clickOrder.filter((x) => x !== id);
            } else {
                selection.add(id);
                clickOrder.push(id);
            }
        } else {
            selection = new Set(id ? [id] : []);
            clickOrder = id ? [id] : [];
        }
        renderCanvas();
        renderInspector();
        renderStatusForSelection();
        renderOutline();
    }

    /** Select everything in a rectangle. Marquee selection is view state — it posts nothing. */
    function selectInRect(a, b, add) {
        const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
        const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
        const hit = allControls(schema ? schema.controls : [])
            .filter((c) => !c.locked
                && c.properties.x < x2 && c.properties.x + c.properties.width > x1
                && c.properties.y < y2 && c.properties.y + c.properties.height > y1
                && inActiveContainer(c.id))
            .map((c) => c.id);
        if (add) {
            // Shift+marquee ADDS: the click order survives, newcomers append in schema
            // order. Locked never joins (filtered above, AGENTS.md invariant 4).
            for (const id of hit) {
                if (!selection.has(id)) { selection.add(id); clickOrder.push(id); }
            }
        } else {
            selection = new Set(hit);
            clickOrder = hit.slice();
        }
        renderCanvas();
        renderInspector();
        renderStatusForSelection();
        renderOutline();
    }

    function renderStatusForSelection() {
        const n = selection.size;
        if (n === 0) return;
        const el = $('status');
        if (!el) return;
        if (n === 1) {
            // Read-only readout in FORM units straight from the schema (never screen
            // pixels), so it holds at any zoom. Geometry is modelled for every control,
            // locked or not — a locked single-selection reads the same way.
            const c = selected()[0];
            const p = c.properties;
            el.textContent =
                `1 control selected — ${c.id} · X ${p.x}, Y ${p.y} · ${p.width} × ${p.height}`;
            return;
        }
        el.textContent = `${n} controls selected.`;
    }

    // ------------------------------------------------------- document outline
    /**
     * D6 Document Outline (issue #34): a hierarchy view over the schema tree.
     *
     * Containers nest (their children render indented inside the parent row); locked
     * controls appear with their reason and are never editable. Clicks reuse select(),
     * F2 renames through the existing `rename` command path (never a schema commit).
     *
     * Task 6 (#52) binds the outline to A1: every unlocked row carries ▲▼ step
     * buttons that move the control one z-order slot via stepControl/commit, so the
     * outline order (schema order, front-first per ADR 0009) is editable, not just
     * displayed. Locked rows and refused forms get no buttons (invariant 4).
     * Outline DRAG-reparent stays omitted — a row drag has no file-space point to
     * convert, so it would fake the canvas gesture; rows are never draggable.
     *
     * The panel is built with DOM calls here, not in the host HTML skeleton, so this
     * stays one merge-pass region. `outlineEl` is held module-side because the panel
     * is created lazily on first render.
     */
    let outlineEl = null;
    function renderOutline() {
        const wb = document.querySelector('.workbench');
        if (!wb || !schema) return;
        if (!outlineEl || outlineEl.parentNode !== wb) {
            outlineEl = el('aside', 'outline');
            outlineEl.id = 'outline';
            outlineEl.setAttribute('role', 'tree');
            outlineEl.setAttribute('aria-label', 'Document Outline');
            outlineEl.style.minWidth = '150px';
            outlineEl.style.maxWidth = '230px';
            outlineEl.style.overflow = 'auto';
            outlineEl.style.fontSize = '12px';
            wb.appendChild(outlineEl);
        }
        outlineEl.innerHTML = '';
        outlineEl.appendChild(el('h3', null, 'Outline'));
        outlineEl.appendChild(el('div', 'outline-hint', 'Click to select · F2 to rename · ▲▼ step order'));
        const tree = el('div', 'outline-tree');
        tree.setAttribute('role', 'group');
        for (const c of schema.controls) appendOutlineRow(tree, c, 0);
        outlineEl.appendChild(tree);
    }
    function appendOutlineRow(parent, c, depth) {
        const simple = simpleName(c.type);
        const row = el('div', 'outline-row'
            + (selection.has(c.id) ? ' selected' : '')
            + (c.locked ? ' locked' : '')
            + (readOnly ? ' readonly' : ''));
        row.dataset.id = c.id;
        row.setAttribute('role', 'treeitem');
        row.style.cursor = 'pointer';
        row.style.whiteSpace = 'nowrap';
        if (selection.has(c.id)) row.style.background = '#37373d';
        const label = el('span', 'outline-label', `${c.id} (${simple})`);
        label.style.paddingLeft = (4 + depth * 12) + 'px';
        if (c.locked) {
            row.title = c.lockedReason || 'Not modelled.';
            label.style.color = '#858585';
            label.style.fontStyle = 'italic';
        }
        row.appendChild(label);
        if (c.locked) {
            const why = el('span', 'outline-locked-reason', c.lockedReason || 'Not modelled.');
            why.style.color = '#858585';
            why.style.fontSize = '11px';
            row.appendChild(why);
        }
        // Task 6 (#52) step-order buttons: one z-order slot per click, riding the
        // A1 move through stepControl/commit. Never on locked rows (invariant 4:
        // a Locked Control is never written) and never on refused forms — and the
        // row itself is never draggable, so outline order is stepped, never faked.
        if (!c.locked && !readOnly) {
            const fwd = el('button', 'outline-step-fwd', '▲');
            fwd.title = 'Move ' + c.id + ' one step toward the front';
            fwd.setAttribute('aria-label', 'Move ' + c.id + ' toward front');
            fwd.addEventListener('click', (e) => {
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                stepControl(c.id, 'forward');
            });
            const back = el('button', 'outline-step-back', '▼');
            back.title = 'Move ' + c.id + ' one step toward the back';
            back.setAttribute('aria-label', 'Move ' + c.id + ' toward back');
            back.addEventListener('click', (e) => {
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                stepControl(c.id, 'backward');
            });
            row.appendChild(fwd);
            row.appendChild(back);
        }
        row.addEventListener('mousedown', (e) => {
            // A mousedown on the open rename field must not reselect and destroy it.
            if (e.target && e.target.classList && e.target.classList.contains('outline-rename')) return;
            e.stopPropagation();
            select(c.id);
        });
        parent.appendChild(row);
        // Children nest INSIDE the parent row, so the DOM itself is the hierarchy.
        // Deliberately no drag handlers and no buttons here: reorder UI is out of scope.
        if (c.children && c.children.length) {
            const kids = el('div', 'outline-children');
            kids.setAttribute('role', 'group');
            for (const ch of c.children) appendOutlineRow(kids, ch, depth + 1);
            row.appendChild(kids);
        }
        return row;
    }
    function outlineRowFor(id) {
        if (!outlineEl) return null;
        return Array.from(outlineEl.querySelectorAll('.outline-row'))
            .find((n) => n.dataset.id === id) || null;
    }
    /**
     * F2 rename: opens an inline field on the outline row and posts through the
     * existing `rename` command path, exactly like the inspector Name field. Locked
     * controls and refused forms never reach the input. Enter posts, Escape/blur
     * cancels with no message — a no-op rename never dirties the file.
     */
    function beginOutlineRename(id) {
        const target = id || (selection.size === 1 ? [...selection][0] : null);
        if (!target) return;
        const c = findControl(target);
        if (!c || c.locked || readOnly) return;
        renderOutline();
        const row = outlineRowFor(target);
        if (!row || row.querySelector('.outline-rename')) return;
        const input = document.createElement('input');
        input.className = 'outline-rename';
        input.type = 'text';
        input.value = c.id;
        input.setAttribute('aria-label', 'Rename ' + c.id);
        let done = false;
        const finish = (commitIt) => {
            if (done) return;
            done = true;
            const to = input.value.trim();
            input.remove();
            if (commitIt && to && to !== c.id) post('rename', { id: c.id, to });
        };
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('dblclick', (e) => e.stopPropagation());
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(false));
        row.appendChild(input);
        input.focus();
        if (typeof input.select === 'function') input.select();
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

    /**
     * Keyboard nudge over dragRoots: ONE shared delta for the group (a container already
     * carries its children), clamped through every member's parent frame so a
     * multi-selection moves as one block and never splits at an edge. Fully blocked =
     * no model touch and no commit, so hammering an arrow at a wall never dirties the
     * file (byte-identity on untouched).
     */
    function nudgeGroup(targets, dx, dy) {
        const cl = clampMoveDelta(targets.map(clampItem), dx, dy);
        if (cl.dx === 0 && cl.dy === 0) return;
        for (const t of targets) { t.properties.x += cl.dx; t.properties.y += cl.dy; markChanged(t, 'x'); markChanged(t, 'y'); }
        renderStatusForSelection();
        commit();
    }

    /**
     * Clamp a shared move delta so every member lands inside its own parent frame (a
     * control lives inside its container — VS containment). `items` are position
     * snapshots so a drag clamps its TOTAL delta from the gesture start, not the last
     * mousemove. Axes are independent and each takes the tightest room across the
     * group.
     */
    function clampMoveDelta(items, dx, dy) {
        let cx = dx, cy = dy;
        for (const it of items) {
            cx = clampAxis(cx, it.x, it.w, it.fw);
            cy = clampAxis(cy, it.y, it.h, it.fh);
        }
        return { dx: Math.round(cx), dy: Math.round(cy) };
    }
    /** Limit `d` so `pos + d` stays within [0, max(0, frame - size)]. */
    function clampAxis(d, pos, size, frame) {
        return Math.min(Math.max(d, -pos), Math.max(0, frame - size) - pos);
    }
    /** Snapshot a control for clampMoveDelta: current position over its parent frame. */
    function clampItem(c) {
        const f = parentFrame(c);
        return {
            x: c.properties.x, y: c.properties.y,
            w: c.properties.width, h: c.properties.height, fw: f.w, fh: f.h,
        };
    }

    /**
     * Minimum resize extent: the modelled MinimumSize when the schema surfaces one,
     * else the 2px DOM floor. The engine does not parse MinimumSize today, so this is
     * opportunistic — a control carrying `properties.minimumSize = {width, height}` is
     * honored, everything else floors at 2. No schema change.
     */
    function minExtent(c) {
        const ms = (c.properties && c.properties.minimumSize) || {};
        return {
            w: Math.max(2, Number.isFinite(ms.width) ? Math.round(ms.width) : 0),
            h: Math.max(2, Number.isFinite(ms.height) ? Math.round(ms.height) : 0),
        };
    }

    /**
     * Keyboard resize (Shift+arrows): VS SizeControl semantics — Right/Down grow the
     * east/south edges, Left/Up shrink them, top-left anchored. The same TextChanges a
     * resize-handle drag emits (Size args only, never Location).
     */
    function keyResize(c, dx, dy) {
        const min = minExtent(c);
        if (dx) { c.properties.width = Math.max(Math.round(c.properties.width + dx), min.w); markChanged(c, 'width'); }
        if (dy) { c.properties.height = Math.max(Math.round(c.properties.height + dy), min.h); markChanged(c, 'height'); }
        renderStatusForSelection();
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
        if (!selectionEditable()) return;

        // Center in Form works on any non-empty editable selection, including a single
        // control. Each control centres within its immediate parent frame — the form's
        // clientSize at top level, else the parent's modelled width/height. Container
        // chrome is ignored: an approximation stated here, not simulated layout.
        if (kind === 'center-form-h' || kind === 'center-form-v') {
            for (const c of s) {
                const p = c.properties;
                const frame = parentFrame(c);
                if (kind === 'center-form-h') { p.x = Math.round((frame.w - p.width) / 2); markChanged(c, 'x'); }
                else { p.y = Math.round((frame.h - p.height) / 2); markChanged(c, 'y'); }
            }
            commit();
            renderCanvas();
            return;
        }

        if (s.length < 2) return;

        // Make Same Size copies the click-order dominant's extents (VS primary).
        // Position is untouched: resizing keeps the top-left corner, like VS.
        if (kind === 'same-w' || kind === 'same-h' || kind === 'same-both') {
            const ref = (dominant() || s[0]).properties;
            for (const c of s) {
                if (kind === 'same-w' || kind === 'same-both') { c.properties.width = ref.width; markChanged(c, 'width'); }
                if (kind === 'same-h' || kind === 'same-both') { c.properties.height = ref.height; markChanged(c, 'height'); }
            }
            commit();
            renderCanvas();
            return;
        }

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

        // Align references the DOMINANT control's edges (VS aligns to the primary),
        // not the bounding box of the group.
        const dom = dominant() || s[0];
        const dp = dom.properties;

        for (const c of s) {
            const p = c.properties;
            switch (kind) {
                case 'left': p.x = dp.x; markChanged(c, 'x'); break;
                case 'right': p.x = dp.x + dp.width - p.width; markChanged(c, 'x'); break;
                case 'hcenter': p.x = Math.round(dp.x + (dp.width - p.width) / 2); markChanged(c, 'x'); break;
                case 'top': p.y = dp.y; markChanged(c, 'y'); break;
                case 'bottom': p.y = dp.y + dp.height - p.height; markChanged(c, 'y'); break;
                case 'vcenter': p.y = Math.round(dp.y + (dp.height - p.height) / 2); markChanged(c, 'y'); break;
            }
        }
        commit();
        renderCanvas();
    }

    /** Immediate parent frame for Center in Form: form clientSize at top level, else the
     * parent control's modelled width/height. */
    function parentFrame(c) {
        const parent = parentOf(c.id);
        if (!parent) return { w: schema.form.clientSize.width, h: schema.form.clientSize.height };
        return { w: parent.properties.width, h: parent.properties.height };
    }

    function parentOf(id) {
        const walk = (nodes, parent) => {
            for (const n of nodes || []) {
                if (n.id === id) return parent;
                const found = walk(n.children, n);
                if (found !== null && found !== undefined) return found;
            }
            return null;
        };
        return walk(schema ? schema.controls : [], null);
    }

    /** True when `id` is nested inside `ancestorId` at any depth. */
    function isDescendantOf(id, ancestorId) {
        let p = parentOf(id);
        while (p) {
            if (p.id === ancestorId) return true;
            p = parentOf(p.id);
        }
        return false;
    }

    /**
     * Drag/nudge roots: members of `group` that are not nested inside another member.
     * A child rides along when its container moves (its coordinates are
     * parent-relative), so moving it again by the same delta would displace it twice.
     */
    function dragRoots(group) {
        return group.filter((g) => !group.some((o) => o !== g && isDescendantOf(g.id, o.id)));
    }

    /**
     * Task 6 (#52) drag-reparent hit-test, in MODEL space (schema x/y plus ancestor
     * offsets), never DOM rects: the harness stand-in has no layout engine, and a
     * rect-based test would prove the stand-in rather than the canvas. Returns the
     * deepest visible container whose frame holds the form-space point, or null.
     *
     * - Locked containers never hit (invariant 4), nor does anything in `exclude`
     *   (the dragged roots and their descendants — a control cannot parent to
     *   itself or to its own child).
     * - A TabControl resolves to its active page (TabPage targeting): a point on
     *   its strip/chrome still lands on the visible page. Hidden pages never hit.
     * - Depth decides, ties go to the front-most sibling (lowest schema index —
     *   index 0 is front per ADR 0009).
     */
    function containerFrameBox(c) {
        const o = frameOrigin(parentOf(c.id));
        return {
            x: o.x + c.properties.x, y: o.y + c.properties.y,
            w: c.properties.width, h: c.properties.height,
        };
    }
    function depthOf(c) {
        let d = 0, p = parentOf(c.id);
        while (p) { d += 1; p = parentOf(p.id); }
        return d;
    }
    function pointInBox(fx, fy, b) {
        return fx >= b.x && fy >= b.y && fx <= b.x + b.w && fy <= b.y + b.h;
    }
    function reparentTargetAt(fx, fy, exclude) {
        if (!schema) return null;
        const flat = allControls(schema.controls);
        const activeByTab = new Map();
        for (const c of flat) {
            if (simpleName(c.type) === 'TabControl') {
                const a = activeTabPage(c);
                if (a) activeByTab.set(c.id, a.id);
            }
        }
        let best = null, bestDepth = -1, bestIdx = Infinity;
        const consider = (c, idx) => {
            const d = depthOf(c);
            if (d > bestDepth || (d === bestDepth && idx < bestIdx)) {
                best = c; bestDepth = d; bestIdx = idx;
            }
        };
        flat.forEach((c, idx) => {
            if (!c || exclude.has(c.id) || c.locked) return;
            const simple = simpleName(c.type);
            if (!containerTypes().has(simple)) return;
            if (simple === 'TabControl') {
                const aid = activeByTab.get(c.id);
                const pg = aid ? findControl(aid) : null;
                if (!pg || pg.locked || exclude.has(pg.id)) return;
                if (pointInBox(fx, fy, containerFrameBox(pg))) { consider(pg, idx); return; }
                if (pointInBox(fx, fy, containerFrameBox(c))) consider(pg, idx);
                return;
            }
            if (simple === 'TabPage') {
                const tab = parentOf(c.id);
                if (tab && simpleName(tab.type) === 'TabControl'
                    && activeByTab.get(tab.id) !== c.id) return; // hidden page
            }
            if (pointInBox(fx, fy, containerFrameBox(c))) consider(c, idx);
        });
        return best;
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
            markChanged(sorted[i], axis);
            cursor += sorted[i].properties[extentAxis];
        }
    }

    /**
     * A1 Z-order (ADR 0009): Bring to Front / Send to Back. The schema arrays ARE the paint
     * order (index 0 is front), so this is a pure reorder of the sibling list — no property
     * changes, one debounced commit() like every other edit, and therefore one VS Code undo
     * step (ADR 0004). The engine expresses it as a surgical relocation of the
     * Controls.Add lines; unmodelled properties survive because nothing is deleted.
     *
     * Multi-selections move as a block within each parent group, preserving internal order.
     * Locked controls never move: the single-selection buttons are hidden for them, and the
     * multi path filters them (AGENTS.md invariant 4).
     */
    function zorderSelection(dir) {
        if (readOnly) return;
        const s = selected().filter((c) => !c.locked);
        if (!s.length) return;
        const groups = new Map();
        for (const c of s) {
            const list = siblingList(c);
            if (!groups.has(list)) groups.set(list, []);
            groups.get(list).push(c);
        }
        let moved = false;
        for (const [list, members] of groups) {
            if (members.some((m) => list.indexOf(m) < 0)) continue;   // detached model: never guess
            const before = list.map((m) => m.id).join(',');
            // Front is index 0, back is the end — the same order the file's Controls.Add
            // block and the Controls collection use (ADR 0009).
            if (dir === 'front' || dir === 'back') {
                for (const m of members) list.splice(list.indexOf(m), 1);
                if (dir === 'front') list.unshift(...members);
                else list.push(...members);
            } else {
                // Task 6 (#52) single step: one slot toward the front
                // ('forward', lower index) or the back. A step against the
                // wall changes nothing, so the `before` comparison below posts
                // no commit and the file stays byte-identical.
                stepMove(list, members, dir);
            }
            if (list.map((m) => m.id).join(',') !== before) moved = true;
        }
        if (moved) commit();
    }

    /**
     * Task 6 (#52) single-step z-order (the outline ▲▼ buttons). Each member moves
     * exactly one slot, front-most first going forward so a block keeps its
     * internal order, back-most first going back. Members already at the wall
     * stay — the group still steps around them. Returns whether anything moved.
     */
    function stepMove(list, members, dir) {
        const present = members.filter((m) => list.indexOf(m) >= 0);
        if (!present.length) return false;
        let moved = false;
        if (dir === 'forward') {
            const ordered = present.sort((a, b) => list.indexOf(a) - list.indexOf(b));
            for (const m of ordered) {
                const i = list.indexOf(m);
                if (i <= 0) continue;
                list.splice(i, 1);
                list.splice(i - 1, 0, m);
                moved = true;
            }
        } else {
            const ordered = present.sort((a, b) => list.indexOf(b) - list.indexOf(a));
            for (const m of ordered) {
                const i = list.indexOf(m);
                if (i < 0 || i >= list.length - 1) continue;
                list.splice(i, 1);
                list.splice(i + 1, 0, m);
                moved = true;
            }
        }
        return moved;
    }

    /**
     * Task 6 (#52) outline step: move one control one slot in its own sibling
     * list and commit, riding the A1 Controls.Add relocation like every other
     * z-order op (one commit, one VS Code undo step). Locked controls and
     * refused forms never reach here — they get no buttons.
     */
    function stepControl(id, dir) {
        if (readOnly) return;
        const c = findControl(id);
        if (!c || c.locked || findControl(c.id) !== c) return;
        const list = siblingList(c);
        const before = list.map((m) => m.id).join(',');
        if (stepMove(list, [c], dir) && list.map((m) => m.id).join(',') !== before) commit();
    }

    /** The sibling list a control reorders within: its parent's children, else top level. */
    function siblingList(c) {
        const parent = parentOf(c.id);
        return parent ? parent.children : (schema ? schema.controls : []);
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
            ['Same Width', () => align('same-w')],
            ['Same Height', () => align('same-h')],
            ['Same Size', () => align('same-both')],
            ['Center in Form Horizontally', () => align('center-form-h')],
            ['Center in Form Vertically', () => align('center-form-v')],
            ['Bring to Front', () => zorderSelection('front')],
            ['Send to Back', () => zorderSelection('back')],
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
        clickOrder = copies.map((c) => c.id);
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

    // ------------------------------------------------------- clipboard (A2 #3)
    /**
     * Clipboard copy/paste across forms via the host round-trip. The webview cannot touch
     * the system clipboard on its own (permissions + async), so copy posts ControlNode JSON
     * to the host (`copy`), which writes it via `vscode.env.clipboard`; paste asks the host
     * (`requestPaste`), which reads it back and re-posts it as `paste`.
     *
     * The in-form core reuses the duplicate kernel above: deep clone, fresh ids via
     * `uniqueId`, one GRID offset, one debounced commit. Cross-form paste needs no extra
     * dialect work in the canvas — `generate` re-runs dialect detection per target file
     * (SCHEMA.md:337-349), so committing the pasted nodes writes them in that file's own
     * dialect. No schema change, no ADR (spec-vs-parity.md §2 clipboard bullet).
     */
    const CLIPBOARD_PREFIX = 'vscforms-controls-v1:';
    function handledSimpleNames() { return new Set(HANDLED.map(([n]) => n)); }
    /** Serialize the selection for the clipboard: dragRoots, locked never joins. */
    function serializeSelection() {
        if (!schema) return [];
        const roots = dragRoots(selected().filter((c) => !c.locked));
        return JSON.parse(JSON.stringify(roots));
    }
    function copySelection() {
        if (!schema) return;
        const nodes = serializeSelection();
        if (!nodes.length) return;
        post('copy', { nodes });
    }
    function requestPaste() {
        if (!schema || readOnly) return;
        post('requestPaste');
    }
    /** Parse clipboard text back to nodes. Returns null when it is not our payload. */
    function parseClipboardText(text) {
        if (typeof text !== 'string' || !text) return null;
        let body = text;
        if (body.startsWith(CLIPBOARD_PREFIX)) body = body.slice(CLIPBOARD_PREFIX.length);
        else return null;
        try {
            const nodes = JSON.parse(body);
            return Array.isArray(nodes) ? nodes : null;
        } catch { return null; }
    }
    /** Fresh ids for a pasted subtree, so cross-form collisions cannot land. */
    function assignPasteIds(node, used) {
        node.id = uniqueId(used, String(node.id || 'ctl'));
        for (const ch of node.children || []) assignPasteIds(ch, used);
    }
    /** A pasted type the target does not model lands locked, never discarded. */
    function markUnhandledLocked(node, handled) {
        const simple = simpleName(String(node.type || ''));
        if (!handled.has(simple)) {
            node.locked = true;
            node.lockedReason = `${simple} is not one of the handled control types, so its appearance is not modelled.`;
        }
        for (const ch of node.children || []) markUnhandledLocked(ch, handled);
    }
    /** Insert deserialized clipboard nodes: the duplicate kernel, generalized to N roots. */
    function pasteNodes(nodes) {
        if (!schema || readOnly) return;
        if (!Array.isArray(nodes) || !nodes.length) return;
        const handled = handledSimpleNames();
        const used = new Set(allControls(schema.controls).map((c) => c.id));
        const copies = [];
        for (const raw of nodes) {
            if (!raw || typeof raw.id !== 'string' || typeof raw.type !== 'string') continue;
            if (!raw.properties || typeof raw.properties.x !== 'number') continue;
            const copy = JSON.parse(JSON.stringify(raw));
            if (!Array.isArray(copy.children)) copy.children = [];
            assignPasteIds(copy, used);
            markUnhandledLocked(copy, handled);
            copy.properties.x = Math.max(0, Math.round(copy.properties.x + GRID));
            copy.properties.y = Math.max(0, Math.round(copy.properties.y + GRID));
            copies.push(copy);
        }
        if (!copies.length) return;
        for (const cp of copies) {
            (function walk(n) {
                if (n.locked) schema.analysis.unmodelledCount += 1;
                else schema.analysis.modelledCount += 1;
                for (const ch of n.children || []) walk(ch);
            })(cp);
        }
        schema.controls.push(...copies);
        selection = new Set(copies.map((c) => c.id));
        clickOrder = copies.map((c) => c.id);
        recomputeCoverage();
        commit();
        renderCanvas();
        renderInspector();
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

        // Dragging any member of a multi-selection moves the WHOLE selection by one delta,
        // which is what makes group positioning possible at all. dragRoots drops members
        // nested inside another member: a child rides along with its container, so moving
        // it again would displace it twice.
        const group = dragRoots(selection.size > 1 ? selected() : [c]);
        const groupStart = group.map((g) => ({ g, x: g.properties.x, y: g.properties.y }));

        // Task 6 (#52) reparent tracking: the dragged roots plus every descendant,
        // which can never be a drop target (a control cannot parent to itself or
        // to its own child). The highlight is view state — it posts nothing.
        const dragIds = new Set();
        for (const s of groupStart) {
            dragIds.add(s.g.id);
            for (const d of allControls(s.g.children)) dragIds.add(d.id);
        }
        let dropTarget = null;
        function setDropTarget(t) {
            if ((dropTarget && t && dropTarget.id === t.id) || (!dropTarget && !t)) return;
            dropTarget = t;
            const canvas = $('canvas');
            if (canvas) {
                for (const n of Array.from(canvas.querySelectorAll('.drop-target'))) {
                    n.classList.remove('drop-target');
                }
            }
            if (t) {
                const n = nodeFor(t.id);
                if (n) n.classList.add('drop-target');
            }
        }

        function move(ev) {
            // Divide the scale out FIRST, then snap in form space. Snapping in screen space
            // drifts at fractional zoom and pulls controls off the grid.
            const { dx, dy } = formDelta(ev, origin);
            // Alt held mid-gesture suppresses snap entirely (#49): raw 1px deltas, no
            // pull, no guides — read off the MOVE event, since Alt may go down mid-drag.
            const suppressed = !!ev.altKey;
            let qx = suppressed ? Math.round(dx) : snapTo(dx);
            let qy = suppressed ? Math.round(dy) : snapTo(dy);
            // Magnetic pull over the group's shared bbox, so a multi-selection snaps as
            // one block and never splits. Quantize first, then pull: the pull corrects a
            // quantized landing onto a nearby edge/center/baseline, or leaves it alone.
            let guides = [];
            if (!suppressed && view.snap && view.snapMode === 'lines') {
                const bb = groupBBox(groupStart, qx, qy);
                const parent = parentOf(c.id);
                const sn = snapMoveRect(bb.x, bb.y, bb.w, bb.h,
                    groupStart.length === 1 ? baselineOf(c) + qy : null,
                    snapExclude(groupStart), parent, frameOrigin(parent));
                qx += sn.dx; qy += sn.dy; guides = sn.guides;
            }
            // Container clamp (#48): one shared delta, limited so every root lands inside
            // its own parent frame. Clamped from the gesture START — clamping per-mousemove
            // would stick at the wall and never come back. Runs after the pull so a pull
            // past the wall is still contained.
            const cl = clampMoveDelta(groupStart.map((s) => {
                const f = parentFrame(s.g);
                return {
                    x: s.x, y: s.y,
                    w: s.g.properties.width, h: s.g.properties.height, fw: f.w, fh: f.h,
                };
            }), qx, qy);
            for (const s of groupStart) {
                s.g.properties.x = s.x + cl.dx;
                s.g.properties.y = s.y + cl.dy;
                markChanged(s.g, 'x'); markChanged(s.g, 'y');
                const n = nodeFor(s.g.id);
                if (n) {
                    n.style.left = s.g.properties.x + 'px';
                    n.style.top = s.g.properties.y + 'px';
                }
            }
            renderSnapGuides(guides);
            // Task 6 (#52): hover highlight. The pointer is converted to form units
            // (scale-correct, like every other gesture) and hit-tested against the
            // model — locked containers and the dragged subtree never highlight.
            const fp = canvasFormPoint(ev.clientX, ev.clientY);
            setDropTarget(reparentTargetAt(fp.x, fp.y, dragIds));
            updateInspectorValues();
            renderStatusForSelection();
        }
        function up() {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            clearGuides();
            // Task 6 (#52): drop reparents. The gesture settled in the OLD parent's
            // frame, so each root's file-space point is converted into the new
            // parent's frame and clamped into it — the same containment every other
            // path enforces. The node is appended (back), which is where the engine
            // appends the relocated `Controls.Add` (ADR 0010), so canvas and file
            // agree. One debounced commit covers move + reparent: one undo step.
            const target = dropTarget;
            setDropTarget(null);
            let reparented = false;
            if (target && findControl(target.id) === target && !target.locked && !readOnly) {
                const newOrigin = frameOrigin(target);
                for (const s of groupStart) {
                    const oldParent = parentOf(s.g.id);
                    if (oldParent && oldParent.id === target.id) continue;
                    // A locked container is never rewritten through, in either
                    // direction (invariant 4): the control moves, but stays put.
                    if ((oldParent && oldParent.locked) || target.locked) continue;
                    const oldOrigin = frameOrigin(oldParent);
                    const gx = oldOrigin.x + s.g.properties.x;
                    const gy = oldOrigin.y + s.g.properties.y;
                    const fw = target.properties.width, fh = target.properties.height;
                    s.g.properties.x = Math.min(Math.max(Math.round(gx - newOrigin.x), 0),
                        Math.max(0, fw - s.g.properties.width));
                    s.g.properties.y = Math.min(Math.max(Math.round(gy - newOrigin.y), 0),
                        Math.max(0, fh - s.g.properties.height));
                    markChanged(s.g, 'x'); markChanged(s.g, 'y');
                    const from = oldParent ? oldParent.children : schema.controls;
                    const at = from.indexOf(s.g);
                    if (at < 0) continue;   // detached model: never guess
                    from.splice(at, 1);
                    target.children.push(s.g);
                    reparented = true;
                }
            }
            const moved = reparented
                || groupStart.some((s) => s.g.properties.x !== s.x || s.g.properties.y !== s.y);
            if (moved) commit();
        }
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }

    function beginResize(e, c, node, dir) {
        e.preventDefault();
        const min = minExtent(c);
        const o = { x: c.properties.x, y: c.properties.y, w: c.properties.width, h: c.properties.height };
        function move(ev) {
            // Same rule as drag: form units in, form units out. Alt suppresses (#49).
            const { dx, dy } = formDelta(ev, { mx: e.clientX, my: e.clientY });
            const suppressed = !!ev.altKey;
            let { x, y, w, h } = o;
            if (dir.includes('e')) w = Math.max(o.w + dx, min.w);
            if (dir.includes('s')) h = Math.max(o.h + dy, min.h);
            if (dir.includes('w')) { w = Math.max(o.w - dx, min.w); x = o.x + (o.w - w); }
            if (dir.includes('n')) { h = Math.max(o.h - dy, min.h); y = o.y + (o.h - h); }
            // Grid quantize on the resized extents (west/north keep the far edge fixed),
            // then magnetic pull of the moving edges in lines mode.
            let guides = [];
            if (!suppressed && view.snap) {
                const g = view.gridSize > 0 ? view.gridSize : GRID;
                const q = (v) => Math.round(v / g) * g;
                if (dir.includes('e')) w = Math.max(q(w), min.w);
                if (dir.includes('s')) h = Math.max(q(h), min.h);
                if (dir.includes('w')) { const r = o.x + o.w; x = q(x); w = Math.max(r - x, min.w); x = r - w; }
                if (dir.includes('n')) { const b = o.y + o.h; y = q(y); h = Math.max(b - y, min.h); y = b - h; }
                if (view.snapMode === 'lines') {
                    const parent = parentOf(c.id);
                    const sn = snapResizeRect(x, y, w, h, dir,
                        snapExclude([{ g: c }]), parent, frameOrigin(parent));
                    x = sn.x; y = sn.y;
                    w = Math.max(sn.w, min.w); h = Math.max(sn.h, min.h);
                    guides = sn.guides;
                }
            }
            c.properties.x = Math.round(x); c.properties.y = Math.round(y);
            c.properties.width = Math.round(w); c.properties.height = Math.round(h);
            if (dir.includes('e') || dir.includes('w')) markChanged(c, 'width');
            if (dir.includes('s') || dir.includes('n')) markChanged(c, 'height');
            if (dir.includes('w')) markChanged(c, 'x');
            if (dir.includes('n')) markChanged(c, 'y');
            const live = nodeFor(c.id);
            if (live) {
                live.style.left = c.properties.x + 'px';
                live.style.top = c.properties.y + 'px';
                live.style.width = Math.max(c.properties.width, 2) + 'px';
                live.style.height = Math.max(c.properties.height, 2) + 'px';
            }
            renderSnapGuides(guides);
            updateInspectorValues();
            renderStatusForSelection();
        }
        function up() {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            clearGuides();
            commit();
        }
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }

    // --------------------------------------------------------------- guides
    let guides = [];
    function clearGuides() { for (const g of guides) g.remove(); guides = []; }
    /**
     * Task 3 (#49) SnapLines: VS-style edge/center/baseline alignment with magnetic
     * pull. Render-only drag math + guide divs — the committed schema carries plain
     * x/y/width/height, so no patcher, schema or protocol change, and no ADR.
     *
     * - Alt held on the move/resize event suppresses everything (handled by the
     *   callers, not here): raw 1px deltas, no pull, no guides.
     * - `grid` mode (or master snap off) skips pull + guides; grid quantize still
     *   applies while master snap is on.
     * - Candidates are same-frame editable siblings (same parent object, unlocked)
     *   plus the parent frame's own edges. Locked controls never participate: a
     *   TLP/FLP child cannot reach here anyway (B2 — those types are unmodelled, so
     *   they arrive locked), and this exclusion is what suppresses snaplines around
     *   them. Frame CENTERS are deliberately not candidates: a wide container dragged
     *   past the form middle would otherwise stick mid-form on every pass.
     * - Baselines apply to the MOVE of a single text control only (Label/TextBox/
     *   Button — the types with a text line), never to groups and never to resize.
     *   The offset is conservative (no layout sim, ADR 0006): default 9pt font at
     *   96dpi with a per-type chrome inset. Same-font pairs align exactly;
     *   cross-type pairs align by text line even when their tops differ.
     */
    const BASELINE_TYPES = new Set(['Label', 'TextBox', 'Button']);
    const BASELINE_INSET = { Label: 2, TextBox: 4, Button: 6 };
    function baselineOf(c) {
        if (!c || !c.properties) return null;
        const simple = simpleName(c.type);
        if (!BASELINE_TYPES.has(simple)) return null;
        const f = c.properties.font || {};
        const size = typeof f.size === 'number' && f.size > 0 ? f.size : 9;
        return c.properties.y + (BASELINE_INSET[simple] || 0) + size * (96 / 72) * 0.8;
    }
    /** Snap candidates for one frame: sibling edges + centers + baselines, plus the
     *  frame's own edges. `exclude` holds dragged ids (roots and their descendants,
     *  which ride along) so a control never snaps to itself. */
    function snapCandidates(exclude, parent) {
        const xs = [];
        const ys = [];
        const baselines = [];
        const f = parent
            ? { w: parent.properties.width, h: parent.properties.height }
            : { w: schema.form.clientSize.width, h: schema.form.clientSize.height };
        xs.push(0, f.w);
        ys.push(0, f.h);
        for (const o of allControls(schema.controls)) {
            if (!o.properties || o.locked || exclude.has(o.id)) continue;
            if (parentOf(o.id) !== parent) continue;   // same frame only, never mixed units
            const p = o.properties;
            xs.push(p.x, p.x + p.width / 2, p.x + p.width);
            ys.push(p.y, p.y + p.height / 2, p.y + p.height);
            const bl = baselineOf(o);
            if (bl !== null && bl !== undefined) baselines.push(bl);
        }
        return { xs, ys, baselines };
    }
    /** Nearest candidate within SNAP of `pos`, or null. */
    function nearestSnap(pos, cands) {
        let best = null;
        for (const at of cands) {
            const d = at - pos;
            if (Math.abs(d) <= SNAP && (best === null || Math.abs(d) < Math.abs(best.d))) {
                best = { d, at };
            }
        }
        return best;
    }
    /** Proposed shared bbox of a drag group at a quantized delta. */
    function groupBBox(starts, qx, qy) {
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const s of starts) {
            x1 = Math.min(x1, s.x + qx); y1 = Math.min(y1, s.y + qy);
            x2 = Math.max(x2, s.x + qx + s.g.properties.width);
            y2 = Math.max(y2, s.y + qy + s.g.properties.height);
        }
        return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    /** Dragged ids plus their descendants (children ride along, so they are the
     *  dragged control for snap purposes too). `starts` are dragRoots entries. */
    function snapExclude(starts) {
        const exclude = new Set();
        for (const s of starts) {
            exclude.add(s.g.id);
            for (const d of allControls(s.g.children)) exclude.add(d.id);
        }
        return exclude;
    }
    /** A parent frame's offset in canvas (form) units: the sum of ancestor positions. */
    function frameOrigin(parent) {
        let x = 0, y = 0;
        let p = parent;
        while (p) { x += p.properties.x; y += p.properties.y; p = parentOf(p.id); }
        return { x, y };
    }
    /**
     * Snap a proposed move rect: every rect edge (left/center/right,
     * top/middle/bottom) plus the single-control baseline competes, and the
     * nearest match per axis wins (edges first on exact ties — deterministic).
     * Guides render at every match within SNAP, positioned in canvas units.
     */
    function snapMoveRect(x, y, w, h, bl, exclude, parent, origin) {
        const c = snapCandidates(exclude, parent);
        const found = [];
        let dx = 0, dy = 0;
        let best = null;
        for (const e of [x, x + w / 2, x + w]) {
            const m = nearestSnap(e, c.xs);
            if (m) {
                found.push({ dir: 'v', pos: origin.x + m.at });
                if (best === null || Math.abs(m.d) < Math.abs(best)) best = m.d;
            }
        }
        dx = best === null ? 0 : best;
        best = null;
        for (const e of [y, y + h / 2, y + h]) {
            const m = nearestSnap(e, c.ys);
            if (m) {
                found.push({ dir: 'h', pos: origin.y + m.at });
                if (best === null || Math.abs(m.d) < Math.abs(best)) best = m.d;
            }
        }
        if (bl !== null && bl !== undefined) {
            const m = nearestSnap(bl, c.baselines);
            if (m) {
                found.push({ dir: 'h', pos: origin.y + m.at, baseline: true });
                if (best === null || Math.abs(m.d) < Math.abs(best)) best = m.d;
            }
        }
        dy = best === null ? 0 : best;
        return { dx, dy, guides: found };
    }
    /**
     * Snap a proposed resize rect: only the edges named by `dir` match. East/south
     * grow the extent; west/north move the origin with the far edge fixed. Centers
     * match by moving twice as far (the far edge stays for west/north too).
     */
    function snapResizeRect(x, y, w, h, dir, exclude, parent, origin) {
        const c = snapCandidates(exclude, parent);
        const found = [];
        if (dir.includes('e') || dir.includes('w')) {
            const fixed = dir.includes('e');
            const edge = fixed ? x + w : x;
            const me = nearestSnap(edge, c.xs);
            const mm = nearestSnap(x + w / 2, c.xs);
            let pick = null;
            if (me) pick = { d: me.d, at: me.at, center: false };
            if (mm && (!pick || Math.abs(mm.d) < Math.abs(pick.d))) {
                pick = { d: mm.d, at: mm.at, center: true };
            }
            if (pick) {
                found.push({ dir: 'v', pos: origin.x + pick.at });
                if (fixed) w += pick.center ? pick.d * 2 : pick.d;
                else { const d = pick.center ? pick.d * 2 : pick.d; x += d; w -= d; }
            }
        }
        if (dir.includes('s') || dir.includes('n')) {
            const fixed = dir.includes('s');
            const edge = fixed ? y + h : y;
            const me = nearestSnap(edge, c.ys);
            const mm = nearestSnap(y + h / 2, c.ys);
            let pick = null;
            if (me) pick = { d: me.d, at: me.at, center: false };
            if (mm && (!pick || Math.abs(mm.d) < Math.abs(pick.d))) {
                pick = { d: mm.d, at: mm.at, center: true };
            }
            if (pick) {
                found.push({ dir: 'h', pos: origin.y + pick.at });
                if (fixed) h += pick.center ? pick.d * 2 : pick.d;
                else { const d = pick.center ? pick.d * 2 : pick.d; y += d; h -= d; }
            }
        }
        return { x, y, w, h, guides: found };
    }
    function renderSnapGuides(found) {
        clearGuides();
        const canvas = $('canvas');
        if (!canvas || !found.length) return;
        for (const g of found) {
            const n = makeGuide(g.dir, g.pos, g.dir === 'h' ? canvas.clientWidth : canvas.clientHeight);
            if (g.baseline) n.classList.add('baseline');
        }
    }
    function makeGuide(dir, pos, extent) {
        const g = el('div', 'guide ' + dir);
        // Controls now carry explicit z-indexes (A1), so view chrome needs one too or it
        // paints underneath them.
        g.style.zIndex = '1000';
        if (dir === 'h') { g.style.top = pos + 'px'; g.style.width = extent + 'px'; }
        else { g.style.left = pos + 'px'; g.style.height = extent + 'px'; }
        $('canvas').appendChild(g);
        return g;
    }

    // -------------------------------------------------------------- inspector
    /**
     * Object selector dropdown (D9): the VS Properties-window object list. Jump
     * selection to a hidden/buried control — selection today is otherwise
     * click/marquee/drill-down only.
     *
     * Selection ONLY: this calls the existing single select() and never edits,
     * reorders, or commits. Locked entries stay enabled so choosing one selects
     * it alone (that is how its reason is readable — invariant 4); select()
     * with no extend can never JOIN a group. Any drill-down scope is left first,
     * because select() ignores ids outside it and a jump must always land.
     */
    function renderObjectSelector(box) {
        if (!schema) return;
        const wrap = el('div', 'object-selector');
        const lab = el('label', null, 'Object');
        lab.setAttribute('for', 'fObjectSelector');
        wrap.appendChild(lab);
        const dropdown = document.createElement('select');
        dropdown.id = 'fObjectSelector';
        dropdown.title = 'Jump selection to any control, including hidden or buried ones';
        const current = selected();
        const currentId = current.length === 1 ? current[0].id : '';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Select a control…';
        dropdown.appendChild(blank);
        const walk = (nodes, trail) => {
            for (const n of nodes || []) {
                const simple = simpleName(n.type);
                const path = trail.concat(n.id).join(' › ');
                const opt = document.createElement('option');
                opt.value = n.id;
                opt.textContent = n.locked ? `${path} (${simple}, locked)` : `${path} (${simple})`;
                if (n.locked && n.lockedReason) opt.title = n.lockedReason;
                if (n.id === currentId) opt.selected = true;
                dropdown.appendChild(opt);
                walk(n.children, trail.concat(n.id));
            }
        };
        walk(schema.controls, []);
        dropdown.addEventListener('change', () => {
            const id = dropdown.value;
            if (!id || !findControl(id)) return;
            activeContainer = null;
            select(id);
        });
        wrap.appendChild(dropdown);
        box.appendChild(wrap);
    }
    function renderInspector() {
        const box = $('inspector');
        box.innerHTML = '';
        renderObjectSelector(box);
        const sel = selected();
        if (sel.length === 0) {
            renderFormInspector(box);
            applyInspectorView(box);
            decorateInspectorRows(box, null);
            renderInspectorDescription(box, `${schema.form.name} (Form) — focus a row to read its description.`);
            applyInspectorFilter();
            return;
        }
        if (sel.length > 1) {
            // Task 5 (#51): common-property intersection rows (agreed values
            // show, divergent show blank) plus the operations that act on the
            // group. Geometry stays on the group ops, never as rows.
            box.appendChild(el('h3', null, `${sel.length} controls selected`));
            renderMultiProps(box, sel);
            for (const [label, fn] of alignActions()) {
                box.appendChild(el('button', null, label)).addEventListener('click', fn);
            }
            renderInspectorDescription(box, `${sel.length} controls selected — focus a row to read its description.`);
            applyInspectorFilter();
            return;
        }
        const c = sel[0];
        const simple = simpleName(c.type);
        box.appendChild(el('h3', null, `${simple} — ${c.id}`));
        renderInspectorViewToggle(box);

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
        // Task 6 (#52) TabStop: the designer default is true, so an unset value
        // renders checked — the same default-true shape as Enabled/Visible above.
        // Commits through the scalar setProp path (with a TabStop INSERT for the
        // first `false`, like Enabled); the engine patch is additive (SCHEMA.md).
        box.appendChild(boolField('TabStop', c.properties.tabStop !== false, appearanceBlocked,
            (v) => setProp(c, 'tabStop', v)));

        if (['Label', 'Button', 'CheckBox', 'RadioButton'].includes(simple)) {
            box.appendChild(boolField('AutoSize', !!c.properties.autoSize, appearanceBlocked,
                (v) => setProp(c, 'autoSize', v)));
        }

        // ---------------------------------------------------------------- appearance
        // These are already in the schema and were already parsed by the engine for all of
        // them. Wiring the inspector is what makes them reachable at all
        // (docs/spec-features.md §3: cheapest real capability in the project — no schema
        // change, no ADR).
        box.appendChild(el('h4', 'inspector-section', 'Appearance'));

        // Booleans are CHECKBOXES, not text fields: "false" typed as a string is a typo that
        // silently produces a different property value.
        box.appendChild(boolField('Enabled', c.properties.enabled !== false,
            appearanceBlocked, (v) => setProp(c, 'enabled', v)));
        box.appendChild(boolField('Visible', c.properties.visible !== false,
            appearanceBlocked, (v) => setProp(c, 'visible', v)));

        box.appendChild(colorField('BackColor', c.properties.backColor ?? '',
            appearanceBlocked, (v) => setProp(c, 'backColor', v)));
        box.appendChild(colorField('ForeColor', c.properties.foreColor ?? '',
            appearanceBlocked, (v) => setProp(c, 'foreColor', v)));

        if (simple === 'CheckBox' || simple === 'RadioButton') {
            box.appendChild(boolField('Checked', !!c.properties.checked, appearanceBlocked,
                (v) => setProp(c, 'checked', v)));
        }

        if (['Button', 'Label', 'CheckBox', 'RadioButton'].includes(simple)) {
            box.appendChild(selectField('TextAlign', c.properties.textAlign || 'MiddleLeft',
                ['TopLeft', 'TopCenter', 'TopRight', 'MiddleLeft', 'MiddleCenter', 'MiddleRight', 'BottomLeft', 'BottomCenter', 'BottomRight'],
                appearanceBlocked, (v) => setProp(c, 'textAlign', v)));
        } else if (simple === 'TextBox') {
            box.appendChild(selectField('TextAlign', c.properties.textAlign || 'Left',
                ['Left', 'Center', 'Right'],
                appearanceBlocked, (v) => setProp(c, 'textAlign', v)));
        }

        if (['Label', 'TextBox', 'Panel', 'PictureBox', 'DataGridView', 'ListView', 'TreeView'].includes(simple)) {
            box.appendChild(selectField('BorderStyle', c.properties.borderStyle || 'None',
                ['None', 'FixedSingle', 'Fixed3D'], appearanceBlocked,
                (v) => setProp(c, 'borderStyle', v)));
        }

        if (HAS_FONT.has(simple)) {
            const f = c.properties.font || { size: 9, bold: false, italic: false };
            box.appendChild(numField('Font size', f.size ?? 9, appearanceBlocked,
                (v) => setProp(c, 'font', Object.assign({}, f, { size: v }))));
            box.appendChild(boolField('Bold', !!f.bold, appearanceBlocked,
                (v) => setProp(c, 'font', Object.assign({}, f, { bold: v }))));
            box.appendChild(boolField('Italic', !!f.italic, appearanceBlocked,
                (v) => setProp(c, 'font', Object.assign({}, f, { italic: v }))));
            // D8: the modal dialog is a second input over the same setProp('font')
            // path — never a new write path. Locked/refused get no button.
            if (!appearanceBlocked) {
                const fontEdit = el('div', 'field');
                fontEdit.dataset.prop = 'Font editor'; fontEdit.dataset.cat = propCategory('Font editor');
                fontEdit.appendChild(el('label', null, 'Font editor'));
                const fontBtn = el('button', 'font-edit-btn', 'Edit Font…');
                fontBtn.title = 'Edit family, size and style in a dialog';
                fontBtn.addEventListener('click', () => openFontDialog(c));
                fontEdit.appendChild(fontBtn);
                box.appendChild(fontEdit);
            }
        }

        // Items list editor — only for ComboBox and ListBox (they have Items in the schema)
        if ((simple === 'ComboBox' || simple === 'ListBox') && !appearanceBlocked) {
            box.appendChild(el('h4', 'inspector-section', 'Items'));
            const itemsContainer = el('div', 'items-editor');
            itemsContainer.dataset.prop = 'Items'; itemsContainer.dataset.cat = propCategory('Items');
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

            // A5 follow-ups: selection + drop-down style, same commit path as Items.
            box.appendChild(numField('SelectedIndex', c.properties.selectedIndex ?? -1, appearanceBlocked,
                (v) => setProp(c, 'selectedIndex', v)));
            box.appendChild(strField('SelectedItem', c.properties.selectedItem ?? '', appearanceBlocked,
                (v) => setProp(c, 'selectedItem', v)));
            if (simple === 'ComboBox') {
                box.appendChild(selectField('DropDownStyle', c.properties.dropDownStyle || 'DropDown',
                    ['Simple', 'DropDown', 'DropDownList'], appearanceBlocked,
                    (v) => setProp(c, 'dropDownStyle', v)));
            }
        }

        // TextBox-specific properties
        if (simple === 'TextBox' && !appearanceBlocked) {
            box.appendChild(el('h4', 'inspector-section', 'TextBox'));
            box.appendChild(boolField('Multiline', !!c.properties.multiline, appearanceBlocked,
                (v) => setProp(c, 'multiline', v)));
            box.appendChild(boolField('ReadOnly', !!c.properties.readOnly, appearanceBlocked,
                (v) => setProp(c, 'readOnly', v)));
            box.appendChild(numField('MaxLength', c.properties.maxLength ?? 32767, appearanceBlocked,
                (v) => setProp(c, 'maxLength', v)));
            box.appendChild(strField('PasswordChar', c.properties.passwordChar ?? '', appearanceBlocked,
                (v) => setProp(c, 'passwordChar', v ? v.slice(0, 1) : '')));
            box.appendChild(selectField('ScrollBars', c.properties.scrollBars || 'None',
                ['None', 'Horizontal', 'Vertical', 'Both'], appearanceBlocked,
                (v) => setProp(c, 'scrollBars', v)));
        }

        // Leaf widget values and ranges (TrackBar, ProgressBar, NumericUpDown)
        if (['TrackBar', 'ProgressBar', 'NumericUpDown'].includes(simple) && !appearanceBlocked) {
            box.appendChild(el('h4', 'inspector-section', 'Range'));
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

        // Center in Form also applies to a single control; same-size needs two, so it lives
        // in the multi-selection box (alignActions) only.
        if (!c.locked && !readOnly) {
            box.appendChild(el('h4', null, 'Arrange'));
            box.appendChild(el('button', null, 'Center in Form Horizontally'))
                .addEventListener('click', () => align('center-form-h'));
            box.appendChild(el('button', null, 'Center in Form Vertically'))
                .addEventListener('click', () => align('center-form-v'));
            box.appendChild(el('button', null, 'Bring to Front'))
                .addEventListener('click', () => zorderSelection('front'));
            box.appendChild(el('button', null, 'Send to Back'))
                .addEventListener('click', () => zorderSelection('back'));
        }

        if (!c.locked && !readOnly) {
            box.appendChild(el('button', 'danger', `Delete ${c.id}`)).addEventListener('click', () => deleteControl(c.id));
        }

        // Task 5 (#51): read-only Events (A3 stays missing), then bold+Reset
        // decoration over the built rows, then the description pane. Neither
        // div is a .field row, so the D10 regroup and filter ignore them.
        renderEventsSection(box);

        applyInspectorView(box);
        // After the regroup: rows moved, so decoration and the pane land last.
        decorateInspectorRows(box, c);
        renderInspectorDescription(box, `${simple} ${c.id} — focus a row to read its description.`);
        applyInspectorFilter();
    }

    function renderFormInspector(box) {
        if (!schema) return;
        box.appendChild(el('h3', null, `${schema.form.name} (Form)`));
        renderInspectorViewToggle(box);
        if (readOnly) {
            const n = el('div', 'field');
            n.appendChild(el('div', 'note warn',
                'This form is read-only in VSCForms. Open it as text to edit it.'));
            box.appendChild(n);
        }
        box.appendChild(strField('Title (Text)', schema.form.text || '', readOnly, (v) => {
            schema.form.text = v;
            commit();
        }));
        box.appendChild(numField('Width', schema.form.clientSize.width, readOnly, (v) => {
            schema.form.clientSize.width = Math.max(v, 80);
            commit();
        }));
        box.appendChild(numField('Height', schema.form.clientSize.height, readOnly, (v) => {
            schema.form.clientSize.height = Math.max(v, 60);
            commit();
        }));
        box.appendChild(el('h4', 'inspector-section', 'Appearance'));
        box.appendChild(colorField('BackColor', schema.form.backColor ?? '', readOnly, (v) => {
            schema.form.backColor = v;
            commit();
        }));
        // Task 5 (#51): form rows get descriptions only — no dirty tracking on
        // the form (its edits assign schema.form directly, never via setProp).
        // NOTE: the pane is appended by the renderInspector caller, AFTER
        // applyInspectorView — the regroup appends moved rows at the end, so a
        // pane appended here would end up mid-box in Categorized/Alphabetical.
    }

    /**
     * D10 view toggle + regroup. The toggle is view state: clicking re-renders the
     * inspector only, never touches `schema`, never posts a commit — so switching
     * views is byte-identical on the file by construction (same class as D1/D5).
     * Categorized groups by PROP_CATEGORIES in alphabetical category order with
     * uncategorized rows under Misc; Alphabetical is one flat A–Z list. Both drop
     * the flat section heads (`.inspector-section`) and keep action surfaces
     * (Arrange/Delete, warnings, object selector) outside the groups. Nodes are
     * MOVED, not rebuilt, so field listeners and in-progress input survive the switch.
     */
    function renderInspectorViewToggle(box) {
        const wrap = el('div', 'inspector-view');
        wrap.setAttribute('role', 'group');
        wrap.title = 'Inspector view. Switching views never touches the file.';
        for (const [mode, label] of [['flat', 'Flat'], ['categorized', 'Categorized'], ['alphabetical', 'Alphabetical']]) {
            const b = el('button', 'inspector-view-btn', label);
            b.dataset.view = mode;
            if (inspectorView === mode) b.setAttribute('aria-pressed', 'true');
            else b.setAttribute('aria-pressed', 'false');
            b.title = mode === 'flat'
                ? 'Flat view (current order). Switching views never touches the file.'
                : `${label} view. Switching views never touches the file.`;
            b.addEventListener('click', () => {
                if (inspectorView === mode) return;
                inspectorView = mode;
                renderInspector();
            });
            wrap.appendChild(b);
        }
        box.appendChild(wrap);
    }

    function applyInspectorView(box) {
        if (inspectorView === 'flat' || !box) return;
        // Legacy flat grouping heads are wrong in every other view — drop them. The
        // Arrange head is an ACTION head (not tagged) and stays, anchoring the tail.
        // (Class-only selectors: the harness stand-in matches those faithfully.)
        for (const h of box.querySelectorAll('.inspector-section')) h.remove();
        // Property rows: every *Field div carries dataset.prop/cat; the Items list
        // editor is a div.items-editor tagged the same way. Warnings carry neither
        // and stay at the top; action buttons carry neither and stay at the tail.
        const rows = [];
        for (const n of Array.from(box.children)) {
            if ((n.classList && n.classList.contains('field') && n.dataset && n.dataset.prop)
                || (n.classList && n.classList.contains('items-editor'))) {
                rows.push(n);
            }
        }
        if (!rows.length) return;
        const anchor = Array.from(box.children).find((n) =>
            n.tagName === 'H4' && /Arrange/.test(n.textContent || ''));
        for (const r of rows) r.remove();
        const labelOf = (n) => String((n.dataset && n.dataset.prop) || '');
        if (inspectorView === 'alphabetical') {
            rows.sort((a, b) => labelOf(a).toLowerCase() < labelOf(b).toLowerCase() ? -1 : 1);
            for (const r of rows) {
                if (anchor) box.insertBefore(r, anchor);
                else box.appendChild(r);
            }
            return;
        }
        // Categorized: alphabetical category order, A–Z labels within a category.
        const groups = new Map();
        for (const r of rows) {
            const cat = (r.dataset && r.dataset.cat) || 'Misc';
            if (!groups.has(cat)) groups.set(cat, []);
            groups.get(cat).push(r);
        }
        for (const cat of Array.from(groups.keys()).sort()) {
            const head = el('h4', 'inspector-cat', cat);
            if (anchor) box.insertBefore(head, anchor);
            else box.appendChild(head);
            const list = groups.get(cat).sort((a, b) =>
                labelOf(a).toLowerCase() < labelOf(b).toLowerCase() ? -1 : 1);
            for (const r of list) {
                if (anchor) box.insertBefore(r, anchor);
                else box.appendChild(r);
            }
        }
    }

    function setProp(c, key, value) {
        markChanged(c, key);
        c.properties[key] = value;
        commit();
    }

    /**
     * Task 5 (#51) edit-recency mark. Render-time only: commit() re-renders
     * first, so decorateInspectorRows picks the class up on the next paint.
     * Geometry gestures mark here too (they mutate properties directly, never
     * through setProp).
     */
    function markChanged(c, key) {
        if (!c || !key) return;
        let set = changedProps.get(c.id);
        if (!set) { set = new Set(); changedProps.set(c.id, set); }
        set.add(key);
    }
    function isChanged(id, key) {
        const set = changedProps.get(id);
        return !!set && set.has(key);
    }

    function boolField(label, value, disabled, onChange) {
        const f = el('div', 'field');
        f.dataset.prop = label; f.dataset.cat = propCategory(label);
        const id = 'f' + label;
        const row = el('div', 'row');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.id = id;
        box.checked = !!value;
        // Task 5 (#51) multi-select divergence: null renders the indeterminate
        // dash, never a checked/unchecked claim about the group.
        if (value === null || value === undefined) box.indeterminate = true;
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
        f.dataset.prop = label; f.dataset.cat = propCategory(label);
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
        f.dataset.prop = label; f.dataset.cat = propCategory(label);
        const id = 'f' + label.replace(/\s+/g, '');
        const lab = el('label', null, label);
        lab.setAttribute('for', id);
        f.appendChild(lab);
        const i = document.createElement('input');
        i.id = id;
        // Task 5 (#51): null is the multi-select divergent blank, never "null".
        i.type = 'number'; i.value = (value === null || value === undefined) ? '' : String(value); i.disabled = !!disabled;
        i.addEventListener('change', () => {
            const v = parseInt(i.value, 10);
            if (!Number.isNaN(v)) onChange(v);
        });
        f.appendChild(i);
        return f;
    }
    function strField(label, value, disabled, onChange) {
        const f = el('div', 'field');
        f.dataset.prop = label; f.dataset.cat = propCategory(label);
        const id = 'f' + label.replace(/\s+/g, '');
        const lab = el('label', null, label);
        lab.setAttribute('for', id);
        f.appendChild(lab);
        const i = document.createElement('input');
        i.id = id;
        // Task 5 (#51): null is the multi-select divergent blank, never "null".
        i.type = 'text'; i.value = (value === null || value === undefined) ? '' : value; i.disabled = !!disabled;
        i.addEventListener('change', () => onChange(i.value));
        f.appendChild(i);
        return f;
    }
    function selectField(label, value, options, disabled, onChange) {
        const f = el('div', 'field');
        f.dataset.prop = label; f.dataset.cat = propCategory(label);
        const id = 'f' + label.replace(/\s+/g, '');
        const lab = el('label', null, label);
        lab.setAttribute('for', id);
        f.appendChild(lab);
        const sel = document.createElement('select');
        sel.id = id;
        sel.disabled = !!disabled;
        for (const optVal of options) {
            const opt = document.createElement('option');
            opt.value = optVal;
            opt.textContent = optVal;
            if (optVal.toLowerCase() === (value || '').toLowerCase()) opt.selected = true;
            sel.appendChild(opt);
        }
        sel.addEventListener('change', () => onChange(sel.value));
        f.appendChild(sel);
        return f;
    }
    function setupInspectorFilter() {
        const filterInput = $('inspector-filter');
        if (!filterInput) return;
        filterInput.addEventListener('input', () => {
            inspectorFilter = filterInput.value.trim().toLowerCase();
            applyInspectorFilter();
        });
    }
    function applyInspectorFilter() {
        const box = $('inspector');
        if (!box) return;
        const query = (inspectorFilter || '').trim().toLowerCase();
        const fields = box.querySelectorAll('.field');
        for (const f of fields) {
            if (!query) {
                f.style.display = '';
                continue;
            }
            const lab = f.querySelector('label');
            const text = lab ? lab.textContent.toLowerCase() : '';
            f.style.display = text.includes(query) ? '' : 'none';
        }
        // D10: an empty category head is clutter — hide it when none of its rows
        // survive the filter. (The Items list editor is never filtered, as in flat.)
        // Index-based sibling walk: works on the live DOM and the harness stand-in.
        const kids = Array.from(box.children);
        for (const h of box.querySelectorAll('.inspector-cat')) {
            if (!query) { h.style.display = ''; continue; }
            const cat = h.textContent;
            let any = false;
            for (let i = kids.indexOf(h) + 1; i < kids.length; i++) {
                const n = kids[i];
                if (n.tagName === 'H4') break;
                if (n.classList && n.classList.contains('field')
                    && n.dataset && n.dataset.cat === cat && n.style.display !== 'none') {
                    any = true;
                    break;
                }
            }
            h.style.display = any ? '' : 'none';
        }
    }
    function inspectorInputById(id) {
        const ins = $('inspector');
        if (!ins) return null;
        // By id scan, not querySelector('#…'): ids like fTitle(Text) hold parens.
        // Index-based lookup would break outside flat view, where X/Y/W/H move.
        return Array.from(ins.querySelectorAll('input')).find((n) => n.id === id) || null;
    }
    function updateInspectorValues() {
        const sel = selected();
        if (sel.length === 1) {
            const c = sel[0];
            const pairs = [['fX', c.properties.x], ['fY', c.properties.y],
                ['fWidth', c.properties.width], ['fHeight', c.properties.height]];
            for (const [id, v] of pairs) {
                const input = inspectorInputById(id);
                if (input) input.value = String(v);
            }
        } else if (sel.length === 0) {
            updateFormInspectorValues();
        }
    }

    // ------------------------------------------------- Task 5 (#51) inspector
    /**
     * Task 5 (#51) VS parity: bold+Reset, multi common-props, description
     * pane, Events read-only. View-only: bold/Reset ride the existing
     * setProp/commit/generate path, multi rows reuse the *Field builders, the
     * pane is text, and Events is a note — no schema/protocol change, no ADR.
     */

    /**
     * Hardcoded per-property descriptions (VS `[Description]` equivalent).
     * The engine cannot load .NET attributes (type resolution is purely
     * syntactic), so these live here next to PROP_CATEGORIES. Keys are the
     * inspector field labels, NOT schema keys. Every offered label must have
     * an entry; showDescription falls back to the pane default text.
     */
    const PROP_DESCRIPTIONS = {
        'X': 'Distance from the left edge of the parent, in form units.',
        'Y': 'Distance from the top edge of the parent, in form units.',
        'Width': 'Control width, in form units. Drag, nudge, or type an exact value.',
        'Height': 'Control height, in form units. Drag, nudge, or type an exact value.',
        'AutoSize': 'Grow or shrink to fit the caption. Labels default to on.',
        'Text': 'The caption shown on the control. Disabled for types that render no text.',
        'Title (Text)': 'The form title shown in the title bar.',
        'BackColor': 'Background colour. Default restores the system colour.',
        'ForeColor': 'Colour of the caption text.',
        'Font size': 'Font size in points. Commits through the same path as the Font dialog.',
        'Bold': 'Bold caption text.',
        'Italic': 'Italic caption text.',
        'Font editor': 'Edit family, size and style in a dialog. Same value as the inline rows.',
        'TextAlign': 'Where the caption sits inside the control.',
        'BorderStyle': 'The edge drawn around the control.',
        'Checked': 'Whether the control starts checked.',
        'Enabled': 'Unchecked greys the control out at runtime.',
        'Visible': 'Unchecked hides the control at runtime; it stays visible here.',
        'TabIndex': 'Focus order when the user presses Tab. Tab-order mode assigns these by click.',
        'TabStop': 'Whether Tab stops on this control. Off skips it in the focus order.',
        'Multiline': 'Allow more than one line of text.',
        'ReadOnly': 'Text can be selected and copied, but not edited.',
        'MaxLength': 'Most characters the text may hold. 32767 is effectively unlimited.',
        'PasswordChar': 'Mask character, e.g. *. Empty means plain text.',
        'ScrollBars': 'Which scroll bars the text box shows.',
        'Minimum': 'Lowest value of the range.',
        'Maximum': 'Highest value of the range.',
        'Value': 'Current value of the range.',
        'SelectedIndex': 'Which item starts selected. -1 selects nothing.',
        'SelectedItem': 'The selected item text. Empty means none.',
        'DropDownStyle': 'DropDown allows typing; DropDownList restricts to the list.',
        'Items': 'The list entries. Add, edit, or remove them here.',
        'Name': 'The control name. Renaming posts a rename message, never a schema commit.',
    };

    /** Inspector label -> schema property key. Geometry and Name have no Reset:
     *  geometry has no unset state, and Name travels by rename message. */
    const PROP_KEY = {
        'X': 'x', 'Y': 'y', 'Width': 'width', 'Height': 'height',
        'Text': 'text', 'TabIndex': 'tabIndex', 'TabStop': 'tabStop', 'AutoSize': 'autoSize',
        'Enabled': 'enabled', 'Visible': 'visible',
        'BackColor': 'backColor', 'ForeColor': 'foreColor',
        'Checked': 'checked', 'TextAlign': 'textAlign', 'BorderStyle': 'borderStyle',
        'Font size': 'font', 'Bold': 'font', 'Italic': 'font',
        'SelectedIndex': 'selectedIndex', 'SelectedItem': 'selectedItem',
        'DropDownStyle': 'dropDownStyle',
        'Multiline': 'multiline', 'ReadOnly': 'readOnly', 'MaxLength': 'maxLength',
        'PasswordChar': 'passwordChar', 'ScrollBars': 'scrollBars',
        'Minimum': 'minimum', 'Maximum': 'maximum', 'Value': 'value',
    };
    const NO_RESET_KEYS = new Set(['x', 'y', 'width', 'height']);

    /** Show one property's description in the pane (VS description pane). */
    function showDescription(label) {
        if (label) describedProp = label;
        const ins = $('inspector');
        const pane = ins && ins.querySelector('.inspector-description');
        if (!pane) return;
        const key = label || describedProp;
        pane.textContent = (key && PROP_DESCRIPTIONS[key])
            || pane.dataset.defaultText || '';
    }
    /** The pane itself: plain text at the inspector bottom, rebuilt every
     *  render (renderInspector rebuilds the box) with the last label kept. */
    function renderInspectorDescription(box, defaultText) {
        const d = el('div', 'inspector-description', '');
        d.dataset.defaultText = defaultText;
        d.textContent = (describedProp && PROP_DESCRIPTIONS[describedProp]) || defaultText;
        box.appendChild(d);
    }
    function wireRowDescription(row, label) {
        if (!row || !label || !PROP_DESCRIPTIONS[label]) return;
        const attach = (n) => {
            if (n) n.addEventListener('focus', () => showDescription(label));
        };
        attach(row.querySelector('input'));
        attach(row.querySelector('select'));
    }

    /**
     * Bold + Reset over already-built single-select rows. Post-pass so the
     * ~30 single-select call sites stay untouched: every row carries
     * dataset.prop, which maps to a schema key via PROP_KEY.
     *
     * Reset DELETES the key from the model and commits through the existing
     * generate diff (the Items DELETE block is the engine precedent). Two
     * deliberate limits: geometry rows bold but never reset (no unset state),
     * and disabled rows (locked/refused) get neither — a Reset there would
     * imply writability we have promised never to exercise (invariant 4).
     *
     * Engine honesty note: generate replaces/inserts scalar statements but
     * never deletes them (only Items blocks and whole controls). Resetting a
     * colour/Font the file already states is therefore a model-side delete
     * the engine answers with "No changes to write" until scalar-delete
     * support lands — visible in the status line, never a corruption.
     */
    function decorateInspectorRows(box, c) {
        const rows = box.querySelectorAll('.field');
        for (const f of rows) {
            const label = f.dataset && f.dataset.prop;
            if (!label) continue;
            wireRowDescription(f, label);
            if (!c) continue;
            const key = PROP_KEY[label];
            if (!key || !isChanged(c.id, key)) continue;
            f.classList.add('changed');
            if (NO_RESET_KEYS.has(key)) continue;
            const main = f.querySelector('input') || f.querySelector('select');
            if (main && main.disabled) continue;
            if (f.querySelector('.prop-reset')) continue;
            const b = el('button', 'prop-reset', 'Reset');
            b.title = 'Reset: delete this value from the model and commit';
            b.addEventListener('click', () => {
                delete c.properties[key];
                commit();
            });
            f.appendChild(b);
        }
        const itemsEd = box.querySelector('.items-editor');
        if (itemsEd) {
            for (const n of itemsEd.querySelectorAll('input')) {
                n.addEventListener('focus', () => showDescription('Items'));
            }
        }
    }

    /**
     * Events section (A3 stays missing). The schema carries no wirings —
     * parse preserves `+=` lines byte-identical without surfacing them, and
     * surfacing them needs the engine parse step from spec-property-tabs §4
     * (a separate change). So this section states the gap read-only: no
     * inputs, no buttons, no scaffold, nothing that writes. Full scaffolding
     * (wiring + Form1.cs stub) needs the #28 ADR, like rename needed 0008.
     */
    function renderEventsSection(box) {
        box.appendChild(el('h4', 'inspector-section', 'Events'));
        const n = el('div', 'events-readonly',
            'Event wirings (e.g. Click += …) live in the Designer file and are '
            + 'preserved untouched. Wiring display and handler scaffolding are not '
            + 'modelled yet (A3) — nothing here writes the file, by design.');
        box.appendChild(n);
    }

    /**
     * Multi-select common properties (VS SelectedObjects intersection). A row
     * is offered only when EVERY member admits it under the same gating the
     * single-select renderer uses — never a new row class, so every offered
     * row rides an existing INSERT path (SCHEMA.md rule: no unwired rows).
     * Agreed values show; divergent show blank (checkboxes indeterminate).
     * One edit writes all members, one debounced commit. Geometry stays on
     * the group ops (align/same-size/center): absolute X/Y rows would fight
     * them. Locked members or a refused form offer ops only, as before.
     */
    function multiCandidates() {
        const btnAlign = ['Button', 'Label', 'CheckBox', 'RadioButton'];
        const fontOf = (c) => c.properties.font || {};
        return [
            { label: 'Text', key: 'text', applies: (s) => !NO_TEXT.has(s),
              get: (c) => c.properties.text ?? '',
              set: (c, v) => { c.properties.text = v; } },
            { label: 'Enabled', key: 'enabled', applies: () => true,
              get: (c) => c.properties.enabled !== false, kind: 'bool',
              set: (c, v) => { c.properties.enabled = v; } },
            { label: 'Visible', key: 'visible', applies: () => true,
              get: (c) => c.properties.visible !== false, kind: 'bool',
              set: (c, v) => { c.properties.visible = v; } },
            { label: 'BackColor', key: 'backColor', applies: () => true, kind: 'color',
              get: (c) => c.properties.backColor ?? '',
              set: (c, v) => { c.properties.backColor = v; } },
            { label: 'ForeColor', key: 'foreColor', applies: () => true, kind: 'color',
              get: (c) => c.properties.foreColor ?? '',
              set: (c, v) => { c.properties.foreColor = v; } },
            { label: 'Checked', key: 'checked', applies: (s) => s === 'CheckBox' || s === 'RadioButton', kind: 'bool',
              get: (c) => !!c.properties.checked,
              set: (c, v) => { c.properties.checked = v; } },
            { label: 'TextAlign', key: 'textAlign', applies: (s) => btnAlign.includes(s),
              options: ['TopLeft', 'TopCenter', 'TopRight', 'MiddleLeft', 'MiddleCenter', 'MiddleRight', 'BottomLeft', 'BottomCenter', 'BottomRight'],
              get: (c) => c.properties.textAlign || 'MiddleLeft',
              set: (c, v) => { c.properties.textAlign = v; } },
            { label: 'TextAlign', key: 'textAlign', applies: (s) => s === 'TextBox',
              options: ['Left', 'Center', 'Right'],
              get: (c) => c.properties.textAlign || 'Left',
              set: (c, v) => { c.properties.textAlign = v; } },
            { label: 'BorderStyle', key: 'borderStyle',
              applies: (s) => ['Label', 'TextBox', 'Panel', 'PictureBox', 'DataGridView', 'ListView', 'TreeView'].includes(s),
              options: ['None', 'FixedSingle', 'Fixed3D'],
              get: (c) => c.properties.borderStyle || 'None',
              set: (c, v) => { c.properties.borderStyle = v; } },
            { label: 'AutoSize', key: 'autoSize', applies: (s) => btnAlign.includes(s), kind: 'bool',
              get: (c) => !!c.properties.autoSize,
              set: (c, v) => { c.properties.autoSize = v; } },
            { label: 'Font size', key: 'font', applies: (s) => HAS_FONT.has(s), kind: 'num',
              get: (c) => fontOf(c).size ?? 9,
              set: (c, v) => { c.properties.font = Object.assign({}, fontOf(c), { size: v }); } },
            { label: 'Bold', key: 'font', applies: (s) => HAS_FONT.has(s), kind: 'bool',
              get: (c) => !!fontOf(c).bold,
              set: (c, v) => { c.properties.font = Object.assign({}, fontOf(c), { bold: v }); } },
            { label: 'Italic', key: 'font', applies: (s) => HAS_FONT.has(s), kind: 'bool',
              get: (c) => !!fontOf(c).italic,
              set: (c, v) => { c.properties.font = Object.assign({}, fontOf(c), { italic: v }); } },
            { label: 'TabIndex', key: 'tabIndex', applies: () => true, kind: 'num',
              get: (c) => c.properties.tabIndex ?? 0,
              set: (c, v) => { c.properties.tabIndex = v; } },
            { label: 'TabStop', key: 'tabStop', applies: () => true, kind: 'bool',
              get: (c) => c.properties.tabStop !== false,
              set: (c, v) => { c.properties.tabStop = v; } },
            { label: 'Multiline', key: 'multiline', applies: (s) => s === 'TextBox', kind: 'bool',
              get: (c) => !!c.properties.multiline,
              set: (c, v) => { c.properties.multiline = v; } },
            { label: 'ReadOnly', key: 'readOnly', applies: (s) => s === 'TextBox', kind: 'bool',
              get: (c) => !!c.properties.readOnly,
              set: (c, v) => { c.properties.readOnly = v; } },
            { label: 'MaxLength', key: 'maxLength', applies: (s) => s === 'TextBox', kind: 'num',
              get: (c) => c.properties.maxLength ?? 32767,
              set: (c, v) => { c.properties.maxLength = v; } },
            { label: 'PasswordChar', key: 'passwordChar', applies: (s) => s === 'TextBox',
              get: (c) => c.properties.passwordChar ?? '',
              set: (c, v) => { c.properties.passwordChar = v ? v.slice(0, 1) : ''; } },
            { label: 'ScrollBars', key: 'scrollBars', applies: (s) => s === 'TextBox',
              options: ['None', 'Horizontal', 'Vertical', 'Both'],
              get: (c) => c.properties.scrollBars || 'None',
              set: (c, v) => { c.properties.scrollBars = v; } },
            { label: 'Minimum', key: 'minimum', applies: (s) => ['TrackBar', 'ProgressBar', 'NumericUpDown'].includes(s), kind: 'num',
              get: (c) => c.properties.minimum ?? 0,
              set: (c, v) => { c.properties.minimum = v; } },
            { label: 'Maximum', key: 'maximum', applies: (s) => ['TrackBar', 'ProgressBar', 'NumericUpDown'].includes(s), kind: 'num',
              get: (c) => c.properties.maximum ?? 100,
              set: (c, v) => { c.properties.maximum = v; } },
            { label: 'Value', key: 'value', applies: (s) => ['TrackBar', 'ProgressBar', 'NumericUpDown'].includes(s), kind: 'num',
              get: (c) => c.properties.value ?? 0,
              set: (c, v) => { c.properties.value = v; } },
            { label: 'SelectedIndex', key: 'selectedIndex', applies: (s) => s === 'ComboBox' || s === 'ListBox', kind: 'num',
              get: (c) => c.properties.selectedIndex ?? -1,
              set: (c, v) => { c.properties.selectedIndex = v; } },
            { label: 'SelectedItem', key: 'selectedItem', applies: (s) => s === 'ComboBox' || s === 'ListBox',
              get: (c) => c.properties.selectedItem ?? '',
              set: (c, v) => { c.properties.selectedItem = v; } },
            { label: 'DropDownStyle', key: 'dropDownStyle', applies: (s) => s === 'ComboBox',
              options: ['Simple', 'DropDown', 'DropDownList'],
              get: (c) => c.properties.dropDownStyle || 'DropDown',
              set: (c, v) => { c.properties.dropDownStyle = v; } },
        ];
    }
    function renderMultiProps(box, sel) {
        if (readOnly || sel.some((c) => c.locked)) return;
        const simples = sel.map((c) => simpleName(c.type));
        for (const cand of multiCandidates()) {
            if (!simples.every(cand.applies)) continue;
            const vals = sel.map(cand.get);
            const agreed = vals.every((v) => v === vals[0]) ? vals[0] : null;
            const applyAll = (v) => {
                for (const m of sel) { markChanged(m, cand.key); cand.set(m, v); }
                commit();
            };
            let row;
            if (cand.options) row = selectField(cand.label, agreed, cand.options, false, applyAll);
            else if (cand.kind === 'bool') row = boolField(cand.label, agreed, false, applyAll);
            else if (cand.kind === 'num') row = numField(cand.label, agreed, false, applyAll);
            else if (cand.kind === 'color') row = colorField(cand.label, agreed === null ? '' : agreed, false, applyAll);
            else row = strField(cand.label, agreed, false, applyAll);
            if (agreed === null) row.title = 'Selected controls disagree — editing sets every member.';
            else if (sel.some((m) => isChanged(m.id, cand.key))) row.classList.add('changed');
            wireRowDescription(row, cand.label);
            box.appendChild(row);
        }
    }

    // ------------------------------------------------------------ add/delete
    /**
     * Task 4 (#50) draw-to-create core. All adds — drop, draw, dblclick, Enter —
     * funnel through createControl: designer name via allocateName (the duplicate
     * kernel's uniqueId twin for fresh names), default size table, container clamp,
     * one debounced commit. No schema change (plain ControlNode), no local undo
     * stack (ADR 0004), never into a locked parent (invariant 4), never when
     * refused. Snapping lives in the GESTURE (drop/draw/place), never here — the
     * model stores plain x/y/width/height like a drag does.
     */
    function defaultControlSize(simple) {
        return {
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
    }

    /**
     * Task 6 (#52) drag-reparent targets. A TabControl never holds leaves directly
     * (resolveContainerTarget), so its visible page — the selected page, the page
     * holding the selection, else the first — is what a drop lands on. Extracted
     * from the tab-strip renderer so render, drop and hit-test agree on which page
     * that is; they must, or a drop would highlight one page and parent to another.
     */
    function tabPagesOf(tab) {
        return (tab.children || []).filter((ch) => simpleName(ch.type) === 'TabPage');
    }
    function activeTabPage(tab) {
        const pages = tabPagesOf(tab);
        for (const p of pages) {
            if (selection.has(p.id)
                || allControls(p.children).some((g) => selection.has(g.id))) return p;
        }
        return pages.length ? pages[0] : null;
    }

    /**
     * Resolve a container control to the list new children join. A TabControl
     * never holds leaves directly — its pages do — so targeting one means its
     * active page (the selected page or the page of the selection, else first).
     * Locked targets refuse (invariant 4: writing their children writes them).
     */
    function resolveContainerTarget(c) {
        if (!c || c.locked) return null;
        if (findControl(c.id) !== c) return null;   // detached model: never guess
        const simple = simpleName(c.type);
        if (simple === 'TabControl') {
            const pages = (c.children || []).filter((ch) =>
                simpleName(ch.type) === 'TabPage' && !ch.locked && findControl(ch.id) === ch);
            if (!pages.length) return null;
            for (const p of pages) {
                if (selection.has(p.id)
                    || allControls(p.children).some((g) => selection.has(g.id))) return p;
            }
            return pages[0];
        }
        if (containerTypes().has(simple)) return c;
        return null;
    }

    /**
     * Where a new control lands. Priority: the clicked container (draw on a
     * Panel draws inside it), else the drill-down scope, else the single
     * selected container (VS dblclick-populates the selected container), else
     * the form top level. A clicked leaf means "beside it": its own parent
     * frame. Null is the top level, never an error.
     */
    function addTargetParent(clicked) {
        if (!schema || readOnly) return null;
        if (clicked) {
            const t = resolveContainerTarget(clicked);
            if (t) return t;
            const p = parentOf(clicked.id);
            if (p && !p.locked && findControl(p.id) === p) {
                return resolveContainerTarget(p) || null;
            }
            return null;
        }
        if (activeContainer) {
            const ac = findControl(activeContainer.id);
            if (ac && ac === activeContainer) {
                const t = resolveContainerTarget(ac);
                if (t) return t;
            }
        }
        const sel = selected();
        if (sel.length === 1) {
            const t = resolveContainerTarget(sel[0]);
            if (t) return t;
        }
        return null;
    }

    /** First free cascade slot in a frame: 8,8 stepping by GRID until unoccupied,
     *  clamped so the default size always fits (container clamp, Task 2 #48). */
    function cascadePos(parent, w, h) {
        const fw = parent ? parent.properties.width : schema.form.clientSize.width;
        const fh = parent ? parent.properties.height : schema.form.clientSize.height;
        const sibs = parent ? (parent.children || []) : schema.controls;
        const maxX = Math.max(0, fw - w), maxY = Math.max(0, fh - h);
        for (let k = 0; k < 20; k++) {
            const x = Math.min(8 + k * GRID, maxX), y = Math.min(8 + k * GRID, maxY);
            if (!sibs.some((s) => s.properties.x === x && s.properties.y === y)) return { x, y };
        }
        return { x: Math.min(8, maxX), y: Math.min(8, maxY) };
    }

    /** Insert one control: the single write path behind drop/draw/dblclick/Enter. */
    function createControl(simple, x, y, w, h, parent) {
        if (!schema || readOnly) return null;
        if (parent && (parent.locked || findControl(parent.id) !== parent)) parent = null;
        const d = defaultControlSize(simple);
        const ww = Math.max(2, Math.round(w !== undefined ? w : d.w));
        const hh = Math.max(2, Math.round(h !== undefined ? h : d.h));
        const fw = parent ? parent.properties.width : schema.form.clientSize.width;
        const fh = parent ? parent.properties.height : schema.form.clientSize.height;
        const xx = Math.min(Math.max(Math.round(x), 0), Math.max(0, fw - ww));
        const yy = Math.min(Math.max(Math.round(y), 0), Math.max(0, fh - hh));
        const node = {
            id: allocateName(simple),
            type: 'System.Windows.Forms.' + simple,
            children: [],
            locked: false,
            properties: {
                x: xx, y: yy, width: ww, height: hh,
                text: d.text,
                tabIndex: schema.analysis.modelledCount,
            },
        };
        if (parent) parent.children.push(node);
        else schema.controls.push(node);
        schema.analysis.modelledCount += 1;
        recomputeCoverage();
        selection = new Set([node.id]);
        clickOrder = [node.id];
        commit();
        return node;
    }

    function addControl(simple, x, y) {
        if (readOnly) return;
        createControl(simple, x, y, undefined, undefined, addTargetParent(null));
    }

    /** Pointer position in FORM units: getBoundingClientRect is scaled pixels,
     *  so the scale divides out here, exactly like formDelta for drags. */
    function canvasFormPoint(clientX, clientY) {
        const box = $('canvas').getBoundingClientRect();
        const k = view.scale || 1;
        return { x: (clientX - box.left) / k, y: (clientY - box.top) / k };
    }

    /**
     * Snap a default-size placement at a parent-relative point: grid quantize,
     * then the Task 3 magnetic pull (edges/centers plus the text baseline for
     * Label/TextBox/Button) with live guides. Alt suppresses everything —
     * callers pass it through from the gesture event. Returns the corrected
     * point; guides render as a side effect, cleared by the gesture end.
     */
    function snapPlacePoint(simple, rx, ry, parent, origin, suppressed) {
        const d = defaultControlSize(simple);
        let px = suppressed ? Math.round(rx) : snapTo(rx);
        let py = suppressed ? Math.round(ry) : snapTo(ry);
        if (!suppressed && view.snap && view.snapMode === 'lines') {
            const full = 'System.Windows.Forms.' + simple;
            const bl = baselineOf({ type: full, properties: { y: py, font: undefined } });
            const sn = snapMoveRect(px, py, d.w, d.h, bl, new Set(), parent, origin);
            px += sn.dx; py += sn.dy;
            renderSnapGuides(sn.guides);
        }
        return { x: px, y: py };
    }

    /** Dblclick/Enter populate: cascade slot in the target parent, same commit. */
    function populateTarget(simple) {
        if (!schema || readOnly) return null;
        const parent = addTargetParent(null);
        const d = defaultControlSize(simple);
        const pos = cascadePos(parent, d.w, d.h);
        return createControl(simple, pos.x, pos.y, d.w, d.h, parent);
    }

    /** Arm/disarm the sticky tool. View state: re-renders the tool + canvas
     *  chrome and posts nothing, so arming never dirties the file. */
    function setArmedTool(simple) {
        if (readOnly && simple) return;
        armedTool = simple;
        renderToolbox();
        renderCanvas();
        if (simple) renderStatus(simple + ' armed — click or drag on the form; Esc to cancel', 'ok');
        else if (selection.size) renderStatusForSelection();
        else renderStatus('Ready.', 'ok');
    }

    /**
     * Task 4 (#50) draw-to-create: the armed pointer gesture. Mousedown anchors
     * (quantized when snapping), mousemove sizes a rubber band with the Task 3
     * resize pull on the moving edges (dir follows the pointer side, so upward
     * drags pull the west/north edges with the far edge fixed), mouseup commits:
     * a tiny gesture places the default size (with the move pull at the anchor),
     * a real rect creates it verbatim. Sticky — the arm survives the commit.
     * Container clamp applies to the rect; locked/refused never reach here.
     */
    function beginDraw(e, simple, clicked) {
        if (!schema || readOnly) return;
        const parent = addTargetParent(clicked || null);
        const origin = frameOrigin(parent);
        const frame = parent
            ? { w: parent.properties.width, h: parent.properties.height }
            : { w: schema.form.clientSize.width, h: schema.form.clientSize.height };
        const box = $('canvas').getBoundingClientRect();
        const k = view.scale || 1;
        let ax = (e.clientX - box.left) / k - origin.x;
        let ay = (e.clientY - box.top) / k - origin.y;
        if (!e.altKey && view.snap) { ax = snapTo(ax); ay = snapTo(ay); }
        else { ax = Math.round(ax); ay = Math.round(ay); }
        ax = Math.min(Math.max(ax, 0), Math.max(0, frame.w - 2));
        ay = Math.min(Math.max(ay, 0), Math.max(0, frame.h - 2));

        const canvas = $('canvas');
        const band = el('div', 'draw-rect');
        band.style.zIndex = '1000';
        band.style.left = (ax + origin.x) + 'px';
        band.style.top = (ay + origin.y) + 'px';
        band.style.width = '2px';
        band.style.height = '2px';
        canvas.appendChild(band);
        let last = { x: ax, y: ay, w: 0, h: 0 };

        function move(ev) {
            const fx = (ev.clientX - box.left) / k - origin.x;
            const fy = (ev.clientY - box.top) / k - origin.y;
            const suppressed = !!ev.altKey;
            let x = Math.min(ax, fx), y = Math.min(ay, fy);
            let w = Math.abs(fx - ax), h = Math.abs(fy - ay);
            let guides = [];
            if (!suppressed && view.snap) {
                const g = view.gridSize > 0 ? view.gridSize : GRID;
                const q = (v) => Math.round(v / g) * g;
                x = q(x); y = q(y);
                w = Math.max(2, q(w)); h = Math.max(2, q(h));
                if (view.snapMode === 'lines') {
                    const dir = (fx >= ax ? 'e' : 'w') + (fy >= ay ? 's' : 'n');
                    const sn = snapResizeRect(x, y, w, h, dir, new Set(), parent, origin);
                    x = sn.x; y = sn.y;
                    w = Math.max(2, sn.w); h = Math.max(2, sn.h);
                    guides = sn.guides;
                }
            } else {
                x = Math.round(x); y = Math.round(y);
                w = Math.max(0, Math.round(w)); h = Math.max(0, Math.round(h));
            }
            if (x < 0) { w += x; x = 0; }
            if (y < 0) { h += y; y = 0; }
            if (x + w > frame.w) w = Math.max(2, frame.w - x);
            if (y + h > frame.h) h = Math.max(2, frame.h - y);
            last = { x, y, w, h };
            band.style.left = (x + origin.x) + 'px';
            band.style.top = (y + origin.y) + 'px';
            band.style.width = Math.max(w, 2) + 'px';
            band.style.height = Math.max(h, 2) + 'px';
            renderSnapGuides(guides);
        }
        function up(ev) {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            const r = last;
            band.remove();
            clearGuides();
            if (r.w < 4 && r.h < 4) {
                const d = defaultControlSize(simple);
                const placed = snapPlacePoint(simple, ax, ay, parent, origin, !!(ev && ev.altKey));
                createControl(simple, placed.x, placed.y, d.w, d.h, parent);
            } else {
                createControl(simple, r.x, r.y,
                    Math.max(2, Math.round(r.w)), Math.max(2, Math.round(r.h)), parent);
            }
        }
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
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
        clickOrder = [];
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
            // Task 4 (#50): with a tool armed, empty-canvas mousedown draws the
            // new control — it never exits the drill scope (the draw targets it)
            // and never starts a marquee. Refused forms never arm, so no guard here.
            if (armedTool && !readOnly && !tabOrderMode) {
                e.preventDefault();
                beginDraw(e, armedTool, null);
                return;
            }
            // Click on empty canvas exits active container
            if (activeContainer) {
                activeContainer = null;
                selection = new Set();
                clickOrder = [];
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
        // As for guides above: view chrome paints above z-indexed controls.
        box.style.zIndex = '1000';
        $('canvas').appendChild(box);
        // Shift+marquee ADDS to the selection; a plain marquee replaces it. Captured
        // at mousedown: the modifier held when the gesture STARTS decides.
        const add = !!e.shiftKey;
        // Form-space origin, so the rectangle tracks the pointer at any zoom.
        const r = $('canvas').getBoundingClientRect();
        const start = { x: (e.clientX - r.left) / view.scale, y: (e.clientY - r.top) / view.scale };

        function move(ev) {
            const cur = { x: (ev.clientX - r.left) / view.scale, y: (ev.clientY - r.top) / view.scale };
            const x = Math.min(start.x, cur.x), y = Math.min(start.y, cur.y);
            const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y);
            box.style.left = x + 'px'; box.style.top = y + 'px';
            box.style.width = w + 'px'; box.style.height = h + 'px';
            selectInRect(start, cur, add);
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
        toggle.title = 'Snap to the grid and to other controls\' edges';
        toggle.addEventListener('click', () => {
            view.snap = !view.snap;
            toggle.textContent = view.snap ? 'Snap: on' : 'Snap: off';
        });
        s.appendChild(toggle);
        // SnapLines vs grid-only (#49): lines mode aligns edges, centers and
        // baselines with magnetic pull; grid-only quantizes with no guides and
        // no pull. View state — switching never touches the file.
        const mode = el('button', 'snap-mode-toggle',
            view.snapMode === 'lines' ? 'Snap mode: lines' : 'Snap mode: grid-only');
        mode.title = 'SnapLines (edges, centers, baselines + magnetic pull) vs grid-only (quantize, no guides)';
        mode.addEventListener('click', () => {
            view.snapMode = view.snapMode === 'lines' ? 'grid' : 'lines';
            mode.textContent = view.snapMode === 'lines' ? 'Snap mode: lines' : 'Snap mode: grid-only';
        });
        s.appendChild(mode);
        // Grid size (#49): the quantize step in form units. View state — changing
        // it never touches the file and needs no protocol change.
        const gridWrap = el('label', 'grid-size-wrap', 'Grid ');
        const gridSize = document.createElement('input');
        gridSize.type = 'number';
        gridSize.className = 'grid-size';
        gridSize.value = String(view.gridSize);
        gridSize.min = '1';
        gridSize.max = '64';
        gridSize.title = 'Grid size in form units';
        gridSize.setAttribute('aria-label', 'Grid size in form units');
        gridSize.addEventListener('change', () => {
            const v = parseInt(gridSize.value, 10);
            if (!Number.isNaN(v) && v >= 1 && v <= 64) view.gridSize = v;
            else gridSize.value = String(view.gridSize);
        });
        // Typing a size must not nudge the selection, like the toolbox filter.
        gridSize.addEventListener('keydown', (e) => e.stopPropagation());
        gridWrap.appendChild(gridSize);
        s.appendChild(gridWrap);
        const tabBtn = el('button', 'tab-order-toggle', 'Tab order: off');
        tabBtn.title = 'Tab order mode: badge each control with its TabIndex, click to reassign in order, Esc to exit';
        tabBtn.addEventListener('click', () => setTabOrderMode(!tabOrderMode));
        s.appendChild(tabBtn);
    }

    /**
     * Tab-order mode switch. Refused forms stay out (read-only when refused); a document
     * load resets silently so the fresh 'Ready' message survives.
     */
    function setTabOrderMode(on, announce = true) {
        if (readOnly) on = false;
        tabOrderMode = on;
        if (on) tabOrderNext = 0;
        const btn = $('status-tools') && $('status-tools').querySelector('.tab-order-toggle');
        if (btn) btn.textContent = on ? 'Tab order: on' : 'Tab order: off';
        renderCanvas();
        renderInspector();
        if (announce) {
            renderStatus(on
                ? 'Tab order mode — click controls in tab order, Esc to exit.'
                : 'Tab order mode off.', 'ok');
        }
    }

    function setupDrop() {
        const canvasWrap = document.querySelector('.stage');
        canvasWrap.addEventListener('dragover', (e) => {
            if (readOnly) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            // Task 4 (#50) live snap on toolbox drag: show the Task 3 guides for
            // the default-size rect at the pointer, before any drop. View state —
            // dragover posts nothing. Alt suppresses like a move.
            try {
                const simple = e.dataTransfer && typeof e.dataTransfer.getData === 'function'
                    ? e.dataTransfer.getData('text/vscforms-control') : null;
                if (!simple || !schema) return;
                if (!HANDLED.some(([n]) => n === simple)) return;
                const parent = addTargetParent(null);
                const origin = frameOrigin(parent);
                const fp = canvasFormPoint(e.clientX, e.clientY);
                snapPlacePoint(simple, fp.x - 20 - origin.x, fp.y - 10 - origin.y,
                    parent, origin, !!e.altKey);
            } catch { /* foreign drag payloads never produce guides */ }
        });
        const leaveGuides = () => clearGuides();
        canvasWrap.addEventListener('dragleave', leaveGuides);
        canvasWrap.addEventListener('drop', (e) => {
            if (readOnly) return;
            const simple = e.dataTransfer.getData('text/vscforms-control');
            if (!simple) return;
            e.preventDefault();
            clearGuides();
            // Scale-correct form point (the old raw subtraction drifted at any
            // zoom), then the same quantize+pull as an armed click-place so a
            // drop and a draw-click agree. createControl clamps to the frame.
            //
            // Task 6 (#52) TabPage targeting: a container under the pointer wins
            // over the selection/drill default — a drop parents where it points,
            // like VS. Locked containers never win (the hit-test excludes them).
            const fp = canvasFormPoint(e.clientX, e.clientY);
            const hit = reparentTargetAt(fp.x, fp.y, new Set());
            const parent = (hit && resolveContainerTarget(hit)) || addTargetParent(null);
            const origin = frameOrigin(parent);
            const placed = snapPlacePoint(simple, fp.x - 20 - origin.x, fp.y - 10 - origin.y,
                parent, origin, !!e.altKey);
            clearGuides();
            const d = defaultControlSize(simple);
            createControl(simple, placed.x, placed.y, d.w, d.h, parent);
        });
    }

    /**
     * Ctrl+Alt+X focuses the toolbox search (Cmd+Alt+X on macOS — the VS `View.Toolbox`
     * chord, minus the menu). Bound on `window` rather than the stage so it works from
     * anywhere: the inspector, the canvas, or the search box itself. View state only —
     * it focuses an input and posts nothing.
     */
    function setupToolboxKeys() {
        window.addEventListener('keydown', (e) => {
            if (!(e.ctrlKey || e.metaKey) || !e.altKey) return;
            if (e.key !== 'x' && e.key !== 'X' && e.code !== 'KeyX') return;
            e.preventDefault();
            focusToolboxSearch();
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
        renderOutline();
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
                clickOrder = [];
                // Task 5 (#51): a fresh document is a fresh baseline — edited
                // marks and the described row belong to the previous model.
                changedProps = new Map();
                describedProp = null;
                // A new document means fresh view state; reset silently so the
                // 'Ready' / 'changed on disk' message below survives.
                setTabOrderMode(false, false);
                armedTool = null;
                clearGuides();
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
            case 'paste': {
                // Host round-trip reply to `requestPaste`. Refused forms paste nothing.
                if (readOnly) break;
                const d = msg.data;
                let nodes = null;
                if (Array.isArray(d)) nodes = d;
                else if (d && Array.isArray(d.nodes)) nodes = d.nodes;
                else if (d && typeof d.text === 'string') nodes = parseClipboardText(d.text);
                else if (typeof d === 'string') nodes = parseClipboardText(d);
                if (nodes) pasteNodes(nodes);
                break;
            }
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
    setupToolboxKeys();
    setupInspectorFilter();
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
                    case 'c': case 'C':
                        // Copy wins over Align Center (ALIGN_KEYS.c): clipboard is the
                        // product claim, centering stays on its inspector button.
                        if (!e.shiftKey) { e.preventDefault(); copySelection(); return; }
                        break;
                    case 'v': case 'V':
                        // Plain Ctrl/Cmd+V pastes via the host round-trip; Ctrl+Shift+V
                        // keeps meaning Distribute Vertically (DISTRIBUTE_KEYS.v).
                        if (!e.shiftKey) { e.preventDefault(); requestPaste(); return; }
                        break;
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
                // Shift-modified C/V fall through to the align/distribute table below.
                const spread = DISTRIBUTE_KEYS[e.key.toLowerCase()];
                if (e.shiftKey && spread) { e.preventDefault(); align(spread); return; }
                const kind = ALIGN_KEYS[e.key.toLowerCase()];
                if (kind) { e.preventDefault(); align(kind); }
                return;
            }
            // Escape clears the selection and cancels any in-progress gesture. Its absence is
            // felt: without it there is no way out of a selection short of clicking again.
            // D6: F2 renames the single selected control through the existing rename path.
            if (e.key === 'F2') { e.preventDefault(); beginOutlineRename(); return; }
            // Task 4 (#50) Enter adds the armed tool at a cascade slot in the
            // target parent (dblclick without a pointer). Plain Enter only — Ctrl
            // is untouched — and refused forms never arm, so there is nothing to add.
            if (e.key === 'Enter' && armedTool && !(e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                populateTarget(armedTool);
                return;
            }
            if (e.key === 'Escape') {
                // The sticky tool disarms first; the existing exit/clear below
                // still runs, so one Escape both disarms and deselects.
                if (armedTool) setArmedTool(null);
                if (tabOrderMode) setTabOrderMode(false);
                if (activeContainer) {
                    activeContainer = null;
                    selection = new Set();
                    clickOrder = [];
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