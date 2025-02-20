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

/**
 * Plugin Settings
 */
interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
};

/**
 * Main Plugin Class
 */
export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// Ribbon icon example (just a placeholder)
		const ribbonIconEl = this.addRibbonIcon("dice", "Sample Plugin", () => {
			new Notice("Looks a!");
		});
		ribbonIconEl.addClass("my-plugin-ribbon-class");

		// Status bar example (just a placeholder)
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText("Status Bar Text");

		// Simple command
		this.addCommand({
			id: "open-sample-modal-simple",
			name: "Open sample modal (simple)",
			callback: () => {
				new SampleModal(this.app).open();
			},
		});

		// Editor command
		this.addCommand({
			id: "sample-editor-command",
			name: "Sample editor command",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection("Sample Editor Command");
			},
		});

		// Complex command
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
			},
		});

		// Adds a settings tab
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// Register a global DOM event (example)
		this.registerDomEvent(document, "click", (evt: MouseEvent) => {
			console.log("click", evt);
		});

		// Register an interval (example)
		this.registerInterval(
			window.setInterval(() => console.log("setInterval"), 5 * 60 * 1000)
		);

		// --- Toggle Hidden Content Markdown Post-Processor ---
		// (1) For all text outside KaTeX, hide :-...-: as clickable spans
		// (2) For all math blocks, only wrap in toggler if preceded by :- and followed by -:
		this.registerMarkdownPostProcessor((element, context) => {
			// 1) Hide :-...-: in normal text
			hideCustomDelimitersText(element);

			// 2) Wrap math with toggler if user typed :- around it
			const mathEls = element.querySelectorAll(".math");
			mathEls.forEach((mathEl) => wrapMathElement(mathEl));
		});
	}

	onunload() {
		// Any cleanup if needed
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/**
 * Simple Modal Example
 */
class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText("Woah!");
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Settings Tab Example
 */
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
			.setDesc("It's a secret")
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

/**
 * We walk the DOM text nodes (excluding KaTeX sections) and replace
 * `:-...-:` with clickable "[hidden]" spans for NON-math content.
 * This avoids conflicts with LaTeX braces.
 */
function hideCustomDelimitersText(rootEl: HTMLElement) {
	const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			// Skip if this text node is inside a math container
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

	// Regex to match :-...-: (non-greedy)
	const delimiterRegex = /:-(.*?)-:/g;

	for (const textNode of textNodes) {
		const nodeText = textNode.nodeValue;
		if (!nodeText) continue;

		let match;
		let lastIndex = 0;
		const fragments: (string | Node)[] = [];

		// Find all :-...-: matches
		while ((match = delimiterRegex.exec(nodeText)) !== null) {
			const startIndex = match.index;
			const endIndex = startIndex + match[0].length;
			const contentInside = match[1]; // text between :- and -:

			// Push any text before the match
			if (startIndex > lastIndex) {
				fragments.push(nodeText.slice(lastIndex, startIndex));
			}

			// Create the hidden text span
			const span = createHiddenTextSpan(contentInside);
			fragments.push(span);

			lastIndex = endIndex;
		}

		// If we had matches or leftover text after the last match,
		// replace the original text node with new fragments
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
 * Check if an element (or its ancestors) is part of a KaTeX (.math) container
 */
function isInsideMath(el: HTMLElement | null): boolean {
	if (!el) return false;
	if (
		el.classList &&
		(el.classList.contains("math") ||
			el.classList.contains("toggle-hidden-math-wrapper"))
	) {
		return true;
	}
	return isInsideMath(el.parentElement);
}

/**
 * Create a span that hides the original content, showing "[hidden]" initially.
 */
function createHiddenTextSpan(originalContent: string): HTMLSpanElement {
	const span = document.createElement("span");
	span.className = "toggle-hidden-text";
	span.setAttribute("data-original", originalContent);
	span.setAttribute("data-hidden", "true");
	span.style.cursor = "pointer";
	span.style.color = "gray";
	span.style.textDecoration = "underline";

	// Initial placeholder
	span.textContent = "[hidden]";

	// On click, toggle between hidden and revealed
	span.addEventListener("click", () => {
		const isHidden = span.getAttribute("data-hidden") === "true";
		if (isHidden) {
			// Reveal
			span.innerHTML = `<span class="bracket" style="color: gray;">[</span>
				<span class="revealed-text">${originalContent}</span>
				<span class="bracket" style="color: gray;">]</span>`;
			span.setAttribute("data-hidden", "false");
			span.style.textDecoration = "";
			span.style.color = "";
		} else {
			// Hide again
			span.textContent = "[hidden]";
			span.setAttribute("data-hidden", "true");
			span.style.color = "gray";
		}
	});

	return span;
}

/**
 * Wrap an inline or display math element IF it is preceded by ":-"
 * and followed by "-:" in the text. That means the user typed:
 *
 *    :-$ x^2 $-:
 *
 * We'll remove those delimiters and wrap the math in a "[hidden]" toggler.
 */
function wrapMathElement(mathEl: Element) {
	// If it's already wrapped, skip
	const parent = mathEl.parentElement;
	if (!parent || parent.classList.contains("toggle-hidden-math-wrapper")) {
		return;
	}

	// Check if there's leftover ":-" in the previous text node
	// and leftover "-:" in the next text node
	let foundDelimiters = false;

	// Check previous sibling's text for trailing ':-'
	const prevTextSibling = mathEl.previousSibling;
	if (prevTextSibling && prevTextSibling.nodeType === Node.TEXT_NODE) {
		const txt = prevTextSibling.nodeValue ?? "";
		// Does it end with ':-'?
		const match = txt.match(/(.*):-\s*$/);
		if (match) {
			prevTextSibling.nodeValue = match[1]; // remove ':-'
			foundDelimiters = true;
		}
	}

	// Check next sibling's text for leading '-:'
	const nextTextSibling = mathEl.nextSibling;
	if (nextTextSibling && nextTextSibling.nodeType === Node.TEXT_NODE) {
		const txt = nextTextSibling.nodeValue ?? "";
		// Does it start with '-:'?
		const match = txt.match(/^\s*-:(.*)/);
		if (match) {
			nextTextSibling.nodeValue = match[1]; // remove '-:'
			foundDelimiters = true;
		}
	}

	// If we didn't find the ":-" and "-:" pair around this math, skip
	if (!foundDelimiters) {
		return;
	}

	// Otherwise, wrap the math in a toggler
	const isDisplay = mathEl.classList.contains("math-display");
	const wrapperTag = isDisplay ? "div" : "span";

	const wrapper = document.createElement(wrapperTag);
	wrapper.className = "toggle-hidden-math-wrapper";
	wrapper.setAttribute("data-hidden", "true");
	wrapper.style.cursor = "pointer";

	parent.insertBefore(wrapper, mathEl);

	// CREATE PLACEHOLDER: "[hidden]"
	const placeholder = document.createElement(wrapperTag);
	placeholder.className = "toggle-hidden-math-placeholder";
	placeholder.style.cursor = "pointer";
	placeholder.innerHTML = `<span style="color: gray;">[hidden]</span>`;

	// CREATE REVEALED CONTAINER with brackets
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

	// Hide revealed math by default
	revealedContainer.style.display = "none";

	wrapper.appendChild(placeholder);
	wrapper.appendChild(revealedContainer);

	// Toggle on click
	wrapper.addEventListener("click", () => {
		const isHidden = wrapper.getAttribute("data-hidden") === "true";
		if (isHidden) {
			// Reveal the math
			placeholder.style.display = "none";
			revealedContainer.style.display = "";
			wrapper.setAttribute("data-hidden", "false");
		} else {
			// Hide the math
			placeholder.style.display = "";
			revealedContainer.style.display = "none";
			wrapper.setAttribute("data-hidden", "true");
		}
	});
}
