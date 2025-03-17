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
import { OcclusionShape, OcclusionData } from "./main"; // Import the interfaces from main.ts

export const VIEW_TYPE_OCCLUSION = "occlusion-view";

export class OcclusionView extends ItemView {
	plugin: MyPlugin; // Change the type to MyPlugin

	containerEl: HTMLElement;
	fileSelectEl: HTMLSelectElement;
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
			cls: "flex-grow max-w-full sm:max-w-xs",
		});

		// Add a label above the select for better mobile UX
		fileSelectContainer.createEl("label", {
			text: "Image",
			cls: "block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1",
		});

		this.fileSelectEl = fileSelectContainer.createEl("select", {
			cls: "bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2 dark:bg-gray-700 dark:border-gray-600 dark:text-white",
		});

		const files = this.plugin.app.vault.getFiles();
		const imageFiles = files.filter((f) =>
			f.extension.match(/(png|jpe?g|gif)/i)
		);
		imageFiles.forEach((f: TFile) => {
			const option = this.fileSelectEl.createEl("option", {
				text: f.path,
			}) as HTMLOptionElement;
			option.value = f.path;
		});
		this.fileSelectEl.onchange = () => {
			this.loadImage(this.fileSelectEl.value);
		};

		// Create mode toggle and zoom controls in a group
		const controlsGroup = topRowContainer.createDiv({
			cls: "flex items-center gap-2",
		});

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

		zoomInButton.onclick = () => {
			this.currentScale *= 1.1;
			this.stage.scale({ x: this.currentScale, y: this.currentScale });
			this.stage.draw();
		};

		zoomOutButton.onclick = () => {
			this.currentScale *= 0.9;
			this.stage.scale({ x: this.currentScale, y: this.currentScale });
			this.stage.draw();
		};

		resetZoomButton.onclick = () => {
			this.currentScale = this.initialScale;
			this.stage.scale({ x: this.currentScale, y: this.currentScale });
			this.stage.draw();
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
			if (this.selectedRect && !this.reviewMode) {
				this.selectedRect.destroy();
				this.transformer.nodes([]);
				this.selectedRect = null;
				this.shapeLayer.draw();
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
			if (e.target === this.stage) {
				this.transformer.nodes([]);
				this.selectedRect = null;
			}
		});

		// Add mobile pinch zoom support
		let lastCenter: { x: number; y: number } | null = null;
		let lastDist = 0;

		this.stage.on("touchmove", (e) => {
			e.evt.preventDefault();

			const touch1 = e.evt.touches[0];
			const touch2 = e.evt.touches[1];

			// Handle pinch zoom
			if (touch1 && touch2) {
				// Calculate center point between two touches
				const center = {
					x: (touch1.clientX + touch2.clientX) / 2,
					y: (touch1.clientY + touch2.clientY) / 2,
				};

				// Calculate distance between touches
				const dist = Math.sqrt(
					Math.pow(touch2.clientX - touch1.clientX, 2) +
						Math.pow(touch2.clientY - touch1.clientY, 2)
				);

				if (!lastCenter) {
					lastCenter = center;
					lastDist = dist;
					return;
				}

				// Calculate scale change
				const scaleChange = dist / lastDist;

				// Update scale
				const newScale = this.currentScale * scaleChange;
				this.currentScale = newScale;
				this.stage.scale({ x: newScale, y: newScale });

				// Update position to zoom toward center point
				const newPos = {
					x: center.x - (center.x - this.stage.x()) * scaleChange,
					y: center.y - (center.y - this.stage.y()) * scaleChange,
				};
				this.stage.position(newPos);

				lastCenter = center;
				lastDist = dist;

				this.stage.batchDraw();
			}
		});

		this.stage.on("touchend", () => {
			lastCenter = null;
			lastDist = 0;
		});

		// Instead of using ResizeObserver, we can listen for leaf resize events
		this.registerInterval(
			window.setInterval(() => {
				// Check if container dimensions have changed
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
			}, 500) // Check every 500ms
		);

		// Add a transformer change event handler to update the width/height inputs
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

		// Add this after transformer transform event
		this.transformer.on("transformend", () => {
			if (this.selectedRect) {
				// Apply the scale to the width/height and reset scale to 1
				const newWidth = Math.round(
					this.selectedRect.width() * this.selectedRect.scaleX()
				);
				const newHeight = Math.round(
					this.selectedRect.height() * this.selectedRect.scaleY()
				);

				this.selectedRect.width(newWidth);
				this.selectedRect.height(newHeight);
				this.selectedRect.scaleX(1);
				this.selectedRect.scaleY(1);

				// Update the inputs
				this.widthInput.value = newWidth.toString();
				this.heightInput.value = newHeight.toString();
			}
		});

		if (this.fileSelectEl.value) {
			this.loadImage(this.fileSelectEl.value);
		}
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
			this.shapeLayer.getChildren().forEach((child: Konva.Node) => {
				if (child instanceof Konva.Rect) child.draggable(false);
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
		} else {
			this.controlsDiv.style.display = "";
			this.addRectButton.style.display = "";
			this.deleteButton.style.display = "";
			this.saveButton.style.display = "";
			this.resetButton.style.display = "none";
			this.transformer.visible(true);
			this.shapeLayer.getChildren().forEach((child: Konva.Node) => {
				if (child instanceof Konva.Rect) child.draggable(true);
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

		// Recreate transformer with free resize settings
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
		this.imageLayer.draw();
		this.shapeLayer.draw();

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

			// Add the image to the stage
			const kImage = new Konva.Image({
				image: img,
				x: 0,
				y: 0,
				width: nativeWidth,
				height: nativeHeight,
			});
			this.imageLayer.add(kImage);

			// Resize the stage to fit the container
			this.resizeStage();

			this.loadSavedShapes(filePath);
		};
		img.src = url;
	}

	addRectangle(): void {
		const rect = new Konva.Rect({
			x: 50,
			y: 50,
			width: 100,
			height: 100,
			fill: "#000000",
			opacity: 1,
			draggable: true,
		});
		rect.on("click tap", (e) => {
			e.cancelBubble = true;
			if (this.reviewMode) {
				rect.visible(!rect.visible());
				this.shapeLayer.draw();
			} else {
				this.selectedRect = rect;
				this.transformer.nodes([rect]);
				this.colorInput.value = rect.fill() as string;
				this.widthInput.value = rect.width().toString();
				this.heightInput.value = rect.height().toString();
			}
		});
		this.shapeLayer.add(rect);
		this.shapeLayer.draw();
	}

	async saveOcclusionData(): Promise<void> {
		const filePath = this.fileSelectEl.value;
		if (!filePath) return;
		const shapes: OcclusionShape[] = this.shapeLayer
			.getChildren()
			.map((shape: Konva.Node) => {
				if (shape instanceof Konva.Rect) {
					return {
						x: shape.x(),
						y: shape.y(),
						width: shape.width(),
						height: shape.height(),
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
				draggable: !this.reviewMode,
			});
			rect.on("click tap", (e) => {
				e.cancelBubble = true;
				if (this.reviewMode) {
					rect.visible(!rect.visible());
					this.shapeLayer.draw();
				} else {
					this.selectedRect = rect;
					this.transformer.nodes([rect]);
					this.colorInput.value = rect.fill() as string;
					this.widthInput.value = rect.width().toString();
					this.heightInput.value = rect.height().toString();
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

		this.stage.width(containerWidth);
		this.stage.height(containerHeight);

		// If we have an image loaded, adjust the scale to fit
		const backgroundImage = this.imageLayer.findOne("Image") as Konva.Image;
		if (backgroundImage) {
			const imgWidth = backgroundImage.width();
			const imgHeight = backgroundImage.height();

			// Calculate scale to fit the container while maintaining aspect ratio
			const scale = Math.min(
				containerWidth / imgWidth,
				containerHeight / imgHeight,
				1
			);

			this.initialScale = scale;
			this.currentScale = scale;
			this.stage.scale({ x: scale, y: scale });
		}

		this.stage.draw();
	}

	async onClose(): Promise<void> {
		// Optional cleanup if needed in the future
	}

	resetOcclusions(): void {
		if (!this.reviewMode) return;

		// Make all rectangles visible again
		this.shapeLayer.getChildren().forEach((child: Konva.Node) => {
			if (child instanceof Konva.Rect) {
				child.visible(true);
			}
		});

		this.shapeLayer.draw();
		new Notice("All occlusions reset");
	}
}

// Change the default export to be a class that extends MyPlugin
// This is no longer needed since we're using MyPlugin directly
// export default class OcclusionPlugin extends Plugin { ... }
