# CUA Data Collection App

A powerful Electron-based application for capturing user interactions, screen recordings, and browser window screenshots for AI training data collection.

## Features

- **Multi-screen video recording** at ultra-high quality (up to 8K @ 60fps)
- **Global event capture** (mouse clicks, keyboard input, scrolling)
- **Browser window detection** with coordinate translation
- **Dual screenshot system** (full screen + browser window)
- **Atomic event ordering** ensures chronological accuracy
- **FFmpeg integration** for video processing and conversion
- **Cross-platform support** (macOS, Windows, Linux)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd cua_app
```

2. Install dependencies:
```bash
npm install
```

3. Install FFmpeg (required for video conversion):
   - **macOS**: `brew install ffmpeg`
   - **Windows**: Download from [FFmpeg.org](https://ffmpeg.org/download.html)
   - **Linux**: `sudo apt install ffmpeg` or `sudo yum install ffmpeg`

## Usage

1. Start the application:
```bash
npm start
```

2. Use the overlay window to:
   - Enter a task name
   - Click "Start" to begin recording
   - Click "Stop" or press F9 to end recording

### Keyboard Shortcuts

- **F9** - Stop recording
- **Escape** - Cancel recording
- **Ctrl+Shift+R** - Start recording with auto-generated task name

## Output Structure

Each recording session creates:
```
data/
└── [task-name]/
    ├── session_data.json     # Event data and metadata
    ├── screenshots/          # PNG screenshots
    │   ├── initial_*.png     # Initial state
    │   ├── final_*.png       # Final state
    │   └── event_*.png       # Per-event screenshots
    └── videos/               # MP4 video recordings
        └── recording_*.mp4   # Per-display recordings
```

## Technical Details

### Event Types Captured

- **Clicks** (left/right mouse buttons)
- **Drags** (mouse movements with button held)
- **Keyboard input** (letters, numbers, special keys)
- **Key combinations** (Ctrl+C, Cmd+V, etc.)
- **Scroll sequences** (debounced scroll events)

### Coordinate Systems

- **Desktop coordinates** - Global screen position
- **Browser-relative coordinates** - Position within browser window (when applicable)

### Video Quality

- **Resolution**: Up to 8K (7680x4320)
- **Frame rate**: 60 FPS
- **Bitrate**: 100 Mbps for near-lossless quality
- **Codec**: H.264 with ultra-high quality settings

## Platform-Specific Features

### macOS
- Uses `screencapture` for high-quality screenshots
- AppleScript integration for precise browser window detection
- Accessibility API integration for window bounds

### Windows/Linux
- Uses screenshot-desktop library
- FFmpeg for video capture and processing

## Development

### Project Structure
```
src/
├── main.js              # Main Electron process
├── renderer.js          # Main window renderer
├── overlay.html         # Recording overlay UI
├── video-recorder.html  # Video recording worker
└── index.html          # Main application window
```

### Dependencies

- **Electron** - Cross-platform desktop framework
- **uiohook-napi** - Global input event capture
- **screenshot-desktop** - Cross-platform screenshots
- **fluent-ffmpeg** - Video processing and conversion

## Requirements

- **Node.js** 16+ 
- **FFmpeg** (for video conversion)
- **macOS**: Accessibility permissions for window detection
- **Windows**: No additional requirements
- **Linux**: X11 display server

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Troubleshooting

### Common Issues

1. **"No screen sources found"** - Check screen recording permissions
2. **"AppleScript failed"** - Grant Accessibility permissions on macOS
3. **"FFmpeg not found"** - Install FFmpeg and ensure it's in PATH
4. **Small windows detected** - Increase window size threshold in code

### macOS Permissions

Grant permissions in System Preferences > Security & Privacy > Privacy:
- **Screen Recording** - Required for video capture
- **Accessibility** - Required for window detection