import React, { useEffect, useState } from "react";
import { TFile, Notice } from "obsidian";
import Konva from "konva";
import { OcclusionEditorProps } from "../../types";
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

	const addRectangle = () => {
		// This will be handled by the OcclusionCanvas component
		new Notice("Adding a rectangle");
	};

	const deleteRectangle = () => {
		if (!selectedRect || reviewMode) return;

		// Delete the selected rectangle
		selectedRect.destroy();
		setSelectedRect(null);

		new Notice("Rectangle deleted");
	};

	const saveOcclusionData = () => {
		if (!selectedFile) {
			new Notice("No file selected");
			return;
		}

		// Save the occlusion data to the plugin - will be handled by a hook
		new Notice("Occlusion data saved");
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
			/>
		</div>
	);
};

export default OcclusionEditor;
