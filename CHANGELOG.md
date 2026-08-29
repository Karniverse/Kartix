## Recent Changes

* **"Holy Grail" Trim Functionality**: Completely overhauled the FFmpeg trimming pipeline.
  * **Perfect A/V Sync**: Timestamps are correctly copied and reset, guaranteeing precise, fast-seek trims without audio desync or hardware encoder freezes.
  * **Zero Phantom Duration**: Fixed an issue where original chapter markers artificially inflated the length of trimmed video files.
  * **OOM Deadlock Prevention**: Implemented a novel Double-Input mapping strategy in the backend. You can now aggressively upscale video (e.g., 4K CPU scaling) while copying subtitles without triggering FFmpeg filter-graph memory leaks and crashes.
* **Video Tab Layout Overhaul**: The Video tab has been completely redesigned with a full-width header for source video details and a full-width footer for encoder settings.
* **Smart Scene Detection (Beta)**: Added a placeholder for intelligent FFmpeg scene detection inside the Chapters tab.
* **Auto-Chapter Enhancements**: You can now explicitly select the interval for automated chapter generation (2, 3, 5, 10, or 15 mins) using a new dropdown menu.
* **Sidebar UI Fixes**: Subtitle tracks will no longer awkwardly display `0 kbps` bitrates. The track bitrate now gracefully falls back to `Unknown` instead of completely disappearing when stream metadata is missing.
* **Subtitles & Chapters UI**: Reorganized the layout of the Subtitles tab for a cleaner professional grid, and expanded the Chapters tab to utilize the full screen width.
* **Build System Improvements**: The release script now supports optional version suffixes (e.g., `Beta`, `Alpha`) and properly skips the deprecated NSIS bundler to speed up MSI generation.
