/**
 * Headless tests for the OpenTUI rendering backend.
 *
 * These run under Bun (the engine loads its Zig core via bun:ffi, which Node
 * cannot do) and use `@opentui/core/testing`'s `createTestRenderer` to capture
 * the composed cell grid without a real terminal. They are kept in this
 * subdirectory so the Node `--test test/*.test.ts` suite never tries to load
 * them. Run with `bun test test/opentui` (see package.json `test:opentui`).
 */

import { expect, test } from "bun:test";
import { ansi256IndexToRgb, type CliRenderer, RGBA, TextAttributes } from "@opentui/core";
import { createTestRenderer, pasteBytes, type TestRendererSetup } from "@opentui/core/testing";
import { CURSOR_MARKER, Image, ProcessTerminal, Text } from "../../src/index.ts";
import { isKittyProtocolActive } from "../../src/keys.ts";
import { OpenTuiSurface } from "../../src/opentui/surface.ts";
import { encodeCellImageMarker, getCellImage, isCellArtMode, registerCellImage } from "../../src/terminal-image.ts";

const WIDTH = 40;
const HEIGHT = 12;

/** OpenTuiSurface wired to a headless test renderer instead of a real terminal. */
class HeadlessSurface extends OpenTuiSurface {
	setup!: TestRendererSetup;
	readonly ready: Promise<void>;
	private resolveReady!: () => void;

	constructor(terminal: ProcessTerminal) {
		super(terminal);
		this.ready = new Promise<void>((resolve) => {
			this.resolveReady = resolve;
		});
	}

	protected override async createRenderer(): Promise<CliRenderer> {
		this.setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
		queueMicrotask(() => this.resolveReady());
		return this.setup.renderer;
	}

	/** Feed a raw key sequence through the inherited input routing. */
	feedKey(sequence: string): void {
		(this as unknown as { handleInput(data: string): void }).handleInput(sequence);
	}

	readonly inputLog: string[] = [];

	protected override handleInput(data: string): void {
		this.inputLog.push(data);
		super.handleInput(data);
	}

	private drawWaiters: (() => void)[] = [];

	protected override doRender(): void {
		super.doRender();
		for (const resolve of this.drawWaiters.splice(0)) resolve();
	}

	/** Resolves once the next scheduled draw has painted (requestRender is coalesced). */
	nextDraw(): Promise<void> {
		return new Promise((resolve) => {
			this.drawWaiters.push(resolve);
		});
	}
}

class DelayedSurface extends OpenTuiSurface {
	setup!: TestRendererSetup;
	destroyed = false;
	readonly rendererRequested: Promise<void>;
	private readonly rendererPromise: Promise<CliRenderer>;
	private markRendererRequested!: () => void;
	private finishRenderer!: (renderer: CliRenderer) => void;

	constructor(terminal: ProcessTerminal) {
		super(terminal);
		this.rendererRequested = new Promise<void>((resolve) => {
			this.markRendererRequested = resolve;
		});
		this.rendererPromise = new Promise<CliRenderer>((resolve) => {
			this.finishRenderer = resolve;
		});
	}

	protected override createRenderer(): Promise<CliRenderer> {
		this.markRendererRequested();
		return this.rendererPromise;
	}

	async finishStartup(): Promise<void> {
		this.setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
		const renderer = this.setup.renderer as CliRenderer & { destroy(): void };
		const destroy = renderer.destroy.bind(renderer);
		renderer.destroy = () => {
			this.destroyed = true;
			destroy();
		};
		this.finishRenderer(renderer);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	isSurfaceStarted(): boolean {
		return (this as unknown as { surfaceStarted: boolean }).surfaceStarted;
	}
}

class RejectingSurface extends OpenTuiSurface {
	readonly rendererRequested: Promise<void>;
	private markRendererRequested!: () => void;

	constructor(terminal: ProcessTerminal) {
		super(terminal);
		this.rendererRequested = new Promise<void>((resolve) => {
			this.markRendererRequested = resolve;
		});
	}

	protected override createRenderer(): Promise<CliRenderer> {
		this.markRendererRequested();
		return Promise.reject(new Error("renderer failed"));
	}

	isSurfaceStarted(): boolean {
		return (this as unknown as { surfaceStarted: boolean }).surfaceStarted;
	}
}

async function launch(configure: (ui: HeadlessSurface) => void): Promise<HeadlessSurface> {
	const ui = new HeadlessSurface(new ProcessTerminal());
	configure(ui);
	ui.start();
	await ui.ready;
	// Let the synchronous tail of init() (start + first draw) finish.
	await new Promise((resolve) => setTimeout(resolve, 0));
	return ui;
}

/** A 30-line history with a pinned header and footer (a 10-row middle viewport). */
function startSurface(): Promise<HeadlessSurface> {
	return launch((ui) => {
		const header = new Text("HEADERMARK", 0, 0);
		const lines = Array.from({ length: 30 }, (_, i) => new Text(`LINE${String(i).padStart(2, "0")}`, 0, 0));
		const footer = new Text("FOOTERMARK", 0, 0);
		ui.addChild(header);
		for (const line of lines) ui.addChild(line);
		ui.addChild(footer);
		ui.setRegions([header], lines);
	});
}

async function frame(ui: HeadlessSurface): Promise<string[]> {
	const drawn = ui.nextDraw();
	ui.requestRender();
	await drawn;
	await ui.setup.flush();
	return ui.setup.captureCharFrame().split("\n");
}

/** A decoder returning a solid-red RGBA buffer at the requested supersample size. */
function solidRedDecoder(onSize?: (w: number, h: number) => void) {
	return async (_base64: string, _mime: string, width: number, height: number) => {
		onSize?.(width, height);
		const pixels = new Uint8Array(width * height * 4);
		for (let p = 0; p < width * height; p++) {
			pixels[p * 4] = 255; // R
			pixels[p * 4 + 3] = 255; // A
		}
		return pixels;
	};
}

/** The per-row marker lines Image.render() emits for a cell-art image (one per row). */
function cellImageLines(id: number, columns: number, rows: number): string[] {
	return Array.from({ length: rows }, (_, row) => encodeCellImageMarker(id, columns, rows, row));
}

/** True if any captured span (fg or bg) is solid red. */
function hasRed(spans: { fg: RGBA; bg: RGBA }[]): boolean {
	return spans.flatMap((sp) => [sp.fg.toInts(), sp.bg.toInts()]).some(([r, g, b]) => r > 200 && g < 80 && b < 80);
}

test("stop before async renderer startup resolves cancels the stale renderer without disabling modes it never enabled", async () => {
	const ui = new DelayedSurface(new ProcessTerminal());
	const writes: string[] = [];
	ui.terminal.write = (data: string) => {
		writes.push(data);
	};
	ui.start();
	await ui.rendererRequested;
	ui.stop();
	await ui.finishStartup();

	expect(ui.destroyed).toBe(true);
	expect(ui.isSurfaceStarted()).toBe(false);
	expect((ui as unknown as { renderer: CliRenderer | null }).renderer).toBeNull();
	expect(writes.join("")).not.toContain("\x1b[?2004l");
});

test("renderer startup rejection resets lifecycle and cell-art mode without disabling modes it never enabled", async () => {
	const ui = new RejectingSurface(new ProcessTerminal());
	const writes: string[] = [];
	ui.terminal.write = (data: string) => {
		writes.push(data);
	};
	ui.start();
	await ui.rendererRequested;
	await new Promise((resolve) => setTimeout(resolve, 0));

	expect(isCellArtMode()).toBe(false);
	expect(ui.isSurfaceStarted()).toBe(false);
	expect((ui as unknown as { renderer: CliRenderer | null }).renderer).toBeNull();
	expect(writes.join("")).toContain("OpenTUI engine failed to start: renderer failed");
	expect(writes.join("")).not.toContain("\x1b[?2004l");
});

test("stop resets cell-art image mode for later non-OpenTUI renders", async () => {
	const ui = await launch(() => {});
	ui.stop();

	const image = new Image(
		"ignored",
		"image/png",
		{ fallbackColor: (text) => text },
		{},
		{ widthPx: 10, heightPx: 10 },
	);
	const lines = image.render(20);

	expect(isCellArtMode()).toBe(false);
	expect(lines.join("\n")).not.toContain("\x1b_R");
});

test("stop clears registered cell-art image payloads", async () => {
	const id = 12345;
	const ui = await launch(() => {});
	registerCellImage(id, { base64Data: "payload", mimeType: "image/png" });

	expect(getCellImage(id)).toBeDefined();
	ui.stop();
	expect(getCellImage(id)).toBeUndefined();
});

test("stop clears decoded cell-art image state", async () => {
	const ui = await launch(() => {});
	const internals = ui as unknown as {
		cellImageCache: Map<string, { pixels: Uint8Array; stride: number }>;
		cellImagePending: Set<string>;
	};
	internals.cellImageCache.set("1:2x2", { pixels: new Uint8Array(16), stride: 8 });
	internals.cellImagePending.add("1:2x2");

	ui.stop();

	expect(internals.cellImageCache.size).toBe(0);
	expect(internals.cellImagePending.size).toBe(0);
});

test("stop clears terminal progress state", async () => {
	const terminal = new ProcessTerminal();
	const progressStates: boolean[] = [];
	terminal.setProgress = (active) => {
		progressStates.push(active);
	};
	const ui = await launch((surface) => {
		surface.terminal = terminal;
	});

	terminal.setProgress(true);
	ui.stop();

	expect(progressStates).toEqual([true, false]);
});

test("region layout pins header to the top and footer to the bottom with history tail in the middle", async () => {
	const ui = await startSurface();
	const rows = await frame(ui);

	expect(rows[0]).toContain("HEADERMARK");
	const lastNonEmpty = [...rows].reverse().find((row) => row.trim().length > 0) ?? "";
	expect(lastNonEmpty).toContain("FOOTERMARK");

	const joined = rows.join("\n");
	expect(joined).toContain("LINE29"); // newest line is at the live tail
	expect(joined).not.toContain("LINE00"); // oldest has scrolled past the top edge
});

test("Shift+Home scrolls history to the oldest line; Shift+End returns to the live tail", async () => {
	const ui = await startSurface();

	ui.feedKey("\x1b[1;2H"); // shift+home -> oldest
	expect((await frame(ui)).join("\n")).toContain("LINE00");

	ui.feedKey("\x1b[1;2F"); // shift+end -> live tail
	const live = (await frame(ui)).join("\n");
	expect(live).toContain("LINE29");
	expect(live).not.toContain("LINE00");
});

test("mouse wheel up reveals older history; wheel down returns to the live tail", async () => {
	const ui = await startSurface();
	expect((await frame(ui)).join("\n")).toContain("LINE29");

	await ui.setup.mockMouse.scroll(20, 5, "up");
	const scrolled = (await frame(ui)).join("\n");
	expect(scrolled).toContain("LINE17"); // wheel step (3 lines) revealed older history
	expect(scrolled).not.toContain("LINE29");

	await ui.setup.mockMouse.scroll(20, 5, "down");
	expect((await frame(ui)).join("\n")).toContain("LINE29"); // back at the live tail
});

test("resize keeps the header pinned and does not throw", async () => {
	const ui = await startSurface();
	ui.setup.resize(60, 20);
	const rows = await frame(ui);
	expect(rows[0]).toContain("HEADERMARK");
});

test("exit echoes the conversation to the normal screen for scrollback, excluding chrome", async () => {
	const ui = await startSurface();

	// stop() writes the transcript via terminal.write -> process.stdout.write.
	const writes: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	(process.stdout as unknown as { write: unknown }).write = (chunk: unknown, encoding?: unknown, cb?: unknown) => {
		writes.push(typeof chunk === "string" ? chunk : String(chunk));
		const callback = typeof encoding === "function" ? encoding : cb;
		if (typeof callback === "function") (callback as () => void)();
		return true;
	};
	try {
		ui.stop();
	} finally {
		(process.stdout as unknown as { write: unknown }).write = original;
	}

	const out = writes.join("");
	expect(out).toContain("LINE00"); // full conversation persists, not just the viewport
	expect(out).toContain("LINE29");
	expect(out).not.toContain("HEADERMARK"); // header/footer chrome is excluded
	expect(out).not.toContain("FOOTERMARK");
});

test("stop echoes the transcript only once", async () => {
	const terminal = new ProcessTerminal();
	const writes: string[] = [];
	terminal.write = (data) => {
		writes.push(data);
	};
	terminal.setProgress = () => {};
	const ui = await launch((surface) => {
		surface.terminal = terminal;
		surface.addChild(new Text("ONCEMARK", 0, 0));
	});

	ui.stop();
	ui.stop();

	expect(writes.join("").match(/ONCEMARK/g)?.length ?? 0).toBe(1);
});

test("overlays composite on top of the base content and clear when hidden", async () => {
	const ui = await startSurface();
	expect((await frame(ui)).join("\n")).not.toContain("OVERLAYMARK");

	ui.showOverlay(new Text("OVERLAYMARK", 0, 0), { width: 20 });
	expect((await frame(ui)).join("\n")).toContain("OVERLAYMARK");

	ui.hideOverlay();
	expect((await frame(ui)).join("\n")).not.toContain("OVERLAYMARK");
});

test("ANSI SGR colors are translated to cell colors rather than printed literally", async () => {
	const ui = await launch((s) => {
		// A bare component emitting a red-then-reset ANSI line (mirrors what
		// markdown/message renderers produce). Only render() is required.
		s.addChild({ render: () => ["\x1b[31mREDTEXT\x1b[0m"] });
	});

	const joined = (await frame(ui)).join("\n");
	expect(joined).toContain("REDTEXT");
	expect(joined).not.toContain("[31m"); // the SGR escape was interpreted, not shown
	expect(joined).not.toContain("\x1b");

	const span = ui.setup
		.captureSpans()
		.lines.flatMap((line) => line.spans)
		.find((s) => s.text.includes("REDTEXT"));
	expect(span).toBeDefined();
	expect(span?.fg.toInts()).toEqual(RGBA.fromInts(...ansi256IndexToRgb(1), 255).toInts());
});

test("a focused component's CURSOR_MARKER positions the hardware cursor and is stripped from output", async () => {
	const prompt = "PROMPT> ";
	const ui = await launch((s) => {
		s.setShowHardwareCursor(true);
		const header = new Text("HEADERMARK", 0, 0);
		const lines = Array.from({ length: 30 }, (_, i) => new Text(`LINE${String(i).padStart(2, "0")}`, 0, 0));
		// A bottom-pinned editor-like line emitting the cursor marker after its text.
		const editor = { render: () => [`${prompt}${CURSOR_MARKER}`] };
		s.addChild(header);
		for (const line of lines) s.addChild(line);
		s.addChild(editor);
		s.setRegions([header], lines);
	});

	const rows = await frame(ui);
	const [col, row] = ui.setup.captureSpans().cursor;
	expect(row).toBe(HEIGHT - 1); // the editor line pins to the bottom row
	expect(col).toBe(prompt.length); // cursor sits right after the prompt text

	const bottom = rows[HEIGHT - 1] ?? "";
	expect(bottom).toContain("PROMPT>"); // the line rendered
	expect(bottom).not.toContain("pi:c"); // the APC cursor marker was stripped, not painted
});

test("cell-art image markers decode via the injected decoder and paint supersampled cells", async () => {
	const COLS = 6;
	const ROWS = 3;
	const id = 4242;
	let decodeWidth = 0;
	let decodeHeight = 0;

	const ui = await launch((s) => {
		s.setImageDecoder(
			solidRedDecoder((w, h) => {
				decodeWidth = w;
				decodeHeight = h;
			}),
		);
		registerCellImage(id, { base64Data: "ignored", mimeType: "image/png" });
		// Mimics Image.render() under cell-art mode: one marker line per row.
		s.addChild({ render: () => cellImageLines(id, COLS, ROWS) });
	});

	// First frame hits the decode cache miss and kicks the async decode; once it
	// resolves it requests a redraw, so wait then re-capture.
	await frame(ui);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await ui.setup.flush();

	// Each cell is a 2×2 supersample block (SUPERSAMPLE = 2).
	expect(decodeWidth).toBe(COLS * 2);
	expect(decodeHeight).toBe(ROWS * 2);

	expect(hasRed(ui.setup.captureSpans().lines.flatMap((line) => line.spans))).toBe(true);
});

test("a cell-art image at the bottom viewport edge paints its visible rows without bleeding over pinned chrome", async () => {
	const id = 7;
	const IMG_ROWS = 5; // taller than the single viewport row it lands on

	const ui = await launch((s) => {
		s.setImageDecoder(solidRedDecoder());
		registerCellImage(id, { base64Data: "ignored", mimeType: "image/png" });
		const header = new Text("HEADERMARK", 0, 0);
		// 20 filler lines then the image as the final scroll content, so its first row
		// pins to the bottom row of the middle viewport (directly above the footer).
		const fillers = Array.from({ length: 20 }, () => new Text("FILL", 0, 0));
		const image = { render: () => cellImageLines(id, 8, IMG_ROWS) };
		const footer = new Text("FOOTERMARK", 0, 0);
		s.addChild(header);
		for (const f of fillers) s.addChild(f);
		s.addChild(image);
		s.addChild(footer);
		s.setRegions([header], [...fillers, image]);
	});

	await frame(ui);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await ui.setup.flush();

	const lines = ui.setup.captureSpans().lines;
	const footerRow = lines[HEIGHT - 1];
	expect(footerRow.spans.map((sp) => sp.text).join("")).toContain("FOOTERMARK"); // chrome survived
	expect(hasRed(footerRow.spans)).toBe(false); // image stayed in the viewport, not over the footer
	expect(hasRed(lines.flatMap((line) => line.spans))).toBe(true); // the visible top row still painted
});

test("a cell-art image whose top has scrolled above the viewport still paints its remaining rows", async () => {
	const id = 9;
	const IMG_ROWS = 8; // taller than the viewport leaves room for, so its top scrolls off

	const ui = await launch((s) => {
		s.setImageDecoder(solidRedDecoder());
		registerCellImage(id, { base64Data: "ignored", mimeType: "image/png" });
		const header = new Text("HEADERMARK", 0, 0);
		// Image first, then a few fillers. The middle viewport (10 rows) shows the
		// live tail, so the image's top rows sit above the viewport top while its
		// lower rows remain visible — the partial-scroll case.
		const image = { render: () => cellImageLines(id, 8, IMG_ROWS) };
		const fillers = Array.from({ length: 4 }, () => new Text("FILL", 0, 0));
		const footer = new Text("FOOTERMARK", 0, 0);
		s.addChild(header);
		s.addChild(image);
		for (const f of fillers) s.addChild(f);
		s.addChild(footer);
		s.setRegions([header], [image, ...fillers]);
	});

	await frame(ui);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await ui.setup.flush();

	// Under the old single-marker design the marker (image row 0) had scrolled above
	// the viewport, so nothing painted. Per-row markers keep the visible rows alive.
	expect(hasRed(ui.setup.captureSpans().lines.flatMap((line) => line.spans))).toBe(true);
});

test("re-rendering a cell-art image at a new size evicts the stale-size buffer for that id", async () => {
	const id = 11;
	let cols = 6;
	let rows = 3;

	const ui = await launch((s) => {
		s.setImageDecoder(solidRedDecoder());
		registerCellImage(id, { base64Data: "ignored", mimeType: "image/png" });
		// A component whose emitted cell size changes between frames, as Image.render()
		// does after a terminal resize (recomputed cols/rows -> a new decode key).
		s.addChild({ render: () => cellImageLines(id, cols, rows) });
	});

	await frame(ui);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await ui.setup.flush();

	cols = 10;
	rows = 5;
	await frame(ui);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await ui.setup.flush();

	const cache = (ui as unknown as { cellImageCache: Map<string, unknown> }).cellImageCache;
	const forId = [...cache.keys()].filter((key) => key.startsWith(`${id}:`));
	expect(forId).toEqual([`${id}:20x10`]); // only the current-size buffer remains, not the 12x6 one
});

test("rapid resizes, including one while an image decode is pending, keep rendering without throwing", async () => {
	const id = 31;
	const ui = await launch((s) => {
		s.setImageDecoder(solidRedDecoder());
		registerCellImage(id, { base64Data: "ignored", mimeType: "image/png" });
		const header = new Text("HEADERMARK", 0, 0);
		const image = { render: () => cellImageLines(id, 6, 3) };
		s.addChild(header);
		s.addChild(image);
		s.setRegions([header], [image]);
	});

	// Kick a frame (starts an async decode) then resize repeatedly before the
	// decode's microtask resolves, so the framebuffer is destroyed/recreated under
	// an in-flight decode — the path onResize churns. Each resize recreates the
	// native FrameBufferRenderable; this asserts that churn never throws.
	ui.requestRender();
	for (const [w, h] of [
		[20, 8],
		[80, 40],
		[10, 6],
		[100, 30],
		[WIDTH, HEIGHT],
	]) {
		ui.setup.resize(w, h);
	}
	await new Promise((resolve) => setTimeout(resolve, 30));
	await ui.setup.flush();

	const rows = await frame(ui);
	expect(rows[0]).toContain("HEADERMARK"); // still composes correctly at the final size
	expect(hasRed(ui.setup.captureSpans().lines.flatMap((line) => line.spans))).toBe(true); // image survived the churn
});

test("bracketed paste mode is enabled on start and disabled on stop", async () => {
	const terminal = new ProcessTerminal();
	const writes: string[] = [];
	terminal.write = (data) => {
		writes.push(data);
	};
	terminal.setProgress = () => {};
	const ui = await launch((surface) => {
		surface.terminal = terminal;
	});

	expect(writes.join("")).toContain("\x1b[?2004h");
	expect(writes.join("")).not.toContain("\x1b[?2004l");
	ui.stop();
	expect(writes.join("")).toContain("\x1b[?2004l");
});

test("a paste event re-enters input as a single bracketed-paste sequence", async () => {
	const ui = await launch(() => {});
	ui.inputLog.length = 0;
	const pasted = "hello\n\x1b[200~not-a-real-start\n\x1b[201~not-a-real-end\n\x1b[1;2H";

	ui.setup.renderer.keyInput.processPaste(pasteBytes(pasted));

	expect(ui.inputLog).toEqual([`\x1b[200~${pasted}\x1b[201~`]);
});

test("the kitty protocol flag mirrors the renderer while running and resets on stop", async () => {
	const ui = await launch(() => {});
	expect(isKittyProtocolActive()).toBe(ui.setup.renderer.useKittyKeyboard);
	ui.stop();
	expect(isKittyProtocolActive()).toBe(false);
});

test("mouse drag selection copies the selected text with the copy key via the clipboard writer", async () => {
	const ui = await startSurface();
	const copies: string[] = [];
	ui.setClipboardWriter((text) => copies.push(text));
	const ready: string[] = [];
	ui.setSelectionReadyHandler(() => ready.push("ready"));
	await frame(ui);

	// Viewport rows 1..10 show LINE20..LINE29; drag across "LINE21" on row 2.
	await ui.setup.mockMouse.drag(0, 2, 5, 2);
	expect(copies).toEqual([]);
	expect(ready).toEqual(["ready"]);

	ui.feedKey("\x03");

	expect(copies).toEqual(["LINE21"]);
});

test("selection copy key falls back to OSC 52 when no clipboard writer is set", async () => {
	const ui = await startSurface();
	await frame(ui);
	const osc: string[] = [];
	ui.setup.renderer.copyToClipboardOSC52 = (text: string) => {
		osc.push(text);
		return true;
	};

	await ui.setup.mockMouse.drag(0, 2, 5, 2);
	expect(osc).toEqual([]);

	ui.feedKey("\x03");

	expect(osc).toEqual(["LINE21"]);
});

test("a multi-row drag copies the first, middle, and last row text with newlines", async () => {
	const ui = await startSurface();
	const copies: string[] = [];
	ui.setClipboardWriter((text) => copies.push(text));
	await frame(ui);

	// Viewport rows 1..10 show LINE20..LINE29; drag from row 2 col 2 to row 4 col 4.
	await ui.setup.mockMouse.drag(2, 2, 4, 4);
	ui.feedKey("\x03");

	expect(copies).toEqual(["NE21\nLINE22\nLINE2"]);
});

test("mouse wheel scrolling clears a pending selection before copy", async () => {
	const ui = await startSurface();
	const copies: string[] = [];
	ui.setClipboardWriter((text) => copies.push(text));
	await frame(ui);

	await ui.setup.mockMouse.drag(0, 2, 5, 2);
	await ui.setup.mockMouse.scroll(20, 5, "up");
	await frame(ui);
	ui.feedKey("\x03");

	expect(copies).toEqual([]);
	expect((ui as unknown as { selectionRange: unknown }).selectionRange).toBeNull();
});

test("normalizeSelection keeps start <= end when clamping a drag past the bottom edge collapses both rows", async () => {
	const ui = await startSurface();
	await frame(ui);
	const normalize = (
		ui as unknown as {
			normalizeSelection: (selection: { anchor: { x: number; y: number }; focus: { x: number; y: number } }) => {
				startX: number;
				startY: number;
				endX: number;
				endY: number;
			};
		}
	).normalizeSelection.bind(ui);

	// Anchor on the last row, dragged past the bottom edge and to the left.
	const range = normalize({ anchor: { x: 10, y: HEIGHT - 1 }, focus: { x: 3, y: HEIGHT + 5 } });

	expect(range.startY).toBe(range.endY);
	expect(range.startX).toBeLessThanOrEqual(range.endX);
});

test("a plain click dismisses the selection without copying", async () => {
	const ui = await startSurface();
	const copies: string[] = [];
	ui.setClipboardWriter((text) => copies.push(text));
	const ready: string[] = [];
	ui.setSelectionReadyHandler(() => ready.push("ready"));
	await frame(ui);

	await ui.setup.mockMouse.click(3, 2);

	expect(copies).toEqual([]);
	expect(ready).toEqual([]);
});

test("an active drag highlights selected cells and escape clears the released selection", async () => {
	const ui = await startSurface();
	ui.setClipboardWriter(() => {});
	await frame(ui);

	await ui.setup.mockMouse.pressDown(0, 2);
	await ui.setup.mockMouse.emitMouseEvent("drag", 5, 2);
	await frame(ui);

	const fb = (ui as unknown as { fb: { frameBuffer: { buffers: { attributes: Uint32Array }; width: number } } }).fb;
	const idx = 2 * fb.frameBuffer.width + 3;
	expect(fb.frameBuffer.buffers.attributes[idx] & TextAttributes.INVERSE).not.toBe(0);

	await ui.setup.mockMouse.release(5, 2);
	await frame(ui);
	expect(fb.frameBuffer.buffers.attributes[idx] & TextAttributes.INVERSE).not.toBe(0);

	ui.feedKey("\x1b");
	await frame(ui);
	expect(fb.frameBuffer.buffers.attributes[idx] & TextAttributes.INVERSE).toBe(0);
});

test("scrolling into history overlays a lines-below indicator; the live tail has none", async () => {
	const ui = await startSurface();
	expect((await frame(ui)).join("\n")).not.toContain("below");

	ui.feedKey("\x1b[1;2H"); // shift+home -> oldest
	expect((await frame(ui)).join("\n")).toContain("20 lines below");

	ui.feedKey("\x1b[1;2F"); // shift+end -> live tail
	expect((await frame(ui)).join("\n")).not.toContain("below");
});
