/**
 * Convert a Pi-rendered ANSI line into OpenTUI cell draws.
 *
 * Pi's components emit lines as ANSI strings (SGR colors/attributes). OpenTUI's
 * cell buffer is structured: `drawText(text, x, y, fg, bg, attributes)` takes an
 * explicit `RGBA` foreground/background and an attribute bitmask, and renders
 * embedded escape bytes literally. This module bridges the two by tokenizing a
 * single line's SGR state into styled runs and drawing each run at the correct
 * visible column.
 *
 * SGR parsing mirrors `AnsiCodeTracker` in ../utils.ts (kept separate because
 * that tracker re-emits ANSI codes, whereas here we resolve them to `RGBA`).
 */
import { ansi256IndexToRgb, createTextAttributes, type OptimizedBuffer, RGBA, TextAttributes } from "@opentui/core";
import { extractAnsiCode, visibleWidth } from "../utils.ts";

export interface StyledRun {
	text: string;
	fg: RGBA;
	bg?: RGBA;
	attributes: number;
}

/** Resolved SGR foreground/background as a stored code string, like AnsiCodeTracker. */
interface SgrState {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	blink: boolean;
	inverse: boolean;
	hidden: boolean;
	strikethrough: boolean;
	fgCode: string | null; // e.g. "31", "38;5;240", "38;2;10;20;30"
	bgCode: string | null;
}

const DEFAULT_SGR_STATE: SgrState = {
	bold: false,
	dim: false,
	italic: false,
	underline: false,
	blink: false,
	inverse: false,
	hidden: false,
	strikethrough: false,
	fgCode: null,
	bgCode: null,
};

function freshState(): SgrState {
	return { ...DEFAULT_SGR_STATE };
}

function resetState(s: SgrState): void {
	Object.assign(s, DEFAULT_SGR_STATE);
}

/** Apply one SGR sequence (e.g. "\x1b[1;31m") to the running state. */
function applySgr(s: SgrState, code: string): void {
	if (!code.endsWith("m")) return; // ignore non-SGR escapes (cursor moves, OSC, etc.)
	const match = code.match(/\x1b\[([\d;]*)m/);
	if (!match) return;
	const params = match[1];
	if (params === "" || params === "0") {
		resetState(s);
		return;
	}
	const parts = params.split(";");
	let i = 0;
	while (i < parts.length) {
		const n = Number.parseInt(parts[i], 10);
		if (n === 38 || n === 48) {
			if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
				const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`;
				if (n === 38) s.fgCode = colorCode;
				else s.bgCode = colorCode;
				i += 3;
				continue;
			}
			if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
				const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
				if (n === 38) s.fgCode = colorCode;
				else s.bgCode = colorCode;
				i += 5;
				continue;
			}
		}
		switch (n) {
			case 0:
				resetState(s);
				break;
			case 1:
				s.bold = true;
				break;
			case 2:
				s.dim = true;
				break;
			case 3:
				s.italic = true;
				break;
			case 4:
				s.underline = true;
				break;
			case 5:
				s.blink = true;
				break;
			case 7:
				s.inverse = true;
				break;
			case 8:
				s.hidden = true;
				break;
			case 9:
				s.strikethrough = true;
				break;
			case 21:
			case 22:
				s.bold = false;
				if (n === 22) s.dim = false;
				break;
			case 23:
				s.italic = false;
				break;
			case 24:
				s.underline = false;
				break;
			case 25:
				s.blink = false;
				break;
			case 27:
				s.inverse = false;
				break;
			case 28:
				s.hidden = false;
				break;
			case 29:
				s.strikethrough = false;
				break;
			case 39:
				s.fgCode = null;
				break;
			case 49:
				s.bgCode = null;
				break;
			default:
				if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) s.fgCode = String(n);
				else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) s.bgCode = String(n);
				break;
		}
		i++;
	}
}

function tripletToRgba([r, g, b]: readonly [number, number, number]): RGBA {
	return RGBA.fromInts(r, g, b, 255);
}

/** Resolve a stored SGR color code (foreground or background) to an RGBA, or null for default. */
function resolveColor(code: string | null): RGBA | null {
	if (code === null) return null;
	// 256-color: "38;5;N" / "48;5;N"
	if (code.includes(";5;")) {
		const idx = Number.parseInt(code.split(";")[2], 10);
		return tripletToRgba(ansi256IndexToRgb(idx));
	}
	// RGB: "38;2;R;G;B" / "48;2;R;G;B"
	if (code.includes(";2;")) {
		const p = code.split(";");
		return RGBA.fromInts(Number(p[2]), Number(p[3]), Number(p[4]), 255);
	}
	// Standard 16 colors map to ANSI 256 palette indices 0..15.
	const n = Number.parseInt(code, 10);
	if (n >= 30 && n <= 37) return tripletToRgba(ansi256IndexToRgb(n - 30));
	if (n >= 90 && n <= 97) return tripletToRgba(ansi256IndexToRgb(n - 90 + 8));
	if (n >= 40 && n <= 47) return tripletToRgba(ansi256IndexToRgb(n - 40));
	if (n >= 100 && n <= 107) return tripletToRgba(ansi256IndexToRgb(n - 100 + 8));
	return null;
}

export interface TokenizeOptions {
	/** Foreground used when no SGR fg is active. Defaults to OpenTUI's default foreground. */
	defaultFg?: RGBA;
	/** Background used when no SGR bg is active. Defaults to undefined (transparent). */
	defaultBg?: RGBA;
}

/**
 * Split a single ANSI line into styled runs of plain (escape-free) text.
 * Newlines are not expected; callers pass one display line at a time.
 */
export function tokenizeAnsiLine(line: string, opts: TokenizeOptions = {}): StyledRun[] {
	const defaultFg = opts.defaultFg ?? RGBA.defaultForeground();
	const state = freshState();
	const runs: StyledRun[] = [];
	let pending = "";

	const flush = () => {
		if (pending.length === 0) return;
		const fg = resolveColor(state.fgCode) ?? defaultFg;
		const bg = resolveColor(state.bgCode) ?? opts.defaultBg;
		const attributes = createTextAttributes({
			bold: state.bold,
			italic: state.italic,
			underline: state.underline,
			dim: state.dim,
			blink: state.blink,
			inverse: state.inverse,
			hidden: state.hidden,
			strikethrough: state.strikethrough,
		});
		runs.push({ text: pending, fg, bg, attributes });
		pending = "";
	};

	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b") {
			const ansi = extractAnsiCode(line, i);
			if (ansi) {
				flush();
				applySgr(state, ansi.code);
				i += ansi.length;
				continue;
			}
		}
		pending += line[i];
		i++;
	}
	flush();
	return runs;
}

/**
 * Draw one ANSI line into an OptimizedBuffer at row `y`, starting at column `x`.
 * Runs advance by their visible width so wide characters and combining marks
 * land on the correct cells. Returns the next free column.
 */
export function drawAnsiLine(
	buffer: OptimizedBuffer,
	line: string,
	y: number,
	x = 0,
	opts: TokenizeOptions = {},
): number {
	let col = x;
	for (const run of tokenizeAnsiLine(line, opts)) {
		buffer.drawText(run.text, col, y, run.fg, run.bg, run.attributes);
		col += visibleWidth(run.text);
	}
	return col;
}

export { TextAttributes };
