import React, { useState, useEffect } from "react";
import Konva from "konva";
import { ShapeControlsProps } from "../../types";

const ShapeControls: React.FC<ShapeControlsProps> = ({
	selectedRect,
	reviewMode,
	onAddRect,
	onDeleteRect,
	onSave,
}) => {
	const [color, setColor] = useState("#000000");
	const [width, setWidth] = useState("100");
	const [height, setHeight] = useState("100");
	const [resetVisible, setResetVisible] = useState(false);

	// Update input fields when selected rect changes
	useEffect(() => {
		if (selectedRect) {
			setColor(selectedRect.fill() as string);
			setWidth(Math.round(selectedRect.width()).toString());
			setHeight(Math.round(selectedRect.height()).toString());
		}
	}, [selectedRect]);

	// Handle color change
	const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const newColor = e.target.value;
		setColor(newColor);

		if (selectedRect && !reviewMode) {
			selectedRect.fill(newColor);
			selectedRect.getLayer()?.batchDraw();
		}
	};

	// Handle width change
	const handleWidthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const newWidth = e.target.value;
		setWidth(newWidth);

		if (selectedRect && !reviewMode) {
			selectedRect.width(parseFloat(newWidth));
			selectedRect.getLayer()?.batchDraw();
		}
	};

	// Handle height change
	const handleHeightChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const newHeight = e.target.value;
		setHeight(newHeight);

		if (selectedRect && !reviewMode) {
			selectedRect.height(parseFloat(newHeight));
			selectedRect.getLayer()?.batchDraw();
		}
	};

	// Reset all occlusions (make visible again)
	const handleReset = () => {
		// This will be implemented in the parent component
		setResetVisible(false);
	};

	return (
		<div className="flex flex-wrap items-center justify-between w-full gap-2 mt-2">
			{/* Shape controls - only show in edit mode */}
			<div
				className="flex flex-wrap items-center gap-2"
				style={{ display: reviewMode ? "none" : "flex" }}
			>
				{/* Color picker */}
				<div className="flex flex-col items-start">
					<label className="block mb-1 text-xs font-medium text-gray-700 dark:text-gray-300">
						Color
					</label>
					<input
						type="color"
						value={color}
						onChange={handleColorChange}
						className="w-10 h-8 border border-gray-300 rounded cursor-pointer dark:border-gray-600"
					/>
				</div>

				{/* Width and height inputs */}
				<div className="flex flex-col items-start">
					<label className="block mb-1 text-xs font-medium text-gray-700 dark:text-gray-300">
						Size
					</label>
					<div className="flex items-center gap-1">
						<div className="flex items-center">
							<span className="mr-1 text-xs font-medium text-gray-700 dark:text-gray-300">
								W:
							</span>
							<input
								type="number"
								value={width}
								onChange={handleWidthChange}
								min="10"
								className="block p-1 text-sm text-gray-900 border border-gray-300 rounded-lg bg-gray-50 focus:ring-blue-500 focus:border-blue-500 w-14 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
							/>
						</div>
						<div className="flex items-center">
							<span className="mr-1 text-xs font-medium text-gray-700 dark:text-gray-300">
								H:
							</span>
							<input
								type="number"
								value={height}
								onChange={handleHeightChange}
								min="10"
								className="block p-1 text-sm text-gray-900 border border-gray-300 rounded-lg bg-gray-50 focus:ring-blue-500 focus:border-blue-500 w-14 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
							/>
						</div>
					</div>
				</div>
			</div>

			{/* Action buttons */}
			<div className="flex flex-wrap gap-2">
				{/* Add button - only in edit mode */}
				<button
					onClick={onAddRect}
					className="inline-flex items-center px-3 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 focus:ring-4 focus:ring-green-300 dark:bg-green-500 dark:hover:bg-green-600 dark:focus:ring-green-800"
					style={{ display: reviewMode ? "none" : "inline-flex" }}
				>
					Add
				</button>

				{/* Delete button - only in edit mode */}
				<button
					onClick={onDeleteRect}
					className="inline-flex items-center px-3 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 focus:ring-4 focus:ring-red-300 dark:bg-red-500 dark:hover:bg-red-600 dark:focus:ring-red-800"
					style={{ display: reviewMode ? "none" : "inline-flex" }}
				>
					Delete
				</button>

				{/* Save button - only in edit mode */}
				<button
					onClick={onSave}
					className="inline-flex items-center px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:ring-4 focus:ring-blue-300 dark:bg-blue-500 dark:hover:bg-blue-600 dark:focus:ring-blue-800"
					style={{ display: reviewMode ? "none" : "inline-flex" }}
				>
					Save
				</button>

				{/* Reset button - only in review mode */}
				<button
					onClick={handleReset}
					className="inline-flex items-center px-3 py-2 text-sm font-medium text-white bg-yellow-500 rounded-lg hover:bg-yellow-600 focus:ring-4 focus:ring-yellow-300 dark:bg-yellow-500 dark:hover:bg-yellow-600 dark:focus:ring-yellow-800"
					style={{
						display:
							resetVisible && reviewMode ? "inline-flex" : "none",
					}}
				>
					Reset All
				</button>
			</div>
		</div>
	);
};

export default ShapeControls;
