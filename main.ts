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
	// NEW fields for learning phase.
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
 * For quality < 3, the note enters (or continues in) a learning phase with short intervals.
 * For quality >= 3, the note leaves the learning phase (if active) and follows normal SM‑2 scheduling.
 *
 * @param state The current state of the note.
 * @param quality The rating given by the user (0–5).
 * @param reviewDate The date/time of the review.
 * @param stopScheduling If true, stops further scheduling.
 * @returns The updated NoteState.
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

	// Create a new state object to avoid mutating the original.
	let newState = { ...state };

	if (quality < 3) {
		// The note is answered incorrectly—enter or continue learning mode.
		if (!newState.isLearning) {
			// Start learning phase.
			newState.isLearning = true;
			newState.learningStep = 0;
		} else {
			// Already in learning mode; advance to the next learning step if available.
			if (
				newState.learningStep !== undefined &&
				newState.learningStep < LEARNING_STEPS.length - 1
			) {
				newState.learningStep++;
			}
		}
		// Reset repetition count since the card is forgotten.
		newState.repetition = 0;
		// Compute next review date using the learning step interval (in minutes).
		const stepIndex = newState.learningStep ?? 0;
		const intervalMinutes = LEARNING_STEPS[stepIndex];
		const nextReview = addMinutes(reviewDate, intervalMinutes);
		newState.lastReviewDate = reviewDate.toISOString();
		newState.nextReviewDate = nextReview.toISOString();
		newState.active = true;
		return newState;
	} else {
		// quality >= 3: the note is answered correctly.
		if (newState.isLearning) {
			// If the note was in learning mode, exit learning mode and restart with a basic review interval.
			newState.isLearning = false;
			newState.learningStep = undefined;
			newState.repetition = 1;
			newState.interval = 1; // 1 day for the first successful review.
		} else {
			// Normal review phase.
			newState.repetition++;
			if (newState.repetition === 1) {
				newState.interval = 1; // day
			} else if (newState.repetition === 2) {
				newState.interval = 6; // days
			} else {
				// For later repetitions, multiply the previous interval by the EF (easiness factor).
				newState.interval = Math.round(newState.interval * newState.ef);
			}
		}

		// Update the easiness factor using the SM‑2 formula.
		let newEF =
			newState.ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
		if (newEF < 1.3) newEF = 1.3;
		newState.ef = parseFloat(newEF.toFixed(2));

		// Compute next review date using the interval in days.
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

// A constant to uniquely identify the review sidebar view.
export const REVIEW_VIEW_TYPE = "review-sidebar";

// The review sidebar displays all notes that are due for review. Clicking on a note opens it.
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
		// Safely access a container element.
		const container = this.containerEl.children[1] || this.containerEl;
		container.empty();

		// Gather active notes due for review.
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

		// If no notes to review, display a simple message.
		if (reviewNotes.length === 0) {
			const noNotesEL = container.createEl("p", {
				text: "No notes to review!",
			});
			noNotesEL.style.textAlign = "center";
			return;
		}

		// Header with centered title.
		const header = container.createEl("div", { cls: "review-header" });
		header.style.display = "flex";
		header.style.justifyContent = "center";
		header.style.alignItems = "center";
		header.style.marginBottom = "16px";

		const title = header.createEl("h2", { text: "Review Queue" });
		title.style.fontFamily = "'Roboto', sans-serif";
		title.style.margin = "0";
		title.style.fontSize = "24px";

		// Create a container for the review cards.
		const cardContainer = container.createEl("div", {
			cls: "card-container",
		});
		cardContainer.style.display = "flex";
		cardContainer.style.flexDirection = "column";
		cardContainer.style.gap = "12px";
		cardContainer.style.padding = "0 8px"; // Added padding for mobile devices

		reviewNotes.forEach((filePath) => {
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (!file || !(file instanceof TFile)) return;
			const noteState = this.plugin.spacedRepetitionLog[filePath];

			// Create a minimal, mobile-friendly card.
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

			// Truncate the title if longer than 15 characters.
			let titleText = file.basename;
			if (titleText.length > 15) {
				titleText = titleText.substring(0, 15) + "...";
			}

			// Note title (clickable to open the note).
			const cardTitle = card.createEl("h3", { text: titleText });
			cardTitle.style.margin = "0";
			cardTitle.style.fontSize = "18px";
			cardTitle.style.fontWeight = "bold";
			cardTitle.style.color = "#333";
			cardTitle.style.flexGrow = "1"; // Allow title to take up remaining space
			cardTitle.onclick = async (evt) => {
				evt.preventDefault();
				const leaf = this.plugin.app.workspace.getLeaf(true);
				await leaf.openFile(file);
			};

			// Show only the current EF rating.
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

	// spacedRepetitionLog maps file paths to their NoteState.
	spacedRepetitionLog: { [filePath: string]: NoteState } = {};

	async onload() {
		await this.loadPluginData();

		this.addPluginRibbonIcon();
		this.addStatusBar();
		this.registerCommands();
		this.addSettingTab(new SampleSettingTab(this.app, this));

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

		// NEW: Register the review sidebar view and add a ribbon icon to open it.
		this.registerView(
			REVIEW_VIEW_TYPE,
			(leaf) => new ReviewSidebarView(leaf, this)
		);
		// For opening the review queue sidebar, use "file-text" icon.
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

	// Ribbon icon uses "check-square" and calls openReviewModal().
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

	// openReviewModal() checks for an active Markdown file and opens the RatingModal.
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

		// NEW: Command to open the Review Queue sidebar.
		this.addCommand({
			id: "open-review-queue",
			name: "Open Review Queue",
			callback: () => {
				this.activateReviewSidebar();
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
		// Use the current time for the review.
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
		// Refresh the Review Queue if it's open.
		this.refreshReviewQueue();
	}

	// NEW: Activate (or reveal) the review sidebar.
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

	// NEW: Refresh the Review Queue sidebar if it's open.
	private refreshReviewQueue(): void {
		const reviewLeaves =
			this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
		reviewLeaves.forEach((leaf) => {
			if (leaf.view instanceof ReviewSidebarView) {
				leaf.view.onOpen();
			}
		});
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
 * The Stop Scheduling button uses Obsidian's default "mod-cta" styling.
 *
 * For hidden elements (both inline math and regular text, and for block‑level math),
 * the placeholder text is "[show]". In addition, for block‑level math, we measure
 * the height of the underlying math block and set the placeholder's height to match,
 * thereby minimizing layout shift.
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

		// Define ratings with descriptive text and their corresponding colors.
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

		// Create an Obsidian-styled button for Stop Scheduling.
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

	// Initially show the gray "[show]" placeholder.
	span.style.cursor = "pointer";
	span.style.color = "gray";
	span.style.textDecoration = "underline";
	span.textContent = "[show]";

	span.addEventListener("click", () => {
		const isHidden = span.getAttribute("data-hidden") === "true";
		if (isHidden) {
			// Remove forced styles so revealed text inherits normal text color.
			span.removeAttribute("style");
			span.style.cursor = "pointer";
			span.innerHTML = `
				<span class="bracket" style="color: gray;">[</span>
				<span class="revealed-text">${originalContent}</span>
				<span class="bracket" style="color: gray;">]</span>
			`;
			span.setAttribute("data-hidden", "false");
		} else {
			// Go back to the gray "[show]" placeholder.
			span.innerHTML = "[show]";
			span.setAttribute("data-hidden", "true");
			span.style.cursor = "pointer";
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

	let placeholder: HTMLElement;
	if (mathEl.classList.contains("math-block")) {
		// For block-level math, create a placeholder.
		placeholder = document.createElement("div");
		placeholder.style.padding = "11px 10px";
		placeholder.style.margin = "0 0";
		placeholder.style.backgroundColor = "#fafafa";
		placeholder.style.textAlign = "center";
		placeholder.style.fontSize = "14px";
		placeholder.style.lineHeight = "1.5";
		placeholder.style.borderRadius = "4px";
		placeholder.style.color = "black";
		placeholder.style.cursor = "pointer";
		placeholder.textContent = "show";
	} else {
		// For inline math, just do a simple "[show]" placeholder in gray.
		placeholder = document.createElement(wrapperTag);
		placeholder.className = "toggle-hidden-math-placeholder";
		placeholder.style.cursor = "pointer";
		placeholder.style.textAlign = "center";
		placeholder.style.color = "gray";
		placeholder.innerHTML = "[show]";
	}

	const revealedContainer = document.createElement(wrapperTag);
	revealedContainer.className = "toggle-hidden-math-revealed";
	revealedContainer.style.display = "none";

	if (!mathEl.classList.contains("math-block")) {
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
	} else {
		revealedContainer.appendChild(mathEl);
	}

	wrapper.appendChild(placeholder);
	wrapper.appendChild(revealedContainer);

	wrapper.addEventListener("click", () => {
		const currentlyHidden = wrapper.getAttribute("data-hidden") === "true";
		if (currentlyHidden) {
			// Show the math, hide the placeholder
			placeholder.style.display = "none";
			revealedContainer.style.display = isDisplayMath
				? "block"
				: "inline";
			wrapper.setAttribute("data-hidden", "false");
		} else {
			// Hide the math, show the placeholder
			if (mathEl.classList.contains("math-block")) {
				placeholder.style.display = "block";
			} else {
				placeholder.style.display = "inline";
			}
			revealedContainer.style.display = "none";
			wrapper.setAttribute("data-hidden", "true");
		}
	});
}
