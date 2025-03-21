import {
	Plugin,
	Notice,
	TFile,
	WorkspaceLeaf,
	ItemView,
	MarkdownView,
} from "obsidian";
import Konva from "konva";
import MyPlugin from "./main"; // Import the main plugin class
import { OcclusionShape } from "./main"; // Import the interfaces from main.ts
import Fuse from "fuse.js"; // Import Fuse.js for fuzzy search

export const VIEW_TYPE_OCCLUSION = "occlusion-view";

// Command interface for undo/redo operations
interface Command {
	execute(): void;
	undo(): void;
}

// History stack to manage commands
class CommandHistory {
	private undoStack: Command[] = [];
	private redoStack: Command[] = [];

	execute(command: Command): void {
		command.execute();
		this.undoStack.push(command);
		// Clear redo stack when a new command is executed
		this.redoStack = [];
	}

	undo(): void {
		if (this.undoStack.length === 0) return;

		const command = this.undoStack.pop()!;
		command.undo();
		this.redoStack.push(command);
	}

	redo(): void {
		if (this.redoStack.length === 0) return;

		const command = this.redoStack.pop()!;
		command.execute();
		this.undoStack.push(command);
	}

	clear(): void {
		this.undoStack = [];
		this.redoStack = [];
	}
}

// Command for adding rectangles
class AddRectCommand implements Command {
	private rect: Konva.Rect;
	private layer: Konva.Layer;

	constructor(rect: Konva.Rect, layer: Konva.Layer) {
		this.rect = rect;
		this.layer = layer;
	}

	execute(): void {
		this.layer.add(this.rect);
		this.layer.draw();
	}

	undo(): void {
		this.rect.remove();
		this.layer.draw();
	}
}

// Command for deleting rectangles
class DeleteRectsCommand implements Command {
	private rects: Konva.Rect[];
	private layer: Konva.Layer;

	constructor(rects: Konva.Rect[], layer: Konva.Layer) {
		this.rects = [...rects]; // Create a copy of the array
		this.layer = layer;
	}

	execute(): void {
		this.rects.forEach((rect) => rect.remove());
		this.layer.draw();
	}

	undo(): void {
		this.rects.forEach((rect) => this.layer.add(rect));
		this.layer.draw();
	}
}

// Command for moving rectangles
class MoveRectsCommand implements Command {
	private rects: Konva.Rect[];
	private oldPositions: { x: number; y: number }[];
	private newPositions: { x: number; y: number }[];
	private layer: Konva.Layer;

	constructor(rects: Konva.Rect[], layer: Konva.Layer) {
		this.rects = [...rects];
		this.layer = layer;

		// Store initial positions
		this.oldPositions = rects.map((rect) => ({
			x: rect.x(),
			y: rect.y(),
		}));

		// New positions will be set later when the move is complete
		this.newPositions = [];
	}

	setNewPositions(): void {
		this.newPositions = this.rects.map((rect) => ({
			x: rect.x(),
			y: rect.y(),
		}));
	}

	execute(): void {
		this.rects.forEach((rect, i) => {
			if (this.newPositions[i]) {
				rect.position({
					x: this.newPositions[i].x,
					y: this.newPositions[i].y,
				});
			}
		});
		this.layer.draw();
	}

	undo(): void {
		this.rects.forEach((rect, i) => {
			rect.position({
				x: this.oldPositions[i].x,
				y: this.oldPositions[i].y,
			});
		});
		this.layer.draw();
	}
}

// Command for pasting rectangles
class PasteRectsCommand implements Command {
	private rects: Konva.Rect[];
	private layer: Konva.Layer;

	constructor(rects: Konva.Rect[], layer: Konva.Layer) {
		this.rects = [...rects];
		this.layer = layer;
	}

	execute(): void {
		this.rects.forEach((rect) => this.layer.add(rect));
		this.layer.draw();
	}

	undo(): void {
		this.rects.forEach((rect) => rect.remove());
		this.layer.draw();
	}
}

// Command for transforming rectangles (resize)
class TransformRectsCommand implements Command {
	private rects: Konva.Rect[];
	private oldProps: {
		width: number;
		height: number;
		scaleX: number;
		scaleY: number;
	}[];
	private newProps: {
		width: number;
		height: number;
		scaleX: number;
		scaleY: number;
	}[];
	private layer: Konva.Layer;

	constructor(rects: Konva.Rect[], layer: Konva.Layer) {
		this.rects = [...rects];
		this.layer = layer;

		// Store initial properties
		this.oldProps = rects.map((rect) => ({
			width: rect.width(),
			height: rect.height(),
			scaleX: rect.scaleX(),
			scaleY: rect.scaleY(),
		}));

		// New properties will be set later
		this.newProps = [];
	}

	setNewProps(): void {
		this.newProps = this.rects.map((rect) => ({
			width: rect.width(),
			height: rect.height(),
			scaleX: rect.scaleX(),
			scaleY: rect.scaleY(),
		}));
	}

	execute(): void {
		this.rects.forEach((rect, i) => {
			if (this.newProps[i]) {
				rect.width(this.newProps[i].width);
				rect.height(this.newProps[i].height);
				rect.scaleX(this.newProps[i].scaleX);
				rect.scaleY(this.newProps[i].scaleY);
			}
		});
		this.layer.draw();
	}

	undo(): void {
		this.rects.forEach((rect, i) => {
			rect.width(this.oldProps[i].width);
			rect.height(this.oldProps[i].height);
			rect.scaleX(this.oldProps[i].scaleX);
			rect.scaleY(this.oldProps[i].scaleY);
		});
		this.layer.draw();
	}
}

export class OcclusionView extends ItemView {
	plugin: MyPlugin; // Change the type to MyPlugin

	containerEl: HTMLElement;
	fileSelectEl: HTMLInputElement; // Changed from HTMLSelectElement to HTMLInputElement
	fileSearchResultsEl: HTMLElement; // Add element for search results
	selectedFilePath: string = ""; // Track the currently selected file
	fileSearchResults: TFile[] = []; // Store search results
	fuse: Fuse<TFile>; // Fuse instance for fuzzy search
	addRectButton: HTMLButtonElement;
	deleteButton: HTMLButtonElement;
	saveButton: HTMLButtonElement;
	konvaContainer: HTMLDivElement;
	colorInput: HTMLInputElement;
	widthInput: HTMLInputElement;
	heightInput: HTMLInputElement;
	controlsDiv: HTMLElement;
	modeToggleButton: HTMLButtonElement;
	resetButton: HTMLButtonElement;
	resizeObserver: ResizeObserver;

	stage: Konva.Stage;
	imageLayer: Konva.Layer;
	shapeLayer: Konva.Layer;
	transformer: Konva.Transformer;

	selectedRect: Konva.Rect | null = null;
	reviewMode: boolean = false;

	// New zoom properties
	currentScale: number = 1;
	initialScale: number = 1;
	isPanning: boolean = false;
	lastPointerPosition: { x: number; y: number } | null = null;
	lastTouchPosition: { x: number; y: number } | null = null;
	lastCenter: { x: number; y: number } | null = null;
	lastDist: number = 0;

	// Add a new property to track multiple selections
	selectedRects: Konva.Rect[] = [];

	// Add snapping related properties
	snapThreshold: number = 10; // Distance in pixels to trigger snapping
	isSnapping: boolean = false; // Track if snapping is currently enabled

	// Add clipboard for storing copied occlusions
	copiedRects: {
		x: number;
		y: number;
		width: number;
		height: number;
		fill: string;
		opacity: number;
	}[] = [];

	// Add command history property
	commandHistory: CommandHistory = new CommandHistory();

	// Track move commands for drag operations
	currentMoveCommand: MoveRectsCommand | null = null;

	// Track transform commands for resize operations
	currentTransformCommand: TransformRectsCommand | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_OCCLUSION;
	}

	getDisplayText(): string {
		return "Occlusion Editor";
	}

	getIcon(): string {
		return "image-file";
	}

	async onOpen() {
		// Create main container with Tailwind classes
		this.containerEl = this.contentEl.createDiv({
			cls: "flex flex-col h-full bg-gray-50 dark:bg-gray-800",
		});

		// Create a fixed toolbar for controls with Tailwind classes
		const toolbarEl = this.containerEl.createDiv({
			cls: "sticky top-0 z-10 bg-white dark:bg-gray-700 shadow-md p-3 flex flex-wrap gap-2 items-center border-b border-gray-200 dark:border-gray-600",
		});

		// Create a responsive toolbar layout with two rows for mobile
		const topRowContainer = toolbarEl.createDiv({
			cls: "w-full flex flex-wrap items-center gap-2 justify-between",
		});

		// Create file selector section with improved mobile styling
		const fileSelectContainer = topRowContainer.createDiv({
			cls: "flex-grow max-w-full sm:max-w-xs relative",
		});

		// Add a label above the search for better mobile UX
		fileSelectContainer.createEl("label", {
			text: "Image",
			cls: "block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1",
		});

		// Create fuzzy search input instead of select dropdown
		this.fileSelectEl = fileSelectContainer.createEl("input", {
			type: "text",
			placeholder: "Search for an image...",
			cls: "bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2 dark:bg-gray-700 dark:border-gray-600 dark:text-white",
		});

		// Create a container for search results
		this.fileSearchResultsEl = fileSelectContainer.createDiv({
			cls: "absolute z-20 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg max-h-60 overflow-y-auto hidden",
		});

		// Get image files and initialize Fuse
		const files = this.plugin.app.vault.getFiles();
		const imageFiles = files.filter((f) =>
			f.extension.match(/(png|jpe?g|gif)/i)
		);

		// Initialize Fuse.js
		this.fuse = new Fuse(imageFiles, {
			keys: ["path", "name"],
			threshold: 0.4,
			ignoreLocation: true,
		});

		// Setup the search input event handler
		this.fileSelectEl.addEventListener("input", () => {
			const query = this.fileSelectEl.value.trim();

			if (query.length === 0) {
				this.fileSearchResultsEl.addClass("hidden");
				return;
			}

			// Perform fuzzy search
			this.fileSearchResults = this.fuse
				.search(query)
				.map((result) => result.item);

			// Display results
			this.fileSearchResultsEl.empty();
			this.fileSearchResultsEl.removeClass("hidden");

			if (this.fileSearchResults.length === 0) {
				const noResults = this.fileSearchResultsEl.createDiv({
					text: "No matching images found",
					cls: "p-2 text-sm text-gray-500 dark:text-gray-400",
				});
				return;
			}

			// Create result items
			this.fileSearchResults.forEach((file, index) => {
				const resultItem = this.fileSearchResultsEl.createDiv({
					cls: "p-2 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer text-sm flex items-center",
				});

				// Add an icon to visually indicate the file is an image
				const iconEl = resultItem.createSpan({
					cls: "text-gray-500 mr-2 flex-shrink-0",
				});
				iconEl.innerHTML =
					'<svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';

				// Add the file path
				resultItem.createSpan({
					text: file.path,
					cls: "truncate",
				});

				// Handle click to select this file
				resultItem.addEventListener("click", () => {
					this.selectedFilePath = file.path;
					this.fileSelectEl.value = file.path;
					this.fileSearchResultsEl.addClass("hidden");
					this.loadImage(file.path);
				});
			});
		});

		// Add click event listener to show all images when clicking on the search input
		this.fileSelectEl.addEventListener("click", () => {
			// Clear the input field when clicked
			this.fileSelectEl.value = "";

			// Show all image files when clicking on the input
			this.fileSearchResultsEl.empty();
			this.fileSearchResultsEl.removeClass("hidden");

			// Get all image files
			const files = this.plugin.app.vault
				.getFiles()
				.filter((f) => f.extension.match(/(png|jpe?g|gif)/i));

			if (files.length === 0) {
				const noResults = this.fileSearchResultsEl.createDiv({
					text: "No images found in vault",
					cls: "p-2 text-sm text-gray-500 dark:text-gray-400",
				});
				return;
			}

			// Create result items for all images
			files.forEach((file) => {
				const resultItem = this.fileSearchResultsEl.createDiv({
					cls: "p-2 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer text-sm flex items-center",
				});

				// Add an icon
				const iconEl = resultItem.createSpan({
					cls: "text-gray-500 mr-2 flex-shrink-0",
				});
				iconEl.innerHTML =
					'<svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';

				// Add the file path
				resultItem.createSpan({
					text: file.path,
					cls: "truncate",
				});

				// Handle click to select this file
				resultItem.addEventListener("click", () => {
					this.selectedFilePath = file.path;
					this.fileSelectEl.value = file.path;
					this.fileSearchResultsEl.addClass("hidden");
					this.loadImage(file.path);
				});
			});
		});

		// Hide results when clicking outside
		document.addEventListener("click", (e) => {
			if (
				!this.fileSearchResultsEl.contains(e.target as Node) &&
				e.target !== this.fileSelectEl
			) {
				this.fileSearchResultsEl.addClass("hidden");
			}
		});

		// Create mode toggle and zoom controls in a group
		const controlsGroup = topRowContainer.createDiv({
			cls: "flex items-center gap-2",
		});

		// Add a snapping indicator
		const snappingIndicator = controlsGroup.createDiv({
			cls: "text-xs font-medium text-gray-700 dark:text-gray-300 px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded hidden",
			attr: { id: "snapping-status" },
		});
		snappingIndicator.textContent = "Snapping Enabled";

		// Create mode toggle button with Tailwind classes
		this.modeToggleButton = controlsGroup.createEl("button", {
			text: "Review",
			cls: "inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 focus:ring-4 focus:ring-blue-300 dark:bg-blue-500 dark:hover:bg-blue-600 dark:focus:ring-blue-800",
		});
		this.modeToggleButton.onclick = () => this.toggleReviewMode();

		// Create reset button for review mode (initially hidden)
		this.resetButton = controlsGroup.createEl("button", {
			text: "Reset All",
			cls: "inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg bg-yellow-500 text-white hover:bg-yellow-600 focus:ring-4 focus:ring-yellow-300 dark:bg-yellow-500 dark:hover:bg-yellow-600 dark:focus:ring-yellow-800",
			attr: { style: "display: none;" },
		});
		this.resetButton.onclick = () => this.resetOcclusions();

		// Create zoom controls group
		const zoomControlsGroup = controlsGroup.createDiv({
			cls: "flex items-center gap-1",
		});

		const zoomInButton = zoomControlsGroup.createEl("button", {
			cls: "p-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 dark:text-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500",
			attr: { title: "Zoom In", "aria-label": "Zoom In" },
		});
		zoomInButton.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z" clip-rule="evenodd" /></svg>';

		const zoomOutButton = zoomControlsGroup.createEl("button", {
			cls: "p-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 dark:text-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500",
			attr: { title: "Zoom Out", "aria-label": "Zoom Out" },
		});
		zoomOutButton.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5 10a1 1 0 011-1h8a1 1 0 110 2H6a1 1 0 01-1-1z" clip-rule="evenodd" /></svg>';

		const resetZoomButton = zoomControlsGroup.createEl("button", {
			cls: "p-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 dark:text-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500",
			attr: { title: "Reset Zoom", "aria-label": "Reset Zoom" },
		});
		resetZoomButton.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd" /></svg>';

		// Create a helper function for zooming that uses the same logic as gestures
		const zoomStageBy = (
			scaleBy: number,
			centerX?: number,
			centerY?: number
		): void => {
			// Get stage center if no center point provided
			if (centerX === undefined || centerY === undefined) {
				const stage = this.stage;
				centerX = stage.width() / 2;
				centerY = stage.height() / 2;
			}

			// Calculate relative point to maintain position
			const pointTo = {
				x: (centerX - this.stage.x()) / this.currentScale,
				y: (centerY - this.stage.y()) / this.currentScale,
			};

			// Calculate new scale with min/max constraints
			const newScale = Math.max(
				0.1,
				Math.min(this.currentScale * scaleBy, 10)
			);
			this.currentScale = newScale;

			// Calculate new position to zoom toward center point
			const newPos = {
				x: centerX - pointTo.x * this.currentScale,
				y: centerY - pointTo.y * this.currentScale,
			};

			// Apply new scale and position
			this.stage.scale({ x: this.currentScale, y: this.currentScale });
			this.stage.position(newPos);
			this.stage.batchDraw();
		};

		// Update the button handlers to use our new zoom function
		zoomInButton.onclick = () => {
			const center = this.stage.width() / 2;
			const middle = this.stage.height() / 2;
			zoomStageBy(1.1, center, middle);
		};

		zoomOutButton.onclick = () => {
			const center = this.stage.width() / 2;
			const middle = this.stage.height() / 2;
			zoomStageBy(0.9, center, middle);
		};

		resetZoomButton.onclick = () => {
			this.currentScale = this.initialScale;
			// Reset position and scale
			this.resizeStage();
		};

		// Create a second row for shape controls and action buttons
		const bottomRowContainer = toolbarEl.createDiv({
			cls: "w-full flex flex-wrap items-center gap-2 justify-between mt-2",
		});

		// Create a collapsible panel for shape controls - improved for mobile
		this.controlsDiv = bottomRowContainer.createDiv({
			cls: "flex flex-wrap items-center gap-2",
		});

		// Color input with improved mobile styling
		const colorContainer = this.controlsDiv.createDiv({
			cls: "flex flex-col items-start",
		});
		colorContainer.createEl("label", {
			text: "Color",
			cls: "block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1",
		});
		this.colorInput = colorContainer.createEl("input", {
			type: "color",
			cls: "h-8 w-10 rounded cursor-pointer border border-gray-300 dark:border-gray-600",
		});
		this.colorInput.onchange = (e: Event) => {
			if (this.selectedRect && !this.reviewMode) {
				this.selectedRect.fill((e.target as HTMLInputElement).value);
				this.shapeLayer.draw();
			}
		};

		// Create a container for width and height inputs to group them
		const dimensionsContainer = this.controlsDiv.createDiv({
			cls: "flex flex-col items-start",
		});
		dimensionsContainer.createEl("label", {
			text: "Size",
			cls: "block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1",
		});

		const inputsContainer = dimensionsContainer.createDiv({
			cls: "flex items-center gap-1",
		});

		// Width input with improved mobile styling
		const widthContainer = inputsContainer.createDiv({
			cls: "flex items-center",
		});
		widthContainer.createEl("span", {
			text: "W:",
			cls: "text-xs font-medium text-gray-700 dark:text-gray-300 mr-1",
		});
		this.widthInput = widthContainer.createEl("input", {
			type: "number",
			value: "100",
			cls: "bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-14 p-1 dark:bg-gray-700 dark:border-gray-600 dark:text-white",
			attr: { placeholder: "W", min: "10" },
		});
		this.widthInput.onchange = () => {
			if (this.selectedRect && !this.reviewMode) {
				this.selectedRect.width(parseFloat(this.widthInput.value));
				this.shapeLayer.draw();
			}
		};

		// Height input with improved mobile styling
		const heightContainer = inputsContainer.createDiv({
			cls: "flex items-center",
		});
		heightContainer.createEl("span", {
			text: "H:",
			cls: "text-xs font-medium text-gray-700 dark:text-gray-300 mr-1",
		});
		this.heightInput = heightContainer.createEl("input", {
			type: "number",
			value: "100",
			cls: "bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-14 p-1 dark:bg-gray-700 dark:border-gray-600 dark:text-white",
			attr: { placeholder: "H", min: "10" },
		});
		this.heightInput.onchange = () => {
			if (this.selectedRect && !this.reviewMode) {
				this.selectedRect.height(parseFloat(this.heightInput.value));
				this.shapeLayer.draw();
			}
		};

		// Create action buttons container
		const actionsContainer = bottomRowContainer.createDiv({
			cls: "flex flex-wrap gap-2",
		});

		// Add undo/redo buttons to the actionsContainer
		const undoButton = actionsContainer.createEl("button", {
			cls: "inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg bg-gray-600 text-white hover:bg-gray-700 focus:ring-4 focus:ring-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 dark:focus:ring-gray-800",
			attr: { title: "Undo (Ctrl+Z)", "aria-label": "Undo" },
		});
		undoButton.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a4 4 0 0 1 0 8H9m-6-8l4-4m0 0L3 2m4 4H3" /></svg>';
		undoButton.onclick = () => this.undo();

		const redoButton = actionsContainer.createEl("button", {
			cls: "inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg bg-gray-600 text-white hover:bg-gray-700 focus:ring-4 focus:ring-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 dark:focus:ring-gray-800",
			attr: { title: "Redo (Ctrl+Shift+Z)", "aria-label": "Redo" },
		});
		redoButton.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10h8a4 4 0 0 1 0 8h-4m4-8l-4-4m0 0l4-4m-4 4h4" /></svg>';
		redoButton.onclick = () => this.redo();

		// Add occlusion button - renamed to "Add"
		this.addRectButton = actionsContainer.createEl("button", {
			text: "Add",
			cls: "inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 focus:ring-4 focus:ring-green-300 dark:bg-green-500 dark:hover:bg-green-600 dark:focus:ring-green-800",
		});
		this.addRectButton.onclick = () => this.addRectangle();

		// Delete occlusion button
		this.deleteButton = actionsContainer.createEl("button", {
			text: "Delete",
			cls: "inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 focus:ring-4 focus:ring-red-300 dark:bg-red-500 dark:hover:bg-red-600 dark:focus:ring-red-800",
		});
		this.deleteButton.onclick = () => {
			if (this.selectedRects.length > 0 && !this.reviewMode) {
				// Use command system to delete rectangles
				const command = new DeleteRectsCommand(
					this.selectedRects,
					this.shapeLayer
				);
				this.commandHistory.execute(command);

				this.transformer.nodes([]);
				this.selectedRect = null;
				this.selectedRects = [];
			}
		};

		// Save button
		this.saveButton = actionsContainer.createEl("button", {
			text: "Save",
			cls: "inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 focus:ring-4 focus:ring-blue-300 dark:bg-blue-500 dark:hover:bg-blue-600 dark:focus:ring-blue-800",
		});
		this.saveButton.onclick = () => this.saveOcclusionData();

		// Create the Konva container with Tailwind classes
		this.konvaContainer = this.containerEl.createEl("div", {
			cls: "flex-1 relative overflow-auto border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900",
		});

		// Initialize stage with placeholder dimensions
		this.stage = new Konva.Stage({
			container: this.konvaContainer,
			width: 800,
			height: 600,
		});
		this.imageLayer = new Konva.Layer();
		this.shapeLayer = new Konva.Layer();
		this.stage.add(this.imageLayer);
		this.stage.add(this.shapeLayer);

		this.transformer = new Konva.Transformer({
			keepRatio: false,
			enabledAnchors: [
				"top-left",
				"top-center",
				"top-right",
				"middle-left",
				"middle-right",
				"bottom-left",
				"bottom-center",
				"bottom-right",
			],
			rotateEnabled: false,
			borderStroke: "#0096FF",
			borderStrokeWidth: 2,
			anchorStroke: "#0096FF",
			anchorFill: "#FFFFFF",
			anchorSize: 10,
		});
		this.shapeLayer.add(this.transformer);

		// Update to handle both mouse and touch events
		this.stage.on("click tap", (e) => {
			if (this.reviewMode) return;

			// Get if shift key is pressed for multi-selection
			const isShiftPressed = e.evt.shiftKey;

			// If clicked on the stage or any non-rectangle object and not holding shift
			if (
				(e.target === this.stage ||
					!(e.target instanceof Konva.Rect)) &&
				!isShiftPressed
			) {
				// Clear transformer nodes
				this.transformer.nodes([]);

				// Disable dragging on all previously selected rectangles
				this.selectedRects.forEach((rect) => {
					rect.draggable(false);
				});

				// Clear selections
				this.selectedRect = null;
				this.selectedRects = [];

				// Redraw the layer to update visual state
				this.shapeLayer.draw();
			}
		});

		// Add wheel zoom support for desktop trackpads and mouse wheels
		this.stage.on("wheel", (e) => {
			// Prevent default behavior (page scrolling)
			e.evt.preventDefault();

			// Get pointer position (relative to stage)
			const pointer = this.stage.getPointerPosition();
			if (!pointer) return;

			// Calculate relative pointer position to account for stage scaling and position
			const mousePointTo = {
				x: (pointer.x - this.stage.x()) / this.currentScale,
				y: (pointer.y - this.stage.y()) / this.currentScale,
			};

			// Calculate new scale based on wheel delta
			// Use a smaller factor (0.05) for smoother zoom with trackpads
			const zoomFactor = e.evt.ctrlKey ? 0.1 : 0.05;
			const direction = e.evt.deltaY < 0 ? 1 : -1;

			// For trackpads, detecting pinch gestures
			let newScale;
			if (e.evt.ctrlKey) {
				// This is likely a pinch gesture (or ctrl+wheel)
				const scaleBy = direction > 0 ? 1.1 : 0.9;
				newScale = this.currentScale * scaleBy;
			} else {
				// Regular wheel scroll - smoother zoom
				newScale = this.currentScale * (1 + direction * zoomFactor);
			}

			// Set min/max zoom constraints
			newScale = Math.max(0.1, Math.min(newScale, 10));

			// Calculate new position to zoom toward mouse point
			const newPos = {
				x: pointer.x - mousePointTo.x * newScale,
				y: pointer.y - mousePointTo.y * newScale,
			};

			// Apply the new scale and position
			this.currentScale = newScale;
			this.stage.scale({ x: this.currentScale, y: this.currentScale });
			this.stage.position(newPos);
			this.stage.batchDraw();
		});

		// Enhanced panning implementation
		let panStartPosition: { x: number; y: number } | null = null;

		// Method that handles all panning regardless of input type
		const startPan = (clientX: number, clientY: number) => {
			this.isPanning = true;
			panStartPosition = { x: clientX, y: clientY };
			this.stage.container().style.cursor = "grabbing";
		};

		const updatePan = (clientX: number, clientY: number) => {
			if (!this.isPanning || !panStartPosition) return;

			// Calculate how much the pointer has moved
			const dx = clientX - panStartPosition.x;
			const dy = clientY - panStartPosition.y;

			// Update the stage position by the movement amount
			const currentPos = this.stage.position();
			this.stage.position({
				x: currentPos.x + dx,
				y: currentPos.y + dy,
			});

			// Reset start position for the next move
			panStartPosition = { x: clientX, y: clientY };
			this.stage.batchDraw();
		};

		const endPan = () => {
			this.isPanning = false;
			panStartPosition = null;
			this.stage.container().style.cursor = "default";
		};

		// Touch-based panning implementation
		this.stage.on("touchstart", (e) => {
			const touches = e.evt.touches;

			// Use single touch for panning
			if (touches.length === 1 && !this.reviewMode) {
				e.evt.preventDefault();
				startPan(touches[0].clientX, touches[0].clientY);
			} else if (touches.length === 2) {
				// Initialize for pinch zoom
				const touch1 = touches[0];
				const touch2 = touches[1];

				this.lastCenter = {
					x: (touch1.clientX + touch2.clientX) / 2,
					y: (touch1.clientY + touch2.clientY) / 2,
				};

				this.lastDist = Math.sqrt(
					Math.pow(touch2.clientX - touch1.clientX, 2) +
						Math.pow(touch2.clientY - touch1.clientY, 2)
				);
			}
		});

		this.stage.on("touchmove", (e) => {
			const touches = e.evt.touches;

			// Handle pinch zoom with two fingers
			if (touches.length === 2) {
				e.evt.preventDefault();

				const touch1 = touches[0];
				const touch2 = touches[1];

				// Calculate the center point in screen coordinates
				const screenCenter = {
					x: (touch1.clientX + touch2.clientX) / 2,
					y: (touch1.clientY + touch2.clientY) / 2,
				};

				// Convert screen coordinates to stage coordinates
				const stagePoint =
					this.stage.getPointerPosition() || screenCenter;

				// Calculate distance between touches
				const dist = Math.sqrt(
					Math.pow(touch2.clientX - touch1.clientX, 2) +
						Math.pow(touch2.clientY - touch1.clientY, 2)
				);

				if (!this.lastCenter || this.lastDist === 0) {
					this.lastDist = dist;
					this.lastCenter = screenCenter;
					return;
				}

				// Calculate scale change
				const scaleChange = dist / this.lastDist;

				// Set min/max zoom constraints
				const newScale = Math.max(
					0.1,
					Math.min(this.currentScale * scaleChange, 10)
				);

				// Calculate the point in the original coordinate system
				// This is the point that should remain fixed during zoom
				const pointTo = {
					x: (stagePoint.x - this.stage.x()) / this.currentScale,
					y: (stagePoint.y - this.stage.y()) / this.currentScale,
				};

				// Also calculate panning offset in screen space
				const dx = screenCenter.x - this.lastCenter.x;
				const dy = screenCenter.y - this.lastCenter.y;

				// Calculate new position, keeping the point under the gesture center
				const newPos = {
					x: stagePoint.x - pointTo.x * newScale + dx,
					y: stagePoint.y - pointTo.y * newScale + dy,
				};

				// Apply scale and position
				this.currentScale = newScale;
				this.stage.scale({
					x: this.currentScale,
					y: this.currentScale,
				});
				this.stage.position(newPos);

				this.lastDist = dist;
				this.lastCenter = screenCenter;
			}
			// Handle single touch panning
			else if (touches.length === 1 && this.isPanning) {
				e.evt.preventDefault();
				updatePan(touches[0].clientX, touches[0].clientY);
			}

			this.stage.batchDraw();
		});

		this.stage.on("touchend", () => {
			this.lastDist = 0;
			this.lastCenter = null;

			if (this.isPanning) {
				endPan();
			}
		});

		// Instead of using ResizeObserver, we can listen for leaf resize events
		this.registerInterval(
			window.setInterval(() => {
				if (this.konvaContainer && this.stage) {
					const containerWidth = this.konvaContainer.clientWidth;
					const containerHeight = this.konvaContainer.clientHeight;

					if (
						this.stage.width() !== containerWidth ||
						this.stage.height() !== containerHeight
					) {
						this.resizeStage();
					}
				}
			}, 2)
		);

		// Add a transformer change event handler to update the width/height inputs
		this.transformer.on("transformstart", () => {
			if (this.selectedRects.length > 0 && !this.reviewMode) {
				// Create a transform command when resizing starts
				this.currentTransformCommand = new TransformRectsCommand(
					this.selectedRects,
					this.shapeLayer
				);
			}
		});

		this.transformer.on("transform", () => {
			if (this.selectedRect) {
				// Update the width/height inputs when resizing
				this.widthInput.value = Math.round(
					this.selectedRect.width() * this.selectedRect.scaleX()
				).toString();
				this.heightInput.value = Math.round(
					this.selectedRect.height() * this.selectedRect.scaleY()
				).toString();
			}
		});

		this.transformer.on("transformend", () => {
			if (
				this.selectedRects.length > 0 &&
				this.currentTransformCommand &&
				!this.reviewMode
			) {
				// Apply the transform changes
				this.selectedRects.forEach((rect) => {
					// Apply the scale to the width/height and reset scale to 1
					const newWidth = Math.round(rect.width() * rect.scaleX());
					const newHeight = Math.round(rect.height() * rect.scaleY());

					rect.width(newWidth);
					rect.height(newHeight);
					rect.scaleX(1);
					rect.scaleY(1);
				});

				// Update the inputs if a primary selection exists
				if (this.selectedRect) {
					this.widthInput.value = this.selectedRect
						.width()
						.toString();
					this.heightInput.value = this.selectedRect
						.height()
						.toString();
				}

				// Complete the transform command
				this.currentTransformCommand.setNewProps();
				this.commandHistory.execute(this.currentTransformCommand);
				this.currentTransformCommand = null;
			}
		});

		// Initialize the first image if there are any
		if (imageFiles.length > 0) {
			// Set default selected file
			this.selectedFilePath = imageFiles[0].path;
			this.fileSelectEl.value = this.selectedFilePath;
			this.loadImage(this.selectedFilePath);
		}

		// Add key event listener for keyboard shortcuts
		this.registerKeyboardShortcuts();

		// Set up drag and transform event capture for undo/redo
		this.stage.on("dragstart", (e) => {
			if (e.target instanceof Konva.Rect && !this.reviewMode) {
				// Create a new move command when dragging starts
				this.currentMoveCommand = new MoveRectsCommand(
					this.selectedRects,
					this.shapeLayer
				);
			}
		});

		// Add a new event handler for dragmove to handle snapping
		this.stage.on("dragmove", (e) => {
			if (e.target instanceof Konva.Rect && !this.reviewMode) {
				// Check if shift key is pressed to enable snapping
				this.isSnapping = e.evt.shiftKey;

				if (this.isSnapping) {
					this.handleSnapping(e.target);
				}
			}
		});

		this.stage.on("dragend", (e) => {
			if (
				e.target instanceof Konva.Rect &&
				this.currentMoveCommand &&
				!this.reviewMode
			) {
				// Complete the move command when dragging ends
				this.currentMoveCommand.setNewPositions();
				this.commandHistory.execute(this.currentMoveCommand);
				this.currentMoveCommand = null;
			}
		});
	}

	toggleReviewMode(): void {
		this.reviewMode = !this.reviewMode;
		if (this.reviewMode) {
			this.controlsDiv.style.display = "none";
			this.addRectButton.style.display = "none";
			this.deleteButton.style.display = "none";
			this.saveButton.style.display = "none";
			this.resetButton.style.display = "";
			this.transformer.nodes([]);
			this.transformer.visible(false);

			// Make sure all rectangles are not draggable in review mode
			this.shapeLayer.getChildren().forEach((child: Konva.Node) => {
				if (child instanceof Konva.Rect) {
					child.draggable(false);
				}
			});

			this.modeToggleButton.textContent = "Edit";
			this.modeToggleButton.classList.remove(
				"bg-blue-600",
				"hover:bg-blue-700"
			);
			this.modeToggleButton.classList.add(
				"bg-purple-600",
				"hover:bg-purple-700"
			);

			// Clear selections
			this.selectedRect = null;
			this.selectedRects = [];

			// Reset the snapping state when exiting review mode
			this.isSnapping = false;
		} else {
			this.controlsDiv.style.display = "";
			this.addRectButton.style.display = "";
			this.deleteButton.style.display = "";
			this.saveButton.style.display = "";
			this.resetButton.style.display = "none";
			this.transformer.visible(true);

			// In edit mode, only make the selected rectangle draggable (if any)
			this.shapeLayer.getChildren().forEach((child: Konva.Node) => {
				if (child instanceof Konva.Rect) {
					child.draggable(child === this.selectedRect);
				}
			});

			this.modeToggleButton.textContent = "Review";
			this.modeToggleButton.classList.remove(
				"bg-purple-600",
				"hover:bg-purple-700"
			);
			this.modeToggleButton.classList.add(
				"bg-blue-600",
				"hover:bg-blue-700"
			);
		}
		this.shapeLayer.draw();
	}

	async loadImage(filePath: string): Promise<void> {
		this.imageLayer.destroyChildren();
		this.shapeLayer.destroyChildren();

		// Recreate transformer
		this.transformer = new Konva.Transformer({
			keepRatio: false,
			enabledAnchors: [
				"top-left",
				"top-center",
				"top-right",
				"middle-left",
				"middle-right",
				"bottom-left",
				"bottom-center",
				"bottom-right",
			],
			rotateEnabled: false,
			borderStroke: "#0096FF",
			borderStrokeWidth: 2,
			anchorStroke: "#0096FF",
			anchorFill: "#FFFFFF",
			anchorSize: 10,
		});
		this.shapeLayer.add(this.transformer);

		const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (!file || !(file instanceof TFile)) {
			new Notice("File not found or not a valid image file");
			return;
		}

		const data = await this.plugin.app.vault.readBinary(file);
		const blob = new Blob([data]);
		const url = URL.createObjectURL(blob);

		const img = new Image();
		img.onload = () => {
			const nativeWidth = img.naturalWidth;
			const nativeHeight = img.naturalHeight;

			// Create Konva image with native dimensions
			const kImage = new Konva.Image({
				image: img,
				x: 0,
				y: 0,
				width: nativeWidth,
				height: nativeHeight,
			});

			this.imageLayer.add(kImage);

			// Resize stage to match container and scale appropriately
			this.resizeStage();

			// Load saved shapes after image is properly sized
			this.loadSavedShapes(filePath);

			URL.revokeObjectURL(url);
		};

		img.src = url;
	}

	addRectangle(): void {
		// Calculate the center of the current viewport
		const stage = this.stage;
		const stagePos = stage.position();
		const scale = this.currentScale;

		// The center in stage coordinates
		const viewportCenterX = (stage.width() / 2 - stagePos.x) / scale;
		const viewportCenterY = (stage.height() / 2 - stagePos.y) / scale;

		// Default rectangle size (adjust as needed)
		const rectWidth = 100;
		const rectHeight = 100;

		// Create the rectangle at the viewport center
		const rect = new Konva.Rect({
			x: viewportCenterX - rectWidth / 2,
			y: viewportCenterY - rectHeight / 2,
			width: rectWidth,
			height: rectHeight,
			fill: this.colorInput ? this.colorInput.value : "#000000",
			opacity: 1,
			draggable: false, // Ensure it starts as not draggable
		});

		// Define the dragBoundFunc to ensure consistent behavior
		rect.dragBoundFunc((pos) => {
			return pos; // Simple pass-through for now
		});

		rect.on("click tap", (e) => this.handleRectClick(rect, e));

		// Add additional mousedown and touchstart handler to prevent unintended dragging
		rect.on("mousedown touchstart", (e) => {
			// Only allow drag to begin if the rectangle is already selected
			if (!this.selectedRects.includes(rect) && !e.evt.shiftKey) {
				rect.draggable(false);
			}
		});

		// Use command system to add the rectangle
		const command = new AddRectCommand(rect, this.shapeLayer);
		this.commandHistory.execute(command);

		// Auto-select the newly created rectangle
		if (!this.reviewMode) {
			// Clear previous selections
			this.selectedRects.forEach((r) => {
				if (r !== rect) r.draggable(false);
			});

			this.selectedRects = [rect];
			this.selectedRect = rect;
			rect.draggable(true); // Make it draggable since it's selected
			this.transformer.nodes([rect]);

			if (this.colorInput) this.colorInput.value = rect.fill() as string;
			this.widthInput.value = rect.width().toString();
			this.heightInput.value = rect.height().toString();
		}
	}

	async saveOcclusionData(): Promise<void> {
		const filePath = this.fileSelectEl.value;
		if (!filePath) return;
		const shapes: OcclusionShape[] = this.shapeLayer
			.getChildren()
			.map((shape: Konva.Node) => {
				if (shape instanceof Konva.Rect) {
					// Make sure we're saving the actual dimensions, accounting for any scaling
					const width = shape.width() * shape.scaleX();
					const height = shape.height() * shape.scaleY();

					return {
						x: shape.x(),
						y: shape.y(),
						width: width,
						height: height,
						fill: shape.fill() as string,
						opacity: shape.opacity(),
					};
				}
				return null;
			})
			.filter((s): s is OcclusionShape => s !== null);

		// Update the plugin's occlusion data directly
		this.plugin.occlusion.attachments[filePath] = shapes;
		await this.plugin.savePluginData();

		// Refresh any open reading views to apply the changes
		this.refreshReadingViews();

		new Notice("Occlusion data saved!");
	}

	// Add this new method to refresh reading views
	private refreshReadingViews(): void {
		const leaves = this.plugin.app.workspace.getLeavesOfType("markdown");

		for (const leaf of leaves) {
			const view = leaf.view;

			if (view instanceof MarkdownView && view.getMode() === "preview") {
				// Force a re-render of the reading view
				view.previewMode.rerender(true);
			}
		}
	}

	async loadSavedShapes(filePath: string): Promise<void> {
		// Access the occlusion data directly from the plugin
		const shapes = this.plugin.occlusion.attachments[filePath] || [];

		shapes.forEach((s: OcclusionShape) => {
			const rect = new Konva.Rect({
				x: s.x,
				y: s.y,
				width: s.width,
				height: s.height,
				fill: s.fill,
				opacity: s.opacity,
				draggable: false, // Ensure it starts as not draggable
				// Ensure scale is set to 1 when loading
				scaleX: 1,
				scaleY: 1,
			});

			// Define the dragBoundFunc to ensure consistent behavior
			rect.dragBoundFunc((pos) => {
				return pos; // Simple pass-through for now
			});

			rect.on("click tap", (e) => {
				e.cancelBubble = true;
				if (this.reviewMode) {
					rect.visible(!rect.visible());
					this.shapeLayer.draw();
				} else {
					// Check if shift key is held for multi-selection
					const isShiftPressed = e.evt.shiftKey;

					if (!isShiftPressed) {
						// Deselect all previously selected rectangles if shift isn't pressed
						this.selectedRects.forEach((r) => {
							r.draggable(false);
						});
						this.selectedRects = [];
					}

					// Add to selection if not already selected
					if (!this.selectedRects.includes(rect)) {
						this.selectedRects.push(rect);
					}

					// Always update the primary selected rect for controls
					this.selectedRect = rect;

					// Make all selected rectangles draggable
					this.selectedRects.forEach((r) => r.draggable(true));

					// Update the transformer to show all selected rectangles
					this.transformer.nodes(this.selectedRects);

					// Update controls for the primary selected rectangle
					this.colorInput.value = rect.fill() as string;
					this.widthInput.value = rect.width().toString();
					this.heightInput.value = rect.height().toString();
				}
			});

			// Add additional mousedown and touchstart handler to prevent unintended dragging
			rect.on("mousedown touchstart", (e) => {
				// Only allow drag to begin if the rectangle is already selected
				if (!this.selectedRects.includes(rect) && !e.evt.shiftKey) {
					rect.draggable(false);
				}
			});

			this.shapeLayer.add(rect);
		});

		this.shapeLayer.draw();
	}

	// Add a new method to handle stage resizing
	resizeStage(): void {
		if (!this.stage) return;

		const containerWidth = this.konvaContainer.clientWidth;
		const containerHeight = this.konvaContainer.clientHeight;

		// Set stage to container size
		this.stage.width(containerWidth);
		this.stage.height(containerHeight);

		// If we have an image loaded, adjust the scale and position to match original image exactly
		const backgroundImage = this.imageLayer.findOne("Image") as Konva.Image;
		if (backgroundImage) {
			const imgWidth = backgroundImage.width();
			const imgHeight = backgroundImage.height();

			// Calculate the scaling factor to maintain aspect ratio
			const scaleX = containerWidth / imgWidth;
			const scaleY = containerHeight / imgHeight;
			const scale = Math.min(scaleX, scaleY);

			// Calculate centering position
			const centerX = (containerWidth - imgWidth * scale) / 2;
			const centerY = (containerHeight - imgHeight * scale) / 2;

			// Reset stage position and scale
			this.stage.position({
				x: centerX,
				y: centerY,
			});

			// Update scale properties
			this.initialScale = scale;
			this.currentScale = scale;

			// Apply scale to stage
			this.stage.scale({ x: scale, y: scale });

			backgroundImage.position({
				x: 0,
				y: 0,
			});

			backgroundImage.width(imgWidth);
			backgroundImage.height(imgHeight);
			backgroundImage.scale({
				x: 1,
				y: 1,
			});
		}

		this.stage.batchDraw();
	}

	async onClose(): Promise<void> {
		// Remove the key event listener when closing
		document.removeEventListener("keydown", this.handleKeyDown);
		console.log("Keyboard shortcuts unregistered");

		// Existing cleanup code
		if (this.stage) {
			this.stage.off("wheel");
			this.stage.off("touchmove");
			this.stage.off("touchend");
			this.stage.off("mousedown");
			this.stage.off("mousemove");
			this.stage.off("mouseup");
			this.stage.off("mouseleave");
		}
	}

	resetOcclusions(): void {
		if (!this.reviewMode) return;

		this.shapeLayer.getChildren().forEach((child: Konva.Node) => {
			if (child instanceof Konva.Rect) {
				child.visible(true);
			}
		});

		this.shapeLayer.draw();
		new Notice("All occlusions reset");
	}

	setSelectedFile(filePath: string): void {
		this.selectedFilePath = filePath;
		this.fileSelectEl.value = filePath;
		this.loadImage(filePath);
	}

	handleKeyDown = (e: KeyboardEvent) => {
		// Check if we're not focused in an input element
		const activeElement = document.activeElement;
		const isInputFocused =
			activeElement instanceof HTMLInputElement ||
			activeElement instanceof HTMLTextAreaElement;

		// Only handle when not in an input field
		if (!isInputFocused) {
			// Handle delete/backspace
			if (
				(e.key === "Backspace" || e.key === "Delete") &&
				this.selectedRects.length > 0 &&
				!this.reviewMode
			) {
				e.preventDefault(); // Prevent the default behavior

				// Use command system to delete rectangles
				const command = new DeleteRectsCommand(
					this.selectedRects,
					this.shapeLayer
				);
				this.commandHistory.execute(command);

				this.transformer.nodes([]);
				this.selectedRect = null;
				this.selectedRects = [];
			}

			// Handle copy (super+c or ctrl+c)
			if (
				e.key === "c" &&
				(e.metaKey || e.ctrlKey) &&
				this.selectedRects.length > 0 &&
				!this.reviewMode
			) {
				e.preventDefault();
				this.copySelectedRects();
			}

			// Handle paste (super+v or ctrl+v)
			if (e.key === "v" && (e.metaKey || e.ctrlKey) && !this.reviewMode) {
				e.preventDefault();
				this.pasteRects();
			}

			// Handle undo with Command+Z (macOS) or Ctrl+Z (Windows/Linux)
			if (
				e.key === "z" &&
				(e.metaKey || e.ctrlKey) &&
				!e.shiftKey &&
				!this.reviewMode
			) {
				e.preventDefault();
				console.log("Undo triggered with keyboard shortcut");
				this.undo();
			}

			// Handle redo with Command+Shift+Z (macOS) or Ctrl+Shift+Z (Windows/Linux)
			// Also support Ctrl+Y as an alternative redo shortcut
			if (
				((e.key === "z" && e.shiftKey) || e.key === "y") &&
				(e.metaKey || e.ctrlKey) &&
				!this.reviewMode
			) {
				e.preventDefault();
				console.log("Redo triggered with keyboard shortcut");
				this.redo();
			}

			// Handle shift key for snapping indicator
			if (e.key === "Shift" && !this.reviewMode) {
				// Update a visual indicator that snapping is available when dragging
				const statusElement =
					document.getElementById("snapping-status");
				if (statusElement) {
					statusElement.style.display = "inline";
				}
			}
		}
	};

	// Add a utility method to ensure all occlusions are not draggable except selected ones
	resetDraggableState(): void {
		this.shapeLayer.getChildren().forEach((child: Konva.Node) => {
			if (child instanceof Konva.Rect) {
				// Only allow dragging for rectangles in the selectedRects array
				child.draggable(this.selectedRects.includes(child));
			}
		});
	}

	// Add a new method to handle clicked occlusions for both new rectangles and loaded ones
	handleRectClick(
		rect: Konva.Rect,
		e: Konva.KonvaEventObject<MouseEvent | TouchEvent>
	): void {
		e.cancelBubble = true;

		if (this.reviewMode) {
			rect.visible(!rect.visible());
			this.shapeLayer.draw();
			return;
		}

		const isShiftPressed = e.evt.shiftKey;

		// If not holding shift, deselect all current selections
		if (!isShiftPressed) {
			this.selectedRects.forEach((r) => {
				r.draggable(false);
			});
			this.selectedRects = [];
		}

		// Add to selection if not already selected
		if (!this.selectedRects.includes(rect)) {
			this.selectedRects.push(rect);
		}

		// Set as primary selected rectangle
		this.selectedRect = rect;

		// Update draggable state for all selections
		this.selectedRects.forEach((r) => r.draggable(true));

		// Update transformer
		this.transformer.nodes(this.selectedRects);

		// Update controls
		this.colorInput.value = rect.fill() as string;
		this.widthInput.value = rect.width().toString();
		this.heightInput.value = rect.height().toString();

		this.shapeLayer.draw();
	}

	// Add method to copy selected rectangles
	copySelectedRects(): void {
		if (this.selectedRects.length === 0) return;

		// Clear previous copies
		this.copiedRects = [];

		// Store properties of selected rectangles
		this.selectedRects.forEach((rect) => {
			this.copiedRects.push({
				x: rect.x(),
				y: rect.y(),
				width: rect.width() * rect.scaleX(),
				height: rect.height() * rect.scaleY(),
				fill: rect.fill() as string,
				opacity: rect.opacity(),
			});
		});
	}

	// Add method to paste copied rectangles
	pasteRects(): void {
		if (this.copiedRects.length === 0) return;

		// Clear current selection
		this.selectedRects.forEach((rect) => {
			rect.draggable(false);
		});
		this.selectedRects = [];

		// Calculate offset for pasted rectangles (20px to make them visible)
		const offsetX = 20;
		const offsetY = 20;

		// Create new rectangles based on copied ones
		const newRects: Konva.Rect[] = [];

		this.copiedRects.forEach((rectData) => {
			const rect = new Konva.Rect({
				x: rectData.x + offsetX,
				y: rectData.y + offsetY,
				width: rectData.width,
				height: rectData.height,
				fill: rectData.fill,
				opacity: rectData.opacity,
				draggable: true,
				scaleX: 1,
				scaleY: 1,
			});

			// Define the dragBoundFunc to ensure consistent behavior
			rect.dragBoundFunc((pos) => {
				return pos; // Simple pass-through for now
			});

			// Add click and tap event handlers
			rect.on("click tap", (e) => {
				this.handleRectClick(rect, e);
			});

			// Add mousedown and touchstart handler
			rect.on("mousedown touchstart", (e) => {
				// Only allow drag to begin if the rectangle is already selected
				if (!this.selectedRects.includes(rect) && !e.evt.shiftKey) {
					rect.draggable(false);
				}
			});

			newRects.push(rect);
			this.selectedRects.push(rect);
		});

		// Use command system to paste rectangles
		const command = new PasteRectsCommand(newRects, this.shapeLayer);
		this.commandHistory.execute(command);

		// Set the last rect as the primary selected one
		if (this.selectedRects.length > 0) {
			this.selectedRect =
				this.selectedRects[this.selectedRects.length - 1];

			// Update controls for the primary selected rectangle
			this.colorInput.value = this.selectedRect.fill() as string;
			this.widthInput.value = this.selectedRect.width().toString();
			this.heightInput.value = this.selectedRect.height().toString();
		}

		// Update transformer to show all selected rectangles
		this.transformer.nodes(this.selectedRects);
	}

	undo(): void {
		if (this.reviewMode) return;

		console.log("Undoing last action");
		this.commandHistory.undo();

		// After undoing, update selection state
		this.updateSelectionState();
	}

	redo(): void {
		if (this.reviewMode) return;

		console.log("Redoing last action");
		this.commandHistory.redo();

		// After redoing, update selection state
		this.updateSelectionState();
	}

	// Helper method to update selection state after undo/redo
	updateSelectionState(): void {
		// First clear the current selection
		this.selectedRects = [];
		this.selectedRect = null;
		this.transformer.nodes([]);

		// We need a way to determine which rectangles should be selected after undo/redo
		// For now, we'll just work with what's visible and selectable on the stage
		this.resetDraggableState();
		this.shapeLayer.draw();
	}

	// Add this after the handleKeyDown method
	registerKeyboardShortcuts(): void {
		// Remove any existing event listener before adding a new one
		document.removeEventListener("keydown", this.handleKeyDown);
		document.removeEventListener("keyup", this.handleKeyUp);

		// Add the event listener to handle keyboard shortcuts
		document.addEventListener("keydown", this.handleKeyDown);
		document.addEventListener("keyup", this.handleKeyUp);

		// Log that shortcuts are registered
		console.log("Keyboard shortcuts registered for occlusion editor");
	}

	// Add the keyup handler
	handleKeyUp = (e: KeyboardEvent) => {
		if (e.key === "Shift" && !this.reviewMode) {
			// Hide the snapping indicator
			const statusElement = document.getElementById("snapping-status");
			if (statusElement) {
				statusElement.style.display = "none";
			}

			// Reset snapping state
			this.isSnapping = false;
		}
	};

	// Method to handle snapping during drag operations
	handleSnapping(rect: Konva.Rect): void {
		// Get all rectangles except the ones being dragged
		const otherRects = this.getAllOtherRectangles();

		// Calculate the current rect's edges
		const rectEdges = this.getRectangleEdges(rect);

		// Initialize variables to track the closest snapping distances using type assertion
		let closestSnapX = null as null | {
			distance: number;
			position: number;
		};
		let closestSnapY = null as null | {
			distance: number;
			position: number;
		};

		// Check each other rectangle for potential snap points
		otherRects.forEach((otherRect) => {
			const otherEdges = this.getRectangleEdges(otherRect);

			// Check horizontal snapping (left and right edges)
			this.checkEdgeSnapping(
				rectEdges.left,
				otherEdges,
				"horizontal",
				(position) => {
					if (
						closestSnapX === null ||
						Math.abs(position - rectEdges.left) <
							Math.abs(closestSnapX.distance)
					) {
						closestSnapX = {
							distance: position - rectEdges.left,
							position: position,
						};
					}
				}
			);

			this.checkEdgeSnapping(
				rectEdges.right,
				otherEdges,
				"horizontal",
				(position) => {
					if (
						closestSnapX === null ||
						Math.abs(position - rectEdges.right) <
							Math.abs(closestSnapX.distance)
					) {
						closestSnapX = {
							distance: position - rectEdges.right,
							position: position - rect.width(),
						};
					}
				}
			);

			// Check vertical snapping (top and bottom edges)
			this.checkEdgeSnapping(
				rectEdges.top,
				otherEdges,
				"vertical",
				(position) => {
					if (
						closestSnapY === null ||
						Math.abs(position - rectEdges.top) <
							Math.abs(closestSnapY.distance)
					) {
						closestSnapY = {
							distance: position - rectEdges.top,
							position: position,
						};
					}
				}
			);

			this.checkEdgeSnapping(
				rectEdges.bottom,
				otherEdges,
				"vertical",
				(position) => {
					if (
						closestSnapY === null ||
						Math.abs(position - rectEdges.bottom) <
							Math.abs(closestSnapY.distance)
					) {
						closestSnapY = {
							distance: position - rectEdges.bottom,
							position: position - rect.height(),
						};
					}
				}
			);
		});

		// Apply the snapping if we found any snap points within the threshold
		let newX = rect.x();
		let newY = rect.y();

		if (
			closestSnapX &&
			Math.abs(closestSnapX.distance) <= this.snapThreshold
		) {
			newX = closestSnapX.position;
		}

		if (
			closestSnapY &&
			Math.abs(closestSnapY.distance) <= this.snapThreshold
		) {
			newY = closestSnapY.position;
		}

		// Update the rectangle position
		rect.position({ x: newX, y: newY });

		// If we're moving multiple rectangles, adjust the others based on the snapped one
		if (this.selectedRects.length > 1) {
			const deltaX = newX - rect.x();
			const deltaY = newY - rect.y();

			this.selectedRects.forEach((selectedRect) => {
				if (selectedRect !== rect) {
					selectedRect.position({
						x: selectedRect.x() + deltaX,
						y: selectedRect.y() + deltaY,
					});
				}
			});
		}
	}

	// Get all rectangles except those currently selected
	getAllOtherRectangles(): Konva.Rect[] {
		const otherRects: Konva.Rect[] = [];

		this.shapeLayer.getChildren().forEach((node) => {
			if (
				node instanceof Konva.Rect &&
				!this.selectedRects.includes(node)
			) {
				otherRects.push(node);
			}
		});

		return otherRects;
	}

	// Calculate a rectangle's edge positions
	getRectangleEdges(rect: Konva.Rect): {
		left: number;
		right: number;
		top: number;
		bottom: number;
	} {
		return {
			left: rect.x(),
			right: rect.x() + rect.width(),
			top: rect.y(),
			bottom: rect.y() + rect.height(),
		};
	}

	// Check if an edge should snap to any of the other edges
	checkEdgeSnapping(
		edge: number,
		otherEdges: {
			left: number;
			right: number;
			top: number;
			bottom: number;
		},
		direction: "horizontal" | "vertical",
		callback: (position: number) => void
	): void {
		// Edges to check based on direction
		const edgesToCheck =
			direction === "horizontal"
				? [otherEdges.left, otherEdges.right]
				: [otherEdges.top, otherEdges.bottom];

		// Check if any edge is within the snap threshold
		edgesToCheck.forEach((otherEdge) => {
			const distance = Math.abs(edge - otherEdge);
			if (distance <= this.snapThreshold) {
				callback(otherEdge);
			}
		});
	}
}
