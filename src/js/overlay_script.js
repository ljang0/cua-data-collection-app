const { ipcRenderer } = require('electron');
        
let isRecording = false;
const statusIndicator = document.getElementById('statusIndicator');
const taskInput = document.getElementById('taskInput');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const recordingNotification = document.getElementById('recordingNotification');

// Show brief notification for recording events
function showNotification(message, isStop = false) {
    recordingNotification.textContent = message;
    recordingNotification.className = `recording-notification show ${isStop ? 'stop' : ''}`;
    
    // Hide after 2 seconds
    setTimeout(() => {
        recordingNotification.classList.remove('show');
    }, 2000);
}

startBtn.addEventListener('click', async () => {
    console.log('Start button clicked');
    const taskName = taskInput.value.trim();
    if (!taskName) {
        alert('Please enter a task name first!');
        taskInput.focus();
        return;
    }
    
    try {
        console.log('Starting recording with task:', taskName);
        await ipcRenderer.invoke('start-recording', taskName);
        console.log('Recording started successfully');
    } catch (error) {
        console.error('Failed to start recording:', error);
    }
});

stopBtn.addEventListener('click', async (event) => {
    console.log('Stop button clicked!');
    event.preventDefault();
    event.stopPropagation();
    
    try {
        console.log('Stopping recording...');
        await ipcRenderer.invoke('stop-recording');
        console.log('Recording stopped successfully');
    } catch (error) {
        console.error('Failed to stop recording:', error);
    }
});

taskInput.addEventListener('input', () => {
    const hasTask = taskInput.value.trim().length > 0;
    startBtn.disabled = !hasTask || isRecording;
});

ipcRenderer.on('recording-started', () => {
    isRecording = true;
    statusIndicator.classList.add('recording');
    startBtn.disabled = true;
    stopBtn.disabled = false;
    taskInput.disabled = true;
});

ipcRenderer.on('recording-stopped', () => {
    isRecording = false;
    statusIndicator.classList.remove('recording');
    startBtn.disabled = false;
    stopBtn.disabled = true;
    taskInput.disabled = false;
    
    // Clear task input after successful recording
    setTimeout(() => {
        taskInput.value = '';
        startBtn.disabled = true; // Disable start button until new task entered
    }, 2000);
});

// Handle screenshot mode
ipcRenderer.on('enter-screenshot-mode', () => {
    document.querySelector('.overlay-container').classList.add('screenshot-mode');
});

ipcRenderer.on('exit-screenshot-mode', () => {
    document.querySelector('.overlay-container').classList.remove('screenshot-mode');
});

// Handle recording mode (completely invisible during video recording)
ipcRenderer.on('enter-recording-mode', () => {
    document.querySelector('.overlay-container').classList.add('recording-mode');
    console.log('Overlay entered recording mode (invisible)');
});

ipcRenderer.on('exit-recording-mode', () => {
    document.querySelector('.overlay-container').classList.remove('recording-mode');
    showNotification('⏹️ Recording Stopped', true);
    console.log('Overlay exited recording mode (visible)');
});

// Initialize
startBtn.disabled = true; // Start disabled until task name entered