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
	ItemView,
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
 * 3) spacedRepetitionLog (our new addition for SM‑2)
 */
interface PluginData {
	settings: MyPluginSettings;
	visits: { [filePath: string]: string[] };
	spacedRepetitionLog: { [filePath: string]: NoteState };
}

/**
 * NoteState describes how we track spaced repetition for a given note (file).
 * We no longer store a unique id since the file path is used as the key.
 *
 * NEW: Two additional optional fields:
 * - isLearning: whether the note is in the learning phase.
 * - learningStep: the current index in the learning steps.
 */
interface NoteState {
	repetition: number; // SM‑2 repetition count
	interval: number; // Interval in days (for review phase)
	ef: number; // Easiness factor
	lastReviewDate: string; // ISO string of last review
	nextReviewDate?: string; // ISO string of next review (if active)
	active: boolean; // Whether the note is actively scheduled
	isLearning?: boolean; // true if the note is in the learning phase
	learningStep?: number; // index of the current learning step
}

/* ============================================================================
 * SPACED REPETITION LOGIC
 * ========================================================================== */

/**
 * Helper: Computes the next review date, given a last review date and interval (in days).
 */
function getNextReviewDate(lastReview: Date, interval: number): Date {
	const nextReview = new Date(lastReview);
	nextReview.setDate(lastReview.getDate() + interval);
	return nextReview;
}

/**
 * Helper: Adds a given number of minutes to a Date.
 */
function addMinutes(date: Date, minutes: number): Date {
	const result = new Date(date);
	result.setMinutes(result.getMinutes() + minutes);
	return result;
}

// Define learning intervals (in minutes) for the learning phase.
const LEARNING_STEPS: number[] = [10, 30];

/**
 * Updates the note state based on the review quality.
 */
function updateNoteState(
	state: NoteState,
	quality: number,
	reviewDate: Date,
	stopScheduling: boolean = false
): NoteState {
	if (stopScheduling) {
		return {
			...state,
			lastReviewDate: reviewDate.toISOString(),
			nextReviewDate: undefined,
			active: false,
		};
	}

	let newState = { ...state };

	if (quality < 3) {
		if (!newState.isLearning) {
			newState.isLearning = true;
			newState.learningStep = 0;
		} else if (
			newState.learningStep !== undefined &&
			newState.learningStep < LEARNING_STEPS.length - 1
		) {
			newState.learningStep++;
		}
		newState.repetition = 0;
		const stepIndex = newState.learningStep ?? 0;
		const intervalMinutes = LEARNING_STEPS[stepIndex];
		const nextReview = addMinutes(reviewDate, intervalMinutes);
		newState.lastReviewDate = reviewDate.toISOString();
		newState.nextReviewDate = nextReview.toISOString();
		newState.active = true;
		return newState;
	} else {
		if (newState.isLearning) {
			newState.isLearning = false;
			newState.learningStep = undefined;
			newState.repetition = 1;
			newState.interval = 1;
		} else {
			newState.repetition++;
			if (newState.repetition === 1) {
				newState.interval = 1;
			} else if (newState.repetition === 2) {
				newState.interval = 6;
			} else {
				newState.interval = Math.round(newState.interval * newState.ef);
			}
		}

		let newEF =
			newState.ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
		if (newEF < 1.3) newEF = 1.3;
		newState.ef = parseFloat(newEF.toFixed(2));

		const nextReview = getNextReviewDate(reviewDate, newState.interval);
		newState.lastReviewDate = reviewDate.toISOString();
		newState.nextReviewDate = nextReview.toISOString();
		newState.active = true;
		return newState;
	}
}

/* ============================================================================
 * NEW: REVIEW SIDEBAR VIEW IMPLEMENTATION
 * ========================================================================== */

export const REVIEW_VIEW_TYPE = "review-sidebar";

export class ReviewSidebarView extends ItemView {
	plugin: MyPlugin;
	constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return REVIEW_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Review Queue";
	}

	getIcon(): string {
		return "file-text";
	}

	async onOpen() {
		const container = this.containerEl.children[1] || this.containerEl;
		container.empty();

		const now = new Date();
		const reviewNotes: string[] = [];
		for (const filePath in this.plugin.spacedRepetitionLog) {
			const state = this.plugin.spacedRepetitionLog[filePath];
			if (
				state.active &&
				state.nextReviewDate &&
				new Date(state.nextReviewDate) <= now
			) {
				reviewNotes.push(filePath);
			}
		}

		if (reviewNotes.length === 0) {
			container.createEl("p", { text: "No notes to review!" });
			return;
		}

		const header = container.createEl("div", { cls: "review-header" });
		header.style.display = "flex";
		header.style.justifyContent = "center";
		header.style.alignItems = "center";
		header.style.marginBottom = "16px";

		const title = header.createEl("h2", { text: "Review Queue" });
		title.style.fontFamily = "'Roboto', sans-serif";
		title.style.margin = "0";
		title.style.fontSize = "24px";

		const cardContainer = container.createEl("div", {
			cls: "card-container",
		});
		cardContainer.style.display = "flex";
		cardContainer.style.flexDirection = "column";
		cardContainer.style.gap = "12px";
		cardContainer.style.padding = "0 8px";

		reviewNotes.forEach((filePath) => {
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (!file || !(file instanceof TFile)) return;
			const noteState = this.plugin.spacedRepetitionLog[filePath];

			const card = cardContainer.createEl("div", { cls: "review-card" });
			card.style.backgroundColor = "#fff";
			card.style.borderRadius = "8px";
			card.style.boxShadow = "0 2px 4px rgba(0,0,0,0.1)";
			card.style.padding = "12px";
			card.style.display = "flex";
			card.style.flexDirection = "row";
			card.style.gap = "12px";
			card.style.alignItems = "center";
			card.style.cursor = "pointer";

			let titleText = file.basename;
			if (titleText.length > 15) {
				titleText = titleText.substring(0, 15) + "...";
			}

			const cardTitle = card.createEl("h3", { text: titleText });
			cardTitle.style.margin = "0";
			cardTitle.style.fontSize = "18px";
			cardTitle.style.fontWeight = "bold";
			cardTitle.style.color = "#333";
			cardTitle.style.flexGrow = "1";
			cardTitle.onclick = async (evt) => {
				evt.preventDefault();
				const leaf = this.plugin.app.workspace.getLeaf(true);
				await leaf.openFile(file);
			};

			const efRating = noteState.ef.toFixed(2);
			const efElem = card.createEl("p", { text: efRating });
			efElem.style.margin = "0";
			efElem.style.fontSize = "16px";
			efElem.style.color = "#666";

			card.appendChild(cardTitle);
			card.appendChild(efElem);
		});
	}

	async onClose() {
		// No additional cleanup needed.
	}
}

/* ============================================================================
 * MAIN PLUGIN CLASS
 * ========================================================================== */

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	visitLog: { [filePath: string]: string[] } = {};
	spacedRepetitionLog: { [filePath: string]: NoteState } = {};

	private allHidden: boolean = true;

	async onload() {
		await this.loadPluginData();

		this.addPluginRibbonIcon();
		this.addStatusBar();
		this.registerCommands();
		this.addSettingTab(new MyPluginSettingTab(this.app, this));

		// NEW: Ribbon icon to toggle all hidden content (text and math)
		this.addRibbonIcon("eye", "Toggle All Hidden Content", () => {
			this.toggleAllHidden();
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

		this.registerView(
			REVIEW_VIEW_TYPE,
			(leaf) => new ReviewSidebarView(leaf, this)
		);
		this.addRibbonIcon("file-text", "Open Review Queue", () => {
			this.activateReviewSidebar();
		});
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

	private addPluginRibbonIcon(): void {
		const ribbonIconEl = this.addRibbonIcon(
			"check-square",
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

	private openReviewModal(): void {
		const file = this.app.workspace.getActiveFile();
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
						"Invalid rating. Please choose a rating between 0 and 5."
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

		this.addCommand({
			id: "open-review-queue",
			name: "Open Review Queue",
			callback: () => {
				this.activateReviewSidebar();
			},
		});

		// New command: Wrap selected text with [hide][/hide] delimiters.
		this.addCommand({
			id: "wrap-selected-text-with-hide",
			name: "Wrap Selected Text in [hide][/hide]",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const selection = editor.getSelection();
				if (!selection) {
					new Notice("Please select some text to hide.");
					return;
				}
				const wrapped = `[hide]${selection}[/hide]`;
				editor.replaceSelection(wrapped);
			},
		});

		// New command: Toggle all hidden content (for key binding).
		this.addCommand({
			id: "toggle-all-hidden",
			name: "Toggle All Hidden Content",
			callback: () => {
				this.toggleAllHidden();
			},
		});

		// New command: Delete [hide][/hide] wrappers if the cursor is inside them.
		this.addCommand({
			id: "delete-hide-wrappers",
			name: "Delete [hide][/hide] wrappers",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const cursor = editor.getCursor();
				const line = editor.getLine(cursor.line);
				const startIndex = line.lastIndexOf("[hide]", cursor.ch);
				const endIndex = line.indexOf("[/hide]", cursor.ch);
				if (startIndex === -1 || endIndex === -1) {
					new Notice(
						"Cursor is not inside a [hide]...[/hide] block."
					);
					return;
				}
				const before = line.slice(0, startIndex);
				const between = line.slice(
					startIndex + "[hide]".length,
					endIndex
				);
				const after = line.slice(endIndex + "[/hide]".length);
				const newLine = before + between + after;
				editor.setLine(cursor.line, newLine);
				new Notice("Removed [hide] wrappers.");
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
		const updated = updateNoteState(
			noteState,
			quality,
			now,
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

	async activateReviewSidebar() {
		let leaf = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
		if (!leaf) {
			leaf =
				this.app.workspace.getRightLeaf(false) ||
				this.app.workspace.getLeaf(true);
			await leaf.setViewState({
				type: REVIEW_VIEW_TYPE,
				active: true,
			});
		}
		this.app.workspace.revealLeaf(leaf);
	}

	// ============================================================================
	// NEW: TOGGLE ALL HIDDEN CONTENT FUNCTIONALITY (Using CSS classes)
	// ============================================================================

	/**
	 * Toggle hidden state on all elements that use our CSS-based hiding.
	 */
	private toggleAllHidden(): void {
		const textEls = document.querySelectorAll(".toggle-hidden-text");
		if (this.allHidden) {
			textEls.forEach((el) => el.classList.remove("hidden-content"));
		} else {
			textEls.forEach((el) => el.classList.add("hidden-content"));
		}
		this.allHidden = !this.allHidden;
	}
}

/* ============================================================================
 * CUSTOM MODALS
 * ========================================================================== */

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
 * RatingModal presents colored buttons for ratings 0-5 along with spaced-repetition stats.
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
		const buttonContainer = contentEl.createEl("div", {
			cls: "rating-button-container",
		});
		buttonContainer.style.display = "flex";
		buttonContainer.style.flexDirection = "column";
		buttonContainer.style.alignItems = "center";
		buttonContainer.style.margin = "10px 0";
		buttonContainer.style.width = "100%";
		const ratings = [
			{ value: "0", text: "Forgot Completely", color: "#FF4C4C" },
			{ value: "1", text: "Barely Remembered", color: "#FF7F50" },
			{ value: "2", text: "Struggled to Recall", color: "#FFA500" },
			{ value: "3", text: "Correct with Difficulty", color: "#FFFF66" },
			{ value: "4", text: "Good Recall", color: "#ADFF2F" },
			{ value: "5", text: "Perfect Recall", color: "#7CFC00" },
		];
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
		contentEl.appendChild(statsContainer);
		const stopContainer = contentEl.createEl("div");
		stopContainer.style.textAlign = "center";
		stopContainer.style.marginTop = "30px";
		stopContainer.style.width = "100%";
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
 * MARKDOWN POST-PROCESSORS FOR HIDDEN CONTENT
 * ========================================================================== */

/**
 * Process inline hidden text by replacing custom delimiters with a span
 * that holds the original text and is styled via CSS.
 */
function processCustomHiddenText(rootEl: HTMLElement): void {
	const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];
	while (walker.nextNode()) {
		textNodes.push(walker.currentNode as Text);
	}
	// Use new regex for [hide][/hide] delimiters:
	const delimiterRegex = /\[hide\](.*?)\[\/hide\]/g;
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
				fragments.forEach((frag) => {
					if (typeof frag === "string") {
						parent.insertBefore(
							document.createTextNode(frag),
							textNode
						);
					} else {
						parent.insertBefore(frag, textNode);
					}
				});
				parent.removeChild(textNode);
			}
		}
	}
}

/**
 * Returns true if the element is inside a math block.
 */
function isInsideMath(el: HTMLElement | null): boolean {
	if (!el) return false;
	if (el.classList?.contains("math")) return true;
	return isInsideMath(el.parentElement);
}

/**
 * Create a span that holds the hidden text.
 * This version uses CSS classes so that the original content remains in the DOM.
 * Here we add "hidden-content" by default so the text is initially hidden.
 */
function createHiddenTextSpan(originalContent: string): HTMLSpanElement {
	const span = document.createElement("span");
	span.classList.add("toggle-hidden-text", "hidden-content");
	span.textContent = originalContent;
	span.addEventListener("click", () => {
		span.classList.toggle("hidden-content");
	});
	return span;
}

/**
 * Process math blocks by checking for delimiters and then simply adding CSS classes.
 */
function processHiddenMathBlocks(rootEl: HTMLElement): void {
	const mathEls = rootEl.querySelectorAll(".math");
	mathEls.forEach((mathEl) => wrapMathElement(mathEl));
}

/**
 * Instead of creating extra DOM nodes, add CSS classes to the math element so that
 * its hidden state is controlled by CSS.
 * Here we also add "hidden-content" by default if the delimiters are found.
 */
function wrapMathElement(mathEl: Element): void {
	const parent = mathEl.parentElement;
	if (!parent) return;
	let foundDelimiters = false;

	const prevSibling = mathEl.previousSibling;
	if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE) {
		const textContent = prevSibling.nodeValue ?? "";
		// Look for a trailing [hide] delimiter.
		const match = textContent.match(/(.*)\[hide\]\s*$/);
		if (match) {
			prevSibling.nodeValue = match[1];
			foundDelimiters = true;
		}
	}
	const nextSibling = mathEl.nextSibling;
	if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
		const textContent = nextSibling.nodeValue ?? "";
		// Look for a leading [/hide] delimiter.
		const match = textContent.match(/^\s*\[\/hide\](.*)/);
		if (match) {
			nextSibling.nodeValue = match[1];
			foundDelimiters = true;
		}
	}
	if (!foundDelimiters) return;
	(mathEl as HTMLElement).classList.add(
		"toggle-hidden-text",
		"hidden-content"
	);
	mathEl.addEventListener("click", () => {
		(mathEl as HTMLElement).classList.toggle("hidden-content");
	});
}

/* ============================================================================
 * SETTINGS TAB
 * ========================================================================== */

class MyPluginSettingTab extends PluginSettingTab {
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
