import React, { useEffect, useState, useRef } from "react";
import { Stage, Layer, Image as KonvaImage, Transformer } from "react-konva";
import { TFile } from "obsidian";
import Controls from "./Controls";
import ShapeTools from "./ShapeTools";
import { OcclusionShape } from "./main";

interface OcclusionEditorProps {
	plugin: any;
	onClose: () => void;
}

const OcclusionEditor: React.FC<OcclusionEditorProps> = ({
	plugin,
	onClose,
}) => {
	const [selectedFile, setSelectedFile] = useState<string>("");
	const [imageFiles, setImageFiles] = useState<TFile[]>([]);
	const [reviewMode, setReviewMode] = useState(false);
	const [selectedRect, setSelectedRect] = useState(null);
	const [scale, setScale] = useState(1);

	// Refs for Konva elements
	const stageRef = useRef(null);
	const imageLayerRef = useRef(null);
	const shapeLayerRef = useRef(null);
	const transformerRef = useRef(null);

	// Load image files on mount
	useEffect(() => {
		const files = plugin.app.vault.getFiles();
		const imgFiles = files.filter((f) =>
			f.extension.match(/(png|jpe?g|gif)/i)
		);
		setImageFiles(imgFiles);

		if (imgFiles.length > 0) {
			setSelectedFile(imgFiles[0].path);
			loadImage(imgFiles[0].path);
		}
	}, []);

	// Functions to handle image loading, shapes, etc.
	const loadImage = async (filePath: string) => {
		// Similar logic to your current loadImage method
	};

	return (
		<div className="flex flex-col h-full bg-gray-50 dark:bg-gray-800">
			{/* Toolbar */}
			<div className="sticky top-0 z-10 p-3 bg-white shadow-md dark:bg-gray-700">
				<Controls
					selectedFile={selectedFile}
					imageFiles={imageFiles}
					onFileSelect={setSelectedFile}
					reviewMode={reviewMode}
					toggleReviewMode={() => setReviewMode(!reviewMode)}
					// Other props
				/>

				<ShapeTools
					selectedRect={selectedRect}
					reviewMode={reviewMode}
					onAddRect={addRectangle}
					onDeleteRect={deleteRectangle}
					onSave={saveOcclusionData}
					// Other props
				/>
			</div>

			{/* Konva Stage */}
			<div className="relative flex-1 overflow-auto border border-gray-300 dark:border-gray-600">
				<Stage
					ref={stageRef}
					width={window.innerWidth}
					height={window.innerHeight}
					// Event handlers
				>
					<Layer ref={imageLayerRef}>
						{/* Image will be added here */}
					</Layer>
					<Layer ref={shapeLayerRef}>
						{/* Shapes will be added here */}
						<Transformer ref={transformerRef} />
					</Layer>
				</Stage>
			</div>
		</div>
	);
};

export default OcclusionEditor;
