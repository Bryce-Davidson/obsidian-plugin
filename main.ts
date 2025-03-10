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
import { customAlphabet } from "nanoid";
import Fuse from "fuse.js";

// Create a custom nanoid generator with only letters and digits.
const nanoid = customAlphabet(
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
	10
);

/* ============================================================================
 * PLUGIN DATA INTERFACES & CONSTANTS
 * ========================================================================== */

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
	cardTitle?: string;
	// New property: store the line number where the card appears (1-indexed).
	line?: number;
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

interface NoteData {
	noteVisitLog: string[];
}

interface Note {
	cards: { [cardUUID: string]: CardState };
	data: NoteData;
}

interface PluginData {
	settings: MyPluginSettings;
	notes: { [filePath: string]: Note };
}

// Extended Flashcard interface.
interface Flashcard {
	uuid: string;
	content: string;
	noteTitle?: string;
	filePath?: string;
	cardTitle?: string;
	line?: number;
	nextReviewDate?: string;
	ef?: number;
}

/* ============================================================================
 * HELPER FUNCTIONS
 * ========================================================================== */

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
 * Generate a short unique id using the custom nanoid.
 */
function generateUUID(): string {
	return nanoid();
}

/**
 * Scans a note’s content for [card] blocks.
 */
function ensureCardUUIDs(content: string): {
	updatedContent: string;
	flashcards: Flashcard[];
} {
	const flashcards: Flashcard[] = [];
	const regex =
		/\[card(?:=([a-zA-Z0-9]+)(?:,([^\]]+))?)?\]([\s\S]*?)\[\/card\]/gi;
	let updatedContent = content;
	updatedContent = updatedContent.replace(
		regex,
		(match, uuid, cardTitle, innerContent, offset: number) => {
			let cardUUID = uuid;
			if (!cardUUID) {
				cardUUID = generateUUID();
			}
			// Calculate line number.
			const lineNumber = content.substring(0, offset).split("\n").length;
			flashcards.push({
				uuid: cardUUID,
				content: innerContent.trim(),
				cardTitle: cardTitle ? cardTitle.trim() : undefined,
				line: lineNumber,
			});
			return `[card=${cardUUID}${
				cardTitle ? "," + cardTitle.trim() : ""
			}]${innerContent}[/card]`;
		}
	);
	return { updatedContent, flashcards };
}

async function syncFlashcardsForFile(
	plugin: MyPlugin,
	file: TFile
): Promise<Flashcard[]> {
	const content = await plugin.app.vault.read(file);
	const { updatedContent, flashcards } = ensureCardUUIDs(content);
	if (updatedContent !== content) {
		await plugin.app.vault.modify(file, updatedContent);
	}

	if (!plugin.notes[file.path]) {
		plugin.notes[file.path] = {
			cards: {},
			data: { noteVisitLog: [] },
		};
	}
	const fileCards = plugin.notes[file.path].cards;

	const existingCardUUIDs = Object.keys(fileCards);
	const newCardUUIDs = flashcards.map((card) => card.uuid);
	for (const cardUUID of existingCardUUIDs) {
		if (!newCardUUIDs.includes(cardUUID)) {
			delete fileCards[cardUUID];
		}
	}

	let newCardAdded = false;
	const now = new Date().toISOString();
	flashcards.forEach((flashcard) => {
		if (!fileCards[flashcard.uuid]) {
			newCardAdded = true;
			fileCards[flashcard.uuid] = {
				cardUUID: flashcard.uuid,
				cardContent: flashcard.content,
				repetition: 0,
				interval: 0,
				ef: 2.5,
				lastReviewDate: now,
				nextReviewDate: addMinutes(
					new Date(now),
					LEARNING_STEPS[0]
				).toISOString(),
				active: true,
				efHistory: [],
				cardTitle: flashcard.cardTitle,
				line: flashcard.line,
			};
		} else {
			fileCards[flashcard.uuid].cardContent = flashcard.content;
			fileCards[flashcard.uuid].cardTitle = flashcard.cardTitle;
			fileCards[flashcard.uuid].line = flashcard.line;
		}
		flashcard.noteTitle = file.basename;
		flashcard.filePath = file.path;
		flashcard.nextReviewDate = fileCards[flashcard.uuid].nextReviewDate;
		flashcard.ef = fileCards[flashcard.uuid].ef;
	});

	await plugin.savePluginData();
	if (newCardAdded) {
		plugin.refreshUnifiedQueue();
	}
	return flashcards;
}

/* ============================================================================
 * SPACED REPETITION LOGIC
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
			cardContent: state.cardContent,
			cardUUID: state.cardUUID,
			repetition: state.repetition,
			interval: state.interval,
			ef: state.ef,
			cardTitle: state.cardTitle,
			line: state.line,
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
 * BASE SIDEBAR VIEW
 * ========================================================================== */

// Helper to format a Date using 24-hour time in "day-month-year" format.
// If the date is today or tomorrow (relative to the provided 'now' date),
// it returns "Today HH:mm" or "Tomorrow HH:mm" respectively.
function formatReviewDate(date: Date, now: Date): string {
	const dYear = date.getFullYear();
	const dMonth = date.getMonth(); // zero-indexed
	const dDay = date.getDate();

	const nowYear = now.getFullYear();
	const nowMonth = now.getMonth();
	const nowDay = now.getDate();

	const hour = date.getHours().toString().padStart(2, "0");
	const minute = date.getMinutes().toString().padStart(2, "0");

	if (dYear === nowYear && dMonth === nowMonth && dDay === nowDay) {
		return `Today ${hour}:${minute}`;
	}
	const tomorrow = new Date(now);
	tomorrow.setDate(nowDay + 1);
	if (
		dYear === tomorrow.getFullYear() &&
		dMonth === tomorrow.getMonth() &&
		dDay === tomorrow.getDate()
	) {
		return `Tomorrow ${hour}:${minute}`;
	}
	const day = dDay.toString().padStart(2, "0");
	const month = (dMonth + 1).toString().padStart(2, "0");
	return `${day}-${month}-${dYear} ${hour}:${minute}`;
}

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
		let allCards: CardState[] = [];
		for (const note of Object.values(this.plugin.notes)) {
			allCards.push(...Object.values(note.cards));
		}
		const cards = this.filterCards(now, allCards);
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

		const spacer = container.createEl("div", { cls: "header-spacer" });
		spacer.setAttr("style", "height: 12px;");
		const header = container.createEl("div", { cls: "review-header" });
		header.createEl("h2", { text: this.getHeaderTitle() });
		header.createEl("div", {
			cls: "review-count",
			text: this.getCountMessage(cards.length),
		});

		const cardContainer = container.createEl("div", {
			cls: "card-container",
		});
		cards.forEach((cardState) => {
			const file = this.plugin.app.vault.getAbstractFileByPath(
				Object.keys(this.plugin.notes).find(
					(fp) => cardState.cardUUID in this.plugin.notes[fp].cards
				) || ""
			);
			if (!file || !(file instanceof TFile)) return;
			const card = cardContainer.createEl("div", { cls: "review-card" });
			card.addEventListener("click", () => {
				if (cardState.line !== undefined) {
					const options = {
						eState: { line: cardState.line - 1, ch: 0 },
					};
					this.plugin.app.workspace.getLeaf().openFile(file, options);
				} else {
					this.plugin.app.workspace.getLeaf().openFile(file);
				}
			});

			const titleRow = card.createEl("div", { cls: "title-row" });
			const displayTitle = cardState.cardTitle || file.basename;
			titleRow.createEl("h3", {
				text: displayTitle,
				title: displayTitle,
			});

			const fileCache = this.plugin.app.metadataCache.getFileCache(file);
			const tags = fileCache?.frontmatter?.tags;
			const firstTag = Array.isArray(tags) ? tags[0] : tags;
			if (firstTag) {
				const tagEl = titleRow.createEl("div", { cls: "review-tag" });
				tagEl.createEl("span", { text: `#${firstTag}` });
			}

			this.addCardMeta(card, cardState, new Date());
		});
	}

	protected addCardMeta(
		card: HTMLElement,
		cardState: CardState,
		now: Date
	): void {
		const metaContainer = card.createEl("div", { cls: "review-card-meta" });

		if (cardState.nextReviewDate) {
			const nextReview = new Date(cardState.nextReviewDate);
			if (now < nextReview) {
				// Scheduled: display the next review date using our custom formatting.
				const formattedNextReview = formatReviewDate(nextReview, now);
				metaContainer.createEl("div", {
					cls: "review-interval",
					text: formattedNextReview,
				});
			} else {
				// Due: display the last review date using our custom formatting.
				const lastReview = new Date(cardState.lastReviewDate);
				const formattedLastReview = formatReviewDate(lastReview, now);
				metaContainer.createEl("div", {
					cls: "review-interval",
					text: formattedLastReview,
				});
			}
		}

		// Display EF stat as before.
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
 * UNIFIED SIDEBAR VIEW (REVIEW & SCHEDULED)
 * ========================================================================== */

export const UNIFIED_VIEW_TYPE = "unified-queue-sidebar";
export class UnifiedQueueSidebarView extends BaseSidebarView {
	// Filtering state
	filterMode: "due" | "scheduled" = "due";
	searchText: string = "";
	tagFilter: string = "all";

	// Store references to persistent elements.
	filterHeaderEl: HTMLElement;
	controlsContainerEl: HTMLElement;
	cardContainerEl: HTMLElement;

	getViewType(): string {
		return UNIFIED_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Unified Queue";
	}

	getIcon(): string {
		return "file-text";
	}

	getHeaderTitle(): string {
		return "Review Queue";
	}

	getCountMessage(count: number): string {
		return `${count} flashcard${count === 1 ? "" : "s"} found`;
	}

	getEmptyStateIcon(): string {
		return "📚";
	}

	getEmptyStateTitle(): string {
		return "You're all caught up!";
	}

	getEmptyStateMessage(): string {
		return "No flashcards match the current filters.";
	}

	// Implement the abstract method.
	filterCards(now: Date, allCards: CardState[]): CardState[] {
		// For the unified view, filtering is handled via custom rendering.
		return allCards;
	}

	async onOpen() {
		const container = this.containerEl.children[1] || this.containerEl;
		container.empty();
		container.addClass("review-sidebar-container");

		// Create persistent filter header.
		this.filterHeaderEl = container.createEl("div", {
			cls: "filter-header",
		});
		this.filterHeaderEl.createEl("h2", { text: "Filters" });

		this.controlsContainerEl = this.filterHeaderEl.createEl("div", {
			cls: "filter-controls",
		});

		// Create a container for mode buttons and the review button.
		const modeButtonContainer = this.controlsContainerEl.createEl("div", {
			cls: "mode-button-container",
		});

		// Due and Scheduled buttons.
		const dueButton = modeButtonContainer.createEl("button", {
			cls:
				"mode-button" +
				(this.filterMode === "due" ? " active-mode" : ""),
			text: "Due",
		});
		const scheduledButton = modeButtonContainer.createEl("button", {
			cls:
				"mode-button" +
				(this.filterMode === "scheduled" ? " active-mode" : ""),
			text: "Scheduled",
		});

		dueButton.addEventListener("click", () => {
			this.filterMode = "due";
			dueButton.classList.add("active-mode");
			scheduledButton.classList.remove("active-mode");
			this.renderUnifiedCards();
		});
		scheduledButton.addEventListener("click", () => {
			this.filterMode = "scheduled";
			scheduledButton.classList.add("active-mode");
			dueButton.classList.remove("active-mode");
			this.renderUnifiedCards();
		});

		// Review Button placed with the mode buttons.
		const reviewButton = modeButtonContainer.createEl("button", {
			cls: "review-button", // New custom class for distinct styling.
			text: "Review",
		});
		reviewButton.addEventListener("click", () => {
			this.launchReviewModal();
		});

		// Tag filter.
		const tagSelect = this.controlsContainerEl.createEl("select");
		tagSelect.createEl("option", { text: "All Tags", value: "all" });
		// ... [rest of tag filter population code remains unchanged] ...
		tagSelect.value = this.tagFilter;
		tagSelect.addEventListener("change", () => {
			this.tagFilter = tagSelect.value;
			this.renderUnifiedCards();
		});

		// Search input with custom styling.
		const searchInput = this.controlsContainerEl.createEl("input", {
			cls: "filter-search", // Custom class for styling
			attr: { placeholder: "Search..." },
		});
		searchInput.value = this.searchText;
		searchInput.addEventListener("input", () => {
			this.searchText = searchInput.value;
			this.renderUnifiedCards();
		});

		// Create a persistent card container.
		this.cardContainerEl = container.createEl("div", {
			cls: "card-container",
		});
		// Initial render.
		this.renderUnifiedCards();
	}

	/**
	 * Render only the card container according to current filters.
	 */
	renderUnifiedCards() {
		// Clear the card container only.
		this.cardContainerEl.empty();

		let allCards: CardState[] = [];
		for (const note of Object.values(this.plugin.notes)) {
			allCards.push(...Object.values(note.cards));
		}
		const now = new Date();
		let filteredCards = allCards.filter((card) => {
			if (!card.active || !card.nextReviewDate) return false;
			const reviewDate = new Date(card.nextReviewDate);
			return this.filterMode === "due"
				? reviewDate <= now
				: reviewDate > now;
		});

		if (this.tagFilter !== "all") {
			filteredCards = filteredCards.filter((card) => {
				const file = this.plugin.app.vault.getAbstractFileByPath(
					Object.keys(this.plugin.notes).find(
						(fp) => card.cardUUID in this.plugin.notes[fp].cards
					) || ""
				);
				if (file && file instanceof TFile) {
					const fileCache =
						this.plugin.app.metadataCache.getFileCache(file);
					const tags = fileCache?.frontmatter?.tags;
					if (tags) {
						if (Array.isArray(tags)) {
							return tags.includes(this.tagFilter);
						} else {
							return tags === this.tagFilter;
						}
					}
				}
				return false;
			});
		}

		if (this.searchText.trim() !== "") {
			const fuse = new Fuse(filteredCards, {
				keys: ["cardTitle", "cardContent"],
				threshold: 0.4,
			});
			const results = fuse.search(this.searchText.trim());
			filteredCards = results.map((r) => r.item);
		}

		filteredCards.sort((a, b) => {
			const aDate = a.nextReviewDate
				? new Date(a.nextReviewDate).getTime()
				: 0;
			const bDate = b.nextReviewDate
				? new Date(b.nextReviewDate).getTime()
				: 0;
			if (aDate !== bDate) return aDate - bDate;
			return (a.ef || 0) - (b.ef || 0);
		});

		// If no cards, render empty state in the card container.
		if (filteredCards.length === 0) {
			this.cardContainerEl.createEl(
				"div",
				{ cls: "review-empty" },
				(emptyEl) => {
					emptyEl.createEl("h3", { text: this.getEmptyStateTitle() });
					emptyEl.createEl("p", {
						text: this.getEmptyStateMessage(),
					});
				}
			);
		} else {
			filteredCards.forEach((cardState) => {
				const file = this.plugin.app.vault.getAbstractFileByPath(
					Object.keys(this.plugin.notes).find(
						(fp) =>
							cardState.cardUUID in this.plugin.notes[fp].cards
					) || ""
				);
				if (!file || !(file instanceof TFile)) return;
				const card = this.cardContainerEl.createEl("div", {
					cls: "review-card",
				});
				card.addEventListener("click", () => {
					if (cardState.line !== undefined) {
						const options = {
							eState: { line: cardState.line - 1, ch: 0 },
						};
						this.plugin.app.workspace
							.getLeaf()
							.openFile(file, options);
					} else {
						this.plugin.app.workspace.getLeaf().openFile(file);
					}
				});
				const titleRow = card.createEl("div", { cls: "title-row" });
				const displayTitle = cardState.cardTitle || file.basename;
				titleRow.createEl("h3", {
					text: displayTitle,
					title: displayTitle,
				});
				const fileCache =
					this.plugin.app.metadataCache.getFileCache(file);
				const tags = fileCache?.frontmatter?.tags;
				const firstTag = Array.isArray(tags) ? tags[0] : tags;
				if (firstTag) {
					const tagEl = titleRow.createEl("div", {
						cls: "review-tag",
					});
					tagEl.createEl("span", { text: `#${firstTag}` });
				}
				this.addCardMeta(card, cardState, now);
			});
		}
	}

	/**
	 * Launch the review modal for the filtered cards.
	 */
	async launchReviewModal() {
		// Synchronize flashcards for all files in plugin.notes before launching the review.
		const filePaths = Object.keys(this.plugin.notes);
		for (const filePath of filePaths) {
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (file && file instanceof TFile) {
				await syncFlashcardsForFile(this.plugin, file);
			}
		}

		let allFlashcards: Flashcard[] = [];
		for (const filePath in this.plugin.notes) {
			for (const cardUUID in this.plugin.notes[filePath].cards) {
				const card = this.plugin.notes[filePath].cards[cardUUID];
				allFlashcards.push({
					uuid: cardUUID,
					content: card.cardContent, // note: property is "content"
					noteTitle:
						this.plugin.app.vault.getAbstractFileByPath(
							filePath
						) instanceof TFile
							? (
									this.plugin.app.vault.getAbstractFileByPath(
										filePath
									) as TFile
							  ).basename
							: "Unknown Note",
					filePath,
					cardTitle: card.cardTitle,
					line: card.line,
					nextReviewDate: card.nextReviewDate,
					ef: card.ef,
				});
			}
		}
		const now = new Date();
		let filtered = allFlashcards.filter((flashcard) => {
			if (flashcard.nextReviewDate) {
				const reviewDate = new Date(flashcard.nextReviewDate);
				return this.filterMode === "due"
					? reviewDate <= now
					: reviewDate > now;
			}
			return false;
		});
		if (this.tagFilter !== "all") {
			filtered = filtered.filter((flashcard) => {
				const file = this.plugin.app.vault.getAbstractFileByPath(
					flashcard.filePath || ""
				);
				if (file && file instanceof TFile) {
					const fileCache =
						this.plugin.app.metadataCache.getFileCache(file);
					const tags = fileCache?.frontmatter?.tags;
					if (tags) {
						if (Array.isArray(tags)) {
							return tags.includes(this.tagFilter);
						} else {
							return tags === this.tagFilter;
						}
					}
				}
				return false;
			});
		}
		if (this.searchText.trim() !== "") {
			// Update Fuse keys: use "content" instead of "cardContent"
			const fuse = new Fuse(filtered, {
				keys: ["cardTitle", "content"],
				threshold: 0.4,
			});
			const results = fuse.search(this.searchText.trim());
			filtered = results.map((r) => r.item);
		}
		filtered.sort((a, b) => {
			const aDate = a.nextReviewDate
				? new Date(a.nextReviewDate).getTime()
				: 0;
			const bDate = b.nextReviewDate
				? new Date(b.nextReviewDate).getTime()
				: 0;
			if (aDate !== bDate) return aDate - bDate;
			return (a.ef || 0) - (b.ef || 0);
		});
		if (this.plugin.settings.randomizeFlashcards) {
			filtered = shuffleArray(filtered);
		}
		if (filtered.length > 0) {
			new FlashcardModal(
				this.plugin.app,
				filtered,
				this.plugin,
				true
			).open();
		} else {
			new Notice("No flashcards match the current filters.");
		}
	}
}

/* ============================================================================
 * FLASHCARD MODAL
 * ========================================================================== */
class FlashcardModal extends Modal {
	flashcards: Flashcard[];
	currentIndex: number = 0;
	plugin: MyPlugin;
	feedbackContainer: HTMLElement | null = null;
	progressCounter: HTMLElement | null = null;
	modalHeaderEl: HTMLElement | null = null;

	constructor(
		app: App,
		flashcards: Flashcard[],
		plugin: MyPlugin,
		private showNoteTitle: boolean = false
	) {
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

		const topSection = container.createDiv({
			cls: "flashcard-top-section",
		});
		const progressContainer = topSection.createDiv({
			cls: "flashcard-progress-container",
		});
		const progressBar = progressContainer.createDiv({
			cls: "flashcard-progress-bar",
		});
		progressBar.style.width = "0%";
		this.progressCounter = topSection.createDiv({
			cls: "flashcard-progress-counter",
			text: `${this.currentIndex + 1} / ${this.flashcards.length}`,
		});

		this.modalHeaderEl = topSection.createEl("div", {
			cls: "flashcard-modal-header",
		});

		const cardContainer = container.createDiv({ cls: "flashcard-card" });
		this.renderCard(cardContainer);

		const bottomRow = container.createDiv({ cls: "flashcard-bottom-row" });

		const leftContainer = bottomRow.createDiv({
			cls: "flashcard-left-container",
		});
		const stopButton = leftContainer.createEl("button", {
			text: "Stop",
			cls: "flashcard-nav-button stop-button",
		});
		stopButton.addEventListener("click", async () => {
			const currentFlashcard = this.flashcards[this.currentIndex];
			const found = findCardStateAndFile(
				this.plugin,
				currentFlashcard.uuid
			);
			if (!found) {
				new Notice("Card state not found.");
				return;
			}
			const { filePath, card } = found;
			const now = new Date();
			const updated = updateCardState(card, 0, now, true);
			this.plugin.notes[filePath].cards[card.cardUUID] = updated;
			await this.plugin.savePluginData();
			new Notice("Scheduling stopped for this card.");
			this.plugin.refreshUnifiedQueue();

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
				this.close();
			}
		});

		const ratingTray = bottomRow.createDiv({
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

		// Removed the Card button block from the right container

		this.updateProgressBar(progressBar);
		setTimeout(() => {
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
		}, 0);
	}

	renderHeader(currentFlashcard: Flashcard) {
		if (!this.modalHeaderEl) return;
		this.modalHeaderEl.empty();
		const titleText =
			currentFlashcard.cardTitle || currentFlashcard.noteTitle || "";
		// Create the title element and make it clickable
		const titleEl = this.modalHeaderEl.createEl("h2", {
			cls: "flashcard-modal-note-title",
			text: titleText,
		});
		titleEl.style.cursor = "pointer";
		titleEl.addEventListener("click", () => {
			if (currentFlashcard.filePath && currentFlashcard.line) {
				const file = this.plugin.app.vault.getAbstractFileByPath(
					currentFlashcard.filePath
				);
				if (file && file instanceof TFile) {
					const options = {
						eState: { line: currentFlashcard.line - 1, ch: 0 },
					};
					this.plugin.app.workspace.getLeaf().openFile(file, options);
				}
			}
			this.close();
		});

		let tagText = "";
		if (currentFlashcard.filePath) {
			const file = this.plugin.app.vault.getAbstractFileByPath(
				currentFlashcard.filePath
			);
			if (file && file instanceof TFile) {
				const fileCache =
					this.plugin.app.metadataCache.getFileCache(file);
				const tags = fileCache?.frontmatter?.tags;
				tagText = tags ? (Array.isArray(tags) ? tags[0] : tags) : "";
			}
		}
		if (tagText) {
			this.modalHeaderEl.createEl("span", {
				cls: "flashcard-note-tag",
				text: `#${tagText}`,
			});
		}
	}

	renderCard(cardContainer: HTMLElement) {
		cardContainer.empty();
		if (
			this.flashcards.length > 0 &&
			this.currentIndex < this.flashcards.length
		) {
			const currentFlashcard = this.flashcards[this.currentIndex];
			if (this.showNoteTitle) {
				this.renderHeader(currentFlashcard);
			}
			if (currentFlashcard.cardTitle) {
				cardContainer.createEl("div", {
					cls: "flashcard-card-title",
					text: currentFlashcard.cardTitle,
				});
			}
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

	async handleRating(rating: number) {
		const now = new Date();
		const currentCard = this.flashcards[this.currentIndex];
		const found = findCardStateAndFile(this.plugin, currentCard.uuid);
		if (!found) {
			new Notice("Card state not found.");
			return;
		}
		const { filePath, card } = found;
		const updated = updateCardState(card, rating, now, false);
		this.plugin.notes[filePath].cards[card.cardUUID] = updated;
		await this.plugin.savePluginData();
		this.plugin.refreshUnifiedQueue();

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
			this.close();
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ============================================================================
 * HELPER: Find Card State and File
 * ========================================================================== */
function findCardStateAndFile(
	plugin: MyPlugin,
	cardUUID: string
): { filePath: string; card: CardState } | undefined {
	for (const [filePath, note] of Object.entries(plugin.notes)) {
		if (cardUUID in note.cards) {
			return { filePath, card: note.cards[cardUUID] };
		}
	}
	return undefined;
}

/* ============================================================================
 * MAIN PLUGIN CLASS
 * ========================================================================== */
export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	notes: { [filePath: string]: Note } = {};

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
			this.notes = data.notes || {};
		} else {
			this.settings = DEFAULT_SETTINGS;
			this.notes = {};
		}
		document.documentElement.style.setProperty(
			"--hidden-color",
			this.settings.hiddenColor
		);
	}

	async savePluginData() {
		const data: PluginData = {
			settings: this.settings,
			notes: this.notes,
		};
		await this.saveData(data);
	}

	async saveSettings() {
		await this.savePluginData();
	}

	private initializeUI(): void {
		this.addRibbonIcon("layers", "Flashcards", (evt: MouseEvent) => {
			evt.preventDefault();
			this.showAllDueFlashcardsModal();
		}).addClass("flashcard-ribbon-icon");

		this.addRibbonIcon("check-square", "Review Current Note", () => {
			this.openReviewModal();
		});

		this.addRibbonIcon("eye", "Toggle All Hidden Content", () => {
			this.toggleAllHidden();
		});

		this.addRibbonIcon("file-text", "Open Review Queue", () => {
			this.activateUnifiedQueue();
		});

		this.registerMarkdownPostProcessor((el: HTMLElement) => {
			el.innerHTML = el.innerHTML.replace(/\[\/?card(?:=[^\]]+)?\]/g, "");
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
			id: "review-current-note",
			name: "Review Current Note",
			callback: () => this.openReviewModal(),
		});

		this.addCommand({
			id: "review-all-due-flashcards",
			name: "Review All",
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
			editorCallback: async (editor: Editor) => {
				const selection = editor.getSelection();
				if (selection && selection.trim().length > 0) {
					editor.replaceSelection(`[card]${selection.trim()}[/card]`);
					new Notice("Text wrapped as flashcard");
					const activeFile = this.app.workspace.getActiveFile();
					if (activeFile && activeFile instanceof TFile) {
						await syncFlashcardsForFile(this, activeFile);
						this.refreshUnifiedQueue();
					}
				} else {
					new Notice("Please select some text first");
				}
			},
		});

		this.addCommand({
			id: "open-unified-queue",
			name: "Open Unified Queue",
			callback: () => this.activateUnifiedQueue(),
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
		this.registerEvent(
			this.app.workspace.on("file-open", async (file: TFile) => {
				if (file && file instanceof TFile) {
					await syncFlashcardsForFile(this, file);
					const now = new Date().toISOString();
					if (!this.notes[file.path]) {
						this.notes[file.path] = {
							cards: {},
							data: { noteVisitLog: [] },
						};
					}
					this.notes[file.path].data.noteVisitLog.push(now);
					this.savePluginData();
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file: TFile, oldPath: string) => {
				if (this.notes[oldPath]) {
					this.notes[file.path] = this.notes[oldPath];
					delete this.notes[oldPath];
				}
				this.savePluginData();
				this.refreshUnifiedQueue();
				this.scheduleNextDueRefresh();
			})
		);

		this.registerEvent(
			this.app.vault.on("modify", async (file: TFile) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && file.path === activeFile.path) {
					setTimeout(async () => {
						await syncFlashcardsForFile(this, file);
						this.refreshUnifiedQueue();
						this.scheduleNextDueRefresh();
					}, 100);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file: TFile) => {
				delete this.notes[file.path];
				this.savePluginData();
				this.refreshUnifiedQueue();
				this.scheduleNextDueRefresh();
			})
		);
	}

	private registerCustomViews(): void {
		this.registerView(
			UNIFIED_VIEW_TYPE,
			(leaf) => new UnifiedQueueSidebarView(leaf, this)
		);
	}

	deleteAllCardWrappers(editor: Editor) {
		const content = editor.getValue();
		const updatedContent = content.replace(
			/\[card(?:=[^\]]+)?\]([\s\S]*?)\[\/card\]/g,
			"$1"
		);
		editor.setValue(updatedContent);
		new Notice("Removed all [card][/card] wrappers from the note.");
	}

	deleteCardWrappers(editor: Editor) {
		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		const startMatches = [
			...line.substring(0, cursor.ch).matchAll(/\[card(?:=[^\]]+)?\]/g),
		];
		const startMatch =
			startMatches.length > 0
				? startMatches[startMatches.length - 1]
				: null;
		const startIndex = startMatch ? startMatch.index : -1;
		const endIndex = line.indexOf("[/card]", cursor.ch);
		if (startIndex === -1 || endIndex === -1) {
			new Notice("Cursor is not inside a [card]...[/card] block.");
			return;
		}
		const cardTag = startMatch ? startMatch[0] : "[card]";
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
		editor.setValue(newLine);
		new Notice(`Removed ${hideTag}...[/hide] wrappers.`);
	}

	async showFlashcardsModal() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active file open.");
			return;
		}
		let flashcards = await syncFlashcardsForFile(this, activeFile);
		if (this.settings.randomizeFlashcards) {
			flashcards = shuffleArray(flashcards);
		}
		if (flashcards.length > 0) {
			new FlashcardModal(this.app, flashcards, this, true).open();
		} else {
			new Notice("No flashcards found.");
		}
	}

	async showAllDueFlashcardsModal() {
		const now = new Date();
		let allDueFlashcards: Flashcard[] = [];
		for (const filePath in this.notes) {
			for (const cardUUID in this.notes[filePath].cards) {
				const card = this.notes[filePath].cards[cardUUID];
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
						cardTitle: card.cardTitle,
						line: card.line,
						nextReviewDate: card.nextReviewDate,
						ef: card.ef,
					});
				}
			}
		}
		if (allDueFlashcards.length === 0) {
			for (const filePath in this.notes) {
				for (const cardUUID in this.notes[filePath].cards) {
					const card = this.notes[filePath].cards[cardUUID];
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
							cardTitle: card.cardTitle,
							line: card.line,
							nextReviewDate: card.nextReviewDate,
							ef: card.ef,
						});
					}
				}
			}
			new Notice(
				"No due flashcards; starting scheduled flashcards review."
			);
		}

		allDueFlashcards.sort((a, b) => {
			const aDate = a.nextReviewDate
				? new Date(a.nextReviewDate).getTime()
				: 0;
			const bDate = b.nextReviewDate
				? new Date(b.nextReviewDate).getTime()
				: 0;
			if (aDate !== bDate) {
				return aDate - bDate;
			}
			return (a.ef || 0) - (b.ef || 0);
		});

		if (this.settings.randomizeFlashcards) {
			allDueFlashcards = shuffleArray(allDueFlashcards);
		}
		if (allDueFlashcards.length > 0) {
			new FlashcardModal(this.app, allDueFlashcards, this, true).open();
		} else {
			new Notice("No flashcards due or scheduled for review.");
		}
	}

	private openReviewModal(): void {
		this.showFlashcardsModal();
	}

	async activateUnifiedQueue() {
		let leaf = this.app.workspace.getLeavesOfType(UNIFIED_VIEW_TYPE)[0];
		if (!leaf) {
			leaf =
				this.app.workspace.getRightLeaf(false) ||
				this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: UNIFIED_VIEW_TYPE, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
	}

	public refreshUnifiedQueue(): void {
		const leaves = this.app.workspace.getLeavesOfType(UNIFIED_VIEW_TYPE);
		leaves.forEach((leaf) => {
			if (leaf.view instanceof UnifiedQueueSidebarView) {
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
		for (const note of Object.values(this.notes)) {
			for (const card of Object.values(note.cards)) {
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
				this.refreshUnifiedQueue();
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
 * POST-PROCESSORS
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
