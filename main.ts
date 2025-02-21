import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";

/* ============================================================================
 * PLUGIN SETTINGS
 * ========================================================================== */

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
};

/* ============================================================================
 * MAIN PLUGIN CLASS
 * ========================================================================== */

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	/** Called by Obsidian when the plugin is first loaded. */
	async onload() {
		// Load settings
		await this.loadSettings();

		// Initialize UI Elements
		this.addPluginRibbonIcon();
		this.addStatusBar();

		// Register plugin commands
		this.registerCommands();

		// Add a settings tab in Obsidian
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// Register any DOM events
		this.registerDomEvent(document, "click", (evt: MouseEvent) => {
			console.log("Global click event:", evt);
		});

		// Register any repeating intervals
		this.registerInterval(
			window.setInterval(
				() => console.log("Interval ping"),
				5 * 60 * 1000
			)
		);

		// Register a Markdown Post Processor to handle custom hidden text and math
		this.registerMarkdownPostProcessor((element, context) => {
			processCustomHiddenText(element);
			processHiddenMathBlocks(element);
		});
	}

	/** Called by Obsidian when the plugin is unloaded (optional cleanup). */
	onunload() {
		// Cleanup logic if needed
	}

	/** Loads settings from disk, falling back to defaults if unavailable. */
	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	/** Persists current settings to disk. */
	async saveSettings() {
		await this.saveData(this.settings);
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
				// Skip if this text node is inside a math container
				return NodeFilter.FILTER_REJECT;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	});

	const textNodes: Text[] = [];
	while (walker.nextNode()) {
		textNodes.push(walker.currentNode as Text);
	}

	const delimiterRegex = /:-(.*?)-:/g; // Non-greedy match for :-...-:

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

			// Push any plain text before this match
			if (startIndex > lastIndex) {
				fragments.push(nodeText.slice(lastIndex, startIndex));
			}

			// Create a span that toggles hidden content
			fragments.push(createHiddenTextSpan(hiddenContent));
			lastIndex = endIndex;
		}

		// If we found matches, or if there's leftover text after the last match
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
 * We don't want to insert hidden-text toggles inside `.math` blocks.
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
 * Clicking the span toggles between the hidden and revealed states.
 */
function createHiddenTextSpan(originalContent: string): HTMLSpanElement {
	const span = document.createElement("span");
	span.className = "toggle-hidden-text";
	span.setAttribute("data-original", originalContent);
	span.setAttribute("data-hidden", "true");

	// Basic inline styles (could also be done in a CSS file)
	span.style.cursor = "pointer";
	span.style.color = "gray";
	span.style.textDecoration = "underline";
	span.textContent = "[hidden]";

	span.addEventListener("click", () => {
		const isHidden = span.getAttribute("data-hidden") === "true";
		if (isHidden) {
			// Reveal
			span.innerHTML = `
				<span class="bracket" style="color: gray;">[</span>
				<span class="revealed-text">${originalContent}</span>
				<span class="bracket" style="color: gray;">]</span>`;
			span.setAttribute("data-hidden", "false");
			span.style.color = "";
			span.style.textDecoration = "";
		} else {
			// Hide again
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
 * around those math elements, which signals that the user wants the math hidden behind toggles.
 */
function processHiddenMathBlocks(rootEl: HTMLElement): void {
	const mathEls = rootEl.querySelectorAll(".math");
	mathEls.forEach((mathEl) => wrapMathElement(mathEl));
}

/**
 * Wraps an inline or display math element IF it is preceded by ":-" and followed by "-:" in the text.
 * Example usage in user Markdown: `:-$ x^2 $-:`
 */
function wrapMathElement(mathEl: Element): void {
	const parent = mathEl.parentElement;
	if (!parent || parent.classList.contains("toggle-hidden-math-wrapper")) {
		// Already wrapped or no valid parent
		return;
	}

	let foundDelimiters = false;

	// Check previous sibling for trailing ":-"
	const prevSibling = mathEl.previousSibling;
	if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE) {
		const textContent = prevSibling.nodeValue ?? "";
		const match = textContent.match(/(.*):-\s*$/);
		if (match) {
			prevSibling.nodeValue = match[1]; // Remove ":-"
			foundDelimiters = true;
		}
	}

	// Check next sibling for leading "-:"
	const nextSibling = mathEl.nextSibling;
	if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
		const textContent = nextSibling.nodeValue ?? "";
		const match = textContent.match(/^\s*-:(.*)/);
		if (match) {
			nextSibling.nodeValue = match[1]; // Remove "-:"
			foundDelimiters = true;
		}
	}

	// If we didn't find the delimiters around this math element, skip
	if (!foundDelimiters) {
		return;
	}

	// Create a wrapper that will contain both the hidden placeholder and the revealed math
	const isDisplayMath = mathEl.classList.contains("math-display");
	const wrapperTag = isDisplayMath ? "div" : "span";

	const wrapper = document.createElement(wrapperTag);
	wrapper.className = "toggle-hidden-math-wrapper";
	wrapper.setAttribute("data-hidden", "true");
	wrapper.style.cursor = "pointer";

	// Insert the wrapper before the math element
	parent.insertBefore(wrapper, mathEl);

	// Placeholder shown when math is hidden
	const placeholder = document.createElement(wrapperTag);
	placeholder.className = "toggle-hidden-math-placeholder";
	placeholder.style.cursor = "pointer";
	placeholder.style.textAlign = "center";
	placeholder.innerHTML = `<span style="color: gray;">[hidden]</span>`;

	// Set display based on math element class
	if (mathEl.classList.contains("math-inline")) {
		placeholder.style.display = "inline";
	} else if (mathEl.classList.contains("math-block")) {
		placeholder.style.display = "block";
	}

	// A container for the revealed math
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
	revealedContainer.appendChild(mathEl); // move the math element here
	revealedContainer.appendChild(rightBracket);

	// Default to hidden
	revealedContainer.style.display = "none";

	wrapper.appendChild(placeholder);
	wrapper.appendChild(revealedContainer);

	// Toggle hidden/display on click
	wrapper.addEventListener("click", () => {
		const currentlyHidden = wrapper.getAttribute("data-hidden") === "true";
		if (currentlyHidden) {
			// Reveal
			placeholder.style.display = "none";
			revealedContainer.style.display = "inline";
			wrapper.setAttribute("data-hidden", "false");
		} else {
			// Hide
			placeholder.style.display = mathEl.classList.contains("math-inline")
				? "inline"
				: "block";
			revealedContainer.style.display = "none";
			wrapper.setAttribute("data-hidden", "true");
		}
	});
}
