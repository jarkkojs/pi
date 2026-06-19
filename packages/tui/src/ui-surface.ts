/**
 * Engine-agnostic surface contract shared by the rendering backends.
 *
 * `InteractiveMode` drives the UI exclusively through this interface, so the
 * concrete engine can be chosen at startup (see `PI_TUI_ENGINE`). Two
 * implementations exist:
 *   - `TUI` (legacy): inline differential rendering to the real terminal.
 *   - `OpenTuiSurface`: full-screen alternate-screen rendering via OpenTUI.
 *
 * Deliberately excludes `Component.render(width): string[]`: a surface owns the
 * output backend rather than producing lines, so OpenTUI need not emulate a line
 * renderer. Members mirror exactly what `InteractiveMode` calls on `this.ui`.
 */
import type { Terminal } from "./terminal.ts";
import type { Component, InputListener, OverlayHandle, OverlayOptions } from "./tui.ts";

/**
 * Decode an image to a tightly-packed RGBA (`rgba8unorm`) pixel buffer of exactly
 * `pixelWidth × pixelHeight` (row stride = `pixelWidth * 4`). Returns `null` if the
 * image cannot be decoded. Supplied by the host (which owns the image decoder) so
 * the surface need not depend on one; see `OpenTuiSurface.setImageDecoder`.
 */
export type CellImageDecoder = (
	base64Data: string,
	mimeType: string,
	pixelWidth: number,
	pixelHeight: number,
) => Promise<Uint8Array | null>;

export interface UiSurface {
	/** The terminal this surface renders to (dimensions, title, raw output). */
	readonly terminal: Terminal;

	/** Global callback for the debug key (Shift+Ctrl+D), invoked before focus routing. */
	onDebug?: () => void;

	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;

	setFocus(component: Component | null): void;

	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	hideOverlay(): void;
	hasOverlay(): boolean;

	start(): void;
	stop(): void;

	requestRender(force?: boolean): void;
	invalidate(): void;

	addInputListener(listener: InputListener): () => void;
	removeInputListener(listener: InputListener): void;

	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;

	/**
	 * Optional: declare a full-screen region layout. `top` children pin to the top,
	 * `scroll` children form a scrollable history viewport in the middle, and every
	 * other child (in order) pins to the bottom (editor/footer). Engines that render
	 * inline (the legacy TUI) ignore this and stack children top-to-bottom. Children
	 * must still be added via addChild; this only assigns them to regions.
	 */
	setRegions?(top: Component[], scroll: Component[]): void;

	/**
	 * Optional: supply the decoder used to render images as cell art. Engines that
	 * pass terminal-graphics escapes through to the outer terminal (the legacy TUI)
	 * ignore this; the OpenTUI surface, which owns the whole cell grid, uses it to
	 * paint half-block art via the native supersample buffer.
	 */
	setImageDecoder?(decoder: CellImageDecoder): void;

	/**
	 * Optional: supply the writer that puts mouse-selected text on the system
	 * clipboard. Ignored by engines that don't capture the mouse (the terminal
	 * owns selection there). Falls back to OSC 52 if unset.
	 */
	setClipboardWriter?(writer: (text: string) => void): void;

	/**
	 * Optional: notify the host that mouse-selected text is ready for an explicit
	 * copy or dismiss action. Ignored by engines that don't capture the mouse.
	 */
	setSelectionReadyHandler?(handler: () => void): void;
}
