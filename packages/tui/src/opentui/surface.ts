/**
 * OpenTUI rendering backend: a full-screen, alternate-screen `UiSurface`.
 *
 * Extends the legacy `TUI` to inherit its entire imperative model — child
 * containers, the overlay stack, focus tracking, input listeners, and input
 * routing (`handleInput`) — and overrides only the two things that actually
 * differ from the inline renderer:
 *
 *   1. Output: instead of diffing lines and writing ANSI to the terminal, the
 *      composed frame (`composeFrame()`) is drawn cell-by-cell into a persisted
 *      OpenTUI `FrameBufferRenderable`, which OpenTUI's Zig core diffs and flushes
 *      flicker-free. ANSI styling is translated by `drawAnsiLine` (see
 *      ./ansi-to-cells.ts).
 *   2. Input source: raw byte sequences come from OpenTUI's input handler rather
 *      than `ProcessTerminal`, and are fed straight into the inherited
 *      `handleInput` so key parsing (keys.ts) and routing are unchanged.
 *
 * Layout: when the host calls setRegions(), `top` pins to the top, the scroll
 * group is a scrollable history viewport in the middle (mouse wheel and
 * configured scroll keys), and the remaining children (editor/footer) pin to the
 * bottom. Without regions it falls back to a flat tail-aligned render. On stop()
 * the conversation is echoed to the normal screen so it persists in real
 * terminal scrollback, matching the inline legacy engine.
 *
 * Selected at startup via `PI_TUI_ENGINE=opentui`; the default remains the
 * legacy `TUI`. See ../ui-surface.ts.
 */
import { createRequire } from "node:module";
import {
	CliRenderEvents,
	type CliRenderer,
	createCliRenderer,
	decodePasteBytes,
	FrameBufferRenderable,
	type OptimizedBuffer,
	type MouseEvent as OtuiMouseEvent,
	type PasteEvent,
	type Selection,
	TextAttributes,
} from "@opentui/core";
import { getKeybindings } from "../keybindings.ts";
import { setKittyProtocolActive } from "../keys.ts";
import {
	type CellImageMarker,
	clearCellImages,
	getCellImage,
	parseCellImageMarker,
	setCellArtMode,
} from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { TUI } from "../tui.ts";
import type { CellImageDecoder } from "../ui-surface.ts";
import { visibleWidth } from "../utils.ts";
import { drawAnsiLine } from "./ansi-to-cells.ts";

// Bun's FFI `ptr()` turns a TypedArray into a native pointer for
// `drawSuperSampleBuffer`. Required at runtime (the OpenTUI engine is Bun-only) and loaded via
// createRequire like terminal.ts, so tsgo needs no Bun type definitions.
const cjsRequire = createRequire(import.meta.url);

/** A drag selection in screen cells, normalized to reading order (start <= end). */
interface SelectionRange {
	startX: number;
	startY: number;
	endX: number;
	endY: number;
}

export class OpenTuiSurface extends TUI {
	private renderer: CliRenderer | null = null;
	private fb: FrameBufferRenderable | null = null;
	private surfaceStarted = false;
	private startupGeneration = 0;
	private surfaceStopped = true;
	/** Whether init() wrote the bracketed-paste/kitty modes; guards the disable side. */
	private terminalModesApplied = false;
	private cols = 0;
	private rows = 0;
	/**
	 * History scrollback offset in lines above the live bottom. 0 == live view
	 * (tail). Unlike the inline engine, the alternate screen owns its own
	 * scrollback, so this is the only way to review content that has scrolled
	 * past the top edge. Driven by the mouse wheel.
	 */
	private scrollOffset = 0;
	private static readonly WHEEL_STEP = 3;
	/**
	 * Last-drawn scroll viewport geometry (top row and height) and the maximum
	 * offset (oldest line at the top). Updated each draw so keyboard scrolling
	 * (page/home/end) can move by a real page and clamp to the actual history
	 * extent without recomputing layout.
	 */
	private viewportTop = 0;
	private viewportHeight = 0;
	private scrollMax = 0;
	/** Current drag selection in screen cells (see normalizeSelection). */
	private selectionRange: SelectionRange | null = null;
	/** Host-supplied clipboard writer for selection copies; OSC 52 when unset. */
	private clipboardWriter: ((text: string) => void) | null = null;
	/** Host-supplied notification that a selection is awaiting copy/dismissal. */
	private selectionReadyHandler: (() => void) | null = null;
	/**
	 * Full-screen region layout (see setRegions). When set, `regionTop` pins to the
	 * top, `regionScroll` is the scrollable middle, and all other children pin to
	 * the bottom. When unset, the surface falls back to a flat tail-aligned render.
	 */
	private regionTop: Component[] | null = null;
	private regionScroll: Component[] | null = null;
	/**
	 * Cell-art image rendering. Each cell maps to a 2×2 block of supersampled
	 * pixels, so an image occupying `cols × rows` cells decodes to a
	 * `(cols*2) × (rows*2)` RGBA buffer. Decoding is async (host-supplied), so the
	 * results are cached by id+size; a missing entry draws blank until it resolves.
	 */
	private static readonly SUPERSAMPLE = 2;
	private imageDecoder: CellImageDecoder | null = null;
	private readonly cellImageCache = new Map<string, { pixels: Uint8Array; stride: number }>();
	private readonly cellImagePending = new Set<string>();

	setImageDecoder(decoder: CellImageDecoder): void {
		this.imageDecoder = decoder;
	}

	setClipboardWriter(writer: (text: string) => void): void {
		this.clipboardWriter = writer;
	}

	setSelectionReadyHandler(handler: () => void): void {
		this.selectionReadyHandler = handler;
	}

	setRegions(top: Component[], scroll: Component[]): void {
		this.regionTop = top;
		this.regionScroll = scroll;
		this.requestRender();
	}

	override start(): void {
		// createCliRenderer is async; kick it off and wire up once the renderer
		// (and its native core) are ready. requestRender() is a no-op until then,
		// and the final draw() inside init() paints whatever children exist.
		this.surfaceStopped = false;
		const generation = ++this.startupGeneration;
		void this.init(generation).catch((error: unknown) => this.handleInitError(generation, error));
	}

	/**
	 * Create the OpenTUI renderer. A seam so headless tests can inject a
	 * `createTestRenderer` renderer (capturing the cell grid) instead of driving a
	 * real terminal; production always uses the alternate-screen `createCliRenderer`.
	 */
	protected createRenderer(): Promise<CliRenderer> {
		return createCliRenderer({
			screenMode: "alternate-screen",
			exitOnCtrlC: false,
			useThread: false,
			useMouse: true,
		});
	}

	private handleInitError(generation: number, error: unknown): void {
		if (generation !== this.startupGeneration) return;
		this.surfaceStarted = false;
		this.surfaceStopped = true;
		setCellArtMode(false);
		clearCellImages();
		this.renderer?.destroy();
		this.renderer = null;
		this.fb = null;
		this.selectionRange = null;
		if (this.terminalModesApplied) {
			setKittyProtocolActive(false);
			this.terminal.write("\x1b[?2004l");
			this.terminalModesApplied = false;
		}
		// The alternate screen never came up (or was just torn down), so a plain
		// line lands on the normal screen; without it a startup failure is an
		// undiagnosable blank hang.
		const message = error instanceof Error ? error.message : String(error);
		this.terminal.write(`OpenTUI engine failed to start: ${message}\r\n`);
	}

	private async init(generation: number): Promise<void> {
		// Images cannot pass terminal-graphics escapes through OpenTUI's cell grid;
		// render them as half-block cell art instead (see drawCellImage).
		setCellArtMode(true);
		const renderer = await this.createRenderer();
		if (this.surfaceStopped || generation !== this.startupGeneration) {
			setCellArtMode(false);
			clearCellImages();
			renderer.destroy();
			return;
		}
		this.renderer = renderer;
		this.cols = renderer.width;
		this.rows = renderer.height;

		this.fb = this.attachFrameBuffer(renderer, this.cols, this.rows);

		// Feed OpenTUI's raw input sequences through the inherited routing so key
		// parsing and focus behavior match the legacy engine. Keys are consumed
		// (return true) so OpenTUI applies no default handling; mouse sequences are
		// passed through (return false) so OpenTUI's parser turns them into
		// MouseEvents dispatched to onMouseScroll for history scrollback.
		renderer.addInputHandler((sequence: string) => {
			if (OpenTuiSurface.isMouseSequence(sequence)) return false;
			this.handleInput(sequence);
			return true;
		});

		// Paste is a discrete OpenTUI event, not a raw sequence; re-wrap it in
		// bracketed-paste markers so the editor's paste pipeline handles it.
		renderer.keyInput.on("paste", (event: PasteEvent) => {
			this.handleInput(`\x1b[200~${decodePasteBytes(event.bytes)}\x1b[201~`);
		});

		renderer.on(CliRenderEvents.RESIZE, (width: number, height: number) => {
			this.onResize(width, height);
		});

		renderer.on(CliRenderEvents.SELECTION, (selection: Selection) => {
			this.onSelectionFinished(selection);
		});

		renderer.start();
		// OpenTUI enables kitty keyboard but not bracketed paste; enable the
		// latter and mirror the former into the key parser's global flag.
		this.terminal.write("\x1b[?2004h");
		setKittyProtocolActive(renderer.useKittyKeyboard);
		this.terminalModesApplied = true;
		this.surfaceStarted = true;
		this.draw();
	}

	override requestRender(force = false): void {
		if (!this.surfaceStarted) return;
		super.requestRender(force);
	}

	/**
	 * Scheduler callback (see `TUI.requestRender`): compose into the cell buffer
	 * and ask OpenTUI to flush it. Delegating the scheduling to the inherited
	 * `requestRender` keeps its render coalescing and frame-interval throttling.
	 */
	protected override doRender(): void {
		this.draw();
		this.renderer?.requestRender();
	}

	/**
	 * Intercept active selections and configurable history-scroll keys before
	 * inherited routing handles component focus. Everything else falls through to
	 * normal `TUI.handleInput`.
	 */
	protected override handleInput(data: string): void {
		if (this.handleSelectionKey(data)) return;
		if (this.handleScrollKey(data)) return;
		super.handleInput(data);
	}

	private handleSelectionKey(data: string): boolean {
		if (!this.selectionRange) return false;

		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.input.copy")) {
			this.copySelection();
			this.clearSelection();
			return true;
		}

		if (keybindings.matches(data, "tui.select.cancel")) {
			this.clearSelection();
			return true;
		}

		this.clearSelection();
		return false;
	}

	private handleScrollKey(data: string): boolean {
		const keybindings = getKeybindings();
		const page = Math.max(1, this.viewportHeight - 1);
		if (keybindings.matches(data, "tui.scroll.pageUp")) {
			this.scrollBy(page);
		} else if (keybindings.matches(data, "tui.scroll.pageDown")) {
			this.scrollBy(-page);
		} else if (keybindings.matches(data, "tui.scroll.top")) {
			this.scrollBy(this.scrollMax);
		} else if (keybindings.matches(data, "tui.scroll.bottom")) {
			this.scrollBy(-this.scrollMax);
		} else {
			return false;
		}
		return true;
	}

	/** Move the scrollback offset by `delta` lines (positive = older history) and redraw. */
	private scrollBy(delta: number): void {
		this.scrollOffset = Math.max(0, Math.min(this.scrollMax, this.scrollOffset + delta));
		this.requestRender();
	}

	/** SGR (`ESC [ < …`) or legacy (`ESC [ M …`) mouse report. */
	private static isMouseSequence(sequence: string): boolean {
		return sequence.startsWith("\x1b[<") || sequence.startsWith("\x1b[M");
	}

	/**
	 * Mouse-wheel history scrollback. Wheel up reveals older history (larger
	 * offset); wheel down returns toward the live tail. OpenTUI parses mouse input
	 * and dispatches it here via the full-screen frame buffer's hit region.
	 */
	private onScroll(event: OtuiMouseEvent): void {
		const dir = event.scroll?.direction;
		if (dir !== "up" && dir !== "down") return;
		if (this.selectionRange) this.clearSelection();
		this.scrollBy(dir === "up" ? OpenTuiSurface.WHEEL_STEP : -OpenTuiSurface.WHEEL_STEP);
	}

	private onResize(width: number, height: number): void {
		const renderer = this.renderer;
		if (!renderer) return;
		this.cols = width;
		this.rows = height;
		// Screen coordinates change meaning across a resize; drop any live selection.
		renderer.clearSelection();
		// Recreate the frame buffer at the new size (simpler and safer than a
		// partial in-place resize of the underlying cell buffer).
		if (this.fb) {
			renderer.root.remove(this.fb.id);
			this.fb.destroy();
		}
		this.fb = this.attachFrameBuffer(renderer, width, height);
		this.invalidate();
		this.draw();
		renderer.requestRender();
	}

	/** Create the screen-sized frame buffer and attach its mouse and selection hooks. */
	private attachFrameBuffer(renderer: CliRenderer, width: number, height: number): FrameBufferRenderable {
		const fb = new FrameBufferRenderable(renderer, { width, height });
		fb.onMouseScroll = (event: OtuiMouseEvent) => this.onScroll(event);
		// Renderable options don't forward `selectable`; set it directly.
		fb.selectable = true;
		fb.shouldStartSelection = () => true;
		fb.onSelectionChanged = (selection) => this.onCellSelectionChanged(selection);
		fb.getSelectedText = () => this.getSelectedText();
		renderer.root.add(fb);
		return fb;
	}

	/** Track OpenTUI's drag selection; draw() paints the highlight, so just repaint. */
	private onCellSelectionChanged(selection: Selection | null): boolean {
		const previous = this.selectionRange;
		this.selectionRange = selection?.isActive ? this.normalizeSelection(selection) : null;
		if (previous !== null || this.selectionRange !== null) this.requestRender();
		return this.selectionRange !== null;
	}

	/**
	 * Clamp anchor/focus to the screen, then order them into reading order (a
	 * drag past the edge can otherwise collapse both endpoints onto the same
	 * row with startX > endX).
	 */
	private normalizeSelection(selection: Selection): SelectionRange {
		const clampX = (x: number) => Math.max(0, Math.min(this.cols - 1, x));
		const clampY = (y: number) => Math.max(0, Math.min(this.rows - 1, y));
		const anchor = { x: clampX(selection.anchor.x), y: clampY(selection.anchor.y) };
		const focus = { x: clampX(selection.focus.x), y: clampY(selection.focus.y) };
		const forward = anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x);
		const start = forward ? anchor : focus;
		const end = forward ? focus : anchor;
		return { startX: start.x, startY: start.y, endX: end.x, endY: end.y };
	}

	/**
	 * Yield each selected row with its clipped column bounds: the start column on
	 * the first row, the end column on the last row, and the full width between.
	 * `endY` is clamped to the buffer so a selection dragged past the bottom edge
	 * stops at the last real row rather than reading uninitialized cells.
	 */
	private *selectionRows(buffer: OptimizedBuffer): Generator<{ y: number; x0: number; x1: number }> {
		const range = this.selectionRange;
		if (!range) return;
		const width = buffer.width;
		const endY = Math.min(range.endY, buffer.height - 1);
		for (let y = range.startY; y <= endY; y++) {
			const x0 = y === range.startY ? range.startX : 0;
			const x1 = Math.min(y === range.endY ? range.endX : width - 1, width - 1);
			yield { y, x0, x1 };
		}
	}

	/** Read the selected text back from the drawn cell grid, trimmed per row. */
	private getSelectedText(): string {
		const fb = this.fb;
		if (!fb) return "";
		const buffer = fb.frameBuffer;
		const chars = buffer.buffers.char;
		const lines: string[] = [];
		for (const { y, x0, x1 } of this.selectionRows(buffer)) {
			let line = "";
			for (let x = x0; x <= x1; x++) {
				const codepoint = chars[y * buffer.width + x];
				if (codepoint) line += String.fromCodePoint(codepoint);
			}
			lines.push(line.replace(/\s+$/, ""));
		}
		return lines.join("\n");
	}

	/** Keep a finished drag selected until the user copies or dismisses it. */
	private onSelectionFinished(selection: Selection): void {
		if (!this.renderer || selection.isDragging) return;

		const range = selection.isActive ? this.normalizeSelection(selection) : null;
		if (range && (range.startX !== range.endX || range.startY !== range.endY)) {
			this.selectionRange = range;
			this.requestRender();
			this.selectionReadyHandler?.();
			return;
		}

		this.clearSelection();
	}

	private copySelection(): void {
		const renderer = this.renderer;
		if (!renderer) return;

		const text = this.getSelectedText();
		if (text.trim().length === 0) return;

		if (this.clipboardWriter) this.clipboardWriter(text);
		else renderer.copyToClipboardOSC52(text);
	}

	private clearSelection(): void {
		this.selectionRange = null;
		this.renderer?.clearSelection();
		this.requestRender();
	}

	/** Concatenate the rendered lines of a group of components at a given width. */
	private renderGroup(components: Component[], width: number): string[] {
		const out: string[] = [];
		for (const component of components) {
			for (const line of component.render(width)) out.push(line);
		}
		return out;
	}

	/**
	 * Build exactly `rows` screen lines using the region layout: `top` pinned to the
	 * top, the remaining (non-top, non-scroll) children pinned to the bottom, and the
	 * scroll group filling the middle as a viewport offset by the mouse wheel.
	 */
	private buildRegionLines(top: Component[], scroll: Component[]): string[] {
		const { cols, rows } = this;
		const topSet = new Set<Component>(top);
		const scrollSet = new Set<Component>(scroll);
		const bottom = this.children.filter((c) => !topSet.has(c) && !scrollSet.has(c));

		const topLines = this.renderGroup(top, cols);
		const bottomLines = this.renderGroup(bottom, cols);
		const scrollLines = this.renderGroup(scroll, cols);

		const topH = Math.min(topLines.length, rows);
		const bottomH = Math.min(bottomLines.length, Math.max(0, rows - topH));
		const midH = Math.max(0, rows - topH - bottomH);

		// Scroll viewport: live (offset 0) shows the tail; wheel-up reveals older history.
		const vTop = this.viewportGeometry(scrollLines.length, topH, midH);

		const screen: string[] = new Array(rows).fill("");
		for (let r = 0; r < topH; r++) screen[r] = topLines[r];
		for (let i = 0; i < midH; i++) {
			const idx = vTop + i;
			if (idx >= 0 && idx < scrollLines.length) screen[topH + i] = scrollLines[idx];
		}
		for (let r = 0; r < bottomH; r++) screen[rows - bottomH + r] = bottomLines[r];
		return screen;
	}

	/**
	 * Assign the scroll-viewport fields (`viewportTop`, `viewportHeight`,
	 * `scrollMax`, and `scrollOffset` clamped to the live extent) and return the
	 * top index into `content` for the current offset. `contentLength` is the full
	 * scrollable line count and `height` is the visible viewport size.
	 */
	private viewportGeometry(contentLength: number, top: number, height: number): number {
		const liveTop = Math.max(0, contentLength - height);
		this.scrollOffset = Math.min(this.scrollOffset, liveTop);
		this.viewportTop = top;
		this.viewportHeight = height;
		this.scrollMax = liveTop;
		return liveTop - this.scrollOffset;
	}

	/** Flat fallback (no regions set): tail-align the whole composition, wheel-scrollable. */
	private buildFlatLines(): string[] {
		const all = this.render(this.cols);
		const vTop = this.viewportGeometry(all.length, 0, this.rows);
		const screen: string[] = new Array(this.rows).fill("");
		for (let r = 0; r < this.rows; r++) {
			const idx = vTop + r;
			if (idx < all.length) screen[r] = all[idx];
		}
		return screen;
	}

	/** Compose the frame and paint it into the persisted OpenTUI cell buffer. */
	private draw(): void {
		const renderer = this.renderer;
		const fb = this.fb;
		if (!renderer || !fb) return;

		const base =
			this.regionTop && this.regionScroll
				? this.buildRegionLines(this.regionTop, this.regionScroll)
				: this.buildFlatLines();
		// Reuse the inherited overlay compositing + cursor extraction over our
		// screen-sized base (so coordinates are already viewport-relative).
		const { lines, cursor } = this.composeFrameFrom(base, this.cols, this.rows);

		const buffer = fb.frameBuffer;
		buffer.clear();
		const drawn = Math.min(lines.length, this.rows);
		for (let r = 0; r < drawn; r++) {
			const marker = parseCellImageMarker(lines[r]);
			if (marker) {
				this.drawCellImage(buffer, marker, r);
				continue;
			}
			drawAnsiLine(buffer, lines[r], r, 0);
		}

		this.drawScrollIndicator(buffer);
		this.applySelectionHighlight(buffer);

		if (cursor && this.getShowHardwareCursor() && cursor.row >= 0 && cursor.row < this.rows) {
			renderer.setCursorPosition(cursor.col, cursor.row, true);
		} else {
			renderer.setCursorPosition(0, 0, false);
		}
	}

	/** No native scrollbar in the alternate screen; overlay a "lines below" pill. */
	private drawScrollIndicator(buffer: OptimizedBuffer): void {
		if (this.scrollOffset <= 0 || this.viewportHeight <= 0) return;
		const label = ` ${this.scrollOffset} line${this.scrollOffset === 1 ? "" : "s"} below `;
		const row = this.viewportTop + this.viewportHeight - 1;
		const col = Math.max(0, Math.floor((this.cols - label.length) / 2));
		drawAnsiLine(buffer, `\x1b[2m\x1b[7m${label}\x1b[0m`, row, col);
	}

	/** XOR-invert the selected cells so already-inverse cells flip back. */
	private applySelectionHighlight(buffer: OptimizedBuffer): void {
		const { attributes } = buffer.buffers;
		for (const { y, x0, x1 } of this.selectionRows(buffer)) {
			for (let x = x0; x <= x1; x++) attributes[y * buffer.width + x] ^= TextAttributes.INVERSE;
		}
	}

	/**
	 * Paint a cell-art image at row `y`. The image spans `marker.rows` rows
	 * downward (over the blank lines the Image component reserved). Decoding is
	 * async, so a not-yet-decoded image draws blank and triggers a redraw once its
	 * RGBA buffer is ready.
	 */
	private drawCellImage(buffer: OptimizedBuffer, marker: CellImageMarker, y: number): void {
		const ss = OpenTuiSurface.SUPERSAMPLE;
		const pixelWidth = marker.columns * ss;
		const pixelHeight = marker.rows * ss;
		const key = `${marker.id}:${pixelWidth}x${pixelHeight}`;
		const cached = this.cellImageCache.get(key);
		if (cached) {
			// Each marker line carries its own source-row offset, so paint just that one
			// cell row (ss supersample rows). The region layout already clips lines to
			// the viewport, so an image scrolled partway off either edge paints its
			// remaining visible rows with no bleed over the pinned chrome.
			const rowStart = marker.row * ss * cached.stride;
			if (rowStart >= cached.pixels.length) return;
			const row = cached.pixels.subarray(rowStart, rowStart + ss * cached.stride);
			const ptr = cjsRequire("bun:ffi").ptr as (value: Uint8Array) => number;
			buffer.drawSuperSampleBuffer(0, y, ptr(row), row.length, "rgba8unorm", cached.stride);
			return;
		}
		void this.decodeCellImage(marker.id, key, pixelWidth, pixelHeight);
	}

	/** Decode and cache one cell-art image, then request a redraw to paint it. */
	private async decodeCellImage(id: number, key: string, pixelWidth: number, pixelHeight: number): Promise<void> {
		if (this.cellImagePending.has(key)) return;
		const decoder = this.imageDecoder;
		const source = getCellImage(id);
		if (!decoder || !source) return;
		this.cellImagePending.add(key);
		try {
			const pixels = await decoder(source.base64Data, source.mimeType, pixelWidth, pixelHeight);
			if (pixels && pixels.length >= pixelWidth * pixelHeight * 4) {
				// An image only ever displays at its current cell size, so drop any
				// stale-size buffers cached for the same id (e.g. from before a resize)
				// rather than letting them accumulate for the life of the session.
				const prefix = `${id}:`;
				for (const existing of this.cellImageCache.keys()) {
					if (existing !== key && existing.startsWith(prefix)) this.cellImageCache.delete(existing);
				}
				this.cellImageCache.set(key, { pixels, stride: pixelWidth * 4 });
				this.requestRender();
			}
		} catch {
			// Leave the image blank on decode failure rather than crashing the frame.
		} finally {
			this.cellImagePending.delete(key);
		}
	}

	override stop(): void {
		if (this.surfaceStopped) return;
		this.surfaceStarted = false;
		this.surfaceStopped = true;
		this.startupGeneration++;
		setCellArtMode(false);
		clearCellImages();
		this.cellImageCache.clear();
		this.cellImagePending.clear();
		this.selectionRange = null;
		this.terminal.setProgress(false);
		// Snapshot the conversation before tearing down the alternate screen.
		const transcript = this.buildTranscript();
		this.renderer?.destroy();
		this.renderer = null;
		this.fb = null;
		// Undo the modes init() set on the real terminal (destroy() itself only
		// restores the alternate screen and OpenTUI's own protocols).
		if (this.terminalModesApplied) {
			setKittyProtocolActive(false);
			this.terminal.write("\x1b[?2004l");
			this.terminalModesApplied = false;
		}
		// destroy() restores the normal screen; echo the conversation there so it
		// persists in the real terminal scrollback after exit — parity with the
		// inline legacy engine, whose history naturally remains visible on quit.
		if (transcript.length > 0) {
			this.terminal.write(`${transcript.join("\r\n")}\r\n`);
		}
	}

	/**
	 * The conversation lines to leave behind in scrollback on exit: the scroll
	 * region (when regions are set) or the whole surface otherwise, with trailing
	 * blank lines trimmed so exit doesn't leave a gap before the shell prompt.
	 */
	private buildTranscript(): string[] {
		const width = this.cols || this.terminal.columns;
		const lines = this.regionScroll ? this.renderGroup(this.regionScroll, width) : this.render(width);
		let end = lines.length;
		while (end > 0 && visibleWidth(lines[end - 1]) === 0) end--;
		return lines.slice(0, end);
	}
}
