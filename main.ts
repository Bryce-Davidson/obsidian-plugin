import {
	App,
	Editor,
	MarkdownView,
	Modal,
	setIcon,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	ButtonComponent,
	TFile,
	WorkspaceLeaf,
	ItemView,
	MarkdownRenderer,
} from "obsidian";

/* ============================================================================
 * PLUGIN DATA INTERFACES & CONSTANTS
 * ========================================================================== */

interface MyPluginSettings {
	mySetting: string;
	hiddenColor: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
	hiddenColor: "#272c36",
};

interface PluginData {
	settings: MyPluginSettings;
	spacedRepetitionLog: { [filePath: string]: NoteState };
}

interface NoteState {
	repetition: number;
	interval: number;
	ef: number;
	lastReviewDate: string;
	nextReviewDate?: string;
	active: boolean;
	isLearning?: boolean;
	learningStep?: number;
}

/* ============================================================================
 * HELPER FUNCTIONS
 * ========================================================================== */

// Helper function to truncate titles (default max length set to 30 characters)
function truncateTitle(title: string, maxLength: number = 30): string {
	return title.length > maxLength
		? title.substring(0, maxLength) + "…"
		: title;
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
			.setName("Hidden Text Background Color")
			.setDesc("Set the background color for hidden text")
			.addText((text) =>
				text
					.setPlaceholder("Color")
					.setValue(this.plugin.settings.hiddenColor)
					.onChange(async (value) => {
						this.plugin.settings.hiddenColor = value;
						document.documentElement.style.setProperty(
							"--hidden-color",
							value
						);
						await this.plugin.saveSettings();
					})
			);
	}
}

/* ============================================================================
 * SPACED REPETITION LOGIC (Unchanged)
 * ========================================================================== */

function getNextReviewDate(lastReview: Date, interval: number): Date {
	const nextReview = new Date(lastReview);
	nextReview.setDate(lastReview.getDate() + interval);
	return nextReview;
}

function addMinutes(date: Date, minutes: number): Date {
	const result = new Date(date);
	result.setMinutes(result.getMinutes() + minutes);
	return result;
}

function formatInterval(
	lastReviewDate: string,
	nextReviewDate: string
): string {
	const last = new Date(lastReviewDate);
	const next = new Date(nextReviewDate);
	const diffMs = next.getTime() - last.getTime();
	const diffMinutes = Math.floor(diffMs / (1000 * 60));
	const days = Math.floor(diffMinutes / (60 * 24));
	const hours = Math.floor((diffMinutes % (60 * 24)) / 60);
	const minutes = diffMinutes % 60;
	let parts: string[] = [];
	if (days > 0) parts.push(`${days} day(s)`);
	if (hours > 0) parts.push(`${hours} hour(s)`);
	if (minutes > 0 || parts.length === 0) parts.push(`${minutes} minute(s)`);
	return parts.join(", ");
}

const LEARNING_STEPS: number[] = [10, 30];

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
		newState.interval = Math.round(intervalMinutes / (60 * 24));
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
 * REVIEW SIDEBAR VIEW (Review Queue)
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
		container.addClass("review-sidebar-container");

		const now = new Date();
		const reviewNotes: string[] = [];
		const validFiles: string[] = [];

		// Collect due notes
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

		// Verify files exist
		for (const filePath of reviewNotes) {
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (file && file instanceof TFile) {
				validFiles.push(filePath);
			}
		}

		const spacer = container.createEl("div", { cls: "header-spacer" });
		spacer.setAttr("style", "height: 12px;");
		const header = container.createEl("div", { cls: "review-header" });
		header.createEl("h2", { text: "Review Queue" });
		// Always display the subheading, even if 0 notes.
		header.createEl("div", {
			cls: "review-count",
			text: `${validFiles.length} note${
				validFiles.length === 1 ? "" : "s"
			} to review`,
		});

		if (validFiles.length === 0) {
			const emptyState = container.createEl("div", {
				cls: "review-empty",
			});
			const iconDiv = emptyState.createEl("div", {
				cls: "review-empty-icon",
			});
			iconDiv.innerHTML = "📚";
			emptyState.createEl("h3", { text: "You're all caught up!" });
			emptyState.createEl("p", { text: "0 notes due for review." });
		}

		const cardContainer = container.createEl("div", {
			cls: "card-container",
		});
		validFiles.forEach(async (filePath) => {
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (!file || !(file instanceof TFile)) return;
			const noteState = this.plugin.spacedRepetitionLog[filePath];

			const fileCache = this.plugin.app.metadataCache.getFileCache(file);
			const tags = fileCache?.frontmatter?.tags;
			const firstTag = Array.isArray(tags) ? tags[0] : tags;

			const card = cardContainer.createEl("div", { cls: "review-card" });
			card.addEventListener("click", () => {
				this.plugin.app.workspace.getLeaf().openFile(file);
			});

			const titleRow = card.createEl("div", { cls: "title-row" });
			titleRow.createEl("h3", {
				text: file.basename,
				title: file.basename,
			});

			if (firstTag) {
				const tagEl = titleRow.createEl("div", { cls: "review-tag" });
				tagEl.createEl("span", { text: `#${firstTag}` });
			}

			const lastReviewDate = new Date(noteState.lastReviewDate);
			const daysSinceReview = Math.floor(
				(now.getTime() - lastReviewDate.getTime()) /
					(1000 * 60 * 60 * 24)
			);

			const metaContainer = card.createEl("div", {
				cls: "review-card-meta",
			});
			const intervalEl = card.createEl("div", { cls: "review-interval" });
			intervalEl.createEl("span", {
				text: `Last review: ${
					daysSinceReview === 0
						? "Today"
						: daysSinceReview === 1
						? "Yesterday"
						: `${daysSinceReview} days ago`
				}`,
			});

			const efEl = metaContainer.createEl("div", { cls: "review-stat" });
			const efValue = noteState.ef.toFixed(2);
			const efClass =
				noteState.ef >= 2.5
					? "ef-high"
					: noteState.ef >= 1.8
					? "ef-medium"
					: "ef-low";
			efEl.createEl("span", { text: "EF: " });
			efEl.createEl("span", {
				text: efValue,
				cls: `ef-value ${efClass}`,
			});
		});
	}

	async onClose() {
		// Clean up if needed
	}
}

/* ============================================================================
 * SCHEDULED SIDEBAR VIEW (Scheduled Queue)
 * ========================================================================== */

export const SCHEDULED_VIEW_TYPE = "scheduled-sidebar";
export class ScheduledSidebarView extends ItemView {
	plugin: MyPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SCHEDULED_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Scheduled Queue";
	}

	getIcon(): string {
		return "calendar";
	}

	async onOpen() {
		const container = this.containerEl.children[1] || this.containerEl;
		container.empty();
		// Use same container classes for consistent styling.
		container.addClass("review-sidebar-container");

		const now = new Date();
		const scheduledNotes: string[] = [];
		const validFiles: string[] = [];

		// Collect notes with nextReviewDate in the future
		for (const filePath in this.plugin.spacedRepetitionLog) {
			const state = this.plugin.spacedRepetitionLog[filePath];
			if (
				state.active &&
				state.nextReviewDate &&
				new Date(state.nextReviewDate) > now
			) {
				scheduledNotes.push(filePath);
			}
		}

		// Verify files exist
		for (const filePath of scheduledNotes) {
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (file && file instanceof TFile) {
				validFiles.push(filePath);
			}
		}

		// Sort by nextReviewDate ascending
		validFiles.sort((a, b) => {
			const dateA = new Date(
				this.plugin.spacedRepetitionLog[a].nextReviewDate!
			);
			const dateB = new Date(
				this.plugin.spacedRepetitionLog[b].nextReviewDate!
			);
			return dateA.getTime() - dateB.getTime();
		});

		const spacer = container.createEl("div", { cls: "header-spacer" });
		spacer.setAttr("style", "height: 12px;");
		const header = container.createEl("div", { cls: "review-header" });
		header.createEl("h2", { text: "Scheduled Queue" });
		// Always display the subheading even if 0 notes.
		header.createEl("div", {
			cls: "review-count",
			text: `${validFiles.length} note${
				validFiles.length === 1 ? "" : "s"
			} scheduled`,
		});

		if (validFiles.length === 0) {
			const emptyState = container.createEl("div", {
				cls: "review-empty",
			});
			const iconDiv = emptyState.createEl("div", {
				cls: "review-empty-icon",
			});
			iconDiv.innerHTML = "📅";
			emptyState.createEl("h3", { text: "No upcoming reviews!" });
			emptyState.createEl("p", { text: "0 notes scheduled for review." });
		}

		const cardContainer = container.createEl("div", {
			cls: "card-container",
		});
		validFiles.forEach(async (filePath) => {
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (!file || !(file instanceof TFile)) return;
			const noteState = this.plugin.spacedRepetitionLog[filePath];

			const fileCache = this.plugin.app.metadataCache.getFileCache(file);
			const tags = fileCache?.frontmatter?.tags;
			const firstTag = Array.isArray(tags) ? tags[0] : tags;

			const card = cardContainer.createEl("div", { cls: "review-card" });
			card.addEventListener("click", () => {
				this.plugin.app.workspace.getLeaf().openFile(file);
			});

			const titleRow = card.createEl("div", { cls: "title-row" });
			// Use the truncateTitle helper to shorten long note titles
			titleRow.createEl("h3", {
				text: truncateTitle(file.basename),
				title: file.basename,
			});

			if (firstTag) {
				const tagEl = titleRow.createEl("div", { cls: "review-tag" });
				tagEl.createEl("span", { text: `#${firstTag}` });
			}

			const metaContainer = card.createEl("div", {
				cls: "review-card-meta",
			});
			// Display the scheduled next review time
			const nextReviewFormatted = formatNextReviewTime(
				noteState.nextReviewDate!
			);
			metaContainer.createEl("div", {
				cls: "review-interval",
				text: nextReviewFormatted,
			});
		});
	}

	async onClose() {
		// Clean up if needed
	}
}

class FlashcardModal extends Modal {
	flashcards: string[];
	currentIndex: number = 0;
	plugin: Plugin;
	cardEl: HTMLElement | null = null;
	nextBtn: ButtonComponent | null = null;

	constructor(app: App, flashcards: string[], plugin: Plugin) {
		super(app);
		this.flashcards = flashcards;
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();

		// Apply modern styling to modal
		modalEl.addClass("modern-flashcard-modal");

		// Container for the entire modal content
		const container = contentEl.createDiv({
			cls: "flashcard-content-container",
		});

		// Progress bar
		const progressContainer = container.createDiv({
			cls: "flashcard-progress-container",
		});
		const progressBar = progressContainer.createDiv({
			cls: "flashcard-progress-bar",
		});
		this.updateProgressBar(progressBar);

		// Card container with shadow and rounded corners
		const cardContainer = container.createDiv({ cls: "flashcard-card" });
		this.cardEl = cardContainer;

		// Render initial card
		this.renderCard(cardContainer);

		// Navigation controls
		const controls = container.createDiv({ cls: "flashcard-controls" });

		// Previous button
		const prevBtn = new ButtonComponent(controls)
			.setClass("flashcard-nav-button")
			.setClass("flashcard-prev-button")
			.onClick(() => {
				if (this.currentIndex > 0) {
					this.showPrevious();
					this.renderCard(cardContainer);
					this.updateProgressBar(progressBar);
					this.updateNextButtonIcon();
					counter.setText(
						`${this.currentIndex + 1} / ${this.flashcards.length}`
					);
				}
			});

		setIcon(prevBtn.buttonEl, "arrow-left");

		// Counter
		const counter = controls.createDiv({
			cls: "flashcard-counter",
			text: `${this.currentIndex + 1} / ${this.flashcards.length}`,
		});

		// Next button
		this.nextBtn = new ButtonComponent(controls)
			.setClass("flashcard-nav-button")
			.setClass("flashcard-next-button")
			.onClick(() => {
				if (this.currentIndex < this.flashcards.length - 1) {
					this.showNext();
					this.renderCard(cardContainer);
					this.updateProgressBar(progressBar);
					this.updateNextButtonIcon();
					counter.setText(
						`${this.currentIndex + 1} / ${this.flashcards.length}`
					);
				} else if (this.currentIndex === this.flashcards.length - 1) {
					// Close the modal when clicking the green checkmark on the last card
					this.close();
				}
			});

		// Set initial icon state
		this.updateNextButtonIcon();

		// Add keyboard shortcuts
		this.scope.register([], "ArrowLeft", () => {
			prevBtn.buttonEl.click();
			return false;
		});

		this.scope.register([], "ArrowRight", () => {
			if (this.nextBtn) {
				this.nextBtn.buttonEl.click();
			}
			return false;
		});
	}

	updateNextButtonIcon() {
		if (!this.nextBtn) return;

		if (this.currentIndex === this.flashcards.length - 1) {
			// Last card - show checkmark
			setIcon(this.nextBtn.buttonEl, "check");
			this.nextBtn.buttonEl.addClass("last-card-button");
		} else {
			// Not last card - show arrow
			setIcon(this.nextBtn.buttonEl, "arrow-right");
			this.nextBtn.buttonEl.removeClass("last-card-button");
		}
	}

	updateProgressBar(progressBar: HTMLElement) {
		const progress =
			((this.currentIndex + 1) / this.flashcards.length) * 100;
		progressBar.style.width = `${progress}%`;
	}

	onClose() {
		this.contentEl.empty();
	}

	// Render the current flashcard within the provided card container
	renderCard(cardContainer: HTMLElement) {
		cardContainer.empty();

		if (this.flashcards.length > 0) {
			const cardContent = this.flashcards[this.currentIndex];

			// Create a content wrapper
			const contentWrapper = cardContainer.createDiv({
				cls: "flashcard-content",
			});

			// Just show the entire content regardless of any dividers
			MarkdownRenderer.renderMarkdown(
				cardContent,
				contentWrapper,
				this.app.workspace.getActiveFile()?.path ?? "",
				this.plugin
			);
		} else {
			cardContainer.setText("No flashcards available.");
		}
	}

	showPrevious() {
		if (this.currentIndex > 0) {
			this.currentIndex--;
		}
	}

	showNext() {
		if (this.currentIndex < this.flashcards.length - 1) {
			this.currentIndex++;
		}
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
	// Timer ID used to schedule refresh when a scheduled note becomes due
	private refreshTimeout: number | null = null;

	async onload() {
		await this.loadPluginData();

		// Add ribbon icon for flashcards
		const ribbonIconEl = this.addRibbonIcon(
			"layers",
			"Flashcards",
			(evt: MouseEvent) => {
				// Prevent default behavior
				evt.preventDefault();
				// Show the flashcards modal
				this.showFlashcardsModal();
			}
		);

		// Add tooltip to ribbon icon
		ribbonIconEl.addClass("flashcard-ribbon-icon");

		// Command to show flashcards modal
		this.addCommand({
			id: "show-flashcards-modal",
			name: "Show Flashcards Modal",
			callback: () => this.showFlashcardsModal(),
		});

		// Command to wrap selected text in [card][/card] delimiters
		this.addCommand({
			id: "wrap-text-as-flashcard",
			name: "Wrap Selected Text as Flashcard",
			editorCallback: (editor: Editor) => {
				this.wrapSelectedTextAsFlashcard(editor);
			},
		});

		// Register a Markdown postprocessor to remove the [card][/card] delimiters
		// from the rendered view. This ensures they remain hidden in reading view.
		this.registerMarkdownPostProcessor((el: HTMLElement) => {
			el.innerHTML = el.innerHTML.replace(/\[\/?card\]/g, "");
		});

		// ---------------

		document.documentElement.style.setProperty(
			"--hidden-color",
			this.settings.hiddenColor
		);

		this.addRibbonIcon("check-square", "Review Current Note", () => {
			this.openReviewModal();
		});

		this.registerCommands();
		this.addSettingTab(new MyPluginSettingTab(this.app, this));

		this.addRibbonIcon("eye", "Toggle All Hidden Content", () => {
			this.toggleAllHidden();
		});

		this.registerMarkdownPostProcessor((element, context) => {
			processCustomHiddenText(element);
			processMathBlocks(element);
		});

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

				// Refresh both panels if they are open
				this.refreshReviewQueue();
				this.refreshScheduledQueue();
				this.scheduleNextDueRefresh();
			})
		);

		// Refresh panels whenever the active file is modified (e.g. when tags are edited)
		this.registerEvent(
			this.app.vault.on("modify", (file: TFile) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && file.path === activeFile.path) {
					// Small timeout to allow metadata updates to propagate
					setTimeout(() => {
						this.refreshReviewQueue();
						this.refreshScheduledQueue();
						this.scheduleNextDueRefresh();
					}, 100);
				}
			})
		);

		this.registerView(
			REVIEW_VIEW_TYPE,
			(leaf) => new ReviewSidebarView(leaf, this)
		);
		this.registerView(
			SCHEDULED_VIEW_TYPE,
			(leaf) => new ScheduledSidebarView(leaf, this)
		);

		this.addRibbonIcon("file-text", "Open Review Queue", () => {
			this.activateReviewSidebar();
		});
		this.addRibbonIcon("calendar", "Open Scheduled Queue", () => {
			this.activateScheduledSidebar();
		});

		// Schedule the first due refresh based on scheduled notes
		this.scheduleNextDueRefresh();
	}

	onunload() {
		console.log("Unloading MyPlugin");
		if (this.refreshTimeout !== null) {
			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
	}

	async loadPluginData() {
		const data = (await this.loadData()) as PluginData;
		if (data) {
			this.settings = data.settings || DEFAULT_SETTINGS;
			this.spacedRepetitionLog = data.spacedRepetitionLog || {};
		} else {
			this.settings = DEFAULT_SETTINGS;
			this.visitLog = {};
			this.spacedRepetitionLog = {};
		}
	}

	async savePluginData() {
		const data: PluginData = {
			settings: this.settings,
			spacedRepetitionLog: this.spacedRepetitionLog,
		};
		await this.saveData(data);
	}

	async saveSettings() {
		await this.savePluginData();
	}

	wrapSelectedTextAsFlashcard(editor: Editor) {
		const selection = editor.getSelection();

		if (selection) {
			// Trim the selection to avoid extra whitespace
			const trimmedSelection = selection.trim();

			if (trimmedSelection.length > 0) {
				// Replace the selection with the wrapped version
				editor.replaceSelection(`[card]${trimmedSelection}[/card]`);
				new Notice("Text wrapped as flashcard");
			} else {
				new Notice("Please select some text first");
			}
		} else {
			new Notice("Please select some text first");
		}
	}

	async showFlashcardsModal() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active file open.");
			return;
		}
		const content = await this.app.vault.read(activeFile);
		const flashcards = this.parseFlashcards(content);
		if (flashcards.length > 0) {
			new FlashcardModal(this.app, flashcards, this).open();
		} else {
			new Notice("No flashcards found.");
		}
	}

	// Parse every [card]...[/card] pair (even nested ones) as separate flashcards.
	parseFlashcards(content: string): string[] {
		const flashcards: string[] = [];
		const openTag = "[card]";
		const closeTag = "[/card]";
		const stack: number[] = [];
		let pos = 0;

		while (pos < content.length) {
			const nextOpen = content.indexOf(openTag, pos);
			const nextClose = content.indexOf(closeTag, pos);
			if (nextOpen === -1 && nextClose === -1) break;
			if (nextOpen !== -1 && (nextOpen < nextClose || nextClose === -1)) {
				stack.push(nextOpen);
				pos = nextOpen + openTag.length;
			} else if (nextClose !== -1) {
				if (stack.length > 0) {
					const startIndex = stack.pop()!;
					const cardContent = content
						.substring(startIndex + openTag.length, nextClose)
						.trim();
					flashcards.push(cardContent);
				}
				pos = nextClose + closeTag.length;
			}
		}
		return flashcards;
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
			id: "sample-editor-command",
			name: "Sample editor command",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log("Selected text:", editor.getSelection());
				editor.replaceSelection("Sample Editor Command");
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

		this.addCommand({
			id: "open-scheduled-queue",
			name: "Open Scheduled Queue",
			callback: () => {
				this.activateScheduledSidebar();
			},
		});

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

		this.addCommand({
			id: "toggle-all-hidden",
			name: "Toggle All Hidden Content",
			callback: () => {
				this.toggleAllHidden();
			},
		});

		this.addCommand({
			id: "delete-hide-wrappers",
			name: "Delete [hide][/hide] wrappers",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const cursor = editor.getCursor();
				const line = editor.getLine(cursor.line);
				const startMatches = [
					...line
						.substring(0, cursor.ch)
						.matchAll(/\[hide(?:=\d+)?\]/g),
				];
				let startMatch =
					startMatches.length > 0
						? startMatches[startMatches.length - 1]
						: null;
				let startIndex = startMatch ? startMatch.index : -1;
				const endIndex = line.indexOf("[/hide]", cursor.ch);
				if (startIndex === -1 || endIndex === -1) {
					new Notice(
						"Cursor is not inside a [hide]...[/hide] block."
					);
					return;
				}
				const hideTag = startMatch ? startMatch[0] : "[hide]";
				const before = line.slice(0, startIndex);
				const between = line.slice(
					startIndex + hideTag.length,
					endIndex
				);
				const after = line.slice(endIndex + "[/hide]".length);
				const newLine = before + between + after;
				editor.setLine(cursor.line, newLine);
				new Notice(`Removed ${hideTag}...[/hide] wrappers.`);
			},
		});
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
		// Refresh both panels after a note is reviewed
		this.refreshReviewQueue();
		this.refreshScheduledQueue();
		// Recalculate the next due refresh in case scheduled dates have changed
		this.scheduleNextDueRefresh();
	}

	async activateReviewSidebar() {
		let leaf = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
		if (!leaf) {
			leaf =
				this.app.workspace.getRightLeaf(false) ||
				this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
	}

	async activateScheduledSidebar() {
		let leaf = this.app.workspace.getLeavesOfType(SCHEDULED_VIEW_TYPE)[0];
		if (!leaf) {
			leaf =
				this.app.workspace.getRightLeaf(false) ||
				this.app.workspace.getLeaf(true);
			await leaf.setViewState({
				type: SCHEDULED_VIEW_TYPE,
				active: true,
			});
		}
		this.app.workspace.revealLeaf(leaf);
	}

	// ============================================================================
	// TOGGLE ALL HIDDEN CONTENT FUNCTIONALITY (Using CSS classes)
	// ============================================================================
	private toggleAllHidden(): void {
		const textEls = document.querySelectorAll(".hidden-note");
		if (this.allHidden) {
			textEls.forEach((el) => el.classList.remove("toggle-hidden"));
		} else {
			textEls.forEach((el) => el.classList.add("toggle-hidden"));
		}
		this.allHidden = !this.allHidden;
	}

	// ============================================================================
	// Helper functions to refresh the panels
	// ============================================================================
	private refreshReviewQueue(): void {
		const reviewLeaves =
			this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
		reviewLeaves.forEach((leaf) => {
			if (leaf.view instanceof ReviewSidebarView) {
				leaf.view.onOpen();
			}
		});
	}

	private refreshScheduledQueue(): void {
		const scheduledLeaves =
			this.app.workspace.getLeavesOfType(SCHEDULED_VIEW_TYPE);
		scheduledLeaves.forEach((leaf) => {
			if (leaf.view instanceof ScheduledSidebarView) {
				leaf.view.onOpen();
			}
		});
	}

	/**
	 * Schedules a timer to refresh the panels when the next scheduled note becomes due.
	 * It scans the spaced repetition log for the earliest upcoming review time,
	 * and sets a timeout accordingly.
	 */
	private scheduleNextDueRefresh(): void {
		// Clear any existing timer.
		if (this.refreshTimeout !== null) {
			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
		const now = new Date();
		let earliestTime: number | null = null;
		for (const filePath in this.spacedRepetitionLog) {
			const state = this.spacedRepetitionLog[filePath];
			if (state.active && state.nextReviewDate) {
				const nextTime = new Date(state.nextReviewDate).getTime();
				// Only consider scheduled notes that are still in the future.
				if (nextTime > now.getTime()) {
					if (earliestTime === null || nextTime < earliestTime) {
						earliestTime = nextTime;
					}
				}
			}
		}
		if (earliestTime !== null) {
			// Compute the delay until the next note becomes due (add a small margin)
			const delay = earliestTime - now.getTime() + 100;
			this.refreshTimeout = window.setTimeout(() => {
				this.refreshReviewQueue();
				this.refreshScheduledQueue();
				this.scheduleNextDueRefresh();
			}, delay);
		}
	}
}

/* ============================================================================
 * CUSTOM MODALS
 * ========================================================================== */

/**
 * Helper function to format the next review time as "YYYY-MM-DD:HH:mm" in 24hr format
 */
function formatNextReviewTime(dateString: string): string {
	const date = new Date(dateString);
	const year = date.getFullYear();
	const month = ("0" + (date.getMonth() + 1)).slice(-2);
	const day = ("0" + date.getDate()).slice(-2);
	const hours = ("0" + date.getHours()).slice(-2);
	const minutes = ("0" + date.getMinutes()).slice(-2);
	return `${day}-${month}-${year}:${hours}:${minutes}`;
}

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
		if (this.currentState && this.currentState.nextReviewDate) {
			const intervalDisplay = formatInterval(
				this.currentState.lastReviewDate,
				this.currentState.nextReviewDate
			);
			const formattedTime = formatNextReviewTime(
				this.currentState.nextReviewDate
			);
			statsContainer.innerHTML = `<strong>Current Statistics:</strong>
      <br/>Repetitions: ${this.currentState.repetition}
      <br/>Interval: ${intervalDisplay} - ${formattedTime}
      <br/>EF: ${this.currentState.ef}
      <br/>Next Review: ${formattedTime}`;
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
 * MARKDOWN POST-PROCESSORS FOR HIDDEN CONTENT AND INLINE MATH
 * ========================================================================== */

function processCustomHiddenText(rootEl: HTMLElement): void {
	const elements = rootEl.querySelectorAll("*");
	elements.forEach((element) => {
		let html = element.innerHTML;
		if (html.includes("[hide") && html.includes("[/hide]")) {
			html = html.replace(
				/\[hide=(\d+)\]([\s\S]*?)\[\/hide\]/g,
				(match, groupId, content) => {
					return `<span class="hidden-note group-hide toggle-hidden" data-group="${groupId}">${content}</span>`;
				}
			);
			html = html.replace(
				/\[hide\]([\s\S]*?)\[\/hide\]/g,
				(match, content) => {
					return `<span class="hidden-note toggle-hidden">${content}</span>`;
				}
			);
			element.innerHTML = html;
			element.querySelectorAll(".group-hide").forEach((el) => {
				el.addEventListener("click", function () {
					const group = this.getAttribute("data-group");
					if (!group) {
						this.classList.toggle("toggle-hidden");
					} else {
						const groupElements = document.querySelectorAll(
							`.group-hide[data-group="${group}"]`
						);
						const isHidden =
							groupElements[0].classList.contains(
								"toggle-hidden"
							);
						groupElements.forEach((elem) => {
							if (isHidden) {
								elem.classList.remove("toggle-hidden");
							} else {
								elem.classList.add("toggle-hidden");
							}
						});
					}
				});
			});
			element
				.querySelectorAll(".hidden-note:not(.group-hide)")
				.forEach((el) => {
					el.addEventListener("click", function () {
						this.classList.toggle("toggle-hidden");
					});
				});
		}
	});
}

/**
 * Processes paragraphs to detect multiple block-level math expressions and wraps them in a div.
 * Assumes that math blocks are rendered with the class "math-block".
 */
function processMathBlocks(rootEl: HTMLElement): void {
	rootEl.querySelectorAll("p").forEach((paragraph) => {
		const mathBlocks = Array.from(
			paragraph.querySelectorAll(".math-block")
		);
		if (mathBlocks.length > 1) {
			const wrapper = document.createElement("div");
			wrapper.classList.add("inline-math-container");
			while (paragraph.firstChild) {
				wrapper.appendChild(paragraph.firstChild);
			}
			paragraph.replaceWith(wrapper);
		}
	});
}
