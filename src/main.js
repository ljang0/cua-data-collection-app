const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const screenshot = require('screenshot-desktop');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const ffmpeg = require('fluent-ffmpeg');

let mainWindow;
let overlayWindow;
let videoRecorderWindow;
let isRecording = false;
let currentTaskName = '';
let storedTaskName = '';
let sessionData = {
  events: [],
  screenshots: [],
  startTime: null,
  endTime: null
};
let eventCounter = 0;
let mediaRecorder;
let recordedChunks = [];

// Atomic event creation system to ensure chronological order
let eventSlots = new Map(); // eventId -> event object
let maxCompletedEventId = -1;

// Keyboard shortcut state tracking
let shiftPressed = false;
let ctrlPressed = false;
let altPressed = false;
let cmdPressed = false;

// Window bounds caching to fix race conditions
let cachedAppBounds = null;
let cachedAppWindow = null;
let lastBoundsUpdate = 0;
let boundsUpdateInProgress = false;
const BOUNDS_CACHE_DURATION = 2000; // 2 seconds cache
const BOUNDS_UPDATE_DEBOUNCE = 100; // 100ms debounce

// uiohook keycode mapping for better debugging
const keycodeMap = {
  // Letters (QWERTY layout)
  16: 'Q', 17: 'W', 18: 'E', 19: 'R', 20: 'T', 21: 'Y', 22: 'U', 23: 'I', 24: 'O', 25: 'P',
  30: 'A', 31: 'S', 32: 'D', 33: 'F', 34: 'G', 35: 'H', 36: 'J', 37: 'K', 38: 'L',
  44: 'Z', 45: 'X', 46: 'C', 47: 'V', 48: 'B', 49: 'N', 50: 'M',

  // Numbers
  11: '0', 2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9',

  // Function keys
  59: 'F1', 60: 'F2', 61: 'F3', 62: 'F4', 63: 'F5', 64: 'F6',
  65: 'F7', 66: 'F8', 67: 'F9', 68: 'F10', 87: 'F11', 88: 'F12',

  // Modifiers
  42: 'LEFT_SHIFT', 54: 'RIGHT_SHIFT',
  29: 'LEFT_CTRL', 3613: 'RIGHT_CTRL',
  56: 'LEFT_ALT', 3640: 'RIGHT_ALT',
  3675: 'LEFT_CMD', 3676: 'RIGHT_CMD',

  // Special keys
  1: 'ESCAPE', 28: 'ENTER', 57: 'SPACE', 14: 'BACKSPACE', 15: 'TAB',
  12: '-', 13: '=', 26: '[', 27: ']', 43: '\\', 39: ';', 40: "'", 41: '`',
  51: ',', 52: '.', 53: '/',

  // Arrow keys
  72: 'UP', 80: 'DOWN', 75: 'LEFT', 77: 'RIGHT',

  // Additional navigation keys
  71: 'HOME', 79: 'END', 73: 'PAGE_UP', 81: 'PAGE_DOWN',
  82: 'INSERT', 83: 'DELETE',

  // Numpad keys
  82: 'NUMPAD_0', 79: 'NUMPAD_1', 80: 'NUMPAD_2', 81: 'NUMPAD_3',
  75: 'NUMPAD_4', 76: 'NUMPAD_5', 77: 'NUMPAD_6',
  71: 'NUMPAD_7', 72: 'NUMPAD_8', 73: 'NUMPAD_9',
  83: 'NUMPAD_DOT', 78: 'NUMPAD_PLUS', 74: 'NUMPAD_MINUS',
  55: 'NUMPAD_MULTIPLY', 98: 'NUMPAD_DIVIDE', 28: 'NUMPAD_ENTER',

  // Lock keys
  58: 'CAPS_LOCK', 69: 'NUM_LOCK', 70: 'SCROLL_LOCK'
};

function getKeyName(keycode) {
  return keycodeMap[keycode] || `UNKNOWN_${keycode}`;
}

// Detect key combinations
function getKeyCombination(keycode, keyName) {
  // Don't detect combinations for modifier keys themselves
  const isModifierKey = [42, 54, 29, 3613, 56, 3640].includes(keycode); // Shift, Ctrl, Alt keys
  if (isModifierKey) return null;
  
  // Build combination string
  let combination = '';
  const modifiers = [];
  
  if (ctrlPressed || cmdPressed) modifiers.push(process.platform === 'darwin' ? 'Cmd' : 'Ctrl');
  if (altPressed) modifiers.push('Alt');
  if (shiftPressed) modifiers.push('Shift');
  
  if (modifiers.length === 0) return null; // No combination
  
  combination = modifiers.join('+') + '+' + keyName;
  
  // Map to common combination names
  const combinationMap = {
    'Ctrl+C': 'Copy',
    'Cmd+C': 'Copy',
    'Ctrl+V': 'Paste', 
    'Cmd+V': 'Paste',
    'Ctrl+X': 'Cut',
    'Cmd+X': 'Cut',
    'Ctrl+Z': 'Undo',
    'Cmd+Z': 'Undo',
    'Ctrl+Y': 'Redo',
    'Cmd+Y': 'Redo',
    'Ctrl+A': 'Select All',
    'Cmd+A': 'Select All',
    'Ctrl+S': 'Save',
    'Cmd+S': 'Save',
    'Ctrl+N': 'New',
    'Cmd+N': 'New',
    'Ctrl+O': 'Open',
    'Cmd+O': 'Open',
    'Ctrl+F': 'Find',
    'Cmd+F': 'Find',
    'Ctrl+T': 'New Tab',
    'Cmd+T': 'New Tab',
    'Ctrl+W': 'Close Tab',
    'Cmd+W': 'Close Tab',
    'Ctrl+ENTER': 'Ctrl+Enter',
    'Cmd+ENTER': 'Cmd+Enter',
    'Alt+TAB': 'App Switch',
    'Cmd+TAB': 'App Switch'
  };
  
  return {
    combination: combination,
    name: combinationMap[combination] || combination,
    modifiers: modifiers,
    key: keyName
  };
}

// Cached window bounds management to fix race conditions
async function updateCachedAppBounds() {
  if (boundsUpdateInProgress) {
    console.log('Bounds update already in progress, skipping...');
    return cachedAppBounds;
  }
  
  const now = Date.now();
  if (cachedAppBounds && (now - lastBoundsUpdate) < BOUNDS_CACHE_DURATION) {
    console.log('Using cached app bounds (fresh)');
    return cachedAppBounds;
  }
  
  boundsUpdateInProgress = true;
  console.log('Updating cached app bounds...');
  
  try {
    const appWindow = await getActiveApplicationWindow();
    if (!appWindow) {
      boundsUpdateInProgress = false;
      return null;
    }
    
    // Check if it's the same window as cached
    if (cachedAppWindow && cachedAppWindow.id === appWindow.id && 
        (now - lastBoundsUpdate) < BOUNDS_CACHE_DURATION) {
      console.log('Same app window detected, using cached bounds');
      boundsUpdateInProgress = false;
      return cachedAppBounds;
    }
    
    // Get fresh bounds for new/changed window
    const bounds = await getApplicationWindowBoundsRaw(appWindow);
    if (bounds) {
      cachedAppBounds = bounds;
      cachedAppWindow = appWindow;
      lastBoundsUpdate = now;
      console.log(`✓ Cached new app bounds for "${appWindow.name}": ${bounds.width}x${bounds.height} at (${bounds.x}, ${bounds.y})`);
    }
    
    boundsUpdateInProgress = false;
    return bounds;
  } catch (error) {
    console.error('Error updating cached app bounds:', error);
    boundsUpdateInProgress = false;
    return cachedAppBounds; // Return stale cache if available
  }
}

async function getCachedAppBounds() {
  // Return cached bounds if fresh enough
  const now = Date.now();
  if (cachedAppBounds && (now - lastBoundsUpdate) < BOUNDS_CACHE_DURATION) {
    return cachedAppBounds;
  }
  
  // Update cache if stale
  return await updateCachedAppBounds();
}

// Check if FFmpeg is available
function checkFFmpegAvailability() {
  return new Promise((resolve) => {
    ffmpeg.getAvailableFormats((err, formats) => {
      if (err) {
        console.warn('FFmpeg not available:', err.message);
        console.warn('Install FFmpeg from: https://ffmpeg.org/download.html');
        resolve(false);
      } else {
        console.log('✓ FFmpeg is available');
        resolve(true);
      }
    });
  });
}

// Convert video to MP4 using FFmpeg
async function convertToMP4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`Converting ${inputPath} to ${outputPath}...`);

    ffmpeg(inputPath)
      .videoCodec('libx264')          // H.264 codec
      .audioCodec('flac')             // Lossless audio codec
      .addOption('-preset', 'veryslow') // Slowest encoding for best compression/quality
      .addOption('-profile:v', 'high444') // H.264 High 4:4:4 Profile for lossless
      .addOption('-level', '5.2')     // Support up to 8K at higher bitrates
      .addOption('-pix_fmt', 'yuv444p') // Full chroma resolution for lossless
      .addOption('-crf', '0')         // Constant Rate Factor 0 = LOSSLESS
      .addOption('-qp', '0')          // Additional lossless parameter
      .addOption('-x264-params', 'keyint=60:min-keyint=15:ref=16:bframes=16:me=umh:subme=11:trellis=2:aq-mode=3:aq-strength=0.8:psy-rd=1.0:psy-trellis=0.2') // Ultra-high quality settings
      .addOption('-tune', 'stillimage') // Optimize for screen recording content
      .addOption('-movflags', '+faststart') // Better MP4 structure
      // Preserve original frame rate and resolution - don't force anything
      .format('mp4')                  // MP4 format
      .output(outputPath)
      .on('start', (commandLine) => {
        console.log('FFmpeg command:', commandLine);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`Conversion progress: ${Math.round(progress.percent)}%`);
        }
      })
      .on('end', () => {
        console.log(`✓ Conversion completed: ${outputPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error('FFmpeg conversion failed:', err.message);
        reject(err);
      })
      .run();
  });
}

// Direct FFmpeg recording for lossless MP4
let ffmpegProcesses = [];

// Native macOS screen recording
let nativeScreenRecordingProcesses = [];

async function startDirectFFmpegRecording() {
  try {
    console.log('Starting direct FFmpeg screen recording (lossless MP4)...');

    const displays = screen.getAllDisplays();
    console.log(`Found ${displays.length} displays for direct FFmpeg recording`);

    const { spawn } = require('child_process');
    ffmpegProcesses = [];

    for (let i = 0; i < displays.length; i++) {
      const display = displays[i];
      console.log(`Setting up direct FFmpeg recording for display ${display.id}: ${display.bounds.width}x${display.bounds.height}`);

      // Create lossless MP4 output path
      const outputPath = `data/${currentTaskName}/videos/ffmpeg_recording_display_${display.id}.mp4`;

      // FFmpeg command for direct screen capture to lossless MP4
      const ffmpegArgs = [
        '-y', // Overwrite output file
        '-f', 'avfoundation', // Use AVFoundation for macOS screen capture
        '-capture_cursor', '1', // Capture cursor
        '-capture_clicks', '1', // Capture click animations
        '-r', '60', // 60 FPS for smooth playback
        '-i', `${i}:none`, // Screen index with no audio
        '-c:v', 'libx264', // H.264 video codec
        '-preset', 'ultrafast', // Fast encoding for real-time
        '-crf', '0', // Lossless quality (CRF 0)
        '-pix_fmt', 'yuv444p', // Full chroma resolution
        '-tune', 'stillimage', // Optimize for screen content
        '-movflags', '+faststart', // Better MP4 structure
        '-avoid_negative_ts', 'make_zero', // Handle timestamps
        outputPath
      ];

      console.log(`FFmpeg command for display ${display.id}:`, 'ffmpeg', ffmpegArgs.join(' '));

      // Start FFmpeg process
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Ensure stdin is writable for graceful shutdown
      ffmpegProcess.stdin.setDefaultEncoding('utf8');

      ffmpegProcess.stdout.on('data', (data) => {
        console.log(`FFmpeg display ${display.id} stdout:`, data.toString());
      });

      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('frame=')) {
          // Parse frame info for progress
          const frameMatch = output.match(/frame=\s*(\d+)/);
          if (frameMatch) {
            const frameCount = parseInt(frameMatch[1]);
            if (frameCount % 300 === 0) { // Log every 5 seconds at 60fps
              console.log(`Display ${display.id} recording: ${frameCount} frames captured`);
            }
          }
        } else if (!output.includes('deprecated')) {
          console.log(`FFmpeg display ${display.id} stderr:`, output);
        }
      });

      ffmpegProcess.on('error', (error) => {
        console.error(`FFmpeg process error for display ${display.id}:`, error);
      });

      ffmpegProcess.on('exit', (code, signal) => {
        console.log(`FFmpeg process for display ${display.id} exited with code ${code}, signal ${signal}`);
      });

      ffmpegProcesses.push({
        process: ffmpegProcess,
        displayId: display.id,
        outputPath: outputPath,
        displayIndex: i
      });

      console.log(`✓ Direct FFmpeg recording started for display ${display.id}`);
    }

    console.log(`✅ Direct FFmpeg recording started for all ${displays.length} displays`);

  } catch (error) {
    console.error('Direct FFmpeg recording failed:', error);
    throw error;
  }
}

async function stopDirectFFmpegRecording() {
  try {
    console.log(`Stopping ${ffmpegProcesses.length} direct FFmpeg processes...`);

    const stopPromises = ffmpegProcesses.map(async (ffmpegInfo) => {
      return new Promise((resolve) => {
        const { process: ffmpegProcess, displayId, outputPath } = ffmpegInfo;

        console.log(`Sending 'q' command to FFmpeg process for display ${displayId}...`);

        // Set up timeout to force kill if needed
        const forceKillTimeout = setTimeout(() => {
          console.warn(`FFmpeg process for display ${displayId} taking too long, sending SIGTERM...`);
          ffmpegProcess.kill('SIGTERM');

          // Final timeout for SIGKILL
          setTimeout(() => {
            if (!ffmpegProcess.killed) {
              console.warn(`Force killing FFmpeg process for display ${displayId}`);
              ffmpegProcess.kill('SIGKILL');
            }
          }, 3000);
        }, 10000); // 10 second timeout for graceful shutdown

        ffmpegProcess.on('exit', (code, signal) => {
          clearTimeout(forceKillTimeout);
          console.log(`✓ FFmpeg process for display ${displayId} exited (code: ${code}, signal: ${signal}), video saved: ${outputPath}`);
          resolve();
        });

        ffmpegProcess.on('error', (error) => {
          clearTimeout(forceKillTimeout);
          console.error(`FFmpeg process error for display ${displayId}:`, error);
          resolve(); // Still resolve to not hang the promise
        });

        // Send 'q' command to FFmpeg stdin for graceful shutdown
        try {
          ffmpegProcess.stdin.write('q\n');
          ffmpegProcess.stdin.end();
        } catch (error) {
          console.warn(`Could not send 'q' command to FFmpeg for display ${displayId}, sending SIGINT instead`);
          ffmpegProcess.kill('SIGINT');
        }
      });
    });

    // Wait for all processes to stop
    await Promise.all(stopPromises);

    // Clear the processes array
    ffmpegProcesses = [];

    console.log('✅ All direct FFmpeg recordings stopped successfully');

  } catch (error) {
    console.error('Error stopping direct FFmpeg recordings:', error);
  }
}

// Native macOS screen recording using screencapture
async function startNativeScreenRecording() {
  try {
    console.log('Starting native macOS screen recording...');

    const displays = screen.getAllDisplays();
    console.log(`Found ${displays.length} displays for native recording`);

    const { spawn } = require('child_process');
    nativeScreenRecordingProcesses = [];

    for (let i = 0; i < displays.length; i++) {
      const display = displays[i];
      console.log(`Setting up native recording for display ${display.id}: ${display.bounds.width}x${display.bounds.height}`);

      // Create output path
      const outputPath = `data/${currentTaskName}/videos/native_recording_display_${display.id}.mov`;

      // screencapture command for video recording
      const screencaptureArgs = [
        '-D', display.id.toString(), // Specific display
        '-v', // Video recording mode
        '-k', // Show clicks in video recording mode
        '-C', // Capture the cursor as well as the screen
        '-x', // Do not play sounds (quiet)
        outputPath
      ];

      console.log(`Native recording command for display ${display.id}:`, 'screencapture', screencaptureArgs.join(' '));

      // Start screencapture process
      const recordingProcess = spawn('screencapture', screencaptureArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      recordingProcess.stdout.on('data', (data) => {
        console.log(`Native recording display ${display.id} stdout:`, data.toString());
      });

      recordingProcess.stderr.on('data', (data) => {
        const output = data.toString();
        console.log(`Native recording display ${display.id} stderr:`, output);
      });

      recordingProcess.on('error', (error) => {
        console.error(`Native recording process error for display ${display.id}:`, error);
      });

      recordingProcess.on('exit', (code, signal) => {
        console.log(`Native recording process for display ${display.id} exited with code ${code}, signal ${signal}`);
      });

      nativeScreenRecordingProcesses.push({
        process: recordingProcess,
        displayId: display.id,
        outputPath: outputPath,
        displayIndex: i
      });

      console.log(`✓ Native recording started for display ${display.id}`);
    }

    console.log(`✅ Native recording started for all ${displays.length} displays`);

  } catch (error) {
    console.error('Native screen recording failed:', error);
    throw error;
  }
}

async function stopNativeScreenRecording() {
  try {
    console.log(`Stopping ${nativeScreenRecordingProcesses.length} native recording processes...`);

    const stopPromises = nativeScreenRecordingProcesses.map(async (recordingInfo) => {
      return new Promise((resolve) => {
        const { process: recordingProcess, displayId, outputPath } = recordingInfo;

        console.log(`Sending SIGINT to native recording process for display ${displayId}...`);

        // Set up timeout to force kill if needed
        const forceKillTimeout = setTimeout(() => {
          console.warn(`Native recording process for display ${displayId} taking too long, sending SIGTERM...`);
          recordingProcess.kill('SIGTERM');

          // Final timeout for SIGKILL
          setTimeout(() => {
            if (!recordingProcess.killed) {
              console.warn(`Force killing native recording process for display ${displayId}`);
              recordingProcess.kill('SIGKILL');
            }
          }, 3000);
        }, 5000); // 5 second timeout

        recordingProcess.on('exit', async (code, signal) => {
          clearTimeout(forceKillTimeout);
          console.log(`✓ Native recording process for display ${displayId} exited (code: ${code}, signal: ${signal}), video saved: ${outputPath}`);
          await handleRecordingExitAndExtract(outputPath, displayId);
          resolve();
        });

        recordingProcess.on('error', (error) => {
          clearTimeout(forceKillTimeout);
          console.error(`Native recording process error for display ${displayId}:`, error);
          resolve(); // Still resolve to not hang the promise
        });

        // Send graceful termination signal
        recordingProcess.kill('SIGINT');
      });
    });

    // Wait for all processes to stop
    await Promise.all(stopPromises);

    // Clear the processes array
    nativeScreenRecordingProcesses = [];

    console.log('✅ All native recordings stopped successfully');

  } catch (error) {
    console.error('Error stopping native recordings:', error);
  }
}

async function handleRecordingExitAndExtract(outputPath, displayId) {
  try {
    const sessionJsonPath = `data/${currentTaskName}/session_data.json`;

    const frames = await extractPreActionFrames(outputPath, sessionJsonPath, {
      displayId,
      width: null,
      outDir: `data/${currentTaskName}/videos/frames_display_${displayId}`,
      alsoFinal: true,
    });

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('preaction-frames-ready', {
        displayId,
        videoPath: outputPath,
        frames,
      });
    }
    console.log(`✓ Extracted ${frames.length} pre-action frames for display ${displayId}`);
  } catch (err) {
    console.error(`Pre-action frame extraction failed for display ${displayId}:`, err);
  }
}

async function getVideoResolution(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      const stream = data.streams.find(s => s.codec_type === 'video');
      resolve({
        width: stream.width,
        height: stream.height,
      });
    });
  });
}

// Accurate single-frame grab at a timestamp.
// Note: put -ss AFTER -i for frame-accurate seeks.
async function grabFrameAt(inputPath, outPath, seconds, width = null) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputPath)
      .outputOptions(['-frames:v', '1', '-q:v', '1', '-pix_fmt', 'rgb24']);

    if (width) {
      cmd = cmd.videoFilters(`scale=${width}:-1:flags=lanczos`);
    }

    cmd
      .on('end', resolve)
      .on('error', reject)
      .seekInput(seconds)
      .output(outPath)
      .run();
  });
}

// Probe duration with ffprobe (seconds as number).
async function getVideoDurationSec(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      const stream = data.streams.find(s => s.codec_type === 'video');
      resolve(stream?.duration ? parseFloat(stream.duration) : parseFloat(data.format.duration || '0'));
    });
  });
}

async function extractPreActionFrames(videoPath, sessionJsonPath, {
  displayId = 1,
  width = null,           // null => auto-probe native width
  outDir = null,
  includeFinal = true,    // also capture midpoint between last event and end
} = {}) {
  const raw = await fs.readFile(sessionJsonPath, 'utf8');
  const session = JSON.parse(raw);

  // Sort events by time
  const events = (session?.events || [])
    .filter(e => typeof e.timestamp === 'number')
    .sort((a, b) => a.timestamp - b.timestamp);

  const duration = await getVideoDurationSec(videoPath);

  // use video duration as session length fallback
  const sessionLen = duration;

  if (!outDir) {
    outDir = path.join(path.dirname(videoPath), `frames_display_${displayId}`);
  }
  await fs.mkdir(outDir, { recursive: true });

  // decide output width
  const { width: nativeWidth } = await getVideoResolution(videoPath);
  const targetWidth = width ?? (nativeWidth || null);

  const results = [];
  const eps = 1e-3;

  let outPath = path.join(outDir, 'initial_screen.png')
  let nextT = (1 < events.length) ? events[1].timestamp : sessionLen;
  let t = (0.00 + nextT) / 2 
  await grabFrameAt(videoPath, outPath, t, targetWidth);
  results.push({t, outPath });

  for (let i = 0; i < events.length; i++) {
    const cur = events[i];
    nextT = (i < events.length - 1) ? events[i + 1].timestamp : sessionLen;

    // midpoint between current and next (or end of session for last)
    let t = (cur.timestamp + nextT) / 2;
    t = Math.min(Math.max(0, t), Math.max(0, duration - eps));

    const id = cur.id ?? i;
    outPath = path.join(outDir, `event_${String(id)}.png`);
    await grabFrameAt(videoPath, outPath, t, targetWidth);
    results.push({ id, t, outPath });
  }

  if (includeFinal && duration > 0 && events.length > 0) {
    const lastT = events.at(-1).timestamp;
    const tFinal = Math.min((lastT + sessionLen) / 2, duration - eps);
    const finalPath = path.join(outDir, `final_mid.png`);
    await grabFrameAt(videoPath, finalPath, tFinal, targetWidth);
    results.push({ id: 'final', t: tFinal, outPath: finalPath });
  }

  return results;
}



// Helper function to get video-relative timestamp in seconds
function getVideoTimestamp() {
  if (!sessionData.startTime) {
    return 0;
  }
  return (Date.now() - sessionData.startTime) / 1000;
}

// Get current screen information for event context
function getCurrentScreenInfo(x, y) {
  const displays = screen.getAllDisplays();
  const currentDisplay = screen.getDisplayNearestPoint({ x, y });
  
  return {
    currentDisplay: {
      id: currentDisplay.id,
      bounds: currentDisplay.bounds,
      workArea: currentDisplay.workArea,
      scaleFactor: currentDisplay.scaleFactor
    },
    allDisplays: displays.map(display => ({
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor
    })),
    totalDisplays: displays.length
  };
}


// Get application window bounds for coordinate translation (raw, uncached)
async function getApplicationWindowBoundsRaw(appWindow) {
  try {
    if (!appWindow) {
      console.log('No application window provided for bounds calculation');
      return null;
    }

    console.log(`Getting bounds for application window: "${appWindow.name}"`);

    // On macOS, try to get precise window bounds using simpler approach
    if (process.platform === 'darwin') {
      const { exec } = require('child_process');
      const windowId = appWindow.id.split(':')[1];
      
      return new Promise((resolve) => {
        // AppleScript - get the complete Chrome application window bounds (including all UI)
        const script = `
          tell application "System Events"
            try
              set frontProcess to first application process whose frontmost is true
              set processName to name of frontProcess
              
              -- Get all windows and find bounds that encompass the entire Chrome application
              set allWindows to every window of frontProcess
              
              -- Initialize bounds tracking
              set minX to 9999
              set minY to 9999
              set maxX to 0
              set maxY to 0
              
              -- Find the overall bounding box of all Chrome windows
              repeat with currentWindow in allWindows
                set {x, y} to position of currentWindow
                set {w, h} to size of currentWindow
                
                -- Update bounding box
                if x < minX then set minX to x
                if y < minY then set minY to y
                if (x + w) > maxX then set maxX to x + w
                if (y + h) > maxY then set maxY to y + h
              end repeat
              
              -- Calculate total bounds
              set totalX to minX
              set totalY to minY
              set totalWidth to maxX - minX
              set totalHeight to maxY - minY
              
              -- Log what we found for debugging
              log "Process: " & processName
              log "Found " & (count of allWindows) & " windows"
              log "Complete app bounds - Position: " & totalX & ", " & totalY
              log "Complete app bounds - Size: " & totalWidth & " x " & totalHeight
              
              return totalX & "," & totalY & "," & totalWidth & "," & totalHeight
            on error errMsg
              return "error:" & errMsg
            end try
          end tell
        `;
        
        exec(`osascript -e '${script}'`, { timeout: 2000 }, (error, stdout, stderr) => {
          const output = stdout ? stdout.trim() : '';
          console.log('AppleScript output:', output);
          console.log('AppleScript error:', error?.message);
          console.log('AppleScript stderr:', stderr);
          
          if (error || output.startsWith('error') || output === 'no_browser' || !output) {
            console.log('AppleScript failed - cannot get accurate browser bounds');
            console.log('This may be due to missing macOS accessibility permissions');
            console.log('Try: System Preferences > Security & Privacy > Privacy > Accessibility > Add Electron');
            resolve(null);  // Return null instead of guessing
          } else {
            // Handle malformed comma-separated output (e.g., "0, ,, 0, ,, 1440, ,, 41")
            const parts = output.split(',')
              .map(part => part.trim())     // Remove whitespace
              .filter(part => part !== '')  // Remove empty strings
              .map(Number);                 // Convert to numbers
            
            if (parts.length !== 4) {
              console.log(`AppleScript returned unexpected format. Expected 4 values, got ${parts.length}:`, parts);
              resolve(null);
              return;
            }
            
            const [x, y, width, height] = parts;
            console.log(`Browser window bounds: x=${x}, y=${y}, width=${width}, height=${height}`);
            resolve({
              x: x,
              y: y, 
              width: width,
              height: height,
              windowName: appWindow.name,
              method: 'applescript'
            });
          }
        });
      });
    } else {
      // For other platforms, we cannot accurately determine browser bounds
      console.log('Non-macOS platform - browser coordinate translation not available');
      return null;
    }
  } catch (error) {
    console.error('Error getting browser window bounds:', error);
    return null;
  }
}

// Get application window bounds with caching (prevents race conditions)
async function getApplicationWindowBounds() {
  return await getCachedAppBounds();
}

// Atomic event creation system for guaranteed chronological order
function createEventSlot(eventType, basicData = {}) {
  const eventId = eventCounter++;
  const timestamp = getVideoTimestamp();
  const absoluteTimestamp = Date.now();
  
  // Pre-allocate event slot with basic data
  const eventSlot = {
    id: eventId,
    type: eventType,
    timestamp: timestamp,
    absoluteTimestamp: absoluteTimestamp,
    _pending: true,
    ...basicData
  };
  
  eventSlots.set(eventId, eventSlot);
  console.log(`Created event slot ${eventId} for ${eventType}`);
  
  return {
    eventId,
    timestamp,
    absoluteTimestamp,
    complete: (completeData) => completeEvent(eventId, completeData)
  };
}

async function completeEvent(eventId, completeData = {}) {
  const eventSlot = eventSlots.get(eventId);
  if (!eventSlot) {
    console.error(`Event slot ${eventId} not found!`);
    return;
  }
  
  // Wait for action to render before taking screenshot
  console.log(`Waiting for action to render for event ${eventId}...`);
  await new Promise(resolve => setTimeout(resolve, 800)); // 800ms delay for full rendering
  
  // Take screenshot with the pre-assigned event ID
  console.log(`Taking screenshot for event ${eventId}...`);
  const screenshots = await captureScreenshot(eventId);
  
  // Complete the event data
  const completeEvent = {
    ...eventSlot,
    ...completeData,
    _pending: false
  };
  
  // Add screenshots if captured
  if (screenshots) {
    completeEvent.screenshots = {
      displays: screenshots.screenPaths,
      appWindow: screenshots.appWindowPath
    };
    console.log(`✓ Added screenshot paths to event ${eventId}: ${screenshots.screenPaths.length} displays`);
  }
  
  // Update the slot
  eventSlots.set(eventId, completeEvent);
  console.log(`Completed event ${eventId} (${completeEvent.type})`);
  
  // Try to finalize completed events in chronological order
  finalizeCompletedEvents();
}

function finalizeCompletedEvents() {
  // Find consecutive completed events starting from maxCompletedEventId + 1
  let nextEventId = maxCompletedEventId + 1;
  
  while (eventSlots.has(nextEventId)) {
    const event = eventSlots.get(nextEventId);
    
    if (event._pending) {
      // Hit a pending event, stop here
      break;
    }
    
    // Remove internal tracking fields
    const finalEvent = { ...event };
    delete finalEvent._pending;
    
    // Add to sessionData in chronological order
    sessionData.events.push(finalEvent);
    
    // Clean up
    eventSlots.delete(nextEventId);
    maxCompletedEventId = nextEventId;
    
    console.log(`Finalized event ${nextEventId} in chronological order`);
    nextEventId++;
  }
}

function clearEventSlots() {
  eventSlots.clear();
  maxCompletedEventId = -1;
  console.log('Event slots cleared');
}

// Focus change detection to update cached bounds
let focusChangeInterval;
let lastActiveWindowId = null;

function startFocusChangeDetection() {
  if (focusChangeInterval) {
    clearInterval(focusChangeInterval);
  }
  
  // Check for window focus changes every 500ms during recording
  focusChangeInterval = setInterval(async () => {
    if (!isRecording) return;
    
    try {
      const currentWindow = await getActiveApplicationWindow();
      if (currentWindow && currentWindow.id !== lastActiveWindowId) {
        console.log(`Focus changed to: "${currentWindow.name}" (${currentWindow.id})`);
        lastActiveWindowId = currentWindow.id;
        
        // Update bounds cache immediately when focus changes
        setTimeout(async () => {
          await updateCachedAppBounds();
        }, BOUNDS_UPDATE_DEBOUNCE);
      }
    } catch (error) {
      console.error('Error in focus change detection:', error);
    }
  }, 500);
}

function stopFocusChangeDetection() {
  if (focusChangeInterval) {
    clearInterval(focusChangeInterval);
    focusChangeInterval = null;
  }
  lastActiveWindowId = null;
}

// Calculate application-relative coordinates
function getApplicationRelativeCoordinates(desktopX, desktopY, appBounds) {
  if (!appBounds) {
    console.log('No application bounds available for coordinate calculation');
    return null;
  }
  
  const relativeX = desktopX - appBounds.x;
  const relativeY = desktopY - appBounds.y;
  
  // Check if coordinates are within application window
  const isInsideApp = relativeX >= 0 && 
                         relativeY >= 0 && 
                         relativeX <= appBounds.width && 
                         relativeY <= appBounds.height;
  
  console.log(`Coordinate conversion: desktop(${desktopX}, ${desktopY}) → app(${relativeX}, ${relativeY}), inside=${isInsideApp}`);
  
  return {
    x: relativeX,
    y: relativeY,
    isInsideApp: isInsideApp,
    applicationWindow: {
      x: appBounds.x,
      y: appBounds.y,
      width: appBounds.width,
      height: appBounds.height,
      name: appBounds.windowName,
      method: appBounds.method
    }
  };
}

// Get active browser window info 
// Get active application window (any frontmost app)
async function getActiveApplicationWindow() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 150, height: 150 }
    });
    
    console.log(`Found ${sources.length} windows. Looking for frontmost application...`);
    
    // Log all window names and sizes for debugging
    sources.forEach(source => {
      const size = source.thumbnail?.getSize ? source.thumbnail.getSize() : 'unknown size';
      const sizeStr = size !== 'unknown size' ? `${size.width}x${size.height}` : 'unknown size';
      console.log(`Window: "${source.name}" (id: ${source.id}) - ${sizeStr}`);
    });
    
    // Filter out system windows and small notification windows
    const appWindows = sources.filter(source => {
      const name = source.name.toLowerCase();
      
      // Skip system/utility windows
      const isSystemWindow = name.includes('desktop') ||
                            name.includes('wallpaper') ||
                            name.includes('menubar') ||
                            name.includes('dock') ||
                            name === '' ||
                            name.length < 2;
      
      if (isSystemWindow) return false;
      
      // Skip small windows (likely notification popups, not main app windows)  
      // Most notifications/popups are under 300x200 pixels
      const thumbnail = source.thumbnail;
      if (thumbnail && thumbnail.getSize) {
        const size = thumbnail.getSize();
        // Lower threshold to avoid filtering out legitimate app windows
        if (size.width < 300 || size.height < 200) {
          console.log(`Skipping small window (${size.width}x${size.height}): "${source.name}"`);
          return false;
        } else {
          console.log(`Considering window (${size.width}x${size.height}): "${source.name}"`);
        }
      }
      
      return true;
    });
    
    if (appWindows.length > 0) {
      // Sort by window size (largest first) to prioritize main application windows
      appWindows.sort((a, b) => {
        const sizeA = a.thumbnail?.getSize();
        const sizeB = b.thumbnail?.getSize();
        
        if (!sizeA || !sizeB) return 0;
        
        const areaA = sizeA.width * sizeA.height;
        const areaB = sizeB.width * sizeB.height;
        
        return areaB - areaA; // Largest first
      });
      
      console.log(`Found ${appWindows.length} application windows, selected largest: "${appWindows[0].name}"`);
      if (appWindows[0].thumbnail?.getSize) {
        const size = appWindows[0].thumbnail.getSize();
        console.log(`Selected window size: ${size.width}x${size.height}`);
      }
      return appWindows[0];
    }
    
    console.log('No application windows found after filtering. Falling back to first non-system window...');
    
    // Fallback: just filter out system windows but allow any size
    const fallbackWindows = sources.filter(source => {
      const name = source.name.toLowerCase();
      const isSystemWindow = name.includes('desktop') ||
                            name.includes('wallpaper') ||
                            name.includes('menubar') ||
                            name.includes('dock') ||
                            name === '' ||
                            name.length < 2;
      return !isSystemWindow;
    });
    
    if (fallbackWindows.length > 0) {
      console.log(`Using fallback window: "${fallbackWindows[0].name}"`);
      return fallbackWindows[0];
    }
    
    console.log('No windows found at all');
    return null;
  } catch (error) {
    console.error('Error getting application windows:', error);
    return null;
  }
}


// Capture browser window screenshot (includes tab and browser UI)
async function captureApplicationWindowScreenshot(eventId = null) {
  try {
    const appWindow = await getActiveApplicationWindow();
    
    if (!appWindow) {
      return null;
    }
    
    console.log(`Capturing browser window: ${appWindow.name}`);
    
    const appWindowScreenshotPath = eventId 
      ? `data/${currentTaskName}/screenshots/event_${eventId}_app_window.png`
      : `data/${currentTaskName}/screenshots/browser_window_${Date.now()}.png`;
    
    if (process.platform === 'darwin') {
      // On macOS, use screencapture with window ID
      const { exec } = require('child_process');
      return new Promise((resolve) => {
        // Extract window ID from the source ID (format: "window:12345:0")
        const windowId = appWindow.id.split(':')[1];
        
        exec(`/usr/sbin/screencapture -l ${windowId} -x "${appWindowScreenshotPath}"`, (error, stdout, stderr) => {
          if (error) {
            console.error(`Browser window capture failed:`, error.message);
            resolve(null);
          } else {
            console.log(`✓ Browser window screenshot saved: ${appWindowScreenshotPath}`);
            resolve({
              path: appWindowScreenshotPath,
              windowName: appWindow.name,
              windowId: windowId,
              timestamp: Date.now(),
              type: 'browser_window'
            });
          }
        });
      });
    } else {
      // For other platforms, fall back to thumbnail
      const thumbnailBuffer = appWindow.thumbnail.toPNG();
      await fs.writeFile(appWindowScreenshotPath, thumbnailBuffer);
      
      console.log(`✓ Browser window screenshot saved (thumbnail): ${appWindowScreenshotPath}`);
      return {
        path: appWindowScreenshotPath,
        windowName: appWindow.name,
        timestamp: Date.now(),
        type: 'browser_window_thumbnail'
      };
    }
    
  } catch (error) {
    console.error('Failed to capture browser window screenshot:', error);
    return null;
  }
}


// Collect system metadata and screen information
function getSystemMetadata() {
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  
  return {
    // System information
    system: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      version: os.version(),
      hostname: os.hostname(),
      username: os.userInfo().username,
      nodeVersion: process.version,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      cpus: os.cpus().map(cpu => ({
        model: cpu.model,
        speed: cpu.speed,
        cores: cpu.times
      })),
      uptime: os.uptime(),
      locale: app.getLocale(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    
    // Display information
    displays: {
      primary: {
        id: primaryDisplay.id,
        bounds: primaryDisplay.bounds,
        workArea: primaryDisplay.workArea,
        size: primaryDisplay.size,
        workAreaSize: primaryDisplay.workAreaSize,
        scaleFactor: primaryDisplay.scaleFactor,
        rotation: primaryDisplay.rotation,
        internal: primaryDisplay.internal || false
      },
      all: displays.map(display => ({
        id: display.id,
        bounds: display.bounds,
        workArea: display.workArea,
        size: display.size,
        workAreaSize: display.workAreaSize,
        scaleFactor: display.scaleFactor,
        rotation: display.rotation,
        internal: display.internal || false
      })),
      totalScreenArea: {
        width: Math.max(...displays.map(d => d.bounds.x + d.bounds.width)),
        height: Math.max(...displays.map(d => d.bounds.y + d.bounds.height))
      },
      displayCount: displays.length
    },
    
    // Recording environment
    environment: {
      recordingApp: 'data-collector-app',
      recordingVersion: '1.0.0',
      timestamp: new Date().toISOString(),
      userAgent: 'Electron/' + process.versions.electron
    }
  };
}

async function createMainWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  
  mainWindow = new BrowserWindow({
    width: width,
    height: height,
    x: 0,
    y: 0,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false
  });

  await mainWindow.loadFile('src/index.html');
  
  // Make it fullscreen after loading
  mainWindow.maximize();
}

function repositionOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  
  // Get the display where the cursor is currently located
  const cursorPosition = screen.getCursorScreenPoint();
  const currentDisplay = screen.getDisplayNearestPoint(cursorPosition);
  const { width, height } = currentDisplay.workArea;
  
  const newBounds = {
    x: currentDisplay.workArea.x + width - 280,
    y: currentDisplay.workArea.y + 20,
    width: 260,
    height: 140
  };
  
  overlayWindow.setBounds(newBounds);
  // console.log(`Overlay repositioned to screen: ${currentDisplay.id} at ${newBounds.x}, ${newBounds.y}`);
}

// Track cursor movement to detect screen changes
let lastScreenId = null;
let overlayTrackingInterval = null;
let userPositioned = false;
let savedPosition = null;


// Load saved position on startup
const { app: electronApp } = require('electron');
const configPath = path.join(electronApp.getPath('userData'), 'overlay-position.json');

async function loadSavedPosition() {
  try {
    const data = await fs.readFile(configPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function savePosition(position) {
  try {
    await fs.writeFile(configPath, JSON.stringify(position, null, 2));
  } catch (error) {
    console.error('Failed to save position:', error);
  }
}

function trackCursorForScreenChanges() {
  if (!overlayWindow || overlayWindow.isDestroyed() || userPositioned) return;
  
  try {
    const cursorPosition = screen.getCursorScreenPoint();
    const currentDisplay = screen.getDisplayNearestPoint(cursorPosition);
    const overlayBounds = overlayWindow.getBounds();
    
    // Check if overlay is on the same display as cursor
    const overlayDisplay = screen.getDisplayMatching(overlayBounds);
    
    // Only move if on different display and user hasn't manually positioned
    const shouldMove = overlayDisplay.id !== currentDisplay.id;
    
    if (shouldMove) {
      console.log(`Moving overlay to follow cursor on display ${currentDisplay.id}`);
      repositionOverlay();
    }
    
    lastScreenId = currentDisplay.id;
  } catch (error) {
    console.error('Error tracking cursor:', error);
  }
}

function startOverlayTracking() {
  if (overlayTrackingInterval) {
    clearInterval(overlayTrackingInterval);
  }
  // Less aggressive tracking when user hasn't positioned manually
  const interval = userPositioned ? 2000 : 500; // 2s if user positioned, 500ms otherwise
  overlayTrackingInterval = setInterval(trackCursorForScreenChanges, interval);
  console.log(`Started overlay tracking (${interval}ms intervals, userPositioned: ${userPositioned})`);
}

// Track on mouse moves only for display changes
function trackOnMouseMove() {
  if (!overlayWindow || overlayWindow.isDestroyed() || userPositioned) return;
  
  try {
    const cursorPosition = screen.getCursorScreenPoint();
    const currentDisplay = screen.getDisplayNearestPoint(cursorPosition);
    const overlayBounds = overlayWindow.getBounds();
    const overlayDisplay = screen.getDisplayMatching(overlayBounds);
    
    // Only move if on different display
    if (overlayDisplay.id !== currentDisplay.id) {
      repositionOverlay();
    }
  } catch (error) {
    // Ignore errors in mouse move tracking
  }
}

function stopOverlayTracking() {
  if (overlayTrackingInterval) {
    clearInterval(overlayTrackingInterval);
    overlayTrackingInterval = null;
  }
}

async function createOverlayWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  
  // Load saved position or use default
  savedPosition = await loadSavedPosition();
  let initialX = width - 280;
  let initialY = 20;
  
  if (savedPosition) {
    initialX = savedPosition.x;
    initialY = savedPosition.y;
    userPositioned = true;
    console.log('Loaded saved overlay position:', savedPosition);
  }

  overlayWindow = new BrowserWindow({
    width: 260,
    height: 140,
    x: initialX,
    y: initialY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    movable: true,
    focusable: true,
    show: false,
    type: 'panel', // Makes it invisible to screen capture on macOS
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: false,
      webSecurity: false,
      experimentalFeatures: false
    }
  });
  
  // macOS specific: Set window level to be above everything but invisible to screen recording
  if (process.platform === 'darwin') {
    try {
      overlayWindow.setAlwaysOnTop(true, 'pop-up-menu', 1);
    } catch (error) {
      console.log('Could not set window level:', error.message);
    }
  }
  
  // Completely disable all window controls
  overlayWindow.setMenuBarVisibility(false);
  overlayWindow.removeAllListeners('close');
  
  // Remove any system window buttons on all platforms
  if (process.platform === 'darwin') {
    overlayWindow.setWindowButtonVisibility(false);
  }
  
  // Additional attempts to hide window controls
  overlayWindow.setAutoHideMenuBar(true);
  
  // Override window styles to remove chrome
  overlayWindow.webContents.once('dom-ready', () => {
    overlayWindow.webContents.insertCSS(`
      ::-webkit-scrollbar { display: none; }
      body { -webkit-app-region: no-drag; }
      * { -webkit-app-region: no-drag; }
    `);
  });

  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.setVisibleOnAllWorkspaces(true);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  
  // Additional measures to exclude from screen capture
  if (process.platform === 'darwin') {
    // On macOS, set the window to be excluded from screen recording
    overlayWindow.setWindowButtonVisibility(false);
    
    // Try to set NSWindow properties to exclude from screen capture
    try {
      const { systemPreferences } = require('electron');
      overlayWindow.once('ready-to-show', () => {
        // This makes the window invisible to screen recording APIs
        const nsWindow = overlayWindow.getNativeWindowHandle();
        if (nsWindow) {
          // Set sharing type to none (not captured in screen recordings)
          overlayWindow.webContents.executeJavaScript(`
            if (window.process && window.process.platform === 'darwin') {
              console.log('Setting macOS window properties to exclude from screen capture');
            }
          `);
        }
      });
    } catch (error) {
      console.log('Could not set macOS-specific window properties:', error.message);
    }
  }
  
  // Listen for display changes and reposition
  screen.on('display-added', () => {
    setTimeout(repositionOverlay, 500);
  });
  screen.on('display-removed', () => {
    setTimeout(repositionOverlay, 500);
  });
  screen.on('display-metrics-changed', () => {
    setTimeout(repositionOverlay, 200);
  });
  
  // Set up cursor tracking for screen changes
  lastScreenId = primaryDisplay.id;
  
  // Start overlay tracking
  startOverlayTracking();
  
  // Listen for user dragging the overlay
  overlayWindow.on('moved', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    
    const bounds = overlayWindow.getBounds();
    userPositioned = true;
    savedPosition = { x: bounds.x, y: bounds.y };
    
    // Save position asynchronously
    savePosition(savedPosition).catch(console.error);
    console.log('Overlay moved by user, saved position:', savedPosition);
  });
  
  await overlayWindow.loadFile('src/overlay.html');
  overlayWindow.show();
}

async function createVideoRecorderWindow() {
  console.log('Creating video recorder window...');
  videoRecorderWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  videoRecorderWindow.webContents.on('console-message', (event, level, message) => {
    console.log(`[VideoRecorder] ${message}`);
  });

  await videoRecorderWindow.loadFile('src/video-recorder.html');
  console.log('Video recorder window created and loaded');
}

// Capture all displays simultaneously  
async function captureAllScreens(eventId = null) {
  try {
    // Signal overlay to enter screenshot mode (become transparent)
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('enter-screenshot-mode');
    }
    
    // Brief delay to ensure CSS transition completes
    await new Promise(resolve => setTimeout(resolve, 150));
    
    const displays = screen.getAllDisplays();
    const screenshotPromises = [];
    const screenshotPaths = [];
    
    console.log(`Capturing ${displays.length} displays...`);
    
    // Capture each display
    for (let i = 0; i < displays.length; i++) {
      const display = displays[i];
      const screenshotPath = eventId 
        ? `data/${currentTaskName}/screenshots/event_${eventId}_display_${display.id}.png`
        : `data/${currentTaskName}/screenshots/screenshot_${Date.now()}_display_${display.id}.png`;
      screenshotPaths.push({
        displayId: display.id,
        path: screenshotPath,
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
        isPrimary: display.id === screen.getPrimaryDisplay().id
      });
      
      // Try different approaches for each display
      const capturePromise = (async () => {
        try {
          if (process.platform === 'darwin') {
            // macOS: Use screencapture with display ID
            const { exec } = require('child_process');
            await new Promise((resolve, reject) => {
              exec(`/usr/sbin/screencapture -D ${display.id} -x "${screenshotPath}"`, (error, stdout, stderr) => {
                if (error) {
                  console.error(`screencapture failed for display ${display.id}:`, error.message);
                  reject(error);
                } else {
                  console.log(`Screenshot saved for display ${display.id}: ${screenshotPath}`);
                  resolve();
                }
              });
            });
          } else {
            // For other platforms, try screenshot-desktop with screen index
            await screenshot({ 
              filename: screenshotPath,
              format: 'png',
              screen: i
            });
            console.log(`Screenshot saved for display ${display.id}: ${screenshotPath}`);
          }
        } catch (displayError) {
          console.error(`Failed to capture display ${display.id}:`, displayError.message);
          // Continue with other displays even if one fails
        }
      })();
      
      screenshotPromises.push(capturePromise);
    }
    
    // Wait for all screenshots to complete
    await Promise.allSettled(screenshotPromises);
    console.log(`✓ Multi-screen capture completed for ${displays.length} displays`);
    
    // Signal overlay to exit screenshot mode (become visible again)
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('exit-screenshot-mode');
    }
    
    // Capture browser window screenshot  
    const appWindowScreenshot = await captureApplicationWindowScreenshot(eventId);
    
    // Record screenshots in session data (screenshots don't need their own event ID)  
    const screenshotRecord = {
      timestamp: getVideoTimestamp(),
      absoluteTimestamp: Date.now(),
      type: 'multi-screen',
      displayCount: displays.length,
      displays: screenshotPaths
    };
    
    // Add browser window screenshot info if captured
    if (appWindowScreenshot) {
      screenshotRecord.appWindow = appWindowScreenshot;
    }
    
    sessionData.screenshots.push(screenshotRecord);
    
    const result = { 
      screens: screenshotPaths, 
      appWindow: appWindowScreenshot,
      // Flatten paths for easy access
      screenPaths: screenshotPaths.map(s => s.path),
      appWindowPath: appWindowScreenshot?.path || null
    };
    
    return result;
  } catch (error) {
    console.error('Multi-screen capture failed:', error);
    // Make sure to restore overlay even if screenshot fails
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('exit-screenshot-mode');
    }
    return null;
  }
}

// Use multi-screen capture for all screenshots
async function captureScreenshot(eventId = null) {
  return await captureAllScreens(eventId);
}

// Capture initial screenshot at recording start
async function captureInitialScreenshot() {
  try {
    const displays = screen.getAllDisplays();
    const screenshotPaths = [];
    
    console.log('Capturing initial state for all displays...');
    
    // Capture each display with distinct initial naming
    for (let i = 0; i < displays.length; i++) {
      const display = displays[i];
      const screenshotPath = `data/${currentTaskName}/screenshots/initial_display_${display.id}.png`;
      screenshotPaths.push({
        displayId: display.id,
        path: screenshotPath,
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
        isPrimary: display.id === screen.getPrimaryDisplay().id
      });

      // Use screencapture for macOS or fallback for other platforms
      if (process.platform === 'darwin') {
        const { exec } = require('child_process');
        await new Promise((resolve, reject) => {
          exec(`/usr/sbin/screencapture -D ${display.id} -x "${screenshotPath}"`, (error) => {
            if (error) {
              console.error(`Initial screencapture failed for display ${display.id}:`, error.message);
              reject(error);
            } else {
              console.log(`✓ Initial screenshot saved for display ${display.id}: ${screenshotPath}`);
              resolve();
            }
          });
        });
      } else {
        // Fallback for other platforms
        const displayShot = await screenshot({ screen: display.id });
        await fs.writeFile(screenshotPath, displayShot);
        console.log(`✓ Initial screenshot saved for display ${display.id}: ${screenshotPath}`);
      }
    }

    // Capture initial app window screenshot
    const appWindowScreenshot = await captureInitialAppWindowScreenshot();

    return {
      screens: screenshotPaths,
      appWindow: appWindowScreenshot,
      type: 'initial'
    };
  } catch (error) {
    console.error('Initial screenshot capture failed:', error);
    return null;
  }
}

// Capture final screenshot at recording end
async function captureFinalScreenshot() {
  try {
    const displays = screen.getAllDisplays();
    const screenshotPaths = [];
    
    console.log('Capturing final state for all displays...');
    
    // Capture each display with distinct final naming
    for (let i = 0; i < displays.length; i++) {
      const display = displays[i];
      const screenshotPath = `data/${currentTaskName}/screenshots/final_display_${display.id}.png`;
      screenshotPaths.push({
        displayId: display.id,
        path: screenshotPath,
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
        isPrimary: display.id === screen.getPrimaryDisplay().id
      });

      // Use screencapture for macOS or fallback for other platforms
      if (process.platform === 'darwin') {
        const { exec } = require('child_process');
        await new Promise((resolve, reject) => {
          exec(`/usr/sbin/screencapture -D ${display.id} -x "${screenshotPath}"`, (error) => {
            if (error) {
              console.error(`Final screencapture failed for display ${display.id}:`, error.message);
              reject(error);
            } else {
              console.log(`✓ Final screenshot saved for display ${display.id}: ${screenshotPath}`);
              resolve();
            }
          });
        });
      } else {
        // Fallback for other platforms
        const displayShot = await screenshot({ screen: display.id });
        await fs.writeFile(screenshotPath, displayShot);
        console.log(`✓ Final screenshot saved for display ${display.id}: ${screenshotPath}`);
      }
    }

    // Capture final app window screenshot
    const appWindowScreenshot = await captureFinalAppWindowScreenshot();

    return {
      screens: screenshotPaths,
      appWindow: appWindowScreenshot,
      type: 'final'
    };
  } catch (error) {
    console.error('Final screenshot capture failed:', error);
    return null;
  }
}

// Capture initial app window screenshot
async function captureInitialAppWindowScreenshot() {
  try {
    const appWindow = await getActiveApplicationWindow();
    if (!appWindow) return null;

    console.log(`Capturing initial app window: ${appWindow.name}`);
    const screenshotPath = `data/${currentTaskName}/screenshots/initial_app_window.png`;

    if (process.platform === 'darwin') {
      const { exec } = require('child_process');
      const windowId = appWindow.id.split(':')[1];
      
      return new Promise((resolve) => {
        exec(`/usr/sbin/screencapture -l ${windowId} -x "${screenshotPath}"`, (error) => {
          if (error) {
            console.error('Initial app window capture failed:', error.message);
            resolve(null);
          } else {
            console.log(`✓ Initial app window screenshot saved: ${screenshotPath}`);
            resolve({
              path: screenshotPath,
              windowName: appWindow.name,
              windowId: windowId,
              timestamp: Date.now(),
              type: 'initial_app_window'
            });
          }
        });
      });
    } else {
      // Fallback for other platforms
      const thumbnailBuffer = appWindow.thumbnail.toPNG();
      await fs.writeFile(screenshotPath, thumbnailBuffer);
      console.log(`✓ Initial app window screenshot saved: ${screenshotPath}`);
      return {
        path: screenshotPath,
        windowName: appWindow.name,
        timestamp: Date.now(),
        type: 'initial_app_window_thumbnail'
      };
    }
  } catch (error) {
    console.error('Initial app window screenshot failed:', error);
    return null;
  }
}

// Capture final app window screenshot
async function captureFinalAppWindowScreenshot() {
  try {
    const appWindow = await getActiveApplicationWindow();
    if (!appWindow) return null;

    console.log(`Capturing final app window: ${appWindow.name}`);
    const screenshotPath = `data/${currentTaskName}/screenshots/final_app_window.png`;

    if (process.platform === 'darwin') {
      const { exec } = require('child_process');
      const windowId = appWindow.id.split(':')[1];
      
      return new Promise((resolve) => {
        exec(`/usr/sbin/screencapture -l ${windowId} -x "${screenshotPath}"`, (error) => {
          if (error) {
            console.error('Final app window capture failed:', error.message);
            resolve(null);
          } else {
            console.log(`✓ Final app window screenshot saved: ${screenshotPath}`);
            resolve({
              path: screenshotPath,
              windowName: appWindow.name,
              windowId: windowId,
              timestamp: Date.now(),
              type: 'final_app_window'
            });
          }
        });
      });
    } else {
      // Fallback for other platforms
      const thumbnailBuffer = appWindow.thumbnail.toPNG();
      await fs.writeFile(screenshotPath, thumbnailBuffer);
      console.log(`✓ Final app window screenshot saved: ${screenshotPath}`);
      return {
        path: screenshotPath,
        windowName: appWindow.name,
        timestamp: Date.now(),
        type: 'final_app_window_thumbnail'
      };
    }
  } catch (error) {
    console.error('Final app window screenshot failed:', error);
    return null;
  }
}

async function startRecording(taskName) {
  console.log('startRecording called with:', taskName, 'isRecording:', isRecording);
  if (isRecording) {
    console.log('Already recording, ignoring start request');
    return;
  }
  
  currentTaskName = taskName || storedTaskName;
  isRecording = true;
  eventCounter = 0;
  
  // Clear event slots for new recording session
  clearEventSlots();
  
  console.log(`Event counter reset to 0 and event slots cleared for new recording session: ${taskName}`);
  
  console.log('Collecting system metadata...');
  const systemMetadata = getSystemMetadata();
  
  sessionData = {
    events: [],
    screenshots: [],
    startTime: Date.now(),
    endTime: null,
    taskName: taskName,
    metadata: systemMetadata
  };

  console.log('Creating directories for task:', taskName);
  // Create directories
  await fs.mkdir(`data/${taskName}/screenshots`, { recursive: true });
  await fs.mkdir(`data/${taskName}/videos`, { recursive: true });

  console.log('Starting overlay tracking for screen following...');
  // Keep overlay tracking enabled to follow cursor across screens
  startOverlayTracking();

  console.log('Starting video recording...');
  // Start video recording
  await startVideoRecording();
  
  console.log('Starting event listeners...');
  // Start listening to global events
  startEventListeners();
  
  console.log('Initializing app bounds cache...');
  // Initialize the bounds cache to prevent race conditions
  await updateCachedAppBounds();
  
  console.log('Starting window focus change detection...');
  // Start focus change detection to update cached bounds
  startFocusChangeDetection();
  
  console.log('Sending recording-started to overlay and hiding overlay');
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('recording-started');
    // Hide overlay during recording
    overlayWindow.webContents.send('enter-recording-mode');
  }
  
  // Wait for overlay to hide before taking initial screenshot
  console.log('Waiting for overlay to hide before taking initial screenshot...');
  await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
  
  console.log('Taking initial screenshot at recording start...');
  // Take initial screenshot with distinct naming
  const initialScreenshots = await captureInitialScreenshot();
  if (initialScreenshots) {
    console.log('✓ Initial screenshots captured with distinct paths');
  }
  
  // Audio feedback - system beep
  console.log('\x07'); // Bell character for system beep
  
  console.log('Recording started successfully for task:', taskName, '- overlay hidden');
}

async function stopRecording() {
  console.log('stopRecording called, isRecording:', isRecording);
  if (!isRecording) {
    console.log('Not recording, ignoring stop request');
    return;
  }
  
  console.log('Stopping recording...');
  
  console.log('Taking final screenshot before stopping...');
  // Take final screenshot with distinct naming
  const finalScreenshots = await captureFinalScreenshot();
  if (finalScreenshots) {
    console.log('✓ Final screenshots captured with distinct paths');
  }
  
  isRecording = false;
  sessionData.endTime = Date.now();
  
  console.log('Stopping event listeners...');
  // Stop event listeners
  stopEventListeners();
  console.log('✓ Event listeners stopped');
  
  console.log('Stopping focus change detection...');
  // Stop focus change detection
  stopFocusChangeDetection();
  console.log('✓ Focus change detection stopped');
  
  console.log('Clearing app bounds cache...');
  // Clear cached bounds
  cachedAppBounds = null;
  cachedAppWindow = null;
  lastBoundsUpdate = 0;
  console.log('✓ App bounds cache cleared');
  
  console.log('Finalizing any remaining events...');
  // Force finalization of any pending events (shouldn't normally be needed)
  let pendingEvents = 0;
  eventSlots.forEach((event, eventId) => {
    if (event._pending) {
      console.warn(`Warning: Event ${eventId} still pending at recording stop`);
      pendingEvents++;
    }
  });
  
  // Clear event slots system
  clearEventSlots();
  console.log(`✓ Event slots cleared (had ${pendingEvents} pending events)`);
  
  console.log('Stopping overlay tracking...');
  // Stop overlay tracking to prevent flashing
  stopOverlayTracking();
  console.log('✓ Overlay tracking stopped');
  
  console.log('Stopping video recording...');
  // Stop video recording (non-blocking)
  try {
    stopVideoRecording();
    console.log('✓ Video recording stop initiated');
  } catch (error) {
    console.error('Error stopping video recording:', error);
  }
  
  console.log('Saving session data...');
  // Save session data in non-blocking way
  const sessionPath = `data/${currentTaskName}/session_data.json`;
  console.log(`Session data path: ${sessionPath}`);
  console.log(`Session data size: ${sessionData.events?.length || 0} events, ${sessionData.screenshots?.length || 0} screenshots`);
  
  // Save session data without blocking the main thread
  setImmediate(async () => {
    try {
      console.log('Starting JSON serialization...');
      const jsonData = JSON.stringify(sessionData, null, 2);
      console.log(`JSON serialized, size: ${jsonData.length} characters`);
      
      console.log('Writing session data to file...');
      await fs.writeFile(sessionPath, jsonData);
      console.log('✓ Session data saved successfully');
    } catch (error) {
      console.error('Error saving session data:', error);
    }
  });
  
  console.log('✓ Session data save initiated (non-blocking)');
  
  console.log('Sending recording-stopped to overlay and showing overlay');
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('recording-stopped');
    // Show overlay after recording
    overlayWindow.webContents.send('exit-recording-mode');
    console.log('✓ Overlay updated');
  }
  
  // Audio feedback - double beep for stop
  console.log('\x07\x07'); // Double bell character for system beep
  
  console.log(`✅ Recording completely stopped and saved - overlay visible`);
}

async function startVideoRecording() {
  try {
    if (process.platform === 'darwin') {
      // Priority 1: Native macOS screen recording (simplest, most reliable)
      console.log('Starting native macOS screen recording...');
      await startNativeScreenRecording();
    } else {
      // For non-macOS platforms, try FFmpeg first, then WebRTC
      const ffmpegAvailable = await checkFFmpegAvailability();

      if (ffmpegAvailable) {
        console.log('Starting direct FFmpeg screen recording (lossless)...');
        await startDirectFFmpegRecording();
      } else {
        console.log('Falling back to WebRTC recording...');
        if (videoRecorderWindow && !videoRecorderWindow.isDestroyed()) {
          console.log('Sending start-video-recording to video recorder window');
          videoRecorderWindow.webContents.send('start-video-recording');
        } else {
          console.error('Video recorder window not available');
          throw new Error('Video recorder window not available');
        }
      }
    }
  } catch (error) {
    console.error('Failed to start video recording:', error);
    throw error;
  }
}

function stopVideoRecording() {
  // Make this function synchronous and non-blocking
  try {
    // Check if we're using native macOS recording
    if (nativeScreenRecordingProcesses && nativeScreenRecordingProcesses.length > 0) {
      console.log('Stopping native macOS recording...');
      // Stop native processes in background (non-blocking)
      setImmediate(async () => {
        try {
          await stopNativeScreenRecording();
        } catch (error) {
          console.error('Error stopping native recording:', error);
        }
      });
    }
    // Check if we're using direct FFmpeg recording
    else if (ffmpegProcesses && ffmpegProcesses.length > 0) {
      console.log('Stopping direct FFmpeg recording...');
      // Stop FFmpeg processes in background (non-blocking)
      setImmediate(async () => {
        try {
          await stopDirectFFmpegRecording();
        } catch (error) {
          console.error('Error stopping direct FFmpeg recording:', error);
        }
      });
    } else if (videoRecorderWindow && !videoRecorderWindow.isDestroyed()) {
      console.log('Sending stop-video-recording to video recorder window');
      videoRecorderWindow.webContents.send('stop-video-recording');

      // Don't wait - let video processing happen in background
      console.log('Video stop signal sent, continuing immediately...');

      // Set a background timeout to check if video was saved
      setTimeout(() => {
        console.log('Background video processing check complete');
      }, 1000);

    } else {
      console.error('Video recorder window not available for stopping');
    }
  } catch (error) {
    console.error('Failed to stop video recording:', error);
  }

  console.log('Video recording stop completed (non-blocking)');
}

let lastMouseDown = null;
let isDragging = false;

// Scroll debouncing
let scrollDebounceTimer = null;
let scrollAccumulator = {
  totalVertical: 0,
  totalHorizontal: 0,
  lastX: 0,
  lastY: 0,
  startTime: 0,
  events: []
};

function startEventListeners() {
  console.log('Starting event listeners for: TYPE, CLICK, DRAG, SCROLL + KEYBOARD SHORTCUTS');
  
  // Clear any existing listeners first to prevent duplicates
  console.log('Clearing existing uIOhook listeners...');
  uIOhook.removeAllListeners();
  
  // Reset keyboard state
  shiftPressed = false;
  ctrlPressed = false;
  altPressed = false;
  cmdPressed = false;
  
  // Global keyboard shortcuts and event capture
  uIOhook.on('keydown', async (e) => {
    const keyName = getKeyName(e.keycode);
    console.log(`Key pressed: ${keyName} (keycode=${e.keycode}), isRecording=${isRecording}, shift=${shiftPressed}, ctrl=${ctrlPressed}`);
    
    // Track modifier keys (uiohook uses different keycodes) - ALWAYS track these
    if (e.keycode === 42 || e.keycode === 54) shiftPressed = true; // Left/Right Shift
    if (e.keycode === 29 || e.keycode === 3613) ctrlPressed = true;  // Left/Right Ctrl
    if (e.keycode === 56 || e.keycode === 3640) altPressed = true;   // Left/Right Alt
    if (e.keycode === 3675 || e.keycode === 3676) cmdPressed = true; // Left/Right Cmd (Mac)
    
    // Log when we detect modifiers
    if (e.keycode === 42 || e.keycode === 54) console.log(`SHIFT pressed (${keyName})`);
    if (e.keycode === 29 || e.keycode === 3613) console.log(`CTRL pressed (${keyName})`);
    
    // Handle global shortcuts FIRST (work whether recording or not)
    
    // F9 to stop recording
    if (e.keycode === 67 && isRecording) { // F9 key
      console.log(`F9 detected (${keyName}) - stopping recording`);
      await stopRecording();
      return;
    }
    
    // Escape to cancel/stop recording
    if (e.keycode === 1 && isRecording) { // Escape key
      console.log(`Escape detected (${keyName}) - cancelling recording`);
      await stopRecording();
      return;
    }
    
    // Ctrl+Shift+R to start recording (if not already recording) 
    if (ctrlPressed && shiftPressed && e.keycode === 19 && !isRecording) { // R key
      console.log(`Ctrl+Shift+R detected (${keyName}) - attempting to start recording`);
      const defaultTaskName = `task_${new Date().toISOString().split('T')[0]}_${Date.now()}`;
      await startRecording(defaultTaskName);
      return;
    }
    
    // Regular event capture during recording - ONLY proceed if recording
    if (!isRecording) return;
    
    // More inclusive key detection for recording
    const key = UiohookKey[e.keycode] || `Key${e.keycode}`;
    const importantKeys = ['Enter', 'Tab', 'Backspace', 'Delete', 'Space', 'Escape', 'Shift', 'Ctrl', 'Alt', 'Cmd'];

    // Accept all printable characters (letters, numbers, symbols) and important keys using correct uIOhook keycodes
    const isLetter = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25,  // QWERTYUIOP
                      30, 31, 32, 33, 34, 35, 36, 37, 38,       // ASDFGHJKL
                      44, 45, 46, 47, 48, 49, 50].includes(e.keycode); // ZXCVBNM
    const isNumber = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(e.keycode); // 1234567890
    const isSpecialChar = [57, 12, 13, 26, 27, 43, 39, 40, 41, 51, 52, 53].includes(e.keycode); // space, -, =, [, ], \, ;, ', `, ,, ., /
    const isImportantKey = [28, 15, 14, 1, 83].includes(e.keycode); // Enter, Tab, Backspace, Escape, Delete
    const isArrowKey = [72, 80, 75, 77].includes(e.keycode); // UP, DOWN, LEFT, RIGHT arrow keys
    const isFunctionKey = [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88].includes(e.keycode); // F1-F12
    const isNavigationKey = [71, 79, 73, 81, 82].includes(e.keycode); // HOME, END, PAGE_UP, PAGE_DOWN, INSERT
    const isLockKey = [58, 69, 70].includes(e.keycode); // CAPS_LOCK, NUM_LOCK, SCROLL_LOCK
    const isImportant = importantKeys.some(k => key.includes(k));

    const shouldCapture = isLetter || isNumber || isSpecialChar || isImportantKey || isArrowKey || isFunctionKey || isNavigationKey || isLockKey || isImportant;

    // Don't capture the shortcut keys themselves
    const isShortcutKey = e.keycode === 67 || e.keycode === 1 || (ctrlPressed && shiftPressed && e.keycode === 19); // F9, Escape, Ctrl+Shift+R

    // Fallback: capture ANY key that's not a modifier key or shortcut, to ensure we don't miss anything
    const isModifierOnly = [42, 54, 29, 3613, 56, 3640, 3675, 3676].includes(e.keycode); // All modifier keys
    const shouldCaptureFallback = !isModifierOnly && !isShortcutKey;

    if ((shouldCapture || shouldCaptureFallback) && !isShortcutKey) {
      // Check for key combination
      const combination = getKeyCombination(e.keycode, keyName);
      
      if (combination) {
        // Record as key combination
        console.log(`Capturing key combination: ${combination.combination} (${combination.name})`);
        
        // Create atomic event slot for key combination
        const eventSlot = createEventSlot('key_combination', {
          keycode: e.keycode,
          key: keyName,
          combination: combination.combination,
          combinationName: combination.name,
          modifiers: combination.modifiers
        });
        
        // Complete event with screenshot (async, but maintains chronological order)
        await eventSlot.complete();
        
        console.log(`Captured COMBINATION: ${combination.combination} (${combination.name}) at ${getVideoTimestamp().toFixed(2)}s`);
      } else {
        // Record as regular keypress
        console.log(`Capturing keypress: ${keyName}`);
        
        // Create atomic event slot for keypress
        const eventSlot = createEventSlot('type', {
          keycode: e.keycode,
          key: keyName
        });
        
        // Complete event with screenshot (async, but maintains chronological order)
        await eventSlot.complete();
        
        console.log(`Captured TYPE: ${keyName} at ${getVideoTimestamp().toFixed(2)}s`);
      }
    }
  });

  // Track modifier key releases
  uIOhook.on('keyup', (e) => {
    if (e.keycode === 42 || e.keycode === 54) shiftPressed = false; // Left/Right Shift
    if (e.keycode === 29 || e.keycode === 3613) ctrlPressed = false;  // Left/Right Ctrl
    if (e.keycode === 56 || e.keycode === 3640) altPressed = false;   // Left/Right Alt
    if (e.keycode === 3675 || e.keycode === 3676) cmdPressed = false; // Left/Right Cmd (Mac)
  });

  // Capture clicks and start of drags (left and right clicks only)
  uIOhook.on('mousedown', async (e) => {
    if (!isRecording) return;
    
    // Only capture left (1) and right (2) mouse buttons
    if (e.button !== 1 && e.button !== 2) return;
    
    // Check if click is on overlay - skip recording if so
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const overlayBounds = overlayWindow.getBounds();
      const isOnOverlay = e.x >= overlayBounds.x && 
                         e.x <= overlayBounds.x + overlayBounds.width &&
                         e.y >= overlayBounds.y && 
                         e.y <= overlayBounds.y + overlayBounds.height;
      
      if (isOnOverlay) {
        console.log('Click on overlay - skipping screenshot and recording');
        return;
      }
    }
    
    lastMouseDown = { x: e.x, y: e.y, timestamp: getVideoTimestamp(), absoluteTimestamp: Date.now(), button: e.button };
    isDragging = false;
    
    const screenInfo = getCurrentScreenInfo(e.x, e.y);
    
    console.log(`🔍 About to get browser bounds for click at (${e.x}, ${e.y})`);
    
    // Get browser-relative coordinates
    const appBounds = await getApplicationWindowBounds();
    console.log(`🔍 Browser bounds result:`, appBounds);
    
    const appRelative = getApplicationRelativeCoordinates(e.x, e.y, appBounds);
    console.log(`🔍 Browser relative result:`, appRelative);
    
    // Create atomic event slot for guaranteed chronological order
    const eventSlot = createEventSlot('click', {
      x: e.x,
      y: e.y,
      button: e.button === 1 ? 'left' : 'right',
      screenInfo: screenInfo
    });
    
    if (appRelative && appRelative.isInsideApp) {
      console.log(`Click inside browser at (${appRelative.x}, ${appRelative.y}) relative to browser window`);
    }
    
    // Prepare additional data
    const additionalData = {};
    
    // Add browser-relative coordinates ONLY if we have accurate data
    if (appRelative && appBounds && appBounds.method !== 'fallback') {
      additionalData.appRelative = appRelative;
      console.log('✓ Added accurate browser-relative coordinates to click event');
    } else {
      console.log('✗ No accurate browser bounds - skipping browser-relative coordinates');
    }
    
    // Complete event with screenshot (async, but maintains chronological order)
    await eventSlot.complete(additionalData);
    
    console.log(`Captured CLICK: ${e.button === 1 ? 'left' : 'right'} at (${e.x}, ${e.y}) at ${getVideoTimestamp().toFixed(2)}s`);
  });

  // Detect drags and capture drag end
  uIOhook.on('mouseup', async (e) => {
    if (!isRecording || !lastMouseDown) return;
    
    // Only process if same button as mousedown
    if (e.button !== lastMouseDown.button) return;
    
    // Check if drag ends on overlay - skip recording if so
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const overlayBounds = overlayWindow.getBounds();
      const isOnOverlay = e.x >= overlayBounds.x && 
                         e.x <= overlayBounds.x + overlayBounds.width &&
                         e.y >= overlayBounds.y && 
                         e.y <= overlayBounds.y + overlayBounds.height;
      
      if (isOnOverlay) {
        console.log('Drag end on overlay - skipping recording');
        lastMouseDown = null;
        isDragging = false;
        return;
      }
    }
    
    const distance = Math.sqrt(
      Math.pow(e.x - lastMouseDown.x, 2) + 
      Math.pow(e.y - lastMouseDown.y, 2)
    );
    
    // If mouse moved more than 10 pixels, it's a drag (increased threshold)
    if (distance > 10) {
      const screenInfo = getCurrentScreenInfo(e.x, e.y);
      
      // Get browser-relative coordinates for drag start and end
      const appBounds = await getApplicationWindowBounds();
      const startBrowserRelative = getApplicationRelativeCoordinates(lastMouseDown.x, lastMouseDown.y, appBounds);
      const endBrowserRelative = getApplicationRelativeCoordinates(e.x, e.y, appBounds);
      
      // Create atomic event slot for drag
      const eventSlot = createEventSlot('drag', {
        startX: lastMouseDown.x,
        startY: lastMouseDown.y,
        endX: e.x,
        endY: e.y,
        button: e.button === 1 ? 'left' : 'right',
        distance: Math.round(distance),
        startTimestamp: lastMouseDown.timestamp,
        screenInfo: screenInfo
      });
      
      if (startBrowserRelative && endBrowserRelative && startBrowserRelative.isInsideApp && endBrowserRelative.isInsideApp) {
        console.log(`Drag inside browser from (${startBrowserRelative.x}, ${startBrowserRelative.y}) to (${endBrowserRelative.x}, ${endBrowserRelative.y})`);
      }
      
      // Prepare additional data
      const additionalData = {};
      
      // Add browser-relative coordinates ONLY if we have accurate data
      if (startBrowserRelative && endBrowserRelative && appBounds && appBounds.method !== 'fallback') {
        additionalData.appRelative = {
          start: startBrowserRelative,
          end: endBrowserRelative
        };
        console.log('✓ Added accurate browser-relative coordinates to drag event');
      } else {
        console.log('✗ No accurate browser bounds - skipping browser-relative coordinates for drag');
      }
      
      // Complete event with screenshot (async, but maintains chronological order)
      await eventSlot.complete(additionalData);
      
      console.log(`Captured DRAG: ${Math.round(distance)}px from (${lastMouseDown.x}, ${lastMouseDown.y}) to (${e.x}, ${e.y}) at ${getVideoTimestamp().toFixed(2)}s`);
    }
    
    lastMouseDown = null;
    isDragging = false;
  });

  // Capture scroll events with debouncing (wait for scroll to stop)
  uIOhook.on('wheel', async (e) => {
    if (!isRecording) return;
    
    // Check if scroll is on overlay - skip recording if so
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const overlayBounds = overlayWindow.getBounds();
      const isOnOverlay = e.x >= overlayBounds.x && 
                         e.x <= overlayBounds.x + overlayBounds.width &&
                         e.y >= overlayBounds.y && 
                         e.y <= overlayBounds.y + overlayBounds.height;
      
      if (isOnOverlay) {
        console.log('Scroll on overlay - skipping recording');
        return;
      }
    }
    
    // Initialize or reset scroll accumulator
    if (scrollAccumulator.events.length === 0) {
      scrollAccumulator.startTime = Date.now();
      scrollAccumulator.totalVertical = 0;
      scrollAccumulator.totalHorizontal = 0;
    }
    
    // Accumulate scroll data
    scrollAccumulator.totalVertical += e.rotation;
    scrollAccumulator.lastX = e.x;
    scrollAccumulator.lastY = e.y;
    scrollAccumulator.events.push({
      rotation: e.rotation,
      x: e.x,
      y: e.y,
      timestamp: Date.now()
    });
    
    // Clear existing timer
    if (scrollDebounceTimer) {
      clearTimeout(scrollDebounceTimer);
    }
    
    // Set new timer - capture when scrolling stops for 300ms
    scrollDebounceTimer = setTimeout(async () => {
      await captureScrollSequence();
    }, 300);
  });

  // Light mouse movement tracking for screen following (only if not user positioned)
  let mouseTrackingThrottle = 0;
  uIOhook.on('mousemove', (e) => {
    // Only track if user hasn't manually positioned overlay
    if (!userPositioned) {
      const now = Date.now();
      if (now - mouseTrackingThrottle > 1000) { // Increased to 1s
        mouseTrackingThrottle = now;
        trackOnMouseMove();
      }
    }
  });

  uIOhook.start();
}

// Capture accumulated scroll sequence when scrolling stops
async function captureScrollSequence() {
  if (scrollAccumulator.events.length === 0) return;
  
  const totalRotation = scrollAccumulator.totalVertical;
  const direction = totalRotation > 0 ? 'up' : 'down';
  const amount = Math.abs(totalRotation);
  const duration = Date.now() - scrollAccumulator.startTime;
  const screenInfo = getCurrentScreenInfo(scrollAccumulator.lastX, scrollAccumulator.lastY);
  
  // Only capture meaningful scrolls (ignore tiny movements)
  if (amount < 0.5) {
    console.log(`Ignoring minimal scroll (${amount.toFixed(1)})`);
    scrollAccumulator.events = [];
    return;
  }
  
  // Get browser-relative coordinates for scroll location
  const appBounds = await getApplicationWindowBounds();
  const appRelative = getApplicationRelativeCoordinates(scrollAccumulator.lastX, scrollAccumulator.lastY, appBounds);
  
  // Create atomic event slot for scroll
  const eventSlot = createEventSlot('scroll_sequence', {
    x: scrollAccumulator.lastX,
    y: scrollAccumulator.lastY,
    direction: direction,
    totalAmount: Math.round(amount * 10) / 10, // Round to 1 decimal
    duration: duration,
    individualScrolls: scrollAccumulator.events.length,
    screenInfo: screenInfo
  });
  
  if (appRelative && appRelative.isInsideApp) {
    console.log(`Scroll inside browser at (${appRelative.x}, ${appRelative.y}) relative to browser window`);
  }
  
  // Prepare additional data
  const additionalData = {};
  
  // Add browser-relative coordinates ONLY if we have accurate data
  if (appRelative && appBounds && appBounds.method !== 'fallback') {
    additionalData.appRelative = appRelative;
    console.log('✓ Added accurate browser-relative coordinates to scroll event');
  } else {
    console.log('✗ No accurate browser bounds - skipping browser-relative coordinates for scroll');
  }
  
  // Complete event with screenshot (async, but maintains chronological order)
  await eventSlot.complete(additionalData);
  
  console.log(`Captured SCROLL_SEQUENCE: ${direction} (${Math.round(amount * 10) / 10}) over ${duration}ms with ${scrollAccumulator.events.length} events at ${getVideoTimestamp().toFixed(2)}s`);
  
  // Reset accumulator
  scrollAccumulator.events = [];
  scrollAccumulator.totalVertical = 0;
  scrollAccumulator.totalHorizontal = 0;
}

function stopEventListeners() {
  console.log('Stopping event listeners');
  
  // Clear any pending scroll timer
  if (scrollDebounceTimer) {
    clearTimeout(scrollDebounceTimer);
    scrollDebounceTimer = null;
  }
  
  // Reset scroll accumulator
  scrollAccumulator.events = [];
  scrollAccumulator.totalVertical = 0;
  scrollAccumulator.totalHorizontal = 0;
  
  // Reset keyboard state
  shiftPressed = false;
  ctrlPressed = false;
  altPressed = false;
  cmdPressed = false;
  
  try {
    console.log('Removing uIOhook listeners...');
    uIOhook.removeAllListeners();
    
    console.log('Stopping uIOhook...');
    
    // Try to stop uIOhook in a non-blocking way
    setImmediate(() => {
      try {
        uIOhook.stop();
        console.log('uIOhook stopped successfully');
      } catch (error) {
        console.error('Error in delayed uIOhook.stop():', error);
      }
    });
    
  } catch (error) {
    console.error('Error stopping uIOhook:', error);
  }
  
  console.log('Event listeners cleanup initiated');
}

// IPC handlers
ipcMain.handle('start-recording', async (event, taskName) => {
  console.log('IPC: start-recording called with task:', taskName);
  try {
    await startRecording(taskName);
    console.log('IPC: start-recording completed successfully');
    return { success: true };
  } catch (error) {
    console.error('IPC: start-recording failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-recording', async () => {
  console.log('IPC: stop-recording called');
  try {
    await stopRecording();
    console.log('IPC: stop-recording completed successfully');
    return { success: true };
  } catch (error) {
    console.error('IPC: stop-recording failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-recording-status', () => {
  const status = { isRecording, taskName: currentTaskName };
  return status;
});

ipcMain.handle('get-task-name', () => {
  return storedTaskName || null;
});

ipcMain.handle('set-task-name', (event, taskName) => {
  storedTaskName = taskName;
  return { success: true };
});

// Video recording IPC handlers
ipcMain.on('video-recording-started', () => {
  console.log('Video recording started');
});

ipcMain.on('video-recording-error', (event, error) => {
  console.error('Video recording error:', error);
});

ipcMain.on('video-data', async (event, buffer, mimeType, sourceId, screenIndex) => {
  try {
    // Determine file extension based on mime type
    let extension = '.webm'; // default
    if (mimeType && mimeType.includes('mp4')) {
      extension = '.mp4';
    } else if (mimeType && mimeType.includes('webm')) {
      extension = '.webm';
    }
    
    // Create filename with screen identification
    const screenId = screenIndex !== undefined ? `_screen_${screenIndex + 1}` : '';
    const displayId = sourceId ? `_display_${sourceId.slice(-6)}` : ''; // Last 6 chars of display ID
    const originalVideoPath = `data/${currentTaskName}/videos/recording${screenId}${displayId}${extension}`;
    
    await fs.writeFile(originalVideoPath, Buffer.from(buffer));
    console.log(`Screen ${screenIndex + 1} video saved:`, originalVideoPath, `(${mimeType})`);
    
    // Convert to MP4 if it's not already MP4
    if (extension === '.webm') {
      const mp4Path = `data/${currentTaskName}/videos/recording${screenId}${displayId}.mp4`;
      
      // Check if FFmpeg is available
      const ffmpegAvailable = await checkFFmpegAvailability();
      
      if (ffmpegAvailable) {
        console.log(`Converting screen ${screenIndex + 1} WebM to LOSSLESS MP4 (CRF 0)...`);
        try {
          await convertToMP4(originalVideoPath, mp4Path);

          // Delete the original WebM file after successful conversion
          try {
            await fs.unlink(originalVideoPath);
            console.log(`✓ Screen ${screenIndex + 1} original WebM file deleted`);
          } catch (deleteError) {
            console.warn(`Could not delete screen ${screenIndex + 1} original WebM file:`, deleteError.message);
          }

          console.log(`✓ Screen ${screenIndex + 1} LOSSLESS video conversion completed - final file:`, mp4Path);
        } catch (conversionError) {
          console.error(`Screen ${screenIndex + 1} lossless video conversion failed, keeping original WebM file:`, conversionError.message);
        }
      } else {
        console.log(`✗ FFmpeg not available for screen ${screenIndex + 1} - keeping WebM file. Install FFmpeg to enable lossless MP4 conversion.`);
      }
    }
    
  } catch (error) {
    console.error(`Failed to save screen ${screenIndex + 1} video:`, error);
  }
});

// Global keyboard shortcuts (integrated into main event listeners)
function setupGlobalKeyboardShortcuts() {
  console.log('✓ Global keyboard shortcuts will be handled by main event listeners');
  // Note: Global shortcuts are now integrated into the main keydown handler in startEventListeners()
  // This prevents duplicate event listeners and race conditions
}

app.whenReady().then(async () => {
  await createMainWindow();
  await createOverlayWindow();
  await createVideoRecorderWindow();
  
  // Check FFmpeg availability on startup
  console.log('Checking FFmpeg availability...');
  const ffmpegAvailable = await checkFFmpegAvailability();
  if (ffmpegAvailable) {
    console.log('✓ FFmpeg ready - WebM videos will be auto-converted to LOSSLESS MP4 (CRF 0)');
  } else {
    console.log('ℹ FFmpeg not found - videos will be saved as WebM (install FFmpeg for lossless MP4 conversion)');
  }
  
  // Start global keyboard shortcuts immediately
  setupGlobalKeyboardShortcuts();
  
  mainWindow.show();
});

app.on('window-all-closed', async () => {
  if (isRecording) {
    await stopRecording();
  }
  stopOverlayTracking();
  stopEventListeners();
  app.quit();
});

app.on('before-quit', async (event) => {
  event.preventDefault();
  
  console.log('Before quit - cleaning up...');
  
  if (isRecording) {
    await stopRecording();
  }
  
  stopOverlayTracking();
  stopEventListeners();
  
  // Force quit after cleanup
  setTimeout(() => {
    app.exit(0);
  }, 100);
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createMainWindow();
    await createOverlayWindow();
    await createVideoRecorderWindow();
  }
});

// Handle getting screen sources for video recording
ipcMain.handle('get-screen-sources', async () => {
  try {
    // Get both screen displays and individual windows
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 150, height: 150 }
    });

    // Filter and categorize sources
    const screens = sources.filter(source => source.id.startsWith('screen:'));
    const windows = sources.filter(source => source.id.startsWith('window:'))
                           .filter(source =>
                             // Filter out system windows and empty names
                             source.name.length > 0 &&
                             !source.name.includes('Desktop') &&
                             !source.name.includes('Wallpaper') &&
                             !source.name.includes('Window Server')
                           );

    console.log(`Found ${screens.length} screen displays and ${windows.length} application windows`);

    // For now, return only screens to maintain existing behavior
    // TODO: In future, could add UI to let user choose screens vs windows
    return screens;
  } catch (error) {
    console.error('Failed to get screen sources:', error);
    throw error;
  }
});

// Handle getting display information for optimal video quality
ipcMain.handle('get-display-info', () => {
  try {
    const displays = screen.getAllDisplays();
    return displays.map(display => ({
      id: display.id,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      size: display.size,
      workAreaSize: display.workAreaSize
    }));
  } catch (error) {
    console.error('Failed to get display info:', error);
    throw error;
  }
});

// Handle getting overlay bounds for video exclusion
ipcMain.handle('get-overlay-bounds', () => {
  try {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      return overlayWindow.getBounds();
    }
    return null;
  } catch (error) {
    console.error('Failed to get overlay bounds:', error);
    return null;
  }
});

// Add IPC handler to reset overlay position
ipcMain.handle('reset-overlay-position', async () => {
  try {
    userPositioned = false;
    savedPosition = null;
    
    // Delete saved position file
    try {
      await fs.unlink(configPath);
    } catch {
      // File doesn't exist, that's fine
    }
    
    // Reposition to default location
    repositionOverlay();
    
    // Restart tracking with default behavior
    startOverlayTracking();
    
    console.log('Overlay position reset to automatic');
    return { success: true };
  } catch (error) {
    console.error('Failed to reset overlay position:', error);
    return { success: false, error: error.message };
  }
});

// Add IPC handler to quit app
ipcMain.handle('quit-app', async () => {
  console.log('Quit requested - cleaning up...');
  
  // Stop recording if active
  if (isRecording) {
    await stopRecording();
  }
  
  // Stop all tracking
  stopOverlayTracking();
  stopEventListeners();
  
  // Close all windows
  const windows = BrowserWindow.getAllWindows();
  windows.forEach(window => {
    if (!window.isDestroyed()) {
      window.destroy();
    }
  });
  
  // Force quit
  app.exit(0);
});