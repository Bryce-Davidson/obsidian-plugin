import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
} from "obsidian";

/* ============================================================================
 * PLUGIN DATA INTERFACES & CONSTANTS
 * ========================================================================== */

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
};

/**
 * The plugin stores:
 * 1) settings
 * 2) visits (already present in your code)
 * 3) spacedRepetitionLog (our new addition for SM-2)
 */
interface PluginData {
	settings: MyPluginSettings;
	visits: { [filePath: string]: string[] };
	spacedRepetitionLog: { [filePath: string]: NoteState };
}

/**
 * NoteState describes how we track spaced repetition for a given note (file).
 * This is our 'external JSON object' representing SM‑2 data plus an 'active' flag.
 */
interface NoteState {
	id: string; // Some unique ID, often the file path itself
	repetition: number; // SM-2 repetition count
	interval: number; // Interval in days
	ef: number; // Easiness factor
	lastReviewDate: string; // ISO string of last time user reviewed this note
	nextReviewDate?: string; // ISO string of next scheduled review date (if active)
	active: boolean; // Whether the note is actively scheduled
}

/* ============================================================================
 * SPACED REPETITION LOGIC
 * ========================================================================== */

/**
 * Computes the next review date, given a last review date and interval (in days).
 */
function getNextReviewDate(lastReview: Date, interval: number): Date {
	const nextReview = new Date(lastReview);
	nextReview.setDate(lastReview.getDate() + interval);
	return nextReview;
}

/**
 * Applies an SM‑2-like update to a note's state based on the user's quality rating.
 * If stopScheduling is true, the note is deactivated, no next review is scheduled.
 */
function updateNoteState(
	state: NoteState,
	quality: number,
	lastReviewDate: Date,
	stopScheduling: boolean = false
): NoteState {
	// If user wants to stop scheduling, mark as inactive, clear nextReviewDate.
	if (stopScheduling) {
		return {
			...state,
			lastReviewDate: lastReviewDate.toISOString(),
			nextReviewDate: undefined,
			active: false,
		};
	}

	let { id, repetition, interval, ef } = state;

	// SM-2 style logic
	if (quality < 3) {
		repetition = 0;
		interval = 1;
	} else {
		repetition++;
		if (repetition === 1) {
			interval = 1;
		} else if (repetition === 2) {
			interval = 6;
		} else {
			interval = Math.round(interval * ef);
		}
	}

	// EF' = EF + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
	ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
	if (ef < 1.3) ef = 1.3;

	const nextReview = getNextReviewDate(lastReviewDate, interval);

	return {
		id,
		repetition,
		interval,
		ef: parseFloat(ef.toFixed(2)),
		lastReviewDate: lastReviewDate.toISOString(),
		nextReviewDate: nextReview.toISOString(),
		active: true,
	};
}

/* ============================================================================
 * MAIN PLUGIN CLASS
 * ========================================================================== */

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	visitLog: { [filePath: string]: string[] } = {};

	// Our spaced repetition dictionary: file path -> NoteState
	spacedRepetitionLog: { [filePath: string]: NoteState } = {};

	async onload() {
		// Load existing data (settings, visits, spaced rep)
		await this.loadPluginData();

		this.addPluginRibbonIcon();
		this.addStatusBar();
		this.registerCommands();
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// Register a DOM event example (unchanged from your code)
		this.registerDomEvent(document, "click", (evt: MouseEvent) => {
			console.log("Global click event:", evt);
		});

		// Register an interval example (unchanged)
		this.registerInterval(
			window.setInterval(
				() => console.log("Interval ping"),
				5 * 60 * 1000
			)
		);

		// Register Markdown post-processors (unchanged)
		this.registerMarkdownPostProcessor((element, context) => {
			processCustomHiddenText(element);
			processHiddenMathBlocks(element);
		});

		// Listen for active leaf changes to log visits
		this.registerEvent(
			this.app.workspace.on(
				"active-leaf-change",
				(leaf: WorkspaceLeaf | null) => {
					if (!leaf) return;
					const markdownView =
						leaf.view instanceof MarkdownView ? leaf.view : null;
					if (markdownView && markdownView.file) {
						this.logVisit(markdownView.file);
					}
				}
			)
		);

		// Listen for file renames to update the logs
		this.registerEvent(
			this.app.vault.on("rename", (file: TFile, oldPath: string) => {
				// Migrate old visit log entry
				if (this.visitLog[oldPath]) {
					this.visitLog[file.path] = this.visitLog[oldPath];
					delete this.visitLog[oldPath];
				}
				// Migrate spaced repetition log entry
				if (this.spacedRepetitionLog[oldPath]) {
					this.spacedRepetitionLog[file.path] =
						this.spacedRepetitionLog[oldPath];
					delete this.spacedRepetitionLog[oldPath];
				}
				this.savePluginData();
				console.log(`Updated logs from ${oldPath} to ${file.path}`);
			})
		);
	}

	onunload() {
		console.log("Unloading MyPlugin");
	}

	/** Load plugin data from disk, including spaced repetition log. */
	async loadPluginData() {
		const data = (await this.loadData()) as PluginData;
		if (data) {
			this.settings = data.settings || DEFAULT_SETTINGS;
			this.visitLog = data.visits || {};
			this.spacedRepetitionLog = data.spacedRepetitionLog || {};
		} else {
			this.settings = DEFAULT_SETTINGS;
			this.visitLog = {};
			this.spacedRepetitionLog = {};
		}
	}

	/** Save plugin data to disk. */
	async savePluginData() {
		console.log("Saving plugin data");
		const data: PluginData = {
			settings: this.settings,
			visits: this.visitLog,
			spacedRepetitionLog: this.spacedRepetitionLog,
		};
		await this.saveData(data);
	}

	/** Persists current settings to disk. */
	async saveSettings() {
		await this.savePluginData();
	}

	/* ------------------------------------------------------------------------
	 * HELPER METHODS FOR INITIALIZATION
	 * ---------------------------------------------------------------------- */

	private addPluginRibbonIcon(): void {
		const ribbonIconEl = this.addRibbonIcon("dice", "Sample Plugin", () => {
			new Notice("Dice icon clicked!");
		});
		ribbonIconEl.addClass("my-plugin-ribbon-class");
	}

	private addStatusBar(): void {
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText("Status Bar Text");
	}

	private registerCommands(): void {
		this.addCommand({
			id: "open-sample-modal-simple",
			name: "Open sample modal (simple)",
			callback: () => {
				new SampleModal(this.app).open();
			},
		});

		this.addCommand({
			id: "sample-editor-command",
			name: "Sample editor command",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log("Selected text:", editor.getSelection());
				editor.replaceSelection("Sample Editor Command");
			},
		});

		this.addCommand({
			id: "open-sample-modal-complex",
			name: "Open sample modal (complex)",
			checkCallback: (checking: boolean) => {
				const markdownView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					if (!checking) {
						new SampleModal(this.app).open();
					}
					return true;
				}
				return false;
			},
		});

		/* --------------------------------------------------------------------
		 * NEW COMMAND: Prompt user for a rating and update SM-2 for the note
		 * using the custom RatingModal with colored buttons.
		 * ------------------------------------------------------------------ */
		this.addCommand({
			id: "review-current-note",
			name: "Review Current Note (Spaced Repetition)",
			callback: async () => {
				const markdownView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!markdownView) {
					new Notice("No active Markdown file to review.");
					return;
				}
				const file = markdownView.file;
				if (!file) {
					new Notice("No active Markdown file to review.");
					return;
				}
				const filePath = file.path;
				new RatingModal(this.app, (ratingStr: string) => {
					if (!ratingStr) return;
					if (ratingStr.toLowerCase() === "stop") {
						this.updateNoteWithQuality(filePath, 0, true);
					} else {
						const rating = parseInt(ratingStr, 10);
						if (isNaN(rating) || rating < 0 || rating > 5) {
							new Notice(
								"Invalid rating. Please choose a rating from 0–5."
							);
							return;
						}
						this.updateNoteWithQuality(filePath, rating, false);
					}
				}).open();
			},
		});
	}

	/** Logs a visit for the given file by appending the current date/time. */
	private async logVisit(file: TFile) {
		const now = new Date().toISOString();
		if (!this.visitLog[file.path]) {
			this.visitLog[file.path] = [];
		}
		this.visitLog[file.path].push(now);
		console.log(`Logged visit for ${file.path} at ${now}`);
		await this.savePluginData();
	}

	/**
	 * NEW HELPER: Looks up or creates a NoteState, then applies SM-2 updates
	 * via updateNoteState, and saves the changes.
	 */
	private async updateNoteWithQuality(
		filePath: string,
		quality: number,
		stopScheduling: boolean
	) {
		const now = new Date();
		let noteState = this.spacedRepetitionLog[filePath];
		if (!noteState) {
			// If we have no existing state, initialize it
			noteState = {
				id: filePath,
				repetition: 0,
				interval: 0,
				ef: 2.5,
				lastReviewDate: now.toISOString(),
				active: true,
			};
		}

		// Convert lastReviewDate from string to Date
		const lastReviewDate = new Date(noteState.lastReviewDate);

		// Update the note using SM-2 logic
		const updated = updateNoteState(
			noteState,
			quality,
			lastReviewDate,
			stopScheduling
		);
		this.spacedRepetitionLog[filePath] = updated;

		if (stopScheduling) {
			new Notice(`Scheduling stopped for '${filePath}'`);
		} else {
			new Notice(
				`Updated SM-2 for '${filePath}': EF=${updated.ef}, NextReview=${updated.nextReviewDate}`
			);
		}

		await this.savePluginData();
	}
}

/* ============================================================================
 * CUSTOM MODALS
 * ========================================================================== */

/** A simple modal that pops up from a command. */
class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText("Modal opened!");
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * RatingModal presents separate colored buttons for ratings 0–5 in a vertical layout,
 * as well as a "Stop Scheduling" button centered below the rating buttons.
 */
class RatingModal extends Modal {
	private onSubmit: (input: string) => void;

	constructor(app: App, onSubmit: (input: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Select your rating:" });

		// Create a container for the rating buttons (vertical layout).
		const buttonContainer = contentEl.createEl("div", {
			cls: "rating-button-container",
		});
		buttonContainer.style.display = "flex";
		buttonContainer.style.flexDirection = "column";
		buttonContainer.style.alignItems = "center";
		buttonContainer.style.margin = "10px 0";
		buttonContainer.style.width = "100%";

		// Define ratings and their corresponding colors.
		const ratings = [
			{ value: "0", color: "#FF4C4C" }, // Red
			{ value: "1", color: "#FF7F50" }, // Coral
			{ value: "2", color: "#FFA500" }, // Orange
			{ value: "3", color: "#FFFF66" }, // Light Yellow
			{ value: "4", color: "#ADFF2F" }, // Green Yellow
			{ value: "5", color: "#7CFC00" }, // Lawn Green
		];

		// Create a button for each rating.
		ratings.forEach((rating) => {
			const btn = buttonContainer.createEl("button", {
				text: rating.value,
			});
			btn.style.backgroundColor = rating.color;
			btn.style.border = "none";
			// Larger padding and font size for mobile-friendly buttons.
			btn.style.padding = "15px 20px";
			btn.style.margin = "5px 0";
			btn.style.fontSize = "16px";
			btn.style.cursor = "pointer";
			btn.style.borderRadius = "4px";
			// Set button width to 80% of the container.
			btn.style.width = "80%";
			btn.addEventListener("click", () => {
				this.onSubmit(rating.value);
				this.close();
			});
		});

		// Create a separate container for the Stop Scheduling button.
		const stopContainer = contentEl.createEl("div");
		stopContainer.style.textAlign = "center";
		stopContainer.style.marginTop = "20px";
		stopContainer.style.width = "100%";

		const stopButton = stopContainer.createEl("button", {
			text: "Stop Scheduling",
		});
		stopButton.style.backgroundColor = "red";
		stopButton.style.border = "none";
		stopButton.style.padding = "15px 20px";
		stopButton.style.fontSize = "16px";
		stopButton.style.cursor = "pointer";
		stopButton.style.borderRadius = "4px";
		// Set width to 80% and center it.
		stopButton.style.width = "80%";
		stopButton.addEventListener("click", () => {
			this.onSubmit("stop");
			this.close();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/* ============================================================================
 * SETTINGS TAB EXAMPLE
 * ========================================================================== */

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Setting #1")
			.setDesc("It's a secret!")
			.addText((text) =>
				text
					.setPlaceholder("Enter your secret")
					.setValue(this.plugin.settings.mySetting)
					.onChange(async (value) => {
						this.plugin.settings.mySetting = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

/* ============================================================================
 * MARKDOWN POST-PROCESSORS FOR HIDDEN CONTENT (UNCHANGED)
 * ========================================================================== */

function processCustomHiddenText(rootEl: HTMLElement): void {
	const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			if (isInsideMath(node.parentElement)) {
				return NodeFilter.FILTER_REJECT;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	});

	const textNodes: Text[] = [];
	while (walker.nextNode()) {
		textNodes.push(walker.currentNode as Text);
	}

	const delimiterRegex = /:-(.*?)-:/g;

	for (const textNode of textNodes) {
		const nodeText = textNode.nodeValue;
		if (!nodeText) continue;

		let match;
		let lastIndex = 0;
		const fragments: Array<string | Node> = [];

		while ((match = delimiterRegex.exec(nodeText)) !== null) {
			const [fullMatch, hiddenContent] = match;
			const startIndex = match.index;
			const endIndex = startIndex + fullMatch.length;

			if (startIndex > lastIndex) {
				fragments.push(nodeText.slice(lastIndex, startIndex));
			}

			fragments.push(createHiddenTextSpan(hiddenContent));
			lastIndex = endIndex;
		}

		if (lastIndex > 0) {
			if (lastIndex < nodeText.length) {
				fragments.push(nodeText.slice(lastIndex));
			}

			const parent = textNode.parentNode;
			if (parent) {
				for (const frag of fragments) {
					if (typeof frag === "string") {
						parent.insertBefore(
							document.createTextNode(frag),
							textNode
						);
					} else {
						parent.insertBefore(frag, textNode);
					}
				}
				parent.removeChild(textNode);
			}
		}
	}
}

function isInsideMath(el: HTMLElement | null): boolean {
	if (!el) return false;
	if (
		el.classList?.contains("math") ||
		el.classList?.contains("toggle-hidden-math-wrapper")
	) {
		return true;
	}
	return isInsideMath(el.parentElement);
}

function createHiddenTextSpan(originalContent: string): HTMLSpanElement {
	const span = document.createElement("span");
	span.className = "toggle-hidden-text";
	span.setAttribute("data-original", originalContent);
	span.setAttribute("data-hidden", "true");
	span.style.cursor = "pointer";
	span.style.color = "gray";
	span.style.textDecoration = "underline";
	span.textContent = "[hidden]";

	span.addEventListener("click", () => {
		const isHidden = span.getAttribute("data-hidden") === "true";
		if (isHidden) {
			span.innerHTML = `
				<span class="bracket" style="color: gray;">[</span>
				<span class="revealed-text">${originalContent}</span>
				<span class="bracket" style="color: gray;">]</span>`;
			span.setAttribute("data-hidden", "false");
			span.style.color = "";
			span.style.textDecoration = "";
		} else {
			span.textContent = "[hidden]";
			span.setAttribute("data-hidden", "true");
			span.style.color = "gray";
			span.style.textDecoration = "underline";
		}
	});

	return span;
}

function processHiddenMathBlocks(rootEl: HTMLElement): void {
	const mathEls = rootEl.querySelectorAll(".math");
	mathEls.forEach((mathEl) => wrapMathElement(mathEl));
}

function wrapMathElement(mathEl: Element): void {
	const parent = mathEl.parentElement;
	if (!parent || parent.classList.contains("toggle-hidden-math-wrapper")) {
		return;
	}

	let foundDelimiters = false;

	const prevSibling = mathEl.previousSibling;
	if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE) {
		const textContent = prevSibling.nodeValue ?? "";
		const match = textContent.match(/(.*):-\s*$/);
		if (match) {
			prevSibling.nodeValue = match[1];
			foundDelimiters = true;
		}
	}

	const nextSibling = mathEl.nextSibling;
	if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
		const textContent = nextSibling.nodeValue ?? "";
		const match = textContent.match(/^\s*-:(.*)/);
		if (match) {
			nextSibling.nodeValue = match[1];
			foundDelimiters = true;
		}
	}

	if (!foundDelimiters) {
		return;
	}

	const isDisplayMath = mathEl.classList.contains("math-display");
	const wrapperTag = isDisplayMath ? "div" : "span";

	const wrapper = document.createElement(wrapperTag);
	wrapper.className = "toggle-hidden-math-wrapper";
	wrapper.setAttribute("data-hidden", "true");
	wrapper.style.cursor = "pointer";

	parent.insertBefore(wrapper, mathEl);

	const placeholder = document.createElement(wrapperTag);
	placeholder.className = "toggle-hidden-math-placeholder";
	placeholder.style.cursor = "pointer";
	placeholder.style.textAlign = "center";
	placeholder.innerHTML = `<span style="color: gray;">[hidden]</span>`;

	if (mathEl.classList.contains("math-inline")) {
		placeholder.style.display = "inline";
	} else if (mathEl.classList.contains("math-block")) {
		placeholder.style.display = "block";
	}

	const revealedContainer = document.createElement(wrapperTag);
	revealedContainer.className = "toggle-hidden-math-revealed";

	const leftBracket = document.createElement("span");
	leftBracket.className = "bracket";
	leftBracket.style.color = "gray";
	leftBracket.textContent = "[ ";

	const rightBracket = document.createElement("span");
	rightBracket.className = "bracket";
	rightBracket.style.color = "gray";
	rightBracket.textContent = " ]";

	revealedContainer.appendChild(leftBracket);
	revealedContainer.appendChild(mathEl);
	revealedContainer.appendChild(rightBracket);
	revealedContainer.style.display = "none";

	wrapper.appendChild(placeholder);
	wrapper.appendChild(revealedContainer);

	wrapper.addEventListener("click", () => {
		const currentlyHidden = wrapper.getAttribute("data-hidden") === "true";
		if (currentlyHidden) {
			placeholder.style.display = "none";
			revealedContainer.style.display = "inline";
			wrapper.setAttribute("data-hidden", "false");
		} else {
			placeholder.style.display = mathEl.classList.contains("math-inline")
				? "inline"
				: "block";
			revealedContainer.style.display = "none";
			wrapper.setAttribute("data-hidden", "true");
		}
	});
}
