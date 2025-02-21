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
 * PLUGIN DATA INTERFACES
 * ========================================================================== */

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
};

interface PluginData {
	settings: MyPluginSettings;
	visits: { [filePath: string]: string[] };
}

/* ============================================================================
 * MAIN PLUGIN CLASS
 * ========================================================================== */

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	visitLog: { [filePath: string]: string[] } = {};

	/** Called by Obsidian when the plugin is first loaded. */
	async onload() {
		// Load settings and visit data from disk.
		await this.loadPluginData();

		// Initialize UI Elements.
		this.addPluginRibbonIcon();
		this.addStatusBar();

		// Register plugin commands.
		this.registerCommands();

		// Add a settings tab in Obsidian.
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// Register any DOM events.
		this.registerDomEvent(document, "click", (evt: MouseEvent) => {
			console.log("Global click event:", evt);
		});

		// Register any repeating intervals.
		this.registerInterval(
			window.setInterval(
				() => console.log("Interval ping"),
				5 * 60 * 1000
			)
		);

		// Register a Markdown Post Processor to handle custom hidden text and math.
		this.registerMarkdownPostProcessor((element, context) => {
			processCustomHiddenText(element);
			processHiddenMathBlocks(element);
		});

		// Listen for when the active leaf changes (i.e. a note is opened).
		this.registerEvent(
			this.app.workspace.on(
				"active-leaf-change",
				(leaf: WorkspaceLeaf | null) => {
					if (!leaf) return;
					// Ensure the view is a MarkdownView before accessing the file property.
					const markdownView =
						leaf.view instanceof MarkdownView ? leaf.view : null;
					if (markdownView && markdownView.file) {
						this.logVisit(markdownView.file);
					}
				}
			)
		);

		// Listen for file renames to update the visit log.
		this.registerEvent(
			this.app.vault.on("rename", (file: TFile, oldPath: string) => {
				if (this.visitLog[oldPath]) {
					this.visitLog[file.path] = this.visitLog[oldPath];
					delete this.visitLog[oldPath];
					this.savePluginData();
					console.log(
						`Updated visit log from ${oldPath} to ${file.path}`
					);
				}
			})
		);
	}

	/** Called by Obsidian when the plugin is unloaded (optional cleanup). */
	onunload() {
		console.log("Unloading MyPlugin");
	}

	/** Loads settings and visit data from disk. */
	async loadPluginData() {
		const data = (await this.loadData()) as PluginData;
		if (data) {
			this.settings = data.settings || DEFAULT_SETTINGS;
			this.visitLog = data.visits || {};
		} else {
			this.settings = DEFAULT_SETTINGS;
			this.visitLog = {};
		}
	}

	/** Persists settings and visit data to disk. */
	async savePluginData() {
		await this.saveData({
			settings: this.settings,
			visits: this.visitLog,
		} as PluginData);
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
}

/* ============================================================================
 * SAMPLE MODAL EXAMPLE
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

/* ============================================================================
 * SETTINGS TAB EXAMPLE
 * ========================================================================== */

/** Sample settings tab for the plugin, accessible in the Obsidian settings. */
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
 * MARKDOWN POST-PROCESSORS FOR HIDDEN CONTENT
 * ========================================================================== */

/**
 * Replaces any text matching the pattern :-(...)-: with a "[hidden]" toggler
 * in normal text (i.e., not inside a .math container).
 */
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

/**
 * Checks if the given element or any of its ancestors is part of a KaTeX container.
 */
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

/**
 * Creates a <span> element that hides the original content behind a "[hidden]" placeholder.
 */
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

/**
 * Processes `.math` elements within the rendered Markdown, looking for :- and -:
 * around those math elements.
 */
function processHiddenMathBlocks(rootEl: HTMLElement): void {
	const mathEls = rootEl.querySelectorAll(".math");
	mathEls.forEach((mathEl) => wrapMathElement(mathEl));
}

/**
 * Wraps an inline or display math element if it is preceded by ":-" and followed by "-:".
 */
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
