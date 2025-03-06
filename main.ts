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

// Removed uuid import since we no longer need persistent UUIDs.
// import { v4 as uuidv4 } from "uuid";

/* ============================================================================
 * PLUGIN DATA INTERFACES & CONSTANTS
 * ========================================================================== */

interface EFHistoryEntry {
	timestamp: string;
	ef: number;
}

interface MyPluginSettings {
	mySetting: string;
	hiddenColor: string;
	randomizeFlashcards: boolean;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
	hiddenColor: "#272c36",
	randomizeFlashcards: false,
};

// New interface to hold all note data keyed by file path.
interface NoteData {
	spacedRepetitionLog: NoteState;
	visitLog: string[];
}

interface PluginData {
	settings: MyPluginSettings;
	noteData: { [filePath: string]: NoteData };
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
	efHistory?: EFHistoryEntry[];
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

// Helper function to shuffle an array in place using the Fisher-Yates algorithm.
function shuffleArray<T>(array: T[]): T[] {
	let currentIndex = array.length;
	while (currentIndex !== 0) {
		const randomIndex = Math.floor(Math.random() * currentIndex);
		currentIndex--;
		[array[currentIndex], array[randomIndex]] = [
			array[randomIndex],
			array[currentIndex],
		];
	}
	return array;
}

/**
 * Ensure that there is a noteData entry for a given file.
 * Returns the file path (which is used as the key).
 */
function ensureNoteDataForFile(plugin: MyPlugin, file: TFile): string {
	const key = file.path;
	if (!plugin.noteData[key]) {
		plugin.noteData[key] = {
			// Initialize a default spaced repetition log
			spacedRepetitionLog: {
				repetition: 0,
				interval: 0,
				ef: 2.5,
				lastReviewDate: new Date().toISOString(),
				active: true,
			},
			visitLog: [],
		};
		plugin.savePluginData();
	}
	return key;
}

/**
 * Helper to add a new EF history entry to a note’s state.
 */
function updateEFHistoryEntry(state: NoteState, reviewDate: Date): NoteState {
	if (!state.efHistory) state.efHistory = [];
	state.efHistory.push({ timestamp: reviewDate.toISOString(), ef: state.ef });
	return state;
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

		new Setting(containerEl)
			.setName("Randomize Flashcards")
			.setDesc(
				"If enabled, flashcards will be displayed in random order."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.randomizeFlashcards)
					.onChange(async (value) => {
						this.plugin.settings.randomizeFlashcards = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

/* ============================================================================
 * SPACED REPETITION LOGIC (Updated to track EF history)
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
	let newState = { ...state };

	if (stopScheduling) {
		newState = {
			...newState,
			lastReviewDate: reviewDate.toISOString(),
			nextReviewDate: undefined,
			active: false,
		};
		return updateEFHistoryEntry(newState, reviewDate);
	}

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
		return updateEFHistoryEntry(newState, reviewDate);
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
		return updateEFHistoryEntry(newState, reviewDate);
	}
}

// BaseSidebarView.ts
export abstract class BaseSidebarView extends ItemView {
	plugin: MyPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	abstract getViewType(): string;
	abstract getDisplayText(): string;
	abstract getIcon(): string;
	abstract getHeaderTitle(): string;
	abstract getCountMessage(count: number): string;
	abstract getEmptyStateIcon(): string;
	abstract getEmptyStateTitle(): string;
	abstract getEmptyStateMessage(): string;
	abstract filterFiles(now: Date): string[];

	async onOpen() {
		const container = this.containerEl.children[1] || this.containerEl;
		container.empty();
		container.addClass("review-sidebar-container");

		const now = new Date();
		// Filter based on our noteData keys (file paths)
		const validPaths: string[] = [];
		for (const filePath in this.plugin.noteData) {
			const noteState =
				this.plugin.noteData[filePath].spacedRepetitionLog;
			if (
				noteState.active &&
				noteState.nextReviewDate &&
				new Date(noteState.nextReviewDate) <= now
			) {
				// Verify file exists in vault.
				const file =
					this.plugin.app.vault.getAbstractFileByPath(filePath);
				if (file && file instanceof TFile) validPaths.push(filePath);
			}
		}

		const spacer = container.createEl("div", { cls: "header-spacer" });
		spacer.setAttr("style", "height: 12px;");
		const header = container.createEl("div", { cls: "review-header" });
		header.createEl("h2", { text: this.getHeaderTitle() });
		header.createEl("div", {
			cls: "review-count",
			text: this.getCountMessage(validPaths.length),
		});

		if (validPaths.length === 0) {
			const emptyState = container.createEl("div", {
				cls: "review-empty",
			});
			const iconDiv = emptyState.createEl("div", {
				cls: "review-empty-icon",
			});
			iconDiv.innerHTML = this.getEmptyStateIcon();
			emptyState.createEl("h3", { text: this.getEmptyStateTitle() });
			emptyState.createEl("p", { text: this.getEmptyStateMessage() });
			return;
		}

		const cardContainer = container.createEl("div", {
			cls: "card-container",
		});
		validPaths.forEach(async (filePath) => {
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (!file || !(file instanceof TFile)) return;
			const noteState =
				this.plugin.noteData[filePath].spacedRepetitionLog;

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

			this.addCardMeta(card, noteState, now);
		});
	}

	protected addCardMeta(
		card: HTMLElement,
		noteState: NoteState,
		now: Date
	): void {
		const metaContainer = card.createEl("div", { cls: "review-card-meta" });
		const intervalEl = card.createEl("div", { cls: "review-interval" });
		const lastReviewDate = new Date(noteState.lastReviewDate);
		const daysSinceReview = Math.floor(
			(now.getTime() - lastReviewDate.getTime()) / (1000 * 60 * 60 * 24)
		);
		intervalEl.createEl("span", {
			text:
				daysSinceReview === 0
					? "Today"
					: daysSinceReview === 1
					? "Yesterday"
					: `${daysSinceReview} days ago`,
		});

		const efEl = metaContainer.createEl("div", { cls: "review-stat" });
		efEl.createEl("span", { text: "EF: " });
		const efValue = noteState.ef.toFixed(2);
		const efClass =
			noteState.ef >= 2.5
				? "ef-high"
				: noteState.ef >= 1.8
				? "ef-medium"
				: "ef-low";
		efEl.createEl("span", { text: efValue, cls: `ef-value ${efClass}` });
	}
}

// ReviewSidebarView.ts
export const REVIEW_VIEW_TYPE = "review-sidebar";
export class ReviewSidebarView extends BaseSidebarView {
	constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
		super(leaf, plugin);
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

	getHeaderTitle(): string {
		return "Review Queue";
	}

	getCountMessage(count: number): string {
		return `${count} note${count === 1 ? "" : "s"} to review`;
	}

	getEmptyStateIcon(): string {
		return "📚";
	}

	getEmptyStateTitle(): string {
		return "You're all caught up!";
	}

	getEmptyStateMessage(): string {
		return "0 notes due for review.";
	}

	// Only include notes that are due.
	filterFiles(now: Date): string[] {
		const due: string[] = [];
		for (const filePath in this.plugin.noteData) {
			const noteState =
				this.plugin.noteData[filePath].spacedRepetitionLog;
			if (
				noteState.active &&
				noteState.nextReviewDate &&
				new Date(noteState.nextReviewDate) <= now
			) {
				due.push(filePath);
			}
		}
		return due;
	}

	protected addCardMeta(
		card: HTMLElement,
		noteState: NoteState,
		now: Date
	): void {
		const metaContainer = card.createEl("div", { cls: "review-card-meta" });
		const intervalEl = card.createEl("div", { cls: "review-interval" });
		const lastReviewDate = new Date(noteState.lastReviewDate);
		const daysSinceReview = Math.floor(
			(now.getTime() - lastReviewDate.getTime()) / (1000 * 60 * 60 * 24)
		);
		const displayText =
			daysSinceReview === 0
				? "Today"
				: daysSinceReview === 1
				? "Yesterday"
				: `${daysSinceReview} days ago`;
		const lastReviewTime = lastReviewDate.toLocaleTimeString("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
		intervalEl.createEl("span", {
			text: `Last: ${displayText} at ${lastReviewTime}`,
		});

		const efEl = metaContainer.createEl("div", { cls: "review-stat" });
		efEl.createEl("span", { text: "EF: " });
		const efValue = noteState.ef.toFixed(2);
		const efClass =
			noteState.ef >= 2.5
				? "ef-high"
				: noteState.ef >= 1.8
				? "ef-medium"
				: "ef-low";
		efEl.createEl("span", { text: efValue, cls: `ef-value ${efClass}` });
	}
}

// ScheduledSidebarView.ts
export const SCHEDULED_VIEW_TYPE = "scheduled-sidebar";
export class ScheduledSidebarView extends BaseSidebarView {
	constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
		super(leaf, plugin);
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

	getHeaderTitle(): string {
		return "Scheduled Queue";
	}

	getCountMessage(count: number): string {
		return `${count} note${count === 1 ? "" : "s"} scheduled`;
	}

	getEmptyStateIcon(): string {
		return "📅";
	}

	getEmptyStateTitle(): string {
		return "No upcoming reviews!";
	}

	getEmptyStateMessage(): string {
		return "0 notes scheduled for review.";
	}

	// Only include notes that are scheduled for the future.
	filterFiles(now: Date): string[] {
		const scheduled: string[] = [];
		for (const filePath in this.plugin.noteData) {
			const noteState =
				this.plugin.noteData[filePath].spacedRepetitionLog;
			if (
				noteState.active &&
				noteState.nextReviewDate &&
				new Date(noteState.nextReviewDate) > now
			) {
				scheduled.push(filePath);
			}
		}
		return scheduled.sort((a, b) => {
			const dateA = new Date(
				this.plugin.noteData[a].spacedRepetitionLog.nextReviewDate!
			);
			const dateB = new Date(
				this.plugin.noteData[b].spacedRepetitionLog.nextReviewDate!
			);
			return dateA.getTime() - dateB.getTime();
		});
	}

	protected addCardMeta(
		card: HTMLElement,
		noteState: NoteState,
		now: Date
	): void {
		const metaContainer = card.createEl("div", { cls: "review-card-meta" });
		const intervalEl = card.createEl("div", { cls: "review-interval" });
		if (noteState.nextReviewDate) {
			const nextReviewDate = new Date(noteState.nextReviewDate);
			const diffMs = nextReviewDate.getTime() - now.getTime();
			const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
			const displayText =
				diffDays === 0
					? "Today"
					: diffDays === 1
					? "Tomorrow"
					: `in ${diffDays} days`;
			const nextReviewTime = nextReviewDate.toLocaleTimeString("en-GB", {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
			intervalEl.createEl("span", {
				text: `Next: ${displayText} at ${nextReviewTime}`,
			});
		}

		const efEl = metaContainer.createEl("div", { cls: "review-stat" });
		efEl.createEl("span", { text: "EF: " });
		const efValue = noteState.ef.toFixed(2);
		const efClass =
			noteState.ef >= 2.5
				? "ef-high"
				: noteState.ef >= 1.8
				? "ef-medium"
				: "ef-low";
		efEl.createEl("span", { text: efValue, cls: `ef-value ${efClass}` });
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
		modalEl.addClass("modern-flashcard-modal");

		const container = contentEl.createDiv({
			cls: "flashcard-content-container",
		});

		const progressContainer = container.createDiv({
			cls: "flashcard-progress-container",
		});
		const progressBar = progressContainer.createDiv({
			cls: "flashcard-progress-bar",
		});
		this.updateProgressBar(progressBar);

		const cardContainer = container.createDiv({ cls: "flashcard-card" });
		this.cardEl = cardContainer;

		this.renderCard(cardContainer);

		const controls = container.createDiv({ cls: "flashcard-controls" });

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

		const counter = controls.createDiv({
			cls: "flashcard-counter",
			text: `${this.currentIndex + 1} / ${this.flashcards.length}`,
		});

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
					this.close();
				}
			});

		this.updateNextButtonIcon();

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
			setIcon(this.nextBtn.buttonEl, "check");
			this.nextBtn.buttonEl.addClass("last-card-button");
		} else {
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

	renderCard(cardContainer: HTMLElement) {
		cardContainer.empty();
		if (this.flashcards.length > 0) {
			const cardContent = this.flashcards[this.currentIndex];
			const contentWrapper = cardContainer.createDiv({
				cls: "flashcard-content",
			});
			MarkdownRenderer.render(
				this.app,
				cardContent,
				contentWrapper,
				this.app.workspace.getActiveFile()?.path ?? "",
				this.plugin
			);

			const internalLinks =
				contentWrapper.querySelectorAll("a.internal-link");
			internalLinks.forEach((link) => {
				link.addEventListener("click", (evt) => {
					evt.preventDefault();
					const href = link.getAttribute("href");
					if (href) {
						this.plugin.app.workspace.openLinkText(href, "", false);
						this.close();
					}
				});
			});
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
	// All note-related data is stored in noteData, keyed by file path.
	noteData: { [filePath: string]: NoteData } = {};
	private allHidden: boolean = true;
	private refreshTimeout: number | null = null;

	async onload() {
		await this.loadPluginData();
		this.initializeUI();
		this.registerCommands();
		this.registerEvents();
		this.registerCustomViews();
		this.addSettingTab(new MyPluginSettingTab(this.app, this));
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
			this.noteData = data.noteData || {};
		} else {
			this.settings = DEFAULT_SETTINGS;
			this.noteData = {};
		}
		document.documentElement.style.setProperty(
			"--hidden-color",
			this.settings.hiddenColor
		);
	}

	async savePluginData() {
		const data: PluginData = {
			settings: this.settings,
			noteData: this.noteData,
		};
		await this.saveData(data);
	}

	async saveSettings() {
		await this.savePluginData();
	}

	private initializeUI(): void {
		this.addRibbonIcon("layers", "Flashcards", (evt: MouseEvent) => {
			evt.preventDefault();
			this.showFlashcardsModal();
		}).addClass("flashcard-ribbon-icon");

		this.addRibbonIcon("check-square", "Review Current Note", () => {
			this.openReviewModal();
		});

		this.addRibbonIcon("eye", "Toggle All Hidden Content", () => {
			this.toggleAllHidden();
		});

		this.addRibbonIcon("file-text", "Open Review Queue", () => {
			this.activateReviewSidebar();
		});

		this.addRibbonIcon("calendar", "Open Scheduled Queue", () => {
			this.activateScheduledSidebar();
		});

		this.registerMarkdownPostProcessor((el: HTMLElement) => {
			el.innerHTML = el.innerHTML.replace(/\[\/?card\]/g, "");
		});

		this.registerMarkdownPostProcessor((element, context) => {
			processCustomHiddenText(element);
			processMathBlocks(element);
		});
	}

	private registerCommands(): void {
		this.addCommand({
			id: "show-flashcards-modal",
			name: "Show Flashcards Modal",
			callback: () => this.showFlashcardsModal(),
		});

		this.addCommand({
			id: "wrap-text-as-flashcard",
			name: "Wrap Selected Text in [card][/card]",
			editorCallback: (editor: Editor) =>
				this.wrapSelectedTextAsFlashcard(editor),
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
			id: "review-current-note",
			name: "Review Current Note (Spaced Repetition)",
			callback: () => this.openReviewModal(),
		});

		this.addCommand({
			id: "open-review-queue",
			name: "Open Review Queue",
			callback: () => this.activateReviewSidebar(),
		});

		this.addCommand({
			id: "open-scheduled-queue",
			name: "Open Scheduled Queue",
			callback: () => this.activateScheduledSidebar(),
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
				editor.replaceSelection(`[hide]${selection}[/hide]`);
			},
		});

		this.addCommand({
			id: "toggle-all-hidden",
			name: "Toggle All Hidden Content",
			callback: () => this.toggleAllHidden(),
		});

		this.addCommand({
			id: "delete-hide-wrappers",
			name: "Delete [hide][/hide] wrappers",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.deleteHideWrappers(editor);
			},
		});
	}

	private registerEvents(): void {
		// Update noteData when a file is renamed.
		this.registerEvent(
			this.app.vault.on("rename", (file: TFile, oldPath: string) => {
				// Move the noteData entry from oldPath to the new file.path.
				if (this.noteData[oldPath]) {
					this.noteData[file.path] = this.noteData[oldPath];
					delete this.noteData[oldPath];
					this.savePluginData();
				}
				console.log(`Updated data from ${oldPath} to ${file.path}`);
				this.refreshReviewQueue();
				this.refreshScheduledQueue();
				this.scheduleNextDueRefresh();
			})
		);

		this.registerEvent(
			this.app.vault.on("modify", (file: TFile) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && file.path === activeFile.path) {
					setTimeout(() => {
						this.refreshReviewQueue();
						this.refreshScheduledQueue();
						this.scheduleNextDueRefresh();
					}, 100);
				}
			})
		);

		// Remove noteData when a file is deleted.
		this.registerEvent(
			this.app.vault.on("delete", (file: TFile) => {
				if (this.noteData[file.path]) {
					delete this.noteData[file.path];
					this.savePluginData();
					new Notice(`Deleted '${file.basename}' from review logs.`);
				}
			})
		);

		// Log visits using the file path as the key.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!leaf) return;
				const mdView = leaf.view as MarkdownView;
				if (!mdView || !mdView.file) return;
				const file = mdView.file;
				if (file && file instanceof TFile) {
					const key = ensureNoteDataForFile(this, file);
					this.noteData[key].visitLog.push(new Date().toISOString());
					this.savePluginData();
				}
			})
		);
	}

	private registerCustomViews(): void {
		this.registerView(
			REVIEW_VIEW_TYPE,
			(leaf) => new ReviewSidebarView(leaf, this)
		);
		this.registerView(
			SCHEDULED_VIEW_TYPE,
			(leaf) => new ScheduledSidebarView(leaf, this)
		);
	}

	wrapSelectedTextAsFlashcard(editor: Editor) {
		const selection = editor.getSelection();
		if (selection && selection.trim().length > 0) {
			editor.replaceSelection(`[card]${selection.trim()}[/card]`);
			new Notice("Text wrapped as flashcard");
		} else {
			new Notice("Please select some text first");
		}
	}

	deleteHideWrappers(editor: Editor) {
		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		const startMatches = [
			...line.substring(0, cursor.ch).matchAll(/\[hide(?:=\d+)?\]/g),
		];
		const startMatch =
			startMatches.length > 0
				? startMatches[startMatches.length - 1]
				: null;
		const startIndex = startMatch ? startMatch.index : -1;
		const endIndex = line.indexOf("[/hide]", cursor.ch);
		if (startIndex === -1 || endIndex === -1) {
			new Notice("Cursor is not inside a [hide]...[/hide] block.");
			return;
		}
		const hideTag = startMatch ? startMatch[0] : "[hide]";
		const newLine =
			line.slice(0, startIndex) +
			line.slice(startIndex + hideTag.length, endIndex) +
			line.slice(endIndex + "[/hide]".length);
		editor.setLine(cursor.line, newLine);
		new Notice(`Removed ${hideTag}...[/hide] wrappers.`);
	}

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

	async showFlashcardsModal() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active file open.");
			return;
		}
		const content = await this.app.vault.read(activeFile);
		let flashcards = this.parseFlashcards(content);
		if (this.settings.randomizeFlashcards) {
			flashcards = shuffleArray(flashcards);
		}
		if (flashcards.length > 0) {
			new FlashcardModal(this.app, flashcards, this).open();
		} else {
			new Notice("No flashcards found.");
		}
	}

	private openReviewModal(): void {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active Markdown file to review.");
			return;
		}
		const key = ensureNoteDataForFile(this, file);
		const currentState = this.noteData[key].spacedRepetitionLog;
		new RatingModal(this.app, currentState, (ratingStr: string) => {
			if (!ratingStr) return;
			if (ratingStr.toLowerCase() === "stop") {
				this.updateNoteWithQuality(key, 0, true);
			} else {
				const rating = parseInt(ratingStr, 10);
				if (isNaN(rating) || rating < 0 || rating > 5) {
					new Notice(
						"Invalid rating. Please choose a rating between 0 and 5."
					);
					return;
				}
				this.updateNoteWithQuality(key, rating, false);
			}
		}).open();
	}

	private async updateNoteWithQuality(
		key: string,
		quality: number,
		stopScheduling: boolean
	) {
		const now = new Date();
		let noteState = this.noteData[key].spacedRepetitionLog;
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
		this.noteData[key].spacedRepetitionLog = updated;
		if (stopScheduling) {
			new Notice(`Scheduling stopped for '${key}'`);
		} else {
			new Notice(
				`Updated SM-2 for '${key}': EF=${updated.ef}, NextReview=${updated.nextReviewDate}`
			);
		}
		await this.savePluginData();
		this.refreshReviewQueue();
		this.refreshScheduledQueue();
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

	private scheduleNextDueRefresh(): void {
		if (this.refreshTimeout !== null) {
			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
		const now = new Date();
		let earliestTime: number | null = null;
		for (const key in this.noteData) {
			const state = this.noteData[key].spacedRepetitionLog;
			if (state.active && state.nextReviewDate) {
				const nextTime = new Date(state.nextReviewDate).getTime();
				if (
					nextTime > now.getTime() &&
					(earliestTime === null || nextTime < earliestTime)
				) {
					earliestTime = nextTime;
				}
			}
		}
		if (earliestTime !== null) {
			const delay = earliestTime - now.getTime() + 100;
			this.refreshTimeout = window.setTimeout(() => {
				this.refreshReviewQueue();
				this.refreshScheduledQueue();
				this.scheduleNextDueRefresh();
			}, delay);
		}
	}

	private toggleAllHidden(): void {
		const textEls = document.querySelectorAll(".hidden-note");
		if (this.allHidden) {
			textEls.forEach((el) => el.classList.remove("toggle-hidden"));
		} else {
			textEls.forEach((el) => el.classList.add("toggle-hidden"));
		}
		this.allHidden = !this.allHidden;
	}
}

/* ============================================================================
 * CUSTOM MODALS
 * ========================================================================== */

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
				cls: "rating-button",
			});
			btn.style.backgroundColor = rating.color;
			btn.addEventListener("click", () => {
				this.onSubmit(rating.value);
				this.close();
			});
		});
		const statsContainer = contentEl.createEl("div", {
			cls: "stats-container",
		});
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
		const stopContainer = contentEl.createEl("div", {
			cls: "stop-container",
		});
		const stopButton = stopContainer.createEl("button", {
			text: "Stop Scheduling",
			cls: "mod-cta stop-button",
		});
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
