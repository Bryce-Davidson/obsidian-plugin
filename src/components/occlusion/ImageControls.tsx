import React, { useState, useEffect } from "react";
import { TFile } from "obsidian";
import Fuse from "fuse.js";
import { ImageControlsProps } from "../../types";

const ImageControls: React.FC<ImageControlsProps> = ({
	selectedFile,
	imageFiles,
	onFileSelect,
	reviewMode,
	toggleReviewMode,
}) => {
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<TFile[]>([]);
	const [showResults, setShowResults] = useState(false);

	// Initialize Fuse.js for searching
	const [fuse, setFuse] = useState<Fuse<TFile> | null>(null);

	useEffect(() => {
		if (imageFiles.length > 0) {
			const fuseInstance = new Fuse(imageFiles, {
				keys: ["path", "name"],
				threshold: 0.4,
				ignoreLocation: true,
			});
			setFuse(fuseInstance);
		}
	}, [imageFiles]);

	const handleSearch = (query: string) => {
		setSearchQuery(query);

		if (query.trim() === "") {
			setShowResults(false);
			return;
		}

		if (fuse) {
			const results = fuse.search(query).map((result) => result.item);
			setSearchResults(results);
			setShowResults(true);
		}
	};

	const handleSelectFile = (filePath: string) => {
		onFileSelect(filePath);
		setSearchQuery(filePath);
		setShowResults(false);
	};

	const showAllImages = () => {
		setShowResults(true);
		setSearchResults(imageFiles);
	};

	return (
		<div className="flex flex-wrap items-center justify-between w-full gap-2">
			<div className="relative flex-grow max-w-full sm:max-w-xs">
				<label className="block mb-1 text-xs font-medium text-gray-700 dark:text-gray-300">
					Image
				</label>
				<input
					type="text"
					placeholder="Search for an image..."
					className="block w-full p-2 text-sm text-gray-900 border border-gray-300 rounded-lg bg-gray-50 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
					value={searchQuery}
					onChange={(e) => handleSearch(e.target.value)}
					onClick={showAllImages}
				/>

				{/* Search results dropdown */}
				{showResults && (
					<div className="absolute z-20 w-full mt-1 overflow-y-auto bg-white border border-gray-300 rounded-lg shadow-lg dark:bg-gray-800 dark:border-gray-600 max-h-60">
						{searchResults.length === 0 ? (
							<div className="p-2 text-sm text-gray-500 dark:text-gray-400">
								No matching images found
							</div>
						) : (
							searchResults.map((file, index) => (
								<div
									key={index}
									className="flex items-center p-2 text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
									onClick={() => handleSelectFile(file.path)}
								>
									<span className="flex-shrink-0 mr-2 text-gray-500">
										<svg
											className="w-4 h-4"
											xmlns="http://www.w3.org/2000/svg"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<rect
												x="3"
												y="3"
												width="18"
												height="18"
												rx="2"
												ry="2"
											></rect>
											<circle
												cx="8.5"
												cy="8.5"
												r="1.5"
											></circle>
											<polyline points="21 15 16 10 5 21"></polyline>
										</svg>
									</span>
									<span className="truncate">
										{file.path}
									</span>
								</div>
							))
						)}
					</div>
				)}
			</div>

			{/* Mode toggle and other controls */}
			<div className="flex items-center gap-2">
				<button
					className={`inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg text-white ${
						reviewMode
							? "bg-purple-600 hover:bg-purple-700"
							: "bg-blue-600 hover:bg-blue-700"
					}`}
					onClick={toggleReviewMode}
				>
					{reviewMode ? "Edit" : "Review"}
				</button>

				{/* Zoom controls */}
				<div className="flex items-center gap-1">
					<button
						title="Zoom In"
						aria-label="Zoom In"
						className="p-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 dark:text-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							className="w-5 h-5"
							viewBox="0 0 20 20"
							fill="currentColor"
						>
							<path
								fillRule="evenodd"
								d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z"
								clipRule="evenodd"
							/>
						</svg>
					</button>
					<button
						title="Zoom Out"
						aria-label="Zoom Out"
						className="p-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 dark:text-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							className="w-5 h-5"
							viewBox="0 0 20 20"
							fill="currentColor"
						>
							<path
								fillRule="evenodd"
								d="M5 10a1 1 0 011-1h8a1 1 0 110 2H6a1 1 0 01-1-1z"
								clipRule="evenodd"
							/>
						</svg>
					</button>
					<button
						title="Reset Zoom"
						aria-label="Reset Zoom"
						className="p-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 dark:text-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							className="w-5 h-5"
							viewBox="0 0 20 20"
							fill="currentColor"
						>
							<path
								fillRule="evenodd"
								d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
								clipRule="evenodd"
							/>
						</svg>
					</button>
				</div>
			</div>
		</div>
	);
};

export default ImageControls;
