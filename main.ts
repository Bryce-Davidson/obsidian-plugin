import { Plugin, Notice, TFile, WorkspaceLeaf, ItemView } from "obsidian";
import Konva from "konva";

// Define an interface for a single occlusion shape.
interface OcclusionShape {
	x: number;
	y: number;
	width: number;
	height: number;
	fill: string;
	opacity: number;
}

// Define the occlusion data structure.
interface OcclusionData {
	notes: { [filePath: string]: OcclusionShape[] };
}

export default class OcclusionPlugin extends Plugin {
	async onload() {
		console.log("Loading Occlusion Plugin");

		// Register the custom view.
		this.registerView(
			OcclusionView.VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new OcclusionView(leaf, this)
		);

		// Add a ribbon icon to launch the view.
		this.addRibbonIcon("image-file", "Open Occlusion Editor", () => {
			this.activateView();
		});
	}

	async onunload() {
		this.app.workspace
			.getLeavesOfType(OcclusionView.VIEW_TYPE)
			.forEach((leaf: WorkspaceLeaf | null) => {
				if (leaf) leaf.detach();
			});
	}

	async activateView() {
		// Detach any existing views of this type.
		this.app.workspace.detachLeavesOfType(OcclusionView.VIEW_TYPE);
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice("Could not get a workspace leaf");
			return;
		}
		await leaf.setViewState({
			type: OcclusionView.VIEW_TYPE,
			active: true,
		});
		this.app.workspace.revealLeaf(leaf);
	}
}

class OcclusionView extends ItemView {
	static VIEW_TYPE = "occlusion-view";
	plugin: OcclusionPlugin;

	// HTML elements for the UI.
	containerEl: HTMLElement;
	fileSelectEl: HTMLSelectElement;
	addRectButton: HTMLButtonElement;
	saveButton: HTMLButtonElement;
	konvaContainer: HTMLDivElement;
	colorInput: HTMLInputElement;
	widthInput: HTMLInputElement;
	heightInput: HTMLInputElement;
	// Container for editing controls.
	controlsDiv: HTMLElement;
	// Button to toggle review/edit mode.
	modeToggleButton: HTMLButtonElement;

	// Konva objects.
	stage: Konva.Stage;
	imageLayer: Konva.Layer;
	shapeLayer: Konva.Layer;
	transformer: Konva.Transformer;

	// Currently selected rectangle (if any).
	selectedRect: Konva.Rect | null = null;

	// Mode flag: if true, we’re in review mode.
	reviewMode: boolean = false;

	constructor(leaf: WorkspaceLeaf, plugin: OcclusionPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return OcclusionView.VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Occlusion Editor";
	}

	async onOpen() {
		// Create a container for the plugin UI.
		this.containerEl = this.contentEl.createDiv("occlusion-editor");

		// Create a file selector populated with image files from the vault.
		this.fileSelectEl = this.containerEl.createEl(
			"select"
		) as HTMLSelectElement;
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

		// Add a button to toggle between edit and review mode.
		this.modeToggleButton = this.containerEl.createEl("button", {
			text: "Switch to Review Mode",
		});
		this.modeToggleButton.onclick = () => this.toggleReviewMode();

		// Create a container div for editing controls.
		this.controlsDiv = this.containerEl.createDiv("controls");
		// Colour picker.
		this.colorInput = this.controlsDiv.createEl("input", { type: "color" });
		this.colorInput.onchange = (e: Event) => {
			if (this.selectedRect && !this.reviewMode) {
				this.selectedRect.fill((e.target as HTMLInputElement).value);
				this.shapeLayer.draw();
			}
		};
		// Width input.
		this.widthInput = this.controlsDiv.createEl("input", {
			type: "number",
			value: "100",
			attr: { placeholder: "Width" },
		});
		this.widthInput.onchange = () => {
			if (this.selectedRect && !this.reviewMode) {
				this.selectedRect.width(parseFloat(this.widthInput.value));
				this.shapeLayer.draw();
			}
		};
		// Height input.
		this.heightInput = this.controlsDiv.createEl("input", {
			type: "number",
			value: "100",
			attr: { placeholder: "Height" },
		});
		this.heightInput.onchange = () => {
			if (this.selectedRect && !this.reviewMode) {
				this.selectedRect.height(parseFloat(this.heightInput.value));
				this.shapeLayer.draw();
			}
		};

		// Create UI buttons.
		this.addRectButton = this.containerEl.createEl("button", {
			text: "Add Occlusion",
		}) as HTMLButtonElement;
		this.addRectButton.onclick = () => this.addRectangle();

		this.saveButton = this.containerEl.createEl("button", {
			text: "Save",
		}) as HTMLButtonElement;
		this.saveButton.onclick = () => this.saveOcclusionData();

		// Create a container div for Konva.
		this.konvaContainer = this.containerEl.createDiv(
			"konva-container"
		) as HTMLDivElement;
		this.konvaContainer.style.border = "1px solid #ccc";
		// Set fixed dimensions for simplicity.
		this.konvaContainer.style.width = "800px";
		this.konvaContainer.style.height = "600px";

		// Initialize the Konva stage and layers.
		this.stage = new Konva.Stage({
			container: this.konvaContainer,
			width: 800,
			height: 600,
		});
		this.imageLayer = new Konva.Layer();
		this.shapeLayer = new Konva.Layer();
		this.stage.add(this.imageLayer);
		this.stage.add(this.shapeLayer);

		// Add a transformer for resizing and rotating.
		this.transformer = new Konva.Transformer();
		this.shapeLayer.add(this.transformer);

		// Attach a click handler on the stage.
		this.stage.on("click", (e) => {
			if (this.reviewMode) {
				// In review mode, let the rectangle click events handle toggling.
				return;
			}
			// In edit mode, deselect if clicking on an empty area.
			if (e.target === this.stage) {
				this.transformer.nodes([]);
				this.selectedRect = null;
				return;
			}
			// (The rectangle click events below handle selection in edit mode.)
		});

		// Load the image (and any saved shapes) for the initially selected file, if any.
		if (this.fileSelectEl.value) {
			this.loadImage(this.fileSelectEl.value);
		}
	}

	/**
	 * Toggle between edit mode and review mode.
	 * In review mode the editing controls are hidden, the transformer is disabled,
	 * and rectangles are set to non-draggable. In review mode clicking a rectangle toggles its visibility.
	 */
	toggleReviewMode(): void {
		this.reviewMode = !this.reviewMode;
		if (this.reviewMode) {
			// Hide editing controls.
			this.controlsDiv.style.display = "none";
			this.addRectButton.style.display = "none";
			this.saveButton.style.display = "none";
			// Disable transformer.
			this.transformer.nodes([]);
			this.transformer.visible(false);
			// Disable dragging for all rectangles.
			this.shapeLayer.getChildren().forEach((child) => {
				if (child instanceof Konva.Rect) {
					child.draggable(false);
				}
			});
			this.modeToggleButton.textContent = "Switch to Edit Mode";
		} else {
			// Show editing controls.
			this.controlsDiv.style.display = "";
			this.addRectButton.style.display = "";
			this.saveButton.style.display = "";
			this.transformer.visible(true);
			// Enable dragging for all rectangles.
			this.shapeLayer.getChildren().forEach((child) => {
				if (child instanceof Konva.Rect) {
					child.draggable(true);
				}
			});
			this.modeToggleButton.textContent = "Switch to Review Mode";
		}
		this.shapeLayer.draw();
	}

	// Load an image from the vault and render it as a Konva image.
	async loadImage(filePath: string): Promise<void> {
		// Clear previous layers.
		this.imageLayer.destroyChildren();
		this.shapeLayer.destroyChildren();
		// Re-add the transformer after clearing.
		this.transformer = new Konva.Transformer();
		this.shapeLayer.add(this.transformer);
		this.imageLayer.draw();
		this.shapeLayer.draw();

		const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (!file || !(file instanceof TFile)) {
			new Notice("File not found or not a valid image file");
			return;
		}
		// Read file as binary data.
		const data = await this.plugin.app.vault.readBinary(file);
		const blob = new Blob([data]);
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = () => {
			// Add the image to the image layer.
			const kImage = new Konva.Image({
				image: img,
				x: 0,
				y: 0,
				width: this.stage.width(),
				height: this.stage.height(),
			});
			this.imageLayer.add(kImage);
			this.imageLayer.draw();
			// Load saved occlusion shapes for this image.
			this.loadSavedShapes(filePath);
		};
		img.src = url;
	}

	// Adds a new occlusion rectangle (with default settings) to the shape layer.
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
		// Attach a click handler that behaves differently depending on mode.
		rect.on("click", (e) => {
			e.cancelBubble = true;
			if (this.reviewMode) {
				// In review mode, toggle the rectangle’s visibility.
				rect.visible(!rect.visible());
				this.shapeLayer.draw();
			} else {
				// In edit mode, select the rectangle for editing.
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

	// Save the current occlusion shapes to plugin data.
	async saveOcclusionData(): Promise<void> {
		const filePath = this.fileSelectEl.value;
		if (!filePath) return;
		// Extract data from each rectangle.
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

		// Load any existing occlusion data.
		const savedData =
			(await this.plugin.loadData()) as OcclusionData | null;
		const saved: OcclusionData = savedData || { notes: {} };
		// Save shapes for the current file.
		saved.notes[filePath] = shapes;
		await this.plugin.saveData(saved);
		new Notice("Occlusion data saved!");
	}

	// Load and render saved shapes for a given file.
	async loadSavedShapes(filePath: string): Promise<void> {
		const savedData =
			(await this.plugin.loadData()) as OcclusionData | null;
		const saved: OcclusionData = savedData || { notes: {} };
		if (saved.notes[filePath]) {
			saved.notes[filePath].forEach((s: OcclusionShape) => {
				const rect = new Konva.Rect({
					x: s.x,
					y: s.y,
					width: s.width,
					height: s.height,
					fill: s.fill,
					opacity: s.opacity,
					draggable: !this.reviewMode,
				});
				rect.on("click", (e) => {
					e.cancelBubble = true;
					if (this.reviewMode) {
						// In review mode, toggle the rectangle’s visibility.
						rect.visible(!rect.visible());
						this.shapeLayer.draw();
					} else {
						// In edit mode, select the rectangle.
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
	}

	async onClose(): Promise<void> {
		// Optional: Clean up any resources or event listeners.
	}
}
