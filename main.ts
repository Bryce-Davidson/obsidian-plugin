import { App, Plugin, Notice, TFile, WorkspaceLeaf, ItemView } from "obsidian";
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
	fileData: { [filePath: string]: OcclusionShape[] };
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

	// Konva objects.
	stage: Konva.Stage;
	imageLayer: Konva.Layer;
	shapeLayer: Konva.Layer;
	transformer: Konva.Transformer;

	// Currently selected rectangle (if any).
	selectedRect: Konva.Rect | null = null;

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

		// Create a container div for Konva.
		this.konvaContainer = this.containerEl.createDiv(
			"konva-container"
		) as HTMLDivElement;
		this.konvaContainer.style.border = "1px solid #ccc";
		// Set fixed dimensions for simplicity.
		this.konvaContainer.style.width = "800px";
		this.konvaContainer.style.height = "600px";

		// Create control inputs.
		const controlsDiv = this.containerEl.createDiv("controls");
		// Colour picker.
		this.colorInput = controlsDiv.createEl("input", { type: "color" });
		this.colorInput.onchange = (e: Event) => {
			if (this.selectedRect) {
				this.selectedRect.fill((e.target as HTMLInputElement).value);
				this.shapeLayer.draw();
			}
		};
		// Width input.
		this.widthInput = controlsDiv.createEl("input", {
			type: "number",
			value: "100",
			attr: { placeholder: "Width" },
		});
		this.widthInput.onchange = () => {
			if (this.selectedRect) {
				this.selectedRect.width(parseFloat(this.widthInput.value));
				this.shapeLayer.draw();
			}
		};
		// Height input.
		this.heightInput = controlsDiv.createEl("input", {
			type: "number",
			value: "100",
			attr: { placeholder: "Height" },
		});
		this.heightInput.onchange = () => {
			if (this.selectedRect) {
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

		// Initialize the Konva stage and layers.
		this.stage = new Konva.Stage({
			container: this.konvaContainer, // now a HTMLDivElement
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

		// Attach a click handler on the stage to select shapes.
		this.stage.on("click", (e) => {
			// Deselect if clicked on an empty area.
			if (e.target === this.stage) {
				this.transformer.nodes([]);
				this.selectedRect = null;
				return;
			}
			// If a rectangle is clicked, select it.
			if (e.target instanceof Konva.Rect) {
				this.selectedRect = e.target;
				this.transformer.nodes([this.selectedRect]);
				// Update control values to match the selected shape.
				this.colorInput.value = this.selectedRect.fill() as string;
				this.widthInput.value = this.selectedRect.width().toString();
				this.heightInput.value = this.selectedRect.height().toString();
			}
		});

		// Update control values when a shape is transformed.
		this.shapeLayer.on("transformend", () => {
			if (this.selectedRect) {
				this.widthInput.value = this.selectedRect.width().toString();
				this.heightInput.value = this.selectedRect.height().toString();
			}
		});

		// Load the image (and any saved shapes) for the initially selected file, if any.
		if (this.fileSelectEl.value) {
			this.loadImage(this.fileSelectEl.value);
		}
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
			opacity: 0.5,
			draggable: true,
		});
		// Optionally, add a click handler directly on the rectangle.
		rect.on("click", () => {
			this.selectedRect = rect;
			this.transformer.nodes([rect]);
			this.colorInput.value = rect.fill() as string;
			this.widthInput.value = rect.width().toString();
			this.heightInput.value = rect.height().toString();
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
		const saved: OcclusionData = savedData || { fileData: {} };
		// Save shapes for the current file.
		saved.fileData[filePath] = shapes;
		await this.plugin.saveData(saved);
		new Notice("Occlusion data saved!");
	}

	// Load and render saved shapes for a given file.
	async loadSavedShapes(filePath: string): Promise<void> {
		const savedData =
			(await this.plugin.loadData()) as OcclusionData | null;
		const saved: OcclusionData = savedData || { fileData: {} };
		if (saved.fileData[filePath]) {
			saved.fileData[filePath].forEach((s: OcclusionShape) => {
				const rect = new Konva.Rect({
					x: s.x,
					y: s.y,
					width: s.width,
					height: s.height,
					fill: s.fill,
					opacity: s.opacity,
					draggable: true,
				});
				rect.on("click", () => {
					this.selectedRect = rect;
					this.transformer.nodes([rect]);
					this.colorInput.value = rect.fill() as string;
					this.widthInput.value = rect.width().toString();
					this.heightInput.value = rect.height().toString();
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
