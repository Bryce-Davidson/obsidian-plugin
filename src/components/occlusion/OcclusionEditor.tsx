import React, { useEffect, useState } from "react";
import { TFile, Notice } from "obsidian";
import Konva from "konva";
import { OcclusionEditorProps, OcclusionShape } from "../../types";
import ImageControls from "./ImageControls";
import ShapeControls from "./ShapeControls";
import OcclusionCanvas from "./OcclusionCanvas";

const OcclusionEditor: React.FC<OcclusionEditorProps> = ({
	plugin,
	onClose,
	selectedFilePath,
}) => {
	const [selectedFile, setSelectedFile] = useState<string>("");
	const [imageFiles, setImageFiles] = useState<TFile[]>([]);
	const [reviewMode, setReviewMode] = useState(false);
	const [selectedRect, setSelectedRect] = useState<Konva.Rect | null>(null);
	const [shapes, setShapes] = useState<OcclusionShape[]>([]);

	// Load image files on mount
	useEffect(() => {
		const files = plugin.app.vault.getFiles();
		const imgFiles = files.filter((f: TFile) =>
			f.extension.match(/(png|jpe?g|gif)/i)
		);
		setImageFiles(imgFiles);

		// If a selectedFilePath is provided, use it
		if (selectedFilePath) {
			setSelectedFile(selectedFilePath);
		} else if (imgFiles.length > 0) {
			setSelectedFile(imgFiles[0].path);
		}
	}, [selectedFilePath]);

	// Load shapes when selectedFile changes
	useEffect(() => {
		if (selectedFile) {
			const savedShapes =
				plugin.occlusion.attachments[selectedFile] || [];
			setShapes(savedShapes);
		}
	}, [selectedFile]);

	const addRectangle = () => {
		// Don't use window object - create a new shape directly
		const newShape: OcclusionShape = {
			x: 100,
			y: 100,
			width: 100,
			height: 100,
			fill: "#000000",
			opacity: 0.5,
		};
		setShapes([...shapes, newShape]);

		// Optional: Notify with a notice
		new Notice("Rectangle added");
	};

	const deleteRectangle = () => {
		if (!selectedRect || reviewMode) return;

		// Find and delete the selected rectangle from shapes
		const shapeId = selectedRect.id();
		const index = parseInt(shapeId.split("-")[1]);
		if (index >= 0) {
			const newShapes = [...shapes];
			newShapes.splice(index, 1);
			setShapes(newShapes);
			setSelectedRect(null);
		}

		new Notice("Rectangle deleted");
	};

	const saveOcclusionData = () => {
		if (!selectedFile) {
			new Notice("No file selected");
			return;
		}

		// Save the current shapes
		console.log(`Saving ${shapes.length} shapes for ${selectedFile}`);
		plugin.saveOcclusionData(selectedFile, shapes);

		// Refresh reading views to show the updated occlusions
		refreshReadingViews();

		new Notice("Occlusion data saved");
	};

	// Helper function to refresh markdown reading views
	const refreshReadingViews = () => {
		const leaves = plugin.app.workspace.getLeavesOfType("markdown");

		for (const leaf of leaves) {
			const view = leaf.view;

			if (view.getMode && view.getMode() === "preview") {
				// Force a re-render of the reading view
				view.previewMode.rerender(true);
			}
		}
	};

	const handleShapesChange = (newShapes: OcclusionShape[]) => {
		// Prevent unnecessary state updates by comparing the current and new shapes
		const currentShapesJson = JSON.stringify(shapes);
		const newShapesJson = JSON.stringify(newShapes);

		if (currentShapesJson !== newShapesJson) {
			setShapes(newShapes);
		}
	};

	return (
		<div className="flex flex-col h-full bg-gray-50 dark:bg-gray-800">
			{/* Header with controls */}
			<div className="sticky top-0 z-10 p-3 bg-white shadow-md dark:bg-gray-700">
				{/* Image selector and mode toggle */}
				<ImageControls
					selectedFile={selectedFile}
					imageFiles={imageFiles}
					onFileSelect={setSelectedFile}
					reviewMode={reviewMode}
					toggleReviewMode={() => setReviewMode(!reviewMode)}
				/>

				{/* Shape manipulation tools */}
				<ShapeControls
					selectedRect={selectedRect}
					reviewMode={reviewMode}
					onAddRect={addRectangle}
					onDeleteRect={deleteRectangle}
					onSave={saveOcclusionData}
				/>
			</div>

			{/* Canvas area */}
			<OcclusionCanvas
				plugin={plugin}
				selectedFile={selectedFile}
				reviewMode={reviewMode}
				onShapeSelect={setSelectedRect}
				shapes={shapes}
				onShapesChange={handleShapesChange}
			/>
		</div>
	);
};

export default OcclusionEditor;
