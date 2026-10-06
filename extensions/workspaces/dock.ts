/**
 * Dock a persistent sidebar into the right-hand columns of the terminal.
 *
 * pi's widget API only stacks content above or below the editor
 * (`WidgetPlacement = "aboveEditor" | "belowEditor"`), so a panel that sits
 * *beside* the conversation cannot be expressed with `setWidget` alone. This
 * composites it at the terminal level instead:
 *
 *   1. `terminal.columns` is narrowed with a getter override, so pi renders the
 *      whole interface -- header, transcript, editor, footer -- into the left
 *      portion and never thinks the sidebar exists.
 *   2. `tui.doRender` is wrapped so the sidebar is painted inside pi's own frame,
 *      between a synchronized-output begin/end pair. The main area and the
 *      sidebar therefore update atomically and cannot flicker against each
 *      other.
 *   3. pi's full-line erase (`ESC[2K`) is rewritten into a width-limited erase
 *      (`ESC[<mainWidth>X`) for the duration of the frame, because a full-line
 *      erase would otherwise wipe the sidebar columns.
 *
 * Only rows whose content actually changed are repainted, which keeps the panel
 * from being rewritten (and visibly flashing) on every animation frame.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface DockTerminal {
	columns: number;
	rows: number;
	write(data: string): void;
}

export interface DockTui {
	terminal: DockTerminal;
}

/**
 * pi-tui declares `doRender` as protected, so it cannot be named in an
 * interface a TUI must satisfy. Reach it through this shape instead.
 */
interface RenderHost {
	doRender?: (...args: unknown[]) => unknown;
	requestRender?: (force?: boolean) => void;
}

export interface DockConfig {
	/** Sidebar width in columns. Re-read on every paint. */
	width(): number;
	/** Render the sidebar body for an exact width and height. */
	render(width: number, height: number): string[];
	/** Text drawn in the separator column, left of the sidebar. */
	separator(): string;
	/**
	 * Opaque background as "#rrggbb". Leave empty to keep the terminal's own
	 * background, which lets transparency through but can show scroll flash.
	 */
	background?: string;
}

/** `#rrggbb` (with or without the hash) to a background SGR sequence. */
export function backgroundSequence(hex: string | undefined): string {
	const value = (hex ?? "").replace("#", "");
	if (!/^[0-9a-fA-F]{6}$/.test(value)) return "";
	const r = parseInt(value.slice(0, 2), 16);
	const g = parseInt(value.slice(2, 4), 16);
	const b = parseInt(value.slice(4, 6), 16);
	return `\x1b[48;2;${r};${g};${b}m`;
}

const BACKGROUND_RESET = "\x1b[49m";

function moveCursor(row: number, col: number): string {
	return `\x1b[${row};${col}H`;
}

function descriptorFor(target: object, key: string): PropertyDescriptor | undefined {
	let current: object | null = target;
	while (current) {
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (descriptor) return descriptor;
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

export class SidebarDock {
	private readonly tui: DockTui;
	private readonly terminal: DockTerminal;
	private readonly config: DockConfig;
	private readonly background: string;
	private readonly originalWrite: (data: string) => void;

	private originalColumnsDesc: PropertyDescriptor | undefined;
	private originalColumnsOwnDesc: PropertyDescriptor | undefined;
	private originalDoRender: ((...args: unknown[]) => unknown) | null = null;
	private disposed = false;
	private installState = false;

	/** Last painted content, so only genuinely changed rows get rewritten. */
	private cachedLines: string[] | null = null;
	private cachedColumns = 0;
	private cachedRows = 0;
	private cachedWidth = 0;
	private cacheValid = false;

	constructor(tui: DockTui, config: DockConfig) {
		this.tui = tui;
		this.terminal = tui.terminal;
		this.config = config;
		this.background = backgroundSequence(config.background);
		this.originalWrite = this.terminal.write.bind(this.terminal);
	}

	/** True while the dock owns the right-hand columns. */
	get installed(): boolean {
		return this.installState;
	}

	/** True when pi's render loop was hooked, so the dock repaints on its own. */
	get hooked(): boolean {
		return this.originalDoRender !== null;
	}

	private host(): RenderHost {
		return this.tui as unknown as RenderHost;
	}

	install(): void {
		if (this.disposed || this.installState) return;
		this.installState = true;
		this.originalColumnsDesc = descriptorFor(this.terminal, "columns");
		this.originalColumnsOwnDesc = Object.getOwnPropertyDescriptor(this.terminal, "columns");
		const origDesc = this.originalColumnsDesc;
		const terminal = this.terminal;
		const self = this; // `this` inside the getter is the terminal, not the dock

		Object.defineProperty(terminal, "columns", {
			configurable: true,
			enumerable: true,
			get() {
				const raw = origDesc?.get
					? (origDesc.get.call(terminal) as number | undefined)
					: typeof origDesc?.value === "number"
						? (origDesc.value as number)
						: 80;
				const columns = typeof raw === "number" && Number.isFinite(raw) ? raw : 80;
				return Math.max(1, columns - self.sidebarWidth() - 1);
			},
		});

		if (typeof this.host().doRender === "function") {
			const host = this.host();
			const originalDoRender = host.doRender as (...args: unknown[]) => unknown;
			this.originalDoRender = originalDoRender;
			const self = this;
			host.doRender = function (this: unknown, ...args: unknown[]) {
				if (self.disposed) return originalDoRender.apply(this, args);

				const writeOwnDesc = Object.getOwnPropertyDescriptor(terminal, "write");
				const originalWrite = terminal.write;
				const mainWidth = self.mainWidth();
				let forceFullPaint = false;
				let result: unknown;
				let didThrow = false;
				let thrown: unknown;

				self.originalWrite("\x1b[?2026h"); // begin synchronized output
				try {
					Object.defineProperty(terminal, "write", {
						configurable: true,
						enumerable: true,
						writable: true,
						value(this: unknown, data: string) {
							if (typeof data !== "string") return originalWrite.call(this, data);
							if (/\x1b\[(?:2J|3J)/.test(data)) forceFullPaint = true;
							// pi's own sync markers would nest inside ours, and a
							// full-line erase would clear the sidebar columns.
							const sanitized = data
								.replace(/\x1b\[\?2026[hl]/g, "")
								.replace(/\x1b\[[012]K/g, `\x1b[${mainWidth}X`);
							return originalWrite.call(this, sanitized);
						},
					});

					try {
						result = originalDoRender.apply(this, args);
					} catch (error) {
						didThrow = true;
						thrown = error;
					}

					if (!didThrow) {
						try {
							self.paintInternal(forceFullPaint, false);
						} catch {
							// Painting must never break pi's render cycle.
						}
					}
				} finally {
					if (writeOwnDesc) {
						Object.defineProperty(terminal, "write", writeOwnDesc);
					} else {
						Reflect.deleteProperty(terminal, "write");
					}
					self.originalWrite("\x1b[?2026l"); // end synchronized output
				}

				if (didThrow) throw thrown;
				return result;
			};
		}

		// The columns override changes the geometry pi renders into, so the next
		// frame is a full repaint; drop the cache to force it.
		this.cacheValid = false;
	}

	/** Repaint on demand, in its own synchronized frame. */
	paint(): void {
		this.paintInternal(false, true);
	}

	/** Forget cached rows, e.g. after a theme or width change. */
	invalidate(): void {
		this.cacheValid = false;
	}

	/** Terminal width ignoring this dock's own override. */
	rawColumns(): number {
		const desc = this.originalColumnsDesc;
		const raw = desc?.get
			? (desc.get.call(this.terminal) as number | undefined)
			: typeof desc?.value === "number"
				? (desc.value as number)
				: undefined;
		return typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 80;
	}

	/**
	 * Current sidebar width, clamped so a narrow terminal cannot eat the main
	 * pane. A requested width of 0 or less means "auto": roughly a quarter of
	 * the terminal.
	 */
	sidebarWidth(): number {
		const columns = this.rawColumns();
		const requested = Math.floor(this.config.width());
		const wanted =
			Number.isFinite(requested) && requested > 0 ? requested : Math.round(columns * 0.28);
		return Math.max(1, Math.min(wanted, Math.max(1, columns - 24)));
	}

	/** Width of pi's main area: the columns left of the separator. */
	private mainWidth(): number {
		return Math.max(1, this.rawColumns() - this.sidebarWidth() - 1);
	}

	private formatLine(line: string | undefined, width: number): string {
		const content = line === undefined ? "" : truncateToWidth(line, width, "", true);
		const padding = Math.max(0, width - visibleWidth(content));
		return `${this.background}${content}${" ".repeat(padding)}${BACKGROUND_RESET}`;
	}

	private paintInternal(forceFull: boolean, standalone: boolean): void {
		if (this.disposed) return;

		const rows = this.terminal.rows;
		const columns = this.rawColumns();
		if (!Number.isFinite(rows) || rows < 1) return;

		const width = this.sidebarWidth();
		const separatorColumn = columns - width;
		const sidebarColumn = separatorColumn + 1;

		const body = this.config.render(width, rows);
		const formatted: string[] = [];
		for (let row = 0; row < rows; row += 1) {
			formatted.push(this.formatLine(body[row], width));
		}

		const dimensionsChanged =
			this.cachedColumns !== columns || this.cachedRows !== rows || this.cachedWidth !== width;
		const paintAll = forceFull || !this.cacheValid || dimensionsChanged;
		const changed = paintAll
			? formatted.map((_line, index) => index)
			: formatted.reduce<number[]>((acc, line, index) => {
					if (this.cachedLines?.[index] !== line) acc.push(index);
					return acc;
				}, []);

		if (changed.length === 0) return;

		let buffer = standalone ? "\x1b[?2026h" : "";
		buffer += "\x1b7"; // save cursor (DECSC)
		buffer += "\x1b[?7l"; // disable auto-wrap so the last column cannot scroll

		const separator = this.config.separator();
		for (const index of changed) {
			const row = index + 1;
			buffer += moveCursor(row, separatorColumn);
			buffer += separator;
			buffer += moveCursor(row, sidebarColumn);
			buffer += formatted[index];
		}

		buffer += "\x1b[?7h"; // re-enable auto-wrap
		buffer += "\x1b8"; // restore cursor (DECRC)
		if (standalone) buffer += "\x1b[?2026l";

		try {
			this.originalWrite(buffer);
		} catch {
			this.cacheValid = false;
			return;
		}

		this.cachedLines = formatted;
		this.cachedColumns = columns;
		this.cachedRows = rows;
		this.cachedWidth = width;
		this.cacheValid = true;
	}

	/** Release the terminal without making the dock unusable again. */
	uninstall(): void {
		if (!this.installState) return;
		this.installState = false;
		this.cacheValid = false;

		if (this.originalColumnsOwnDesc) {
			Object.defineProperty(this.terminal, "columns", this.originalColumnsOwnDesc);
		} else {
			Reflect.deleteProperty(this.terminal, "columns");
		}

		if (this.originalDoRender !== null) {
			this.host().doRender = this.originalDoRender;
			this.originalDoRender = null;
		}

		// The columns override is gone, so pi renders full width again. Ask for a
		// repaint so the stale sidebar columns are cleared with real content.
		const requestRender = this.host().requestRender;
		if (typeof requestRender === "function") {
			try {
				requestRender.call(this.tui, true);
			} catch {
				// Best effort only.
			}
		}
	}

	dispose(): void {
		this.uninstall();
		this.disposed = true;
	}
}
