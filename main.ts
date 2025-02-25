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
	hiddenColor: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
	hiddenColor: "#00ffbf",
};

/**
 * The plugin stores:
 * 1) settings
 * 2) visits
 * 3) spacedRepetitionLog
 */
interface PluginData {
	settings: MyPluginSettings;
	visits: { [filePath: string]: string[] };
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

		// New: Background Color Setting for Hidden Text
		new Setting(containerEl)
			.setName("Hidden Text Background Color")
			.setDesc("Set the background color for hidden text")
			.addText((text) =>
				text
					.setPlaceholder("Color")
					.setValue(this.plugin.settings.hiddenColor)
					.onChange(async (value) => {
						this.plugin.settings.hiddenColor = value;
						// Update the CSS variable so the change takes effect immediately.
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
 * REVIEW SIDEBAR VIEW (Unchanged)
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

		// First collect all due notes
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

		// Then verify which files actually exist
		for (const filePath of reviewNotes) {
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (file && file instanceof TFile) {
				validFiles.push(filePath);
			}
		}

		// Add some top margin before the header
		const spacer = container.createEl("div", { cls: "header-spacer" });
		spacer.setAttr("style", "height: 12px;");

		const header = container.createEl("div", { cls: "review-header" });
		header.createEl("h2", { text: "Review Queue" });

		if (validFiles.length === 0) {
			const emptyState = container.createEl("div", {
				cls: "review-empty",
			});
			const iconDiv = emptyState.createEl("div", {
				cls: "review-empty-icon",
			});
			iconDiv.innerHTML = "📚"; // Could replace with an SVG icon
			emptyState.createEl("h3", { text: "You're all caught up!" });
			emptyState.createEl("p", {
				text: "There are no notes due for review right now.",
			});
			return;
		}

		header.createEl("div", {
			cls: "review-count",
			text: `${validFiles.length} note${
				validFiles.length === 1 ? "" : "s"
			} to review`,
		});

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

			// Make entire card clickable to open the file
			card.addEventListener("click", () => {
				this.plugin.app.workspace.getLeaf().openFile(file);
			});

			// Create a title row that contains both the title and tag
			const titleRow = card.createEl("div", { cls: "title-row" });

			titleRow.createEl("h3", {
				text: file.basename,
				title: file.basename,
			});

			// Add tag right next to the title if it exists
			if (firstTag) {
				const tagEl = titleRow.createEl("div", { cls: "review-tag" });
				tagEl.createEl("span", { text: `#${firstTag}` });
			}

			// Calculate days since last review
			const lastReviewDate = new Date(noteState.lastReviewDate);
			const daysSinceReview = Math.floor(
				(now.getTime() - lastReviewDate.getTime()) /
					(1000 * 60 * 60 * 24)
			);

			const metaContainer = card.createEl("div", {
				cls: "review-card-meta",
			});

			// Show interval visually
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

			// Show EF with color coding
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
 * MAIN PLUGIN CLASS
 * ========================================================================== */

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	visitLog: { [filePath: string]: string[] } = {};
	spacedRepetitionLog: { [filePath: string]: NoteState } = {};

	private allHidden: boolean = true;

	async onload() {
		await this.loadPluginData();

		// Update the CSS variable on load.
		document.documentElement.style.setProperty(
			"--hidden-color",
			this.settings.hiddenColor
		);

		this.addPluginRibbonIcon();
		this.addStatusBar();
		this.registerCommands();
		this.addSettingTab(new MyPluginSettingTab(this.app, this));

		this.addRibbonIcon("eye", "Toggle All Hidden Content", () => {
			this.toggleAllHidden();
		});

		// this.registerInterval(
		// 	window.setInterval(
		// 		() => console.log("Interval ping"),
		// 		5 * 60 * 1000
		// 	)
		// );

		// Register our markdown post-processor which now handles both
		// plain [hide]...[/hide] and group-based [hide=groupId]...[/hide]
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

		// Register file rename event
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

				// Refresh the review queue view if it's open:
				const reviewLeaves =
					this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
				reviewLeaves.forEach((leaf) => {
					// Ensure the view is an instance of ReviewSidebarView
					if (leaf.view instanceof ReviewSidebarView) {
						leaf.view.onOpen();
					}
				});
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

		this.addCommand({
			id: "wrap-selected-text-with-hide",
			name: "Wrap Selected Text in [hide][/hide]",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const selection = editor.getSelection();
				if (!selection) {
					new Notice("Please select some text to hide.");
					return;
				}
				// Here, you can choose to wrap in plain hide tags or with a group id.
				// For example, plain:
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
}

/* ============================================================================
 * CUSTOM MODALS
 * ============================================================================ */

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
			const intervalDisplay = this.currentState.nextReviewDate
				? formatInterval(
						this.currentState.lastReviewDate,
						this.currentState.nextReviewDate
				  )
				: "Not set";
			statsContainer.innerHTML = `<strong>Current Statistics:</strong>
      <br/>Repetitions: ${this.currentState.repetition}
      <br/>Interval: ${intervalDisplay}
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
 * Process hidden text in markdown.
 *
 * This function supports two syntaxes:
 * 1. Plain hide: [hide]content[/hide] – toggles individually.
 * 2. Group hide: [hide=groupId]content[/hide] – toggles all elements sharing the same group id.
 */
function processCustomHiddenText(rootEl: HTMLElement): void {
	const elements = rootEl.querySelectorAll("*");
	elements.forEach((element) => {
		let html = element.innerHTML;
		// Only process if there is a hide tag present.
		if (html.includes("[hide") && html.includes("[/hide]")) {
			// First process group hide blocks: [hide=groupId]...[/hide]
			html = html.replace(
				/\[hide=(\d+)\]([\s\S]*?)\[\/hide\]/g,
				(match, groupId, content) => {
					return `<span class="hidden-note group-hide toggle-hidden" data-group="${groupId}">${content}</span>`;
				}
			);
			// Then process plain hide blocks: [hide]...[/hide]
			html = html.replace(
				/\[hide\]([\s\S]*?)\[\/hide\]/g,
				(match, content) => {
					return `<span class="hidden-note toggle-hidden">${content}</span>`;
				}
			);
			element.innerHTML = html;

			// Add click event listener for group hide elements.
			element.querySelectorAll(".group-hide").forEach((el) => {
				el.addEventListener("click", function () {
					const group = this.getAttribute("data-group");
					if (!group) {
						this.classList.toggle("toggle-hidden");
					} else {
						// Get the current state of the first group member
						const groupElements = document.querySelectorAll(
							`.group-hide[data-group="${group}"]`
						);
						const isHidden =
							groupElements[0].classList.contains(
								"toggle-hidden"
							);
						// Apply the same state to all elements in the group
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

			// Add individual toggle for plain hide elements.
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

function processHiddenMathBlocks(rootEl: HTMLElement): void {
	const mathEls = rootEl.querySelectorAll(".math");
	mathEls.forEach((mathEl) => wrapMathElement(mathEl));
}

function wrapMathElement(mathEl: Element): void {
	const parent = mathEl.parentElement;
	if (!parent) return;
	let foundDelimiters = false;

	const prevSibling = mathEl.previousSibling;
	if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE) {
		const textContent = prevSibling.nodeValue ?? "";
		const match = textContent.match(/(.*)\[hide\]\s*$/);
		if (match) {
			prevSibling.nodeValue = match[1];
			foundDelimiters = true;
		}
	}

	const nextSibling = mathEl.nextSibling;
	if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
		const textContent = nextSibling.nodeValue ?? "";
		const match = textContent.match(/^\s*\[\/hide\](.*)/);
		if (match) {
			nextSibling.nodeValue = match[1];
			foundDelimiters = true;
		}
	}

	if (!foundDelimiters) return;
	(mathEl as HTMLElement).classList.add("hidden-note", "toggle-hidden");
	mathEl.addEventListener("click", () => {
		(mathEl as HTMLElement).classList.toggle("toggle-hidden");
	});
}
