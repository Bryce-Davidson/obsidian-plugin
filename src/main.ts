import "./main.css";

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
import { GraphView, VIEW_TYPE_GRAPH } from "./graph-view";
import { customAlphabet } from "nanoid";
import Fuse from "fuse.js";
import { OcclusionView, VIEW_TYPE_OCCLUSION } from "./konva";
import Konva from "konva"; // Add this import for the Konva library

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
	efHistory?: { timestamp: string; ef: number; rating: number }[];
	cardTitle?: string;
	line?: number;
	createdAt: string;
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

// Define the OcclusionShape interface here in main.ts
export interface OcclusionShape {
	x: number;
	y: number;
	width: number;
	height: number;
	fill: string;
	opacity: number;
}

// Define OcclusionData here in main.ts
export interface OcclusionData {
	attachments: { [filePath: string]: OcclusionShape[] };
}

// Unified PluginData interface
export interface PluginData {
	settings: MyPluginSettings;
	notes: { [filePath: string]: Note };
	occlusion: OcclusionData;
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
 * Scans a note's content for [card] blocks.
 */
/**
 * Scans a note's content for [card] blocks.
 * If a card doesn't have an explicit title, it attempts to use the first markdown heading within the card.
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

			if (!cardTitle) {
				const headingMatch = innerContent.match(/^(#+)\s+(.*)$/m);
				if (headingMatch) {
					cardTitle = headingMatch[2]
						.replace(/^\d+(\.\d+)*\.\s*/, "")
						.trim();
				}
			}

			const lineNumber = content.substring(0, offset).split("\n").length;
			flashcards.push({
				uuid: cardUUID,
				content: innerContent.trim(),
				cardTitle: cardTitle ? cardTitle.trim() : undefined,
				line: lineNumber,
			});
			return `[card=${cardUUID}]${innerContent}[/card]`;
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
				createdAt: now,
				nextReviewDate: addMinutes(
					new Date(now),
					LEARNING_STEPS[0]
				).toISOString(),
				active: true,
				efHistory: [
					{
						timestamp: now,
						ef: 2.5,
						rating: 3,
					},
				],
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
			createdAt: state.createdAt,
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
	// Record the new EF along with the rating that produced it.
	newState.efHistory.push({
		timestamp: reviewDate.toISOString(),
		ef: newState.ef,
		rating: quality,
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
					text: `Next: ${formattedNextReview}`,
				});
			} else {
				// Due: display the last review date using our custom formatting.
				const lastReview = new Date(cardState.lastReviewDate);
				const formattedLastReview = formatReviewDate(lastReview, now);
				metaContainer.createEl("div", {
					cls: "review-interval",
					text: `Last: ${formattedLastReview}`,
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
	// Filtering state now includes "note"
	filterMode: "due" | "scheduled" | "note" = "due";
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

		this.controlsContainerEl = this.filterHeaderEl.createEl("div", {
			cls: "filter-controls",
		});

		// 1) Review Button (full width, top row)
		const reviewButtonContainer = this.controlsContainerEl.createEl("div", {
			cls: "review-button-container",
		});
		reviewButtonContainer.style.width = "100%";

		const reviewButton = reviewButtonContainer.createEl("button", {
			cls: "review-button full-width",
			text: "Review",
		});
		reviewButton.style.width = "100%";

		reviewButton.addEventListener("click", () => {
			this.launchReviewModal();
		});

		// 2) Mode Buttons (Due, Note, Scheduled)
		const modeButtonContainer = this.controlsContainerEl.createEl("div", {
			cls: "mode-button-container",
		});

		const dueButton = modeButtonContainer.createEl("button", {
			cls:
				"mode-button" +
				(this.filterMode === "due" ? " active-mode" : ""),
			text: "Due",
		});
		const noteButton = modeButtonContainer.createEl("button", {
			cls:
				"mode-button" +
				(this.filterMode === "note" ? " active-mode" : ""),
			text: "Note",
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
			noteButton.classList.remove("active-mode");
			scheduledButton.classList.remove("active-mode");
			this.renderUnifiedCards();
		});
		noteButton.addEventListener("click", () => {
			this.filterMode = "note";
			noteButton.classList.add("active-mode");
			dueButton.classList.remove("active-mode");
			scheduledButton.classList.remove("active-mode");
			this.renderUnifiedCards();
		});
		scheduledButton.addEventListener("click", () => {
			this.filterMode = "scheduled";
			scheduledButton.classList.add("active-mode");
			dueButton.classList.remove("active-mode");
			noteButton.classList.remove("active-mode");
			this.renderUnifiedCards();
		});

		// 3) Tag filter (select)
		const tagSelect = this.controlsContainerEl.createEl("select");
		tagSelect.createEl("option", { text: "All Tags", value: "all" });
		const uniqueTags = new Set<string>();
		for (const notePath in this.plugin.notes) {
			const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
			if (file && file instanceof TFile) {
				const fileCache =
					this.plugin.app.metadataCache.getFileCache(file);
				const tags = fileCache?.frontmatter?.tags;
				if (tags) {
					if (Array.isArray(tags)) {
						tags.forEach((tag) => uniqueTags.add(tag));
					} else {
						uniqueTags.add(tags);
					}
				}
			}
		}
		uniqueTags.forEach((tag) => {
			tagSelect.createEl("option", { text: `#${tag}`, value: tag });
		});
		tagSelect.value = this.tagFilter;
		tagSelect.addEventListener("change", () => {
			this.tagFilter = tagSelect.value;
			this.renderUnifiedCards();
		});

		// 4) Search input
		const searchInput = this.controlsContainerEl.createEl("input", {
			cls: "filter-search",
			attr: { placeholder: "Search..." },
		});
		searchInput.value = this.searchText;
		searchInput.addEventListener("input", () => {
			this.searchText = searchInput.value;
			this.renderUnifiedCards();
		});

		// Create the persistent card container.
		this.cardContainerEl = container.createEl("div", {
			cls: "card-container",
		});
		// Initial render.
		this.renderUnifiedCards();
	}
	/**
	 * Render only the card container according to current filters.
	 */
	renderUnifiedCards(): void {
		// Clear out existing cards.
		this.cardContainerEl.empty();

		// Gather all cards from all notes.
		let allCards: CardState[] = [];
		for (const note of Object.values(this.plugin.notes)) {
			allCards.push(...Object.values(note.cards));
		}

		const now = new Date();
		let filteredCards: CardState[] = allCards;

		// If we're in "note" mode, only show cards from the active note.
		if (this.filterMode === "note") {
			const activeFile = this.plugin.app.workspace.getActiveFile();
			if (activeFile) {
				filteredCards = allCards.filter((card) => {
					const filePath = Object.keys(this.plugin.notes).find(
						(fp) => card.cardUUID in this.plugin.notes[fp].cards
					);
					return filePath === activeFile.path;
				});
			} else {
				filteredCards = [];
			}
		} else {
			// Otherwise, we're in "due" or "scheduled" mode.
			filteredCards = filteredCards.filter((card) => {
				// Exclude cards with no nextReviewDate or not active.
				if (!card.active || !card.nextReviewDate) return false;
				const reviewDate = new Date(card.nextReviewDate);
				// "due" means reviewDate <= now; "scheduled" means reviewDate > now.
				return this.filterMode === "due"
					? reviewDate <= now
					: reviewDate > now;
			});

			// Apply tag filter if not "all".
			if (this.tagFilter !== "all") {
				filteredCards = filteredCards.filter((card) => {
					const filePath = Object.keys(this.plugin.notes).find(
						(fp) => card.cardUUID in this.plugin.notes[fp].cards
					);
					if (!filePath) return false;
					const file =
						this.plugin.app.vault.getAbstractFileByPath(filePath);
					if (file && file instanceof TFile) {
						const fileCache =
							this.plugin.app.metadataCache.getFileCache(file);
						const tags = fileCache?.frontmatter?.tags;
						if (tags) {
							return Array.isArray(tags)
								? tags.includes(this.tagFilter)
								: tags === this.tagFilter;
						}
					}
					return false;
				});
			}

			// Apply search text if provided.
			if (this.searchText.trim() !== "") {
				const fuse = new Fuse(filteredCards, {
					keys: ["cardTitle", "cardContent"],
					threshold: 0.4,
				});
				const results = fuse.search(this.searchText.trim());
				filteredCards = results.map((r) => r.item);
			}
		}

		// Add a Tailwind-styled UI element that shows the number of filtered cards.
		// The "text-center" class centers the text.
		const countEl = this.cardContainerEl.createEl("div", {
			cls: "text-sm font-bold text-blue-500 mb-2 text-center",
		});
		countEl.setText(
			`${filteredCards.length} flashcard${
				filteredCards.length === 1 ? "" : "s"
			}`
		);

		// If no cards left after filters, show empty state.
		if (filteredCards.length === 0) {
			this.cardContainerEl.createEl(
				"div",
				{ cls: "review-empty" },
				(el) => {
					el.createEl("h3", { text: this.getEmptyStateTitle() });
					el.createEl("p", { text: this.getEmptyStateMessage() });
				}
			);
			return;
		}

		// Otherwise, render each filtered card.
		filteredCards.forEach((cardState) => {
			const filePath = Object.keys(this.plugin.notes).find(
				(fp) => cardState.cardUUID in this.plugin.notes[fp].cards
			);
			if (!filePath) return;
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (!file || !(file instanceof TFile)) return;

			// Create card element.
			const card = this.cardContainerEl.createEl("div", {
				cls: "review-card",
			});
			// Set position relative for absolute positioning of the button.
			card.style.position = "relative";

			// Clicking the card opens the file at the specific line if available.
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

			// Title row.
			const titleRow = card.createEl("div", { cls: "title-row" });
			const displayTitle = cardState.cardTitle || file.basename;
			titleRow.createEl("h3", {
				text: displayTitle,
				title: displayTitle,
			});

			this.addCardMeta(card, cardState, now);

			// Add a button to launch the flashcard modal for the individual card.
			const flashcardButton = card.createEl("button", {
				cls: "flashcard-launch-button",
			});
			flashcardButton.style.position = "absolute";
			flashcardButton.style.bottom = "8px";
			flashcardButton.style.right = "8px";
			flashcardButton.style.width = "2.25em";
			flashcardButton.style.height = "2.25em";
			flashcardButton.style.border = "none";
			flashcardButton.style.cursor = "pointer";
			flashcardButton.style.color = "white";

			flashcardButton.addEventListener("click", (e) => {
				e.stopPropagation();
				e.preventDefault();
				const flashcard = {
					uuid: cardState.cardUUID,
					content: cardState.cardContent,
					noteTitle: file.basename,
					filePath: filePath,
					cardTitle: cardState.cardTitle,
					line: cardState.line,
					nextReviewDate: cardState.nextReviewDate,
					ef: cardState.ef,
				};
				new FlashcardModal(
					this.plugin.app,
					[flashcard],
					this.plugin,
					true
				).open();
			});
		});

		// Provide a reset button to reset all currently filtered cards.
		const resetButton = this.cardContainerEl.createEl("button", {
			cls: "filter-reset-button",
			text: "Reset Cards",
		});
		resetButton.addEventListener("click", async () => {
			if (
				!confirm(
					"Are you sure you want to reset all filtered flashcards? This action cannot be undone."
				)
			) {
				return;
			}
			const now = new Date();
			filteredCards.forEach((card) => {
				const filePath = Object.keys(this.plugin.notes).find(
					(fp) => card.cardUUID in this.plugin.notes[fp].cards
				);
				if (filePath) {
					const pluginCard =
						this.plugin.notes[filePath].cards[card.cardUUID];
					const originalCreatedAt =
						pluginCard.createdAt || now.toISOString();
					pluginCard.ef = 2.5;
					pluginCard.repetition = 0;
					pluginCard.interval = 0;
					pluginCard.lastReviewDate = now.toISOString();
					pluginCard.nextReviewDate = addMinutes(
						now,
						LEARNING_STEPS[0]
					).toISOString();
					pluginCard.active = true;
					pluginCard.isLearning = false;
					pluginCard.learningStep = undefined;
					pluginCard.efHistory = [
						{
							timestamp: now.toISOString(),
							ef: 2.5,
							rating: 3,
						},
					];
					pluginCard.createdAt = originalCreatedAt;
				}
			});
			await this.plugin.savePluginData();
			new Notice("All filtered flashcards reset successfully.");
			this.plugin.refreshUnifiedQueue();
		});
	}

	/**
	 * Launch the review modal for the filtered cards.
	 */
	async launchReviewModal() {
		// First, synchronize flashcards for all files.
		const filePaths = Object.keys(this.plugin.notes);
		for (const filePath of filePaths) {
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (file && file instanceof TFile) {
				await syncFlashcardsForFile(this.plugin, file);
			}
		}

		// Collect all flashcards.
		let allFlashcards: Flashcard[] = [];
		for (const filePath in this.plugin.notes) {
			for (const cardUUID in this.plugin.notes[filePath].cards) {
				const card = this.plugin.notes[filePath].cards[cardUUID];
				allFlashcards.push({
					uuid: cardUUID,
					content: card.cardContent, // note: property "content"
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

		// Decide how to filter based on filterMode.
		let filtered: Flashcard[] = [];

		if (this.filterMode === "note") {
			// "Note" mode => only cards from the active note, ignoring whether they're due or scheduled.
			const activeFile = this.plugin.app.workspace.getActiveFile();
			if (activeFile) {
				filtered = allFlashcards.filter(
					(f) => f.filePath === activeFile.path
				);
			} else {
				filtered = [];
			}
		} else {
			// "Due" or "Scheduled" mode => filter by nextReviewDate relative to `now`.
			const now = new Date();
			filtered = allFlashcards.filter((flashcard) => {
				if (!flashcard.nextReviewDate) return false;
				const reviewDate = new Date(flashcard.nextReviewDate);
				return this.filterMode === "due"
					? reviewDate <= now
					: reviewDate > now;
			});
		}

		// Next, apply the tag filter if not set to "all".
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

		// Apply search filter if there is any text.
		if (this.searchText.trim() !== "") {
			const fuse = new Fuse(filtered, {
				// Notice the keys here: "cardTitle" and "content"
				keys: ["cardTitle", "content"],
				threshold: 0.4,
			});
			const results = fuse.search(this.searchText.trim());
			filtered = results.map((r) => r.item);
		}

		// Sort results for consistency — even in note mode, this keeps them consistent.
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

		// Optionally randomize after sorting, if settings demand it.
		if (this.plugin.settings.randomizeFlashcards) {
			filtered = shuffleArray(filtered);
		}

		// Finally, if there are no cards, let the user know.
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
	// Remove modalHeaderEl since we no longer show a title.
	// modalHeaderEl: HTMLElement | null = null;

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

		// Top section with progress bar and counter.
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
		this.progressCounter.addEventListener("click", () => {
			// Navigate to the current flashcard's location.
			const currentFlashcard = this.flashcards[this.currentIndex];
			if (currentFlashcard.filePath && currentFlashcard.line) {
				const file = this.plugin.app.vault.getAbstractFileByPath(
					currentFlashcard.filePath
				);
				if (file && file instanceof TFile) {
					const options = {
						eState: { line: currentFlashcard.line - 1, ch: 0 },
					};
					this.plugin.app.workspace.getLeaf().openFile(file, options);
					this.close();
				}
			} else {
				new Notice(
					"No location information available for this flashcard."
				);
			}
		});

		// Render the flashcard content.
		const cardContainer = container.createDiv({ cls: "flashcard-card" });
		this.renderCard(cardContainer);

		// Bottom row with navigation buttons and rating tray.
		const bottomRow = container.createDiv({ cls: "flashcard-bottom-row" });
		const leftContainer = bottomRow.createDiv({
			cls: "flashcard-left-container",
		});

		// "Stop" button.
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

		// Rating buttons.
		const ratingTray = bottomRow.createDiv({
			cls: "flashcard-rating-tray",
		});
		const ratings = [
			{ value: 1, color: "#FF4C4C" },
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

		this.updateProgressBar(progressBar);
		setTimeout(() => {
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
		}, 0);
	}

	// Remove renderHeader method since we're no longer showing the title.

	renderCard(cardContainer: HTMLElement) {
		cardContainer.empty();
		if (
			this.flashcards.length > 0 &&
			this.currentIndex < this.flashcards.length
		) {
			const currentFlashcard = this.flashcards[this.currentIndex];
			// Removed note title rendering.
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
	occlusion: OcclusionData = { attachments: {} };

	private allHidden: boolean = true;
	private refreshTimeout: number | null = null;
	globalObserver: MutationObserver;

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

		if (this.globalObserver) {
			this.globalObserver.disconnect();
			console.log("Global mutation observer disconnected.");
		}
	}

	async loadPluginData() {
		const data = (await this.loadData()) as PluginData;
		if (data) {
			this.settings = data.settings || DEFAULT_SETTINGS;
			this.notes = data.notes || {};
			this.occlusion = data.occlusion || { attachments: {} };
		} else {
			this.settings = DEFAULT_SETTINGS;
			this.notes = {};
			this.occlusion = { attachments: {} };
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
			occlusion: this.occlusion,
		};
		await this.saveData(data);
	}

	async saveSettings() {
		await this.savePluginData();
	}

	private initializeUI(): void {
		this.addRibbonIcon("layers", "Review Flashcards", (evt: MouseEvent) => {
			evt.preventDefault();
			this.showAllDueFlashcardsModal();
		}).addClass("flashcard-ribbon-icon");

		this.addRibbonIcon("dot-network", "Open Review Graph View", () => {
			this.activateGraphView();
		});

		this.addRibbonIcon("check-square", "Review Current Note", () => {
			this.openReviewModal();
		});

		this.addRibbonIcon("eye", "Toggle All Hidden Content", () => {
			this.toggleAllHidden();
		});

		this.addRibbonIcon("file-text", "Open Review Queue", () => {
			this.activateUnifiedQueue();
		});

		this.addRibbonIcon("image-file", "Open Occlusion Editor", () => {
			this.activateOcclusionView();
		});

		this.registerMarkdownPostProcessor((el: HTMLElement) => {
			el.innerHTML = el.innerHTML.replace(/\[\/?card(?:=[^\]]+)?\]/g, "");
		});

		this.registerMarkdownPostProcessor((element, context) => {
			processCustomHiddenText(element);
			processMathBlocks(element);
			processCustomHiddenCodeBlocks(element, this);
		});

		this.globalObserver = new MutationObserver((mutations) => {
			// Use setTimeout to process images after the current execution context
			setTimeout(() => {
				mutations.forEach((mutation) => {
					mutation.addedNodes.forEach((node) => {
						if (node.nodeType === Node.ELEMENT_NODE) {
							const element = node as HTMLElement;
							element
								.querySelectorAll(
									"img:not([data-occlusion-processed]):not([data-occlusion-processing])"
								)
								.forEach((img) => {
									this.processImageElement(
										img as HTMLImageElement
									);
								});
						}
					});
				});
			}, 0);
		});

		// Consider adding a filter to improve performance
		this.globalObserver.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: false,
			characterData: false,
		});
	}

	private processImageElement(imgElement: HTMLImageElement): void {
		if (imgElement.getAttribute("data-occlusion-processed")) return;

		// First, mark the image as being processed to avoid duplicate processing
		imgElement.setAttribute("data-occlusion-processing", "true");

		const alt = imgElement.getAttribute("alt");
		if (!alt) {
			imgElement.removeAttribute("data-occlusion-processing");
			return;
		}

		const file = this.app.vault
			.getFiles()
			.find((f) => f.name === alt || f.path.endsWith(alt));
		if (!file) {
			imgElement.removeAttribute("data-occlusion-processing");
			return;
		}

		const key = file.path;

		if (!this.occlusion.attachments[key]) {
			imgElement.removeAttribute("data-occlusion-processing");
			return;
		}

		const waitForImageLoad = () => {
			if (imgElement.complete && imgElement.naturalWidth !== 0) {
				this.replaceImageWithKonva(imgElement, key);
			} else {
				imgElement.onload = () => {
					this.replaceImageWithKonva(imgElement, key);
				};

				imgElement.onerror = () => {
					imgElement.removeAttribute("data-occlusion-processing");
				};
			}
		};

		requestAnimationFrame(waitForImageLoad);
	}

	private replaceImageWithKonva(
		imgElement: HTMLImageElement,
		key: string
	): void {
		imgElement.removeAttribute("data-occlusion-processing");
		imgElement.setAttribute("data-occlusion-processed", "true");

		const container = document.createElement("div");
		container.classList.add("occluded-image-container");
		container.style.position = "relative";
		const displayedWidth = imgElement.width || imgElement.clientWidth;
		const displayedHeight = imgElement.height || imgElement.clientHeight;
		container.style.width = "100%";
		container.style.maxWidth = displayedWidth + "px";

		container.setAttribute("data-file-path", key);

		const newImg = new Image();
		let stage: Konva.Stage;
		let imageLayer: Konva.Layer;
		let shapeLayer: Konva.Layer;
		let originalWidth: number;
		let originalHeight: number;
		let aspectRatio: number;

		// Absolutely minimal button
		const toggleButton = document.createElement("button");
		toggleButton.style.position = "absolute";
		toggleButton.style.bottom = "10px";
		toggleButton.style.right = "10px";
		toggleButton.style.width = "24px";
		toggleButton.style.height = "24px";
		toggleButton.style.borderRadius = "50%";
		toggleButton.style.backgroundColor = "#4A6BF5";
		toggleButton.style.border = "2px solid white";
		toggleButton.style.padding = "0";
		toggleButton.style.margin = "0";
		toggleButton.style.zIndex = "1000";
		toggleButton.style.cursor = "pointer";
		toggleButton.style.touchAction = "manipulation";
		// Add a box shadow to make the button more visible
		toggleButton.style.boxShadow = "0 2px 4px rgba(0,0,0,0.2)";

		// Variable to track if occlusion interaction is enabled
		let occlusionInteractionEnabled = false;

		// Append button to container immediately
		container.appendChild(toggleButton);

		newImg.onload = () => {
			originalWidth = newImg.naturalWidth;
			originalHeight = newImg.naturalHeight;
			aspectRatio = originalHeight / originalWidth;

			// Set explicit height on container based on aspect ratio
			container.style.height = container.clientWidth * aspectRatio + "px";
			// Make sure container has positioning context for absolute positioning
			if (container.style.position !== "relative") {
				container.style.position = "relative";
			}

			setTimeout(() => {
				if (!container.isConnected) {
					console.warn(
						"Container not in DOM when trying to create Konva stage"
					);
					return;
				}

				stage = new Konva.Stage({
					container: container,
					width: displayedWidth,
					height: displayedHeight,
				});

				// Change how touch events are handled
				stage.on("contentTouchstart", function (e) {
					// Only prevent default if occlusion interaction is enabled
					if (occlusionInteractionEnabled && e.target !== stage) {
						e.evt.preventDefault();
					}
				});

				imageLayer = new Konva.Layer();
				shapeLayer = new Konva.Layer();
				stage.add(imageLayer);
				stage.add(shapeLayer);

				const kImage = new Konva.Image({
					image: newImg,
					x: 0,
					y: 0,
					width: displayedWidth,
					height: displayedHeight,
				});
				imageLayer.add(kImage).draw();

				// Double-click/tap to open editor remains the same
				stage.on("dblclick", () => {
					this.openOcclusionEditorWithFile(key);
				});

				stage.on("dbltap", () => {
					this.openOcclusionEditorWithFile(key);
				});

				renderShapes();
				setupContinuousResizeMonitoring();

				// Initially disable interaction with occlusions
				disableShapeInteraction();

				// Toggle button functionality - ultra simple
				// Remove the previous listener and create a new one with better touch handling
				toggleButton.removeEventListener("click", () => {});

				// Add multiple event listeners for better mobile support
				const toggleButtonHandler = (e: MouseEvent | TouchEvent) => {
					e.stopPropagation();
					e.preventDefault();
					occlusionInteractionEnabled = !occlusionInteractionEnabled;

					if (occlusionInteractionEnabled) {
						enableShapeInteraction();
						toggleButton.style.backgroundColor = "#4CAF50";
					} else {
						disableShapeInteraction();
						toggleButton.style.backgroundColor = "#4A6BF5";
					}
				};

				// Add both click and touchend events
				toggleButton.addEventListener("click", toggleButtonHandler);
				toggleButton.addEventListener("touchend", toggleButtonHandler, {
					passive: false,
				});

				// Move the button in front of Konva stage by re-appending it to ensure it's on top
				container.appendChild(toggleButton);
			}, 0);
		};

		const renderShapes = () => {
			shapeLayer.destroyChildren();

			const currentWidth = stage.width();
			const currentHeight = stage.height();

			const scaleX = currentWidth / originalWidth;
			const scaleY = currentHeight / originalHeight;

			const shapes = this.occlusion.attachments[key];
			if (shapes && shapes.length > 0) {
				shapes.forEach((s: OcclusionShape) => {
					const rect = new Konva.Rect({
						x: s.x * scaleX,
						y: s.y * scaleY,
						width: s.width * scaleX,
						height: s.height * scaleY,
						fill: s.fill,
						opacity: s.opacity,
						perfectDrawEnabled: false,
						listening: false,
					});

					// Store visibility handler
					const toggleHandler = function (
						e: Konva.KonvaEventObject<MouseEvent | TouchEvent>
					) {
						if (occlusionInteractionEnabled) {
							rect.visible(!rect.visible());
							shapeLayer.draw();
							e.cancelBubble = true;
						}
					};

					// Store the handler
					rect.setAttr("customData", {
						toggleHandler: toggleHandler,
					});

					shapeLayer.add(rect);
				});
				shapeLayer.draw();
			}
		};

		// Function to enable shape interaction
		const enableShapeInteraction = () => {
			shapeLayer.children.forEach((shape) => {
				if (shape instanceof Konva.Shape) {
					shape.listening(true);
					const customData = shape.getAttr("customData");
					if (customData && customData.toggleHandler) {
						shape.on("click tap", customData.toggleHandler);
					}
				}
			});
			shapeLayer.draw();
		};

		// Function to disable shape interaction
		const disableShapeInteraction = () => {
			shapeLayer.children.forEach((shape) => {
				if (shape instanceof Konva.Shape) {
					shape.listening(false);
					shape.off("click tap");
				}
			});
			shapeLayer.draw();
		};

		const resizeStage = () => {
			if (!container || !stage) return;

			const containerWidth = container.clientWidth;
			const containerHeight = containerWidth * aspectRatio;

			if (
				stage.width() !== containerWidth ||
				stage.height() !== containerHeight
			) {
				stage.width(containerWidth);
				stage.height(containerHeight);

				// Update container height to match stage height
				container.style.height = containerHeight + "px";

				const bgImage = imageLayer.findOne("Image") as Konva.Image;
				if (bgImage) {
					bgImage.width(containerWidth);
					bgImage.height(containerHeight);
					imageLayer.draw();
				}

				renderShapes();

				// Ensure button stays on top by re-appending and explicitly checking position
				container.appendChild(toggleButton);

				// Make sure toggle button is properly positioned
				toggleButton.style.bottom = "10px";
				toggleButton.style.right = "10px";
			}
		};

		const setupContinuousResizeMonitoring = () => {
			const intervalId = window.setInterval(() => {
				if (container && stage) {
					resizeStage();
				}
			}, 100);

			container.setAttribute(
				"data-resize-interval",
				intervalId.toString()
			);

			const resizeObserver = new ResizeObserver(() => {
				resizeStage();
			});
			resizeObserver.observe(container);

			const handleWindowResize = () => {
				resizeStage();
			};
			window.addEventListener("resize", handleWindowResize);

			this.register(() => {
				const storedIntervalId = container.getAttribute(
					"data-resize-interval"
				);
				if (storedIntervalId) {
					window.clearInterval(parseInt(storedIntervalId));
				}

				resizeObserver.disconnect();
				window.removeEventListener("resize", handleWindowResize);
			});
		};

		newImg.src = imgElement.src;

		imgElement.parentElement?.replaceChild(container, imgElement);
	}

	private async openOcclusionEditorWithFile(filePath: string): Promise<void> {
		await this.activateOcclusionView();
		const occlusionLeaf =
			this.app.workspace.getLeavesOfType(VIEW_TYPE_OCCLUSION)[0];
		if (occlusionLeaf && occlusionLeaf.view instanceof OcclusionView) {
			const occlusionView = occlusionLeaf.view as OcclusionView;
			occlusionView.setSelectedFile(filePath);
		}
	}

	private registerCommands(): void {
		this.addCommand({
			id: "open-graph-view",
			name: "Open Graph View",
			callback: () => this.activateGraphView(),
		});

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
			id: "resync-cards-current-note",
			name: "Resync Flashcards in Current Note",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile || !(activeFile instanceof TFile)) {
					new Notice("No active note open to sync flashcards.");
					return;
				}
				await syncFlashcardsForFile(this, activeFile);
				new Notice("Flashcards resynced for the current note.");
				this.refreshUnifiedQueue();
			},
		});

		this.addCommand({
			id: "sync-all-cards-in-vault",
			name: "Synchronize All Cards in Vault",
			callback: async () => {
				const markdownFiles = this.app.vault.getMarkdownFiles();
				for (const file of markdownFiles) {
					await syncFlashcardsForFile(this, file);
				}
				await this.savePluginData();
				new Notice("Synchronized all cards across the vault.");
				this.refreshUnifiedQueue();
			},
		});

		this.addCommand({
			id: "reset-card-under-cursor",
			name: "Reset Card Under Cursor",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const content = editor.getValue();
				const cursor = editor.getCursor();
				const lines = content.split("\n");
				let offset = 0;
				for (let i = 0; i < cursor.line; i++) {
					offset += lines[i].length + 1;
				}
				offset += cursor.ch;

				const regex = /\[card=([A-Za-z0-9]+)\]([\s\S]*?)\[\/card\]/g;
				let match: RegExpExecArray | null;
				let found = false;
				let cardUUID = "";
				while ((match = regex.exec(content)) !== null) {
					const start = match.index;
					const end = regex.lastIndex;
					if (offset >= start && offset <= end) {
						cardUUID = match[1];
						found = true;
						break;
					}
				}

				if (!found) {
					new Notice(
						"Cursor is not inside a [card]...[/card] block."
					);
					return;
				}

				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice("No active file open.");
					return;
				}
				if (
					!(activeFile.path in this.notes) ||
					!(cardUUID in this.notes[activeFile.path].cards)
				) {
					new Notice("Card not found in plugin data.");
					return;
				}

				const now = new Date();
				const newCardState: CardState = {
					cardUUID: cardUUID,
					cardContent:
						this.notes[activeFile.path].cards[cardUUID].cardContent,
					cardTitle:
						this.notes[activeFile.path].cards[cardUUID].cardTitle,
					line: this.notes[activeFile.path].cards[cardUUID].line,
					repetition: 0,
					interval: 0,
					ef: 2.5,
					lastReviewDate: now.toISOString(),
					createdAt: now.toISOString(),
					nextReviewDate: addMinutes(
						now,
						LEARNING_STEPS[0]
					).toISOString(),
					active: true,
					efHistory: [],
				};

				this.notes[activeFile.path].cards[cardUUID] = newCardState;
				this.savePluginData();
				new Notice("Card reset successfully.");
				this.refreshUnifiedQueue();
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
			id: "wrap-in-multiline-hide",
			name: "Wrap in multiline hide [hide][/hide]",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const selection = editor.getSelection();
				if (!selection || selection.trim().length === 0) {
					new Notice("Please select some text to hide.");
					return;
				}
				editor.replaceSelection("```hide\n" + selection + "\n```");
				new Notice("Text wrapped in multiline hide block.");
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

		this.addCommand({
			id: "open-occlusion-editor",
			name: "Open Occlusion Editor",
			callback: () => this.activateOcclusionView(),
		});
	}

	private registerEvents(): void {
		this.registerEvent(
			this.app.workspace.on("file-open", async (file: TFile) => {
				if (file && file instanceof TFile) {
					await syncFlashcardsForFile(this, file);
					this.refreshUnifiedQueue();
				}
			})
		);

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
		this.registerView(VIEW_TYPE_GRAPH, (leaf) => new GraphView(leaf, this));

		// Register the Occlusion View
		this.registerView(
			VIEW_TYPE_OCCLUSION,
			(leaf) => new OcclusionView(leaf, this)
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
		// Get the full content of the document.
		const content = editor.getValue();
		const cursor = editor.getCursor();
		// Compute the cursor's offset (i.e. its character index) in the entire content.
		const lines = content.split("\n");
		let offset = 0;
		for (let i = 0; i < cursor.line; i++) {
			offset += lines[i].length + 1; // +1 for the newline
		}
		offset += cursor.ch;

		// Regex to match a card block that uses the [card=UUID] syntax.
		// It captures everything between the opening and closing tags.
		const regex = /\[card=[A-Za-z0-9]+\]([\s\S]*?)\[\/card\]/g;
		let match: RegExpExecArray | null;
		let found = false;
		let newContent = content;
		let wrapperStartOffset = 0;
		// Loop over all card blocks.
		while ((match = regex.exec(content)) !== null) {
			const start = match.index;
			const end = regex.lastIndex;
			// If the cursor offset is within this match...
			if (offset >= start && offset <= end) {
				// Remember where the opening wrapper starts.
				wrapperStartOffset = start;
				// Remove the wrappers and keep only the inner content.
				const inner = match[1];
				newContent =
					newContent.substring(0, start) +
					inner +
					newContent.substring(end);
				found = true;
				break;
			}
		}

		if (found) {
			editor.setValue(newContent);
			const prefix = newContent.substring(0, wrapperStartOffset);
			const prefixLines = prefix.split("\n");
			const newLine = prefixLines.length - 1;
			const newCh = prefixLines[prefixLines.length - 1].length;
			editor.setCursor({ line: newLine, ch: newCh });
			new Notice("Removed [card][/card] wrappers.");
		} else {
			new Notice("Cursor is not inside a [card]...[/card] block.");
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
			if (aDate !== bDate) return aDate - bDate;
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

	async activateGraphView() {
		const newLeaf = this.app.workspace.getLeaf(true);
		await newLeaf.setViewState({
			type: VIEW_TYPE_GRAPH,
			active: true,
		});
		this.app.workspace.revealLeaf(newLeaf);
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

	public refreshGraphView(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GRAPH);
		leaves.forEach((leaf) => {
			if (leaf.view instanceof GraphView) {
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

	async activateOcclusionView() {
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_OCCLUSION)[0];
		if (!leaf) {
			leaf =
				this.app.workspace.getRightLeaf(false) ||
				this.app.workspace.getLeaf(true);
			await leaf.setViewState({
				type: VIEW_TYPE_OCCLUSION,
				active: true,
			});
		}
		this.app.workspace.revealLeaf(leaf);
	}
}

/* ============================================================================
 * POST-PROCESSORS
 * ========================================================================== */

/**
 * Processes inline [hide]…[/hide] markers.
 */
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
 * Processes math blocks to wrap multiple inline math elements.
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

/**
 * Processes multi-line hide blocks written as code fences.
 * This function finds <pre><code> elements whose class name starts with
 * "language-hide" (which covers both "hide" and "hide=2" variants),
 * renders the markdown (including math) inside, and replaces the code block
 * with a div that has the appropriate classes for show/hide functionality.
 */
function processCustomHiddenCodeBlocks(
	rootEl: HTMLElement,
	plugin: MyPlugin
): void {
	const codeBlocks = rootEl.querySelectorAll(
		"pre code[class^='language-hide']"
	);
	codeBlocks.forEach((codeBlock) => {
		let group: string | null = null;
		codeBlock.classList.forEach((cls) => {
			const match = cls.match(/^language-hide=(\d+)$/);
			if (match) {
				group = match[1];
			}
		});
		const source = codeBlock.textContent || "";
		const container = document.createElement("div");
		container.classList.add("hidden-note");
		if (group) {
			container.classList.add("group-hide");
			container.setAttribute("data-group", group);
		}
		container.classList.add("toggle-hidden");

		MarkdownRenderer.render(this.app, source, container, "", plugin);

		container.addEventListener("click", function () {
			if (container.classList.contains("group-hide")) {
				const grp = container.getAttribute("data-group");
				if (grp) {
					const groupElements = document.querySelectorAll(
						`.group-hide[data-group="${grp}"]`
					);
					const isHidden =
						groupElements[0].classList.contains("toggle-hidden");
					groupElements.forEach((elem) => {
						if (isHidden) {
							elem.classList.remove("toggle-hidden");
						} else {
							elem.classList.add("toggle-hidden");
						}
					});
				}
			} else {
				container.classList.toggle("toggle-hidden");
			}
		});

		const pre = codeBlock.parentElement;
		if (pre && pre.parentElement) {
			pre.parentElement.replaceChild(container, pre);
		}
	});
}
