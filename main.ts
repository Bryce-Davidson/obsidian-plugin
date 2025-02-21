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
 * We no longer store a unique id since the file path (the key in spacedRepetitionLog)
 * already provides uniqueness.
 */
interface NoteState {
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
 * If stopScheduling is true, the note is deactivated, and no next review is scheduled.
 */
function updateNoteState(
	state: NoteState,
	quality: number,
	lastReviewDate: Date,
	stopScheduling: boolean = false
): NoteState {
	if (stopScheduling) {
		return {
			...state,
			lastReviewDate: lastReviewDate.toISOString(),
			nextReviewDate: undefined,
			active: false,
		};
	}

	let { repetition, interval, ef } = state;

	// SM-2 style logic: reset repetition if quality is low.
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

	// Update EF using the SM-2 formula.
	ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
	if (ef < 1.3) ef = 1.3;

	const nextReview = getNextReviewDate(lastReviewDate, interval);

	return {
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

	// spacedRepetitionLog maps file paths to their NoteState.
	spacedRepetitionLog: { [filePath: string]: NoteState } = {};

	async onload() {
		await this.loadPluginData();

		this.addPluginRibbonIcon();
		this.addStatusBar();
		this.registerCommands();
		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.registerDomEvent(document, "click", (evt: MouseEvent) => {
			console.log("Global click event:", evt);
		});

		this.registerInterval(
			window.setInterval(
				() => console.log("Interval ping"),
				5 * 60 * 1000
			)
		);

		this.registerMarkdownPostProcessor((element, context) => {
			processCustomHiddenText(element);
			processHiddenMathBlocks(element);
		});

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

		this.registerEvent(
			this.app.vault.on("rename", (file: TFile, oldPath: string) => {
				if (this.visitLog[oldPath]) {
					this.visitLog[file.path] = this.visitLog[oldPath];
					delete this.visitLog[oldPath];
				}
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

	async savePluginData() {
		console.log("Saving plugin data");
		const data: PluginData = {
			settings: this.settings,
			visits: this.visitLog,
			spacedRepetitionLog: this.spacedRepetitionLog,
		};
		await this.saveData(data);
	}

	async saveSettings() {
		await this.savePluginData();
	}

	// Ribbon icon uses "file-text" and calls openReviewModal() when clicked.
	private addPluginRibbonIcon(): void {
		const ribbonIconEl = this.addRibbonIcon(
			"file-text",
			"Review Current Note",
			() => {
				this.openReviewModal();
			}
		);
		ribbonIconEl.addClass("my-plugin-ribbon-class");
	}

	private addStatusBar(): void {
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText("Status Bar Text");
	}

	// openReviewModal() checks for an active Markdown file and opens the RatingModal.
	private openReviewModal(): void {
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
		const currentState = this.spacedRepetitionLog[filePath];
		new RatingModal(this.app, currentState, (ratingStr: string) => {
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

		this.addCommand({
			id: "review-current-note",
			name: "Review Current Note (Spaced Repetition)",
			callback: () => {
				this.openReviewModal();
			},
		});
	}

	private async logVisit(file: TFile) {
		const now = new Date().toISOString();
		if (!this.visitLog[file.path]) {
			this.visitLog[file.path] = [];
		}
		this.visitLog[file.path].push(now);
		console.log(`Logged visit for ${file.path} at ${now}`);
		await this.savePluginData();
	}

	private async updateNoteWithQuality(
		filePath: string,
		quality: number,
		stopScheduling: boolean
	) {
		const now = new Date();
		let noteState = this.spacedRepetitionLog[filePath];
		if (!noteState) {
			noteState = {
				repetition: 0,
				interval: 0,
				ef: 2.5,
				lastReviewDate: now.toISOString(),
				active: true,
			};
		}

		const lastReviewDate = new Date(noteState.lastReviewDate);
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
 * RatingModal presents colored buttons for ratings 0–5 in a vertical layout,
 * with a statistics panel between the rating buttons and the Stop Scheduling button.
 * All text in the modal is black.
 *
 * The Stop Scheduling button now uses Obsidian's default styling (using the "mod-cta" class)
 * to look like a normal button in the app.
 */
class RatingModal extends Modal {
	private onSubmit: (input: string) => void;
	private currentState?: NoteState;

	constructor(
		app: App,
		currentState: NoteState | undefined,
		onSubmit: (input: string) => void
	) {
		super(app);
		this.currentState = currentState;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		// Create container for rating buttons.
		const buttonContainer = contentEl.createEl("div", {
			cls: "rating-button-container",
		});
		buttonContainer.style.display = "flex";
		buttonContainer.style.flexDirection = "column";
		buttonContainer.style.alignItems = "center";
		buttonContainer.style.margin = "10px 0";
		buttonContainer.style.width = "100%";

		// Define ratings with descriptive text and colors in original order.
		const ratings = [
			{ value: "0", text: "Forgot Completely", color: "#FF4C4C" },
			{ value: "1", text: "Barely Remembered", color: "#FF7F50" },
			{ value: "2", text: "Struggled to Recall", color: "#FFA500" },
			{ value: "3", text: "Correct with Difficulty", color: "#FFFF66" },
			{ value: "4", text: "Good Recall", color: "#ADFF2F" },
			{ value: "5", text: "Perfect Recall", color: "#7CFC00" },
		];

		// Create a button for each rating.
		ratings.forEach((rating) => {
			const btn = buttonContainer.createEl("button", {
				text: rating.text,
			});
			btn.style.backgroundColor = rating.color;
			btn.style.border = "none";
			btn.style.padding = "25px 20px";
			btn.style.margin = "5px 0";
			btn.style.fontSize = "16px";
			btn.style.color = "black";
			btn.style.cursor = "pointer";
			btn.style.borderRadius = "4px";
			btn.style.width = "80%";
			btn.addEventListener("click", () => {
				this.onSubmit(rating.value);
				this.close();
			});
		});

		// Create a statistics container to show current spaced-repetition data.
		const statsContainer = contentEl.createEl("div", {
			cls: "stats-container",
		});
		statsContainer.style.width = "80%";
		statsContainer.style.margin = "15px auto";
		statsContainer.style.padding = "10px";
		statsContainer.style.border = "1px solid #ccc";
		statsContainer.style.borderRadius = "4px";
		statsContainer.style.backgroundColor = "#f9f9f9";
		statsContainer.style.fontSize = "14px";
		statsContainer.style.textAlign = "left";
		statsContainer.style.color = "black";

		if (this.currentState) {
			statsContainer.innerHTML = `<strong>Current Statistics:</strong>
      <br/>Repetitions: ${this.currentState.repetition}
      <br/>Interval: ${this.currentState.interval} day(s)
      <br/>EF: ${this.currentState.ef}
      <br/>Next Review: ${
			this.currentState.nextReviewDate
				? new Date(
						this.currentState.nextReviewDate
				  ).toLocaleDateString()
				: "Not set"
		}`;
		} else {
			statsContainer.textContent =
				"No review data available for this note.";
		}

		// Append the statistics container.
		contentEl.appendChild(statsContainer);

		// Create a container for the Stop Scheduling button.
		const stopContainer = contentEl.createEl("div");
		stopContainer.style.textAlign = "center";
		stopContainer.style.marginTop = "30px";
		stopContainer.style.width = "100%";

		// Create a normal Obsidian-styled button for Stop Scheduling.
		const stopButton = stopContainer.createEl("button", {
			text: "Stop Scheduling",
			cls: "mod-cta",
		});
		stopButton.style.width = "80%";
		stopButton.style.color = "black";
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
