// USED BY video-recorder.html
const { ipcRenderer } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
    const statusDiv = document.getElementById('status');
    const quitBtn = document.getElementById('quitBtn');

    async function updateStatus() {
        const status = await ipcRenderer.invoke('get-recording-status');
        
        if (status.isRecording) {
            statusDiv.className = 'status recording';
            statusDiv.textContent = `Recording: ${status.taskName}`;
        } else {
            statusDiv.className = 'status stopped';
            statusDiv.textContent = 'Use overlay to start recording';
        }
    }

    // Quit button handler
    quitBtn.addEventListener('click', async () => {
        await ipcRenderer.invoke('quit-app');
    });

    // Listen for recording status changes
    ipcRenderer.on('recording-started', updateStatus);
    ipcRenderer.on('recording-stopped', updateStatus);

    // Update status every few seconds
    setInterval(updateStatus, 3000);
    updateStatus();
});