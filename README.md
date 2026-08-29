# Kartix Convert

![Kartix Convert](https://img.shields.io/badge/Status-Active-success) ![Tauri](https://img.shields.io/badge/Tauri-v2-blue) ![Rust](https://img.shields.io/badge/Rust-Backend-orange) ![React](https://img.shields.io/badge/React-Frontend-61DAFB)

Kartix Convert is a high-performance, modern video converter built with Rust and Tauri. Designed as an advanced alternative to Handbrake, it offers a beautifully crafted, glassmorphism-inspired UI with deeply customizable audio processing rules.

## Features

- **Blazing Fast Backend**: Powered by Rust and utilizing native FFmpeg bindings for zero-overhead video encoding.
- **Advanced Audio Routing**:
  - Automatically detect and preserve discrete 5.1 channel layouts (e.g., E-AC3 5.1 to AAC 5.1) without accidental downmixing.
  - Software upmixing for 2.0 stereo tracks using ProLogic II (DPL2).
  - EBU R128 Audio Normalization support.
  - Pass-through support for lossless audio copying.
- **Hardware Acceleration Detection**: Automatically profiles your system for NVENC (Nvidia), QSV (Intel), and AMF (AMD) encoders to accelerate video rendering.
- **Modern UI**: A premium React-based frontend featuring dark mode and reactive glass panels.
- **Chapter Generation**: Intelligently auto-generate spaced chapter intervals, with a placeholder for experimental FFmpeg scene-detection.
- **Job Queueing**: Queue up multiple files for batch processing and monitor real-time encoding progress.
- **Automated Releases**: Fully automated GitHub release workflow via CLI, handling MSI generation, Beta tagging, and changelog parsing.
- **"Holy Grail" Trims**: An extremely robust FFmpeg trimming strategy utilizing a double-input architecture to guarantee instantaneous hardware-seek trims, perfectly preserved A/V sync, zero phantom duration, and OOM-prevention during complex scaling pipelines.
## Prerequisites

- **FFmpeg & FFprobe**: Kartix Convert acts as an intelligent orchestrator for FFmpeg. You must have `ffmpeg` and `ffprobe` installed on your system and available in your system's PATH.
- **Node.js**: v18 or later for frontend development.
- **Rust**: Latest stable version (via `rustup`) for the backend.

## Getting Started

1. **Clone the repository**:
   ```bash
   git clone <your-repo-url>
   cd Kartix
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run in development mode**:
   ```bash
   npm run tauri dev
   ```
   This will start both the React development server and the Rust backend, opening the application window.

## Building for Production

To compile the application into a standalone binary:

```bash
npm run tauri build
```

The resulting executable will be placed in `src-tauri/target/release/`.

## Architecture

- **Frontend (`src/`)**: React 19 + Vite with Vanilla CSS utilizing CSS variables for consistent glassmorphism and modern aesthetics.
- **Backend (`src-tauri/src/`)**: Rust utilizing `std::process::Command` for spawned FFmpeg jobs and asynchronous FFprobe metadata extraction. Inter-process communication handles real-time logs and job states.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
