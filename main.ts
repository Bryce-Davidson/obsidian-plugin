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
	MarkdownRenderer,
} from "obsidian";

/* ============================================================================
 * PLUGIN DATA INTERFACES & CONSTANTS
 * ========================================================================== */

// The card state now tracks individual flashcards.
// Note: filePath has been removed from CardState.
interface CardState {
	cardUUID: string;
	cardContent: string;
	repetition: number;
	interval: number;
	ef: number;
	lastReviewDate: string;
	nextReviewDate?: string;
	active: boolean;
	isLearning?: boolean;
	learningStep?: number;
	efHistory?: { timestamp: string; ef: number }[];
	visitLog: string[];
}

// Settings remain unchanged.
interface MyPluginSettings {
	mySetting: string;
	hiddenColor: string;
	randomizeFlashcards: boolean; // NEW setting for randomization
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
	hiddenColor: "#272c36",
	randomizeFlashcards: false, // default is not randomizing flashcards
};

// Now PluginData stores cards grouped by file path.
interface PluginData {
	settings: MyPluginSettings;
	cards: { [filePath: string]: { [cardUUID: string]: CardState } };
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

// Generate a UUID (v4-ish)
function generateUUID(): string {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
		/[xy]/g,
		function (c) {
			const r = (Math.random() * 16) | 0;
			const v = c === "x" ? r : (r & 0x3) | 0x8;
			return v.toString(16);
		}
	);
}

/**
 * A flashcard now includes additional information for review.
 */
interface Flashcard {
	uuid: string;
	content: string;
	noteTitle?: string;
	filePath?: string;
}

/**
 * Scans a note’s content for [card] blocks.
 * If a block is missing a UUID (i.e. not of the form [card=uuid]), one is generated.
 * The note content is updated with the new UUIDs.
 */
function ensureCardUUIDs(content: string): {
	updatedContent: string;
	flashcards: Flashcard[];
} {
	const flashcards: Flashcard[] = [];
	// This regex captures [card] or [card=uuid] blocks
	const regex = /\[card(?:=([a-f0-9\-]+))?\]([\s\S]*?)\[\/card\]/gi;
	let updatedContent = content;
	updatedContent = updatedContent.replace(
		regex,
		(match, uuid, innerContent) => {
			let cardUUID = uuid;
			if (!cardUUID) {
				cardUUID = generateUUID();
			}
			flashcards.push({ uuid: cardUUID, content: innerContent.trim() });
			// Always reformat the block so it includes the UUID.
			return `[card=${cardUUID}]${innerContent}[/card]`;
		}
	);
	return { updatedContent, flashcards };
}

/**
 * For a given file, read its content, ensure all flashcards have UUIDs,
 * update the file if necessary, and sync the plugin’s card store.
 */
async function syncFlashcardsForFile(
	plugin: MyPlugin,
	file: TFile
): Promise<Flashcard[]> {
	const content = await plugin.app.vault.read(file);
	const { updatedContent, flashcards } = ensureCardUUIDs(content);
	if (updatedContent !== content) {
		await plugin.app.vault.modify(file, updatedContent);
	}

	// Get or initialize the card store for this file.
	if (!plugin.cards[file.path]) {
		plugin.cards[file.path] = {};
	}
	const fileCards = plugin.cards[file.path];

	// Remove any cards that are no longer present.
	const existingCardUUIDs = Object.keys(fileCards);
	const newCardUUIDs = flashcards.map((card) => card.uuid);
	for (const cardUUID of existingCardUUIDs) {
		if (!newCardUUIDs.includes(cardUUID)) {
			delete fileCards[cardUUID];
		}
	}

	// Add new card states or update changed ones.
	const now = new Date().toISOString();
	flashcards.forEach((flashcard) => {
		if (!fileCards[flashcard.uuid]) {
			fileCards[flashcard.uuid] = {
				cardUUID: flashcard.uuid,
				cardContent: flashcard.content,
				repetition: 0,
				interval: 0,
				ef: 2.5,
				lastReviewDate: now,
				active: true,
				efHistory: [],
				visitLog: [now],
			};
		} else {
			fileCards[flashcard.uuid].cardContent = flashcard.content;
		}
		// Also attach note information to the flashcard.
		flashcard.noteTitle = file.basename;
		flashcard.filePath = file.path;
	});

	await plugin.savePluginData();
	return flashcards;
}

/* ============================================================================
 * SPACED REPETITION LOGIC (Update per flashcard via updateCardState)
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

function updateCardState(
	state: CardState,
	quality: number,
	reviewDate: Date,
	stopScheduling: boolean = false
): CardState {
	if (stopScheduling) {
		return {
			...state,
			lastReviewDate: reviewDate.toISOString(),
			nextReviewDate: undefined,
			active: false,
			visitLog: state.visitLog, // preserve visit log
			cardContent: state.cardContent,
			cardUUID: state.cardUUID,
			repetition: state.repetition,
			interval: state.interval,
			ef: state.ef,
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
	}

	if (!newState.efHistory) {
		newState.efHistory = [];
	}
	newState.efHistory.push({
		timestamp: reviewDate.toISOString(),
		ef: newState.ef,
	});

	return newState;
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
 * BASE SIDEBAR VIEW (Now displaying individual cards)
 * ========================================================================== */

// Updated abstract signature to accept both current time and a list of all cards.
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
	abstract filterCards(now: Date, allCards: CardState[]): CardState[];

	async onOpen() {
		const container = this.containerEl.children[1] || this.containerEl;
		container.empty();
		container.addClass("review-sidebar-container");

		const now = new Date();
		// Gather cards from all files.
		let allCards: CardState[] = [];
		for (const fileCards of Object.values(this.plugin.cards)) {
			allCards.push(...Object.values(fileCards));
		}
		const cards = this.filterCards(now, allCards);
		// If no cards to review
		if (cards.length === 0) {
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

		// Create header
		const spacer = container.createEl("div", { cls: "header-spacer" });
		spacer.setAttr("style", "height: 12px;");
		const header = container.createEl("div", { cls: "review-header" });
		header.createEl("h2", { text: this.getHeaderTitle() });
		header.createEl("div", {
			cls: "review-count",
			text: this.getCountMessage(cards.length),
		});

		// Create card container – note that multiple cards from the same file may be shown.
		const cardContainer = container.createEl("div", {
			cls: "card-container",
		});
		cards.forEach((cardState) => {
			// Retrieve the file via each card’s grouping.
			// Since CardState no longer contains filePath, we need to find the file.
			const file = this.plugin.app.vault.getAbstractFileByPath(
				// Loop through keys to find the card.
				Object.keys(this.plugin.cards).find(
					(fp) => cardState.cardUUID in this.plugin.cards[fp]
				) || ""
			);
			if (!file || !(file instanceof TFile)) return;
			const card = cardContainer.createEl("div", { cls: "review-card" });
			card.addEventListener("click", () => {
				// Open the file containing the flashcard.
				this.plugin.app.workspace.getLeaf().openFile(file);
			});

			const titleRow = card.createEl("div", { cls: "title-row" });
			titleRow.createEl("h3", {
				text: file.basename,
				title: file.basename,
			});
			// Show a preview of the flashcard content (truncate if needed)
			const preview = truncateTitle(cardState.cardContent, 50);
			card.createEl("p", { text: preview });

			this.addCardMeta(card, cardState, now);
		});
	}

	protected addCardMeta(
		card: HTMLElement,
		cardState: CardState,
		now: Date
	): void {
		const metaContainer = card.createEl("div", { cls: "review-card-meta" });
		const intervalEl = card.createEl("div", { cls: "review-interval" });
		const lastReviewDate = new Date(cardState.lastReviewDate);
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

		// Show Ease Factor
		const efEl = metaContainer.createEl("div", { cls: "review-stat" });
		efEl.createEl("span", { text: "EF: " });
		const efValue = cardState.ef.toFixed(2);
		const efClass =
			cardState.ef >= 2.5
				? "ef-high"
				: cardState.ef >= 1.8
				? "ef-medium"
				: "ef-low";
		efEl.createEl("span", { text: efValue, cls: `ef-value ${efClass}` });
	}
}

/* ============================================================================
 * REVIEW SIDEBAR VIEW (Now for flashcards)
 * ========================================================================== */

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
		return `${count} flashcard${count === 1 ? "" : "s"} to review`;
	}

	getEmptyStateIcon(): string {
		return "📚";
	}

	getEmptyStateTitle(): string {
		return "You're all caught up!";
	}

	getEmptyStateMessage(): string {
		return "0 flashcards due for review.";
	}

	// Filter cards that are due.
	filterCards(now: Date, allCards: CardState[]): CardState[] {
		return allCards
			.filter(
				(card) =>
					card.active &&
					card.nextReviewDate &&
					new Date(card.nextReviewDate) <= now
			)
			.sort((a, b) => a.ef - b.ef); // Sort by EF ascending
	}

	protected addCardMeta(
		card: HTMLElement,
		cardState: CardState,
		now: Date
	): void {
		const metaContainer = card.createEl("div", { cls: "review-card-meta" });
		const intervalEl = card.createEl("div", { cls: "review-interval" });
		const lastReviewDate = new Date(cardState.lastReviewDate);
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

		// Show Ease Factor
		const efEl = metaContainer.createEl("div", { cls: "review-stat" });
		efEl.createEl("span", { text: "EF: " });
		const efValue = cardState.ef.toFixed(2);
		const efClass =
			cardState.ef >= 2.5
				? "ef-high"
				: cardState.ef >= 1.8
				? "ef-medium"
				: "ef-low";
		efEl.createEl("span", { text: efValue, cls: `ef-value ${efClass}` });
	}
}

/* ============================================================================
 * SCHEDULED SIDEBAR VIEW (Now for flashcards)
 * ========================================================================== */

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
		return `${count} flashcard${count === 1 ? "" : "s"} scheduled`;
	}

	getEmptyStateIcon(): string {
		return "📅";
	}

	getEmptyStateTitle(): string {
		return "No upcoming reviews!";
	}

	getEmptyStateMessage(): string {
		return "0 flashcards scheduled for review.";
	}

	// Filter cards that are scheduled for the future.
	filterCards(now: Date, allCards: CardState[]): CardState[] {
		return allCards
			.filter(
				(card) =>
					card.active &&
					card.nextReviewDate &&
					new Date(card.nextReviewDate) > now
			)
			.sort((a, b) => {
				const dateDiff =
					new Date(a.nextReviewDate!).getTime() -
					new Date(b.nextReviewDate!).getTime();
				if (dateDiff !== 0) return dateDiff;
				// If review dates are the same, sort by EF ascending.
				return a.ef - b.ef;
			});
	}

	protected addCardMeta(
		card: HTMLElement,
		cardState: CardState,
		now: Date
	): void {
		const metaContainer = card.createEl("div", { cls: "review-card-meta" });
		const intervalEl = card.createEl("div", { cls: "review-interval" });
		if (cardState.nextReviewDate) {
			const nextReviewDate = new Date(cardState.nextReviewDate);
			const nowLocal = new Date();
			let displayText = "";
			if (
				nowLocal.getFullYear() === nextReviewDate.getFullYear() &&
				nowLocal.getMonth() === nextReviewDate.getMonth() &&
				nowLocal.getDate() === nextReviewDate.getDate()
			) {
				displayText = "Today";
			} else {
				const diffTime = nextReviewDate.getTime() - nowLocal.getTime();
				const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
				displayText =
					diffDays === 1 ? "Tomorrow" : `in ${diffDays} days`;
			}
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
		const efValue = cardState.ef.toFixed(2);
		const efClass =
			cardState.ef >= 2.5
				? "ef-high"
				: cardState.ef >= 1.8
				? "ef-medium"
				: "ef-low";
		efEl.createEl("span", { text: efValue, cls: `ef-value ${efClass}` });
	}
}

/* ============================================================================
 * FLASHCARD MODAL (Now operates on individual card states)
 * ========================================================================== */

class FlashcardModal extends Modal {
	flashcards: Flashcard[];
	currentIndex: number = 0;
	plugin: MyPlugin;
	feedbackContainer: HTMLElement | null = null;
	progressCounter: HTMLElement | null = null; // New progress counter element

	constructor(app: App, flashcards: Flashcard[], plugin: MyPlugin) {
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

		// Create the progress bar container
		const progressContainer = container.createDiv({
			cls: "flashcard-progress-container",
		});
		const progressBar = progressContainer.createDiv({
			cls: "flashcard-progress-bar",
		});
		// Set initial width to 0% so that the transition can animate
		progressBar.style.width = "0%";

		// Create the progress counter outside the progress container
		this.progressCounter = container.createDiv({
			cls: "flashcard-progress-counter",
			text: `${this.currentIndex + 1} / ${this.flashcards.length}`,
		});

		const cardContainer = container.createDiv({ cls: "flashcard-card" });
		this.renderCard(cardContainer);

		this.feedbackContainer = container.createDiv({
			cls: "flashcard-feedback",
		});

		const ratingTray = container.createDiv({
			cls: "flashcard-rating-tray",
		});
		const ratings = [
			{ value: 0, color: "#FF4C4C" },
			{ value: 2, color: "#FFA500" },
			{ value: 3, color: "#FFFF66" },
			{ value: 4, color: "#ADFF2F" },
			{ value: 5, color: "#7CFC00" },
		];
		ratings.forEach((rating) => {
			const btn = ratingTray.createEl("button", { cls: "rating-button" });
			btn.style.backgroundColor = rating.color;
			btn.addEventListener("click", () => {
				this.handleRating(rating.value);
			});
		});

		// Animate the progress bar to the initial progress (should animate from 0% to the starting value)
		this.updateProgressBar(progressBar);
	}

	updateProgressBar(progressBar: HTMLElement) {
		requestAnimationFrame(() => {
			const progress =
				((this.currentIndex + 1) / this.flashcards.length) * 100;
			progressBar.style.width = `${progress}%`;
			if (this.progressCounter) {
				this.progressCounter.textContent = `${
					this.currentIndex + 1
				} / ${this.flashcards.length}`;
			}
		});
	}

	renderCard(cardContainer: HTMLElement) {
		cardContainer.empty();
		if (
			this.flashcards.length > 0 &&
			this.currentIndex < this.flashcards.length
		) {
			const currentFlashcard = this.flashcards[this.currentIndex];

			// Display the note title above the card content.
			if (currentFlashcard.noteTitle) {
				cardContainer.createEl("div", {
					cls: "flashcard-note-title",
					text: currentFlashcard.noteTitle,
				});
			}

			// Render the card content.
			const contentWrapper = cardContainer.createDiv({
				cls: "flashcard-content",
			});
			MarkdownRenderer.render(
				this.app,
				currentFlashcard.content,
				contentWrapper,
				currentFlashcard.filePath ?? "",
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

	// When a rating is clicked, update the specific card’s state.
	async handleRating(rating: number) {
		const now = new Date();
		const currentCard = this.flashcards[this.currentIndex];
		// Locate the card state along with its file key.
		const found = findCardStateAndFile(this.plugin, currentCard.uuid);
		if (!found) {
			new Notice("Card state not found.");
			return;
		}
		const { filePath, card } = found;

		const updated = updateCardState(card, rating, now, false);
		// Reassign the updated state back into the plugin’s cards store.
		this.plugin.cards[filePath][card.cardUUID] = updated;

		await this.plugin.savePluginData();
		// Refresh sidebars
		this.plugin.refreshReviewQueue();
		this.plugin.refreshScheduledQueue();

		if (this.currentIndex < this.flashcards.length - 1) {
			this.currentIndex++;
			const cardContainer = this.contentEl.querySelector(
				".flashcard-card"
			) as HTMLElement;
			this.renderCard(cardContainer);
			const progressBar = this.contentEl.querySelector(
				".flashcard-progress-bar"
			) as HTMLElement;
			this.updateProgressBar(progressBar);
		} else {
			new Notice(`Flashcard review completed. Final EF: ${updated.ef}`);
			this.close();
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ============================================================================
 * HELPER: Find Card State and File from Nested Structure
 * ========================================================================== */
// This helper iterates over plugin.cards and returns both the file path and card state.
function findCardStateAndFile(
	plugin: MyPlugin,
	cardUUID: string
): { filePath: string; card: CardState } | undefined {
	for (const [filePath, fileCards] of Object.entries(plugin.cards)) {
		if (cardUUID in fileCards) {
			return { filePath, card: fileCards[cardUUID] };
		}
	}
	return undefined;
}

/* ============================================================================
 * MAIN PLUGIN CLASS
 * ========================================================================== */

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	// Cards are now stored by file path.
	cards: { [filePath: string]: { [cardUUID: string]: CardState } } = {};

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
			this.cards = data.cards || {};
		} else {
			this.settings = DEFAULT_SETTINGS;
			this.cards = {};
		}
		document.documentElement.style.setProperty(
			"--hidden-color",
			this.settings.hiddenColor
		);
	}

	async savePluginData() {
		const data: PluginData = {
			settings: this.settings,
			cards: this.cards,
		};
		await this.saveData(data);
	}

	async saveSettings() {
		await this.savePluginData();
	}

	private initializeUI(): void {
		// The "Flashcards" ribbon now shows ALL due flashcards.
		this.addRibbonIcon("layers", "Flashcards", (evt: MouseEvent) => {
			evt.preventDefault();
			this.showAllDueFlashcardsModal();
		}).addClass("flashcard-ribbon-icon");

		// "Review Current Note" remains.
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
			// Remove flashcard tags for display.
			el.innerHTML = el.innerHTML.replace(
				/\[\/?card(?:=[a-f0-9\-]+)?\]/g,
				""
			);
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
			callback: () => this.showAllDueFlashcardsModal(),
		});

		this.addCommand({
			id: "delete-all-card-wrappers",
			name: "Delete all [card][/card] wrappers",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.deleteAllCardWrappers(editor);
			},
		});

		this.addCommand({
			id: "delete-card-wrappers",
			name: "Delete [card][/card] wrappers",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.deleteCardWrappers(editor);
			},
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

		// This command now opens the review modal on the current note’s flashcards.
		this.addCommand({
			id: "review-current-note",
			name: "Review Current Note (Flashcards)",
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
		// When a file is opened, sync its flashcards.
		this.registerEvent(
			this.app.workspace.on("file-open", async (file: TFile) => {
				if (file && file instanceof TFile) {
					await syncFlashcardsForFile(this, file);
				}
			})
		);

		// On file rename, update filePath for all card states in that file.
		this.registerEvent(
			this.app.vault.on("rename", (file: TFile, oldPath: string) => {
				if (this.cards[oldPath]) {
					this.cards[file.path] = this.cards[oldPath];
					delete this.cards[oldPath];
				}
				this.savePluginData();
				this.refreshReviewQueue();
				this.refreshScheduledQueue();
				this.scheduleNextDueRefresh();
			})
		);

		// On file modify, if it is the active file, sync its flashcards.
		this.registerEvent(
			this.app.vault.on("modify", async (file: TFile) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && file.path === activeFile.path) {
					setTimeout(async () => {
						await syncFlashcardsForFile(this, file);
						this.refreshReviewQueue();
						this.refreshScheduledQueue();
						this.scheduleNextDueRefresh();
					}, 100);
				}
			})
		);

		// On file delete, remove all card states belonging to that file.
		this.registerEvent(
			this.app.vault.on("delete", (file: TFile) => {
				delete this.cards[file.path];
				this.savePluginData();
				this.refreshReviewQueue();
				this.refreshScheduledQueue();
				this.scheduleNextDueRefresh();
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
			// Wrap with [card][/card] (UUIDs will be added on sync)
			editor.replaceSelection(`[card]${selection.trim()}[/card]`);
			new Notice("Text wrapped as flashcard");
		} else {
			new Notice("Please select some text first");
		}
	}

	// Add this method to your MyPlugin class:
	deleteAllCardWrappers(editor: Editor) {
		const content = editor.getValue();
		// Replace all [card] or [card=...] wrappers with their inner content.
		const updatedContent = content.replace(
			/\[card(?:=[a-f0-9\-]+)?\]([\s\S]*?)\[\/card\]/g,
			"$1"
		);
		editor.setValue(updatedContent);
		new Notice("Removed all [card][/card] wrappers from the note.");
	}

	// Add this method to your plugin class (MyPlugin)
	deleteCardWrappers(editor: Editor) {
		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		// Find the last opening [card] (or [card=uuid]) tag before the cursor
		const startMatches = [
			...line
				.substring(0, cursor.ch)
				.matchAll(/\[card(?:=[a-f0-9\-]+)?\]/g),
		];
		const startMatch =
			startMatches.length > 0
				? startMatches[startMatches.length - 1]
				: null;
		const startIndex = startMatch ? startMatch.index : -1;
		// Find the closing [/card] tag after the cursor
		const endIndex = line.indexOf("[/card]", cursor.ch);
		if (startIndex === -1 || endIndex === -1) {
			new Notice("Cursor is not inside a [card]...[/card] block.");
			return;
		}
		const cardTag = startMatch ? startMatch[0] : "[card]";
		// Remove the delimiters but keep the inner content
		const newLine =
			line.slice(0, startIndex) +
			line.slice(startIndex + cardTag.length, endIndex) +
			line.slice(endIndex + "[/card]".length);
		editor.setLine(cursor.line, newLine);
		new Notice(`Removed ${cardTag}...[/card] wrappers.`);
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

	// Show flashcards for the active file (used by "Review Current Note").
	async showFlashcardsModal() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active file open.");
			return;
		}
		// Sync flashcards and update the file content as needed.
		let flashcards = await syncFlashcardsForFile(this, activeFile);
		if (this.settings.randomizeFlashcards) {
			flashcards = shuffleArray(flashcards);
		}
		if (flashcards.length > 0) {
			new FlashcardModal(this.app, flashcards, this).open();
		} else {
			new Notice("No flashcards found.");
		}
	}

	// Show all due flashcards from across the vault.
	async showAllDueFlashcardsModal() {
		const now = new Date();
		let allDueFlashcards: Flashcard[] = [];
		// First, collect due flashcards.
		for (const filePath in this.cards) {
			for (const cardUUID in this.cards[filePath]) {
				const card = this.cards[filePath][cardUUID];
				if (
					card.active &&
					card.nextReviewDate &&
					new Date(card.nextReviewDate) <= now
				) {
					const file = this.app.vault.getAbstractFileByPath(filePath);
					const noteTitle =
						file && file instanceof TFile
							? file.basename
							: "Unknown Note";
					allDueFlashcards.push({
						uuid: cardUUID,
						content: card.cardContent,
						noteTitle,
						filePath,
					});
				}
			}
		}
		// If no due flashcards, use scheduled ones.
		if (allDueFlashcards.length === 0) {
			for (const filePath in this.cards) {
				for (const cardUUID in this.cards[filePath]) {
					const card = this.cards[filePath][cardUUID];
					if (
						card.active &&
						card.nextReviewDate &&
						new Date(card.nextReviewDate) > now
					) {
						const file =
							this.app.vault.getAbstractFileByPath(filePath);
						const noteTitle =
							file && file instanceof TFile
								? file.basename
								: "Unknown Note";
						allDueFlashcards.push({
							uuid: cardUUID,
							content: card.cardContent,
							noteTitle,
							filePath,
						});
					}
				}
			}
			new Notice(
				"No due flashcards; starting scheduled flashcards review."
			);
		}

		if (this.settings.randomizeFlashcards) {
			allDueFlashcards = shuffleArray(allDueFlashcards);
		}
		if (allDueFlashcards.length > 0) {
			new FlashcardModal(this.app, allDueFlashcards, this).open();
		} else {
			new Notice("No flashcards due or scheduled for review.");
		}
	}

	private openReviewModal(): void {
		// For current note review.
		this.showFlashcardsModal();
	}

	// Update a card's state based on quality.
	private async updateCardWithQuality(
		cardUUID: string,
		quality: number,
		stopScheduling: boolean
	) {
		const now = new Date();
		const found = findCardStateAndFile(this, cardUUID);
		if (!found) {
			new Notice("Card state not found.");
			return;
		}
		const { filePath, card } = found;
		const updated = updateCardState(card, quality, now, stopScheduling);
		// Reassign the updated state into the plugin's store.
		this.cards[filePath][card.cardUUID] = updated;

		new Notice(
			`Updated SM‑2 for card '${cardUUID}': EF=${updated.ef}, NextReview=${updated.nextReviewDate}`
		);
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

	public refreshReviewQueue(): void {
		const reviewLeaves =
			this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
		reviewLeaves.forEach((leaf) => {
			if (leaf.view instanceof ReviewSidebarView) {
				leaf.view.onOpen();
			}
		});
	}

	public refreshScheduledQueue(): void {
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
		for (const fileCards of Object.values(this.cards)) {
			for (const card of Object.values(fileCards)) {
				if (card.active && card.nextReviewDate) {
					const nextTime = new Date(card.nextReviewDate).getTime();
					if (
						nextTime > now.getTime() &&
						(earliestTime === null || nextTime < earliestTime)
					) {
						earliestTime = nextTime;
					}
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
 * CUSTOM MODALS & POST-PROCESSORS (RatingModal unchanged except for variable names)
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
