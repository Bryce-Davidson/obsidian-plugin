import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import * as d3 from "d3";
import MyPlugin from "main";

export const VIEW_TYPE_GRAPH = "graph-view";

interface Node extends d3.SimulationNodeDatum {
	id: string;
	fileName?: string; // Defined for note nodes.
	path?: string; // Defined for note nodes.
	x: number;
	y: number;
	radius: number;
	color: string;
	// For flashcard nodes:
	type: "note" | "card";
	parent?: string; // The note id that this card belongs to.
	offsetX?: number; // Relative x-offset within the note container.
	offsetY?: number; // Relative y-offset within the note container.
	ef?: number; // The EF rating for card nodes.
}

interface Link extends d3.SimulationLinkDatum<Node> {
	source: string | Node;
	target: string | Node;
	value: number;
}

export class GraphView extends ItemView {
	private svg!: d3.Selection<SVGSVGElement, unknown, null, undefined>;
	private simulation!: d3.Simulation<Node, Link>;
	private noteNodes: Node[] = [];
	private cardNodes: Node[] = [];
	private links: Link[] = [];
	private zoom!: d3.ZoomBehavior<SVGSVGElement, unknown>;
	private container!: d3.Selection<SVGGElement, unknown, null, undefined>;
	private plugin: MyPlugin;
	private colorScale = d3.scaleOrdinal(d3.schemeCategory10);
	private efColorScale = d3.scaleLinear<string>().range(["red", "green"]);

	constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_GRAPH;
	}

	getIcon(): string {
		return "dot-network";
	}

	getDisplayText() {
		return "Graph View";
	}

	async onOpen() {
		const containerEl = this.containerEl;
		containerEl.empty();
		containerEl.addClass("graph-view-container");

		// Create a controls container.
		// const controlsEl = containerEl.createDiv({ cls: "graph-controls" });
		// controlsEl.createEl("h3", { text: "Graph View" });
		// Search control removed.

		// Create the SVG container.
		this.svg = d3
			.select(containerEl)
			.append("svg")
			.attr("width", "100%")
			.attr("height", "100%")
			.attr("class", "graph-view-svg");

		// Setup zoom behavior.
		this.zoom = d3
			.zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.1, 8])
			.on("zoom", (event) => {
				this.container.attr("transform", event.transform.toString());
			});
		this.svg.call(this.zoom);

		// Create a container group for the graph elements.
		this.container = this.svg.append("g").attr("class", "graph-container");

		// Load data and render the graph.
		await this.loadGraphData();
		this.renderGraph();

		// Re-render the graph when files are modified.
		this.registerEvent(
			this.app.vault.on("modify", () => {
				this.loadGraphData().then(() => this.renderGraph());
			})
		);
		this.registerEvent(
			this.app.vault.on("create", () => {
				this.loadGraphData().then(() => this.renderGraph());
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", () => {
				this.loadGraphData().then(() => this.renderGraph());
			})
		);
	}

	async loadGraphData() {
		// Reset arrays.
		this.noteNodes = [];
		this.cardNodes = [];
		this.links = [];

		// Load the plugin's stored flashcard data using the official API.
		const flashcardData = await this.plugin.loadData();

		// Get all markdown files for the notes.
		const files = this.app.vault.getMarkdownFiles();

		// Create a map for fast lookup of note nodes by file path.
		const noteMap = new Map<string, Node>();
		// Additionally, create a map by basename for wiki link resolution.
		const basenameMap = new Map<string, Node>();

		// Create note nodes from files using file.path as the unique id.
		for (const file of files) {
			const noteNode: Node = {
				id: file.path,
				fileName: file.basename,
				path: file.path,
				x: Math.random() * 800 - 400,
				y: Math.random() * 800 - 400,
				radius: 12, // Container node radius.
				color: this.colorScale(file.extension),
				type: "note",
			};
			this.noteNodes.push(noteNode);
			noteMap.set(file.path, noteNode);
			basenameMap.set(file.basename, noteNode);
		}

		// Create links between note nodes based on wiki links found in file content.
		// Use the basename map to resolve target nodes.
		for (const file of files) {
			const content = await this.app.vault.read(file);
			const wikiLinkRegex = /\[\[(.*?)(\|.*?)?\]\]/g;
			let match;
			while ((match = wikiLinkRegex.exec(content)) !== null) {
				// The target in a wiki link is typically the note's basename.
				const targetName = match[1].split("#")[0].split("|")[0].trim();
				const sourceNode = noteMap.get(file.path);
				const targetNode = basenameMap.get(targetName);
				if (sourceNode && targetNode) {
					this.links.push({
						source: sourceNode.id,
						target: targetNode.id,
						value: 1,
					});
				}
			}
		}

		// Process flashcard data.
		if (flashcardData && flashcardData.notes) {
			// The keys in flashcardData.notes are expected to be the note file paths.
			for (const notePath in flashcardData.notes) {
				const noteEntry = flashcardData.notes[notePath];
				const cards = noteEntry.cards;
				const cardIds = Object.keys(cards);
				const count = cardIds.length;
				// Only add flashcards if the note exists.
				if (count > 0 && noteMap.has(notePath)) {
					cardIds.forEach((cardId, index) => {
						// Retrieve the card's EF rating from the stored data.
						const cardData = cards[cardId];
						const ef = cardData.ef;
						// Compute an angle for a circular layout around the note.
						const angle = (2 * Math.PI * index) / count;
						const offset = 30; // Distance from the note center.
						const cardNode: Node = {
							id: `${notePath}_${cardId}`,
							x: 0, // Will be positioned relative to the parent note.
							y: 0,
							radius: 5, // Smaller radius for flashcards.
							// Temporarily set the color; will update after computing min/max EF.
							color: "",
							type: "card",
							parent: notePath,
							offsetX: Math.cos(angle) * offset,
							offsetY: Math.sin(angle) * offset,
							ef: ef,
						};
						this.cardNodes.push(cardNode);
					});
				}
			}
		}

		// Update the EF color scale dynamically based on the min and max EF among all cards.
		if (this.cardNodes.length > 0) {
			const minEF = d3.min(this.cardNodes, (d) => d.ef)!;
			const maxEF = d3.max(this.cardNodes, (d) => d.ef)!;
			this.efColorScale.domain([minEF, maxEF]);
			// Update each card node's color.
			this.cardNodes.forEach((card) => {
				if (card.ef !== undefined) {
					card.color = this.efColorScale(card.ef);
				}
			});
		}
		// Note: The force simulation will run only on the note nodes.
	}

	renderGraph() {
		const width = this.containerEl.clientWidth;
		const height = this.containerEl.clientHeight;

		// Clear existing graph.
		this.container.selectAll("*").remove();

		// Render links between note containers.
		const link = this.container
			.selectAll(".link")
			.data(this.links)
			.enter()
			.append("line")
			.attr("class", "link")
			.attr("stroke", "#999")
			.attr("stroke-opacity", 0.6)
			.attr("stroke-width", 1.5);

		// Create an SVG group for each note node.
		const noteGroup = this.container
			.selectAll(".note-node")
			.data(this.noteNodes)
			.enter()
			.append("g")
			.attr("class", "note-node")
			.call(
				d3
					.drag<SVGGElement, Node>()
					.on("start", (event, d) => this.dragStarted(event, d))
					.on("drag", (event, d) => this.dragged(event, d))
					.on("end", (event, d) => this.dragEnded(event, d))
			)
			.on("click", (event, d) => this.nodeClicked(d));

		// Append the note container circle.
		noteGroup
			.append("circle")
			.attr("r", (d) => d.radius)
			.attr("fill", (d) => d.color)
			.attr("stroke", "#fff")
			.attr("stroke-width", 1.5);

		// Append the note label just below the container and limit its length.
		noteGroup
			.append("text")
			.attr("x", 0)
			.attr("y", (d) => d.radius + 15)
			.attr("text-anchor", "middle")
			.text((d) => {
				const title = d.fileName ?? "";
				return title.length > 20
					? title.substring(0, 20) + "..."
					: title;
			})
			.attr("font-size", "10px")
			.attr("font-family", "sans-serif");

		// For each note, append flashcard nodes (if available) inside the container.
		noteGroup.each((d, i, groups) => {
			const parentGroup = d3.select(groups[i]);
			const cardsForNote = this.cardNodes.filter(
				(card) => card.parent === d.id
			);
			parentGroup
				.selectAll(".card-node")
				.data(cardsForNote)
				.enter()
				.append("circle")
				.attr("class", "card-node")
				.attr("r", (card) => card.radius)
				.attr("cx", (card) => card.offsetX!)
				.attr("cy", (card) => card.offsetY!)
				.attr("fill", (card) => card.color)
				.attr("stroke", "#fff")
				.attr("stroke-width", 1);
		});

		// Set up the force simulation on note nodes with adjusted forces.
		this.simulation = d3
			.forceSimulation<Node>(this.noteNodes)
			.force(
				"link",
				d3
					.forceLink<Node, Link>(this.links)
					.id((d) => d.id)
					.distance(100)
			)
			.force("charge", d3.forceManyBody().strength(-100))
			.force("center", d3.forceCenter(width / 2, height / 2))
			.force("x", d3.forceX(width / 2).strength(0.1))
			.force("y", d3.forceY(height / 2).strength(0.1))
			.force("collide", d3.forceCollide().radius(30))
			.on("tick", () => this.ticked(link, noteGroup));
	}

	ticked(
		link: d3.Selection<SVGLineElement, Link, SVGGElement, unknown>,
		noteGroup: d3.Selection<SVGGElement, Node, SVGGElement, unknown>
	) {
		// Update link positions.
		link.attr("x1", (d) => (typeof d.source === "object" ? d.source.x! : 0))
			.attr("y1", (d) => (typeof d.source === "object" ? d.source.y! : 0))
			.attr("x2", (d) => (typeof d.target === "object" ? d.target.x! : 0))
			.attr("y2", (d) =>
				typeof d.target === "object" ? d.target.y! : 0
			);

		// Update note container positions (which moves the card children as well).
		noteGroup.attr("transform", (d) => `translate(${d.x}, ${d.y})`);
	}

	dragStarted(event: d3.D3DragEvent<SVGGElement, Node, unknown>, d: Node) {
		if (!event.active) this.simulation.alphaTarget(0.3).restart();
		d.fx = d.x;
		d.fy = d.y;
	}

	dragged(event: d3.D3DragEvent<SVGGElement, Node, unknown>, d: Node) {
		d.fx = event.x;
		d.fy = event.y;
	}

	dragEnded(event: d3.D3DragEvent<SVGGElement, Node, unknown>, d: Node) {
		if (!event.active) this.simulation.alphaTarget(0);
		d.fx = null;
		d.fy = null;
	}

	nodeClicked(d: Node) {
		// Open the note file when its container is clicked.
		const file = this.app.vault.getAbstractFileByPath(d.path!);
		if (file instanceof TFile) {
			this.app.workspace.getLeaf().openFile(file);
		}
	}

	async onClose() {
		this.containerEl.empty();
	}
}
