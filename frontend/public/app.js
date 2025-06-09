// DOM Elements
console.log('App.js loaded - Test change', new Date().toISOString());
const menuButton = document.getElementById('menuButton');
const menuPanel = document.getElementById('menuPanel');
const precheckView = document.getElementById('precheckView');
const inspectionView = document.getElementById('inspectionView');
const cameraToggle = document.getElementById('cameraToggle');
const captureButton = document.getElementById('captureButton');
const camera = document.getElementById('camera');
const micButton = document.getElementById('micButton');
const inspectionInput = document.getElementById('inspectionInput');
const processButton = document.getElementById('processButton');
const citationResults = document.getElementById('citationResults');
const menuItems = document.querySelectorAll('.menu-item');

// State
let isMenuOpen = false;
let isCameraOn = false;
let isRecording = false;
let currentView = null;
let mediaStream = null;
let recognition = null;
let capturedImage = null;
const retakeButton = document.getElementById('retakeButton');
const fileInput = document.getElementById('fileInput');

// AudioManager class to handle all audio-related operations
class AudioManager {
    constructor() {
        this.currentAudio = null;
        this.currentAudioController = null;
        this.currentStreamController = null; // For aborting the audio stream fetch
        this.currentEventSource = null;
        this.audioQueue = [];
        this.isStreamPlaying = false;
    }

    stopAudio() {
        console.log('AudioManager: stopAudio called');
        
        // Stop current audio playback
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.currentTime = 0;
            this.currentAudio = null;
            console.log('AudioManager: Current audio paused and cleared');
        }
        
        // Abort fetch controller (for old method)
        if (this.currentAudioController) {
            this.currentAudioController.abort();
            this.currentAudioController = null;
        }
        
        // Close SSE connection
        if (this.currentEventSource) {
            this.currentEventSource.close();
            this.currentEventSource = null;
        }
        
        // Abort the streaming audio fetch request
        if (this.currentStreamController) {
            this.currentStreamController.abort();
            this.currentStreamController = null;
            console.log('AudioManager: Current audio stream fetch aborted');
        }
        
        // Clear audio queue
        this.audioQueue = [];
        this.isStreamPlaying = false;
        console.log('AudioManager: Audio queue cleared and stream playing flag reset');
    }

    async playAudio(text) {
        // For now, keep the old method for backward compatibility
        // This can be used as a fallback
        this.stopAudio();
        this.currentAudioController = new AbortController();

        try {
            const response = await fetch('https://us-central1-gemini-med-lit-review.cloudfunctions.net/fda-generate-audio', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ text }),
                signal: this.currentAudioController.signal
            });

            if (!response.ok) {
                throw new Error('Failed to generate audio');
            }

            const { audio } = await response.json();
            this.currentAudio = new Audio(`data:audio/wav;base64,${audio}`);
            this.currentAudio.play();
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('Audio request was cancelled');
            } else {
                console.error('Error playing audio:', error);
            }
        }
    }

    playStreamedAudio(text) {
        // Stop any existing audio/streams
        this.stopAudio();

        // Create SSE connection for streaming audio
        // Using POST body for text is more complex with EventSource, 
        // so we'll use a hybrid approach with POST to initiate
        this._startStreamingAudio(text);
    }

    async _startStreamingAudio(text) {
        // Create a new AbortController for this specific stream
        this.currentStreamController = new AbortController();
        const signal = this.currentStreamController.signal;

        try {
            console.log('AudioManager: Starting new audio stream');
            
            const response = await fetch('https://us-central1-gemini-med-lit-review.cloudfunctions.net/fda-generate-audio', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'  // Signal that we want streaming
                },
                body: JSON.stringify({ text }),
                signal: signal // Pass the signal to fetch
            });

            if (!response.ok) {
                throw new Error(`Failed to start audio stream: ${response.status} ${response.statusText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                // Check if aborted before reading
                if (signal.aborted) {
                    console.log('AudioManager: Stream read loop detected abort signal');
                    throw new DOMException('Aborted by user', 'AbortError');
                }
                
                const { done, value } = await reader.read();
                if (done) {
                    console.log('AudioManager: Stream reader finished (done)');
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line.startsWith('event:')) {
                        const eventType = line.substring(6).trim();
                        continue;
                    }
                    if (line.startsWith('data:')) {
                        const data = line.substring(5).trim();
                        if (data) {
                            try {
                                const parsed = JSON.parse(data);
                                this._handleStreamEvent(parsed);
                            } catch (e) {
                                console.error('Error parsing SSE data:', e);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('AudioManager: Audio stream fetch was aborted');
            } else {
                console.error('AudioManager: Error in audio streaming:', error);
            }
        } finally {
            console.log('AudioManager: _startStreamingAudio finally block');
            // Clear the controller if it was the one for this stream
            if (this.currentStreamController && this.currentStreamController.signal === signal) {
                this.currentStreamController = null;
                console.log('AudioManager: Cleared stream controller as stream ended');
            }
        }
    }

    _handleStreamEvent(data) {
        // Check if the stream was aborted
        if (this.currentStreamController && this.currentStreamController.signal.aborted) {
            console.log('AudioManager: _handleStreamEvent detected abort, not queuing audio');
            return;
        }

        if (data.audio) {
            // Add audio chunk to queue
            this.audioQueue.push(data.audio);
            console.log(`AudioManager: Added audio chunk ${data.sentence_index + 1}/${data.total_sentences} to queue. Queue size: ${this.audioQueue.length}`);
            
            // Start playing if not already playing
            this._playNextFromQueue();
        } else if (data.error) {
            console.error('AudioManager: Stream error event:', data.error);
        } else if (data.message === 'Stream finished') {
            console.log('AudioManager: Audio stream finished event received');
        }
    }

    _playNextFromQueue() {
        // If already playing or queue is empty, return
        if (this.isStreamPlaying || this.audioQueue.length === 0) {
            if (this.isStreamPlaying) console.log('AudioManager: _playNextFromQueue - already playing');
            if (this.audioQueue.length === 0) console.log('AudioManager: _playNextFromQueue - queue empty');
            return;
        }

        // Check if the stream was aborted before playing next
        if (this.currentStreamController && this.currentStreamController.signal.aborted) {
            console.log('AudioManager: _playNextFromQueue detected abort, not playing next from queue');
            this.audioQueue = []; // Clear queue as the stream is aborted
            this.isStreamPlaying = false;
            return;
        }

        this.isStreamPlaying = true;
        const audioBase64 = this.audioQueue.shift();
        console.log(`AudioManager: Playing next from queue. Remaining: ${this.audioQueue.length}`);

        // Create audio element
        this.currentAudio = new Audio(`data:audio/wav;base64,${audioBase64}`);
        
        // Set up event handlers
        this.currentAudio.onended = () => {
            console.log('AudioManager: Audio chunk ended');
            this.isStreamPlaying = false;
            this.currentAudio = null; // Clear current audio instance
            this._playNextFromQueue(); // Play next chunk
        };

        this.currentAudio.onerror = (error) => {
            console.error('AudioManager: Error playing audio chunk:', error);
            this.isStreamPlaying = false;
            this.currentAudio = null; // Clear current audio instance
            // Try to play next chunk
            this._playNextFromQueue();
        };

        // Start playback
        this.currentAudio.play().catch(error => {
            console.error('AudioManager: Failed to play audio chunk:', error);
            this.isStreamPlaying = false;
            this.currentAudio = null; // Clear current audio instance
            this._playNextFromQueue();
        });
    }
}

const audioManager = new AudioManager();

async function resizeAndCompressImage(base64Str, maxWidth, maxHeight, quality) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.src = base64Str;
        img.onload = () => {
            let width = img.width;
            let height = img.height;

            if (width > height) {
                if (width > maxWidth) {
                    height = Math.round((height * maxWidth) / width);
                    width = maxWidth;
                }
            } else {
                if (height > maxHeight) {
                    width = Math.round((width * maxHeight) / height);
                    height = maxHeight;
                }
            }
            
            // Ensure width and height are at least 1px to avoid canvas errors
            width = Math.max(1, width);
            height = Math.max(1, height);

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = (error) => {
            console.error("Image load error in resize function:", error);
            reject(new Error("Failed to load image for resizing."));
        };
    });
}

// Initialize Speech Recognition
if ('webkitSpeechRecognition' in window) {
    recognition = new webkitSpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
        micButton.classList.add('recording');
        isRecording = true;
    };

    recognition.onend = () => {
        micButton.classList.remove('recording');
        isRecording = false;
    };

    recognition.onresult = (event) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcript;
            }
        }
        if (finalTranscript) {
            inspectionInput.value = finalTranscript;
        }
    };
}

// Get location details from coordinates dropdown
function getLocationDetails(address) {
    const coordinates = document.getElementById('coordinates');
    const locationData = JSON.parse(coordinates.dataset.coordinates);
    return locationData.find(location => location.address === address);
}

// Load satellite image for a location
async function loadSatelliteImage(address) {
    console.log('Fetching satellite image...');
    try {
        const imageResult = await window.getMapData({ address });
        
        if (!imageResult.data) {
            console.error('No data received from getMapData');
            throw new Error('Failed to get satellite image data');
        }
        
        const { mapUrl, mapImage } = imageResult.data;
        if (!mapImage) {
            console.error('No image data received from getMapData');
            throw new Error('Failed to get satellite image');
        }
        
        console.log('Successfully received satellite image');
        
        // Get location details
        const locationDetails = getLocationDetails(address);
        
        // Display satellite image
        mapContainer.innerHTML = `
            <img src="${mapImage}" alt="Satellite view" style="width: 100%; height: 100%; object-fit: cover;">
        `;
        
        return { mapImage, locationDetails };
    } catch (err) {
        console.error('Error loading satellite image:', err);
        mapContainer.innerHTML = '<div style="padding: 16px; color: var(--error);">Error loading satellite image</div>';
        throw err;
    }
}

// Analyze site image
async function analyzeSite(mapImage) {
    console.log('Starting vehicle detection analysis...');
    try {
        const analysisResult = await fetch('https://us-central1-gemini-med-lit-review.cloudfunctions.net/site-check-py', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ image: mapImage })
        });

        if (!analysisResult.ok) {
            const errorText = await analysisResult.text();
            console.error('Analysis failed:', errorText);
            throw new Error(`Failed to analyze image: ${errorText}`);
        }

        console.log('Received analysis response');
        const analysisData = await analysisResult.json();
        console.log('Analysis data:', {
            hasVehicleAnalysis: !!analysisData.vehicle_analysis,
            hasAnnotatedImage: !!analysisData.annotated_image,
            totalClusters: analysisData.vehicle_analysis?.total_clusters,
            clusterCount: analysisData.vehicle_analysis?.clusters?.length
        });

        const { vehicle_analysis, annotated_image } = analysisData;
        if (!vehicle_analysis || !annotated_image) {
            console.error('Invalid analysis response:', analysisData);
            throw new Error('Invalid analysis response');
        }

        // Validate cluster data
        if (!vehicle_analysis.clusters || !Array.isArray(vehicle_analysis.clusters)) {
            console.error('Missing or invalid clusters array:', vehicle_analysis);
            throw new Error('Invalid cluster data in analysis response');
        }

        if (!vehicle_analysis.activity_level || !['low', 'high', 'moderate'].includes(vehicle_analysis.activity_level)) {
            console.error('Missing or invalid activity_level:', vehicle_analysis);
            throw new Error('Invalid activity level in analysis response');
        }

        return { vehicle_analysis, annotated_image };
    } catch (err) {
        console.error('Error during analysis:', err);
        throw err;
    }
}

// Initialize map view
let mapContainer = null;
async function initMap() {
    mapContainer = document.getElementById('map');
    const coordinates = document.getElementById('coordinates');
    const defaultAddress = "10 Riverside Dr, Long Prairie, MN 56347";
    
    // Set the default value
    coordinates.value = defaultAddress;
    
    // Start analysis for default address
    await analyzeLocation(defaultAddress);
}

let currentAnalysisController = null;

// Analyze a location
async function analyzeLocation(address) {
    const resultElement = document.getElementById('precheckResult');
    resultElement.textContent = 'Loading satellite image...';

    // Create a local controller for this analysis
    const localAbortController = new AbortController();

    // Cancel any ongoing analysis
    if (currentAnalysisController) {
        currentAnalysisController.abort();
    }
    
    // Set this as the current active controller
    currentAnalysisController = localAbortController;

    // Stop any playing audio
    audioManager.stopAudio();

    try {
        // First load the satellite image
        const { mapImage, locationDetails } = await loadSatelliteImage(address);
        
        // Show initial location info while analysis runs
        resultElement.innerHTML = `
            <div style="margin-bottom: 8px;">
                <span style="font-weight: 600;">Location:</span>
                <div style="font-size: 0.875rem; font-weight: 600;">${locationDetails.name}</div>
                <div style="font-size: 0.875rem;">${locationDetails.address}</div>
                <div style="font-size: 0.875rem; color: var(--on-surface-variant);">Coordinates: ${locationDetails.lat}, ${locationDetails.lon}</div>
            </div>
            <div style="margin-top: 16px;">
                <div style="font-size: 0.875rem;">Analyzing site activity...</div>
            </div>
        `;
        
        // Initialize streaming output
        resultElement.innerHTML = `
            <div style="margin-bottom: 8px;">
                <span style="font-weight: 600;">Location:</span>
                <div style="font-size: 0.875rem; font-weight: 600;">${locationDetails.name}</div>
                <div style="font-size: 0.875rem;">${locationDetails.address}</div>
            </div>
            <div id="streamingOutput">
                Starting analysis...
            </div>
        `;

        // Start analysis in parallel with streaming
        const analysisPromise = analyzeSite(mapImage).catch(error => {
            console.error('Analysis failed:', error);
            throw error;
        });

        // Start streaming status updates
        const streamingOutput = document.getElementById('streamingOutput');
        const analysisStream = new EventSource('https://us-central1-gemini-med-lit-review.cloudfunctions.net/site-check-py/stream');
        
        // Wait for streaming to complete
        await new Promise((resolve, reject) => {
            analysisStream.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'status') {
                        streamingOutput.innerHTML = `<div class="streaming-loading">
                            <span>${data.content}</span>
                            <div class="loading-dots">
                                <span>.</span><span>.</span><span>.</span>
                            </div>
                        </div>`;
                        
                        if (data.content.includes('Finalizing analysis')) {
                            analysisStream.close();
                            resolve();
                        }
                    }
                } catch (error) {
                    console.error('Error parsing stream data:', error);
                    analysisStream.close();
                    reject(error);
                }
            };

            analysisStream.onerror = (error) => {
                console.error('Stream error:', error);
                analysisStream.close();
                reject(new Error('Stream connection failed'));
            };

            // Debug logging to identify the null issue
            console.log('Debug: localAbortController =', localAbortController);
            console.log('Debug: type of localAbortController =', typeof localAbortController);
            if (localAbortController) {
                console.log('Debug: localAbortController.signal =', localAbortController.signal);
                console.log('Debug: type of localAbortController.signal =', typeof localAbortController.signal);
            } else {
                console.error('Debug: localAbortController is null or undefined!');
            }

            localAbortController.signal.addEventListener('abort', () => {
                analysisStream.close();
                reject(new Error('Analysis aborted'));
            });
        });

        // Wait for analysis to complete
        const analysisResult = await analysisPromise;
        
        // Update map with annotated image
        mapContainer.innerHTML = `
            <img src="${analysisResult.annotated_image}" alt="Analyzed satellite view" style="width: 100%; height: 100%; object-fit: cover;">
        `;

        // Update streaming output with final results
        const { activity_level, clusters, observations } = analysisResult.vehicle_analysis;
        let activityDescription;
        let activityLabel;
        
        if (activity_level === "low") {
            activityDescription = "Limited vehicle activity detected, suggesting minimal or intermittent site usage.";
            activityLabel = "Low";
        } else if (activity_level === "moderate") {
            activityDescription = "Moderate vehicle activity detected.";
            activityLabel = "Moderate";
        } else { // Handles "high"
            activityDescription = "Significant vehicle activity detected, indicating active site operations.";
            activityLabel = "High";
        }

        // Add a slight delay to ensure streaming messages are visible
        await new Promise(resolve => setTimeout(resolve, 500));

        const finalResults = `
            <div style="margin-top: 16px;">
                <div style="font-weight: 600; margin-bottom: 8px;">Activity Level: ${activityLabel}</div>
                <div style="margin-bottom: 16px;">${activityDescription}</div>
                <div style="margin-top: 16px; color: var(--on-surface-variant);">
                ${observations.map(obs => `
                    <div style="margin-top: 8px;">• ${obs}</div>
                `).join('')}
                </div>
            </div>
        `;
        
        // Update with final results
        streamingOutput.innerHTML = `
            <div style="font-size: 0.875rem; color: var(--primary); margin-bottom: 8px;">Analysis complete</div>
            ${finalResults}
        `;

        // Automatically play audio using streaming
        const speechText = `Activity Level: ${activityLabel}. ${activityDescription} ${observations.join('. ')}`;
        audioManager.playStreamedAudio(speechText);
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('Analysis was cancelled');
        } else {
            console.error('Error analyzing location:', error);
            resultElement.innerHTML = `
                <div style="padding: 16px; color: var(--error);">
                    Error: ${error.message}
                </div>
            `;
        }
    } finally {
        // Only nullify if this is still the current controller
        if (currentAnalysisController === localAbortController) {
            currentAnalysisController = null;
        }
    }
}

// Menu is now hover-based, so we don't need click toggle
// Keep the button for visual consistency but no click handler needed

// View Switching
menuItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const view = e.target.dataset.view;
        switchView(view);
    });
});

function switchView(view) {
    if (currentView === view) return;
    
    // Stop any playing audio
    audioManager.stopAudio();
    
    // Hide all views
    precheckView.style.display = 'none';
    inspectionView.style.display = 'none';
    
    // Show selected view
    if (view === 'precheck') {
        precheckView.style.display = 'block';
        initMap();
    } else if (view === 'inspection') {
        inspectionView.style.display = 'block';
        // Initialize inspection view buttons
        captureButton.style.display = 'inline-flex';
        retakeButton.style.display = 'none';
        // Clear any existing preview or results
        const preview = document.getElementById('preview');
        if (preview) preview.remove();
        citationResults.innerHTML = '';
        inspectionInput.value = '';
        
        // Reset camera view to show placeholder
        camera.style.display = 'none';
        const placeholder = document.getElementById('cameraPlaceholder');
        if (placeholder) placeholder.style.display = 'flex';
        
        // If camera was on, turn it off
        if (isCameraOn) {
            if (mediaStream) {
                mediaStream.getTracks().forEach(track => track.stop());
                camera.srcObject = null;
            }
            isCameraOn = false;
            cameraToggle.querySelector('.material-icons').textContent = 'videocam_off';
        }
    }
    
    currentView = view;
    
    // Update active menu item
    menuItems.forEach(item => {
        item.classList.toggle('active', item.dataset.view === view);
    });
}

// Camera Controls
async function toggleCamera() {
    const placeholder = document.getElementById('cameraPlaceholder');
    
    if (!isCameraOn) {
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'environment'
                }
            });
            camera.srcObject = mediaStream;
            isCameraOn = true;
            cameraToggle.querySelector('.material-icons').textContent = 'videocam';
            
            // Hide placeholder and show camera
            if (placeholder) placeholder.style.display = 'none';
            camera.style.display = 'block';
        } catch (err) {
            console.error('Error accessing camera:', err);
            alert('Unable to access camera. Please ensure you have granted camera permissions.');
        }
    } else {
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            camera.srcObject = null;
        }
        isCameraOn = false;
        cameraToggle.querySelector('.material-icons').textContent = 'videocam_off';
        
        // Show placeholder and hide camera
        camera.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
    }
}

// Microphone Controls
function toggleMicrophone() {
    if (!recognition) {
        alert('Speech recognition is not supported in this browser.');
        return;
    }

    if (!isRecording) {
        recognition.start();
    } else {
        recognition.stop();
    }
}

// Handle file upload
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = async (loadEvent) => { // Make async and use different event var name
            try {
                // Max width/height 1280px, JPEG quality 0.75
                const resizedImageBase64 = await resizeAndCompressImage(loadEvent.target.result, 1280, 1280, 0.75);
                capturedImage = resizedImageBase64;
                showPreview(capturedImage);
            } catch (error) {
                console.error("Error resizing image from file:", error);
                capturedImage = loadEvent.target.result; // Fallback to original
                showPreview(capturedImage);
                alert("Could not resize image. Proceeding with original if possible.");
            }
        };
        reader.readAsDataURL(file);
    }
});

// Capture frame
async function captureFrame() { // Make async
    if (!isCameraOn) {
        alert('Please turn on the camera first.');
        return;
    }

    // Create a canvas to capture the current video frame
    const canvas = document.createElement('canvas');
    canvas.width = camera.videoWidth;
    canvas.height = camera.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(camera, 0, 0);

    // Get base64 image data
    const originalImageBase64 = canvas.toDataURL('image/jpeg'); // Default browser quality
    try {
        // Max width/height 1280px, JPEG quality 0.75
        const resizedImageBase64 = await resizeAndCompressImage(originalImageBase64, 1280, 1280, 0.75);
        capturedImage = resizedImageBase64;
        showPreview(capturedImage);
    } catch (error) {
        console.error("Error resizing image from camera:", error);
        capturedImage = originalImageBase64; // Fallback to original
        showPreview(capturedImage);
        alert("Could not resize image. Proceeding with original if possible.");
    }
}

// Show preview
function showPreview(imageData) {
    // Show preview
    const preview = document.createElement('img');
    preview.src = imageData;
    preview.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; z-index: 10;';
    preview.id = 'preview';
    
    // Remove any existing preview
    const existingPreview = document.getElementById('preview');
    if (existingPreview) {
        existingPreview.remove();
    }
    
    // Hide the camera and placeholder
    camera.style.display = 'none';
    const placeholder = document.getElementById('cameraPlaceholder');
    if (placeholder) placeholder.style.display = 'none';
    
    // Add preview to the camera container
    const cameraContainer = camera.parentElement;
    cameraContainer.appendChild(preview);
    
    // Update button visibility
    captureButton.style.display = 'none';
    cameraToggle.style.display = 'none';
    retakeButton.style.display = 'flex';
}

// Retake photo
function retakePhoto() {
    // Remove preview
    const preview = document.getElementById('preview');
    if (preview) {
        preview.remove();
    }
    
    // Update button visibility
    captureButton.style.display = 'flex';
    cameraToggle.style.display = 'flex';
    retakeButton.style.display = 'none';
    
    // Clear captured image and file input
    capturedImage = null;
    fileInput.value = '';
    
    // Clear citation results
    citationResults.innerHTML = '';
    
    // Clear background input
    inspectionInput.value = '';
    
    // Show appropriate view based on camera state
    const placeholder = document.getElementById('cameraPlaceholder');
    if (isCameraOn) {
        camera.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
    } else {
        camera.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
    }
}

// Process Inspection
async function processInspection() {
    if (!capturedImage) {
        alert('Please capture a photo first.');
        return;
    }

    const background = inspectionInput.value.trim();
    if (!background) {
        alert('Please provide inspection background information.');
        return;
    }

    try {
        processButton.disabled = true;
        processButton.textContent = 'Processing...';

        // Clear previous results and show status container
        citationResults.innerHTML = `
            <div id="inspectionStatus" style="margin-bottom: 16px;">
                <div class="streaming-loading">
                    <span>Starting inspection...</span>
                    <div class="loading-dots">
                        <span>.</span><span>.</span><span>.</span>
                    </div>
                </div>
            </div>
            <div id="preliminaryCitations" style="display: none;"></div>
            <div id="verifiedCitations"></div>
        `;

        const statusElement = document.getElementById('inspectionStatus');
        const preliminaryCitationsElement = document.getElementById('preliminaryCitations');
        const verifiedCitationsElement = document.getElementById('verifiedCitations');
        
        let preliminaryCitations = [];
        let verifiedCitations = [];
        let summary = '';

        // Send the POST request first to start the analysis
        const postPromise = fetch('https://us-central1-gemini-med-lit-review.cloudfunctions.net/process-inspection', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                image: capturedImage,
                background: background
            })
        });

        // Start streaming status updates simultaneously
        const streamUrl = 'https://us-central1-gemini-med-lit-review.cloudfunctions.net/process-inspection/stream';
        const analysisStream = new EventSource(streamUrl);

        // Handle streaming events
        analysisStream.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log('Received stream event:', data.type, data);
                
                switch(data.type) {
                    case 'ANALYSIS_STARTED':
                        statusElement.innerHTML = `
                            <div class="streaming-loading">
                                <span>Image inspection process initiated...</span>
                                <div class="loading-dots">
                                    <span>.</span><span>.</span><span>.</span>
                                </div>
                            </div>
                        `;
                        break;
                        
                    case 'INITIAL_ANALYSIS_START':
                    case 'INITIAL_ANALYSIS_PROCESSING':
                        statusElement.innerHTML = `
                            <div class="streaming-loading">
                                <span>${data.content}</span>
                                <div class="loading-dots">
                                    <span>.</span><span>.</span><span>.</span>
                                </div>
                            </div>
                        `;
                        break;
                        
                    case 'INITIAL_CITATIONS_IDENTIFIED':
                        preliminaryCitations = data.data.citations;
                        statusElement.innerHTML = `
                            <div class="streaming-loading">
                                <span>Found ${preliminaryCitations.length} potential violations. Verifying...</span>
                                <div class="loading-dots">
                                    <span>.</span><span>.</span><span>.</span>
                                </div>
                            </div>
                        `;
                        // Show preliminary citations
                        preliminaryCitationsElement.innerHTML = `
                            <h3 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 8px;">Preliminary Findings:</h3>
                            ${preliminaryCitations.map((citation, idx) => `
                                <div class="card" style="margin-bottom: 8px; padding: 8px;">
                                    <span style="font-weight: 600;">Violation ${idx + 1}:</span> Section ${citation.section}
                                    <div style="font-size: 0.875rem; color: var(--on-surface-variant);">${citation.reason.substring(0, 100)}...</div>
                                </div>
                            `).join('')}
                        `;
                        preliminaryCitationsElement.style.display = 'block';
                        break;
                        
                    case 'VERIFICATION_PROCESS_START':
                        statusElement.innerHTML = `
                            <div class="streaming-loading">
                                <span>Cross-referencing ${data.data.citation_count} violations with FDA regulations...</span>
                                <div class="loading-dots">
                                    <span>.</span><span>.</span><span>.</span>
                                </div>
                            </div>
                        `;
                        break;
                        
                    case 'CITATION_VERIFICATION_START':
                    case 'CITATION_CODE_LOOKUP':
                    case 'CITATION_AI_VERIFICATION':
                        const citationNum = data.data.citation_index + 1;
                        const totalCitations = data.data.total_citations || preliminaryCitations.length;
                        statusElement.innerHTML = `
                            <div class="streaming-loading">
                                <span>${data.content || `Processing violation ${citationNum} of ${totalCitations}...`}</span>
                                <div class="loading-dots">
                                    <span>.</span><span>.</span><span>.</span>
                                </div>
                            </div>
                        `;
                        break;
                        
                    case 'SINGLE_CITATION_PROCESSED':
                        verifiedCitations.push(data.data.processed_citation);
                        // Update the verified citations display
                        displayVerifiedCitations(verifiedCitations, verifiedCitationsElement);
                        break;
                        
                    case 'SUMMARY_GENERATION_START':
                        statusElement.innerHTML = `
                            <div class="streaming-loading">
                                <span>Generating inspection summary...</span>
                                <div class="loading-dots">
                                    <span>.</span><span>.</span><span>.</span>
                                </div>
                            </div>
                        `;
                        break;
                        
                    case 'SUMMARY_GENERATED':
                        summary = data.data.summary;
                        // Play the summary audio using streaming
                        audioManager.playStreamedAudio(summary);
                        break;
                        
                    case 'ANALYSIS_FINALIZING':
                        statusElement.innerHTML = `
                            <div class="streaming-loading">
                                <span>Finalizing analysis...</span>
                                <div class="loading-dots">
                                    <span>.</span><span>.</span><span>.</span>
                                </div>
                            </div>
                        `;
                        break;
                        
                    case 'ANALYSIS_COMPLETE':
                        // Final update with complete data
                        analysisStream.close();
                        statusElement.innerHTML = `
                            <div style="color: var(--tertiary);">
                                ✓ Analysis complete
                            </div>
                        `;
                        // Hide preliminary citations
                        preliminaryCitationsElement.style.display = 'none';
                        // Display final results
                        displayCitations(data.data.citations, data.data.summary);
                        break;
                        
                    case 'status':
                        // Fallback for any status messages
                        statusElement.innerHTML = `
                            <div class="streaming-loading">
                                <span>${data.content}</span>
                                <div class="loading-dots">
                                    <span>.</span><span>.</span><span>.</span>
                                </div>
                            </div>
                        `;
                        break;
                        
                    case 'heartbeat':
                        // Ignore heartbeat messages
                        break;
                        
                    default:
                        console.log('Unknown event type:', data.type);
                }
            } catch (error) {
                console.error('Error parsing stream data:', error);
            }
        };

        analysisStream.onerror = (error) => {
            console.error('Stream error:', error);
            analysisStream.close();
        };

        // Wait for the POST request to complete
        const response = await postPromise;
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        
        // If stream didn't provide complete results, use POST response
        if (!verifiedCitations.length) {
            displayCitations(result.citations, result.summary);
        }
        
        // Keep retake button visible after processing
        retakeButton.style.display = 'flex';
        captureButton.style.display = 'none';

    } catch (err) {
        console.error('Error processing inspection:', err);
        const statusElement = document.getElementById('inspectionStatus');
        if (statusElement) {
                statusElement.innerHTML = `
                    <div style="color: var(--error);">
                        An error occurred while processing the inspection: ${err.message}
                    </div>
                `;
        }
    } finally {
        processButton.disabled = false;
        processButton.textContent = 'Process';
    }
}

// Display verified citations as they come in
function displayVerifiedCitations(citations, container) {
    container.innerHTML = '';
    citations.forEach(citation => {
        const card = document.createElement('div');
        card.className = 'citation-card';
        card.innerHTML = `
            <img src="${citation.image}" alt="Citation evidence" style="width: 100%; height: auto; margin-bottom: 12px;">
            <h3><a href="${citation.url}" target="_blank">Section ${citation.section}</a></h3>
            <div style="margin-bottom: 12px;">
                <h4>Regulation:</h4>
                <p>${citation.text}</p>
            </div>
            <div>
                <h4>Reason:</h4>
                <p>${citation.reason}</p>
            </div>
        `;
        container.appendChild(card);
    });
}

// Display Citations
function displayCitations(citations, summary) {
    citationResults.innerHTML = '';

    // Create and add summary container
    const summaryContainer = document.createElement('div');
    summaryContainer.className = 'summary-container';
    summaryContainer.innerHTML = `
        <div id="streamingOutput">
            ${summary || 'No summary available for these citations.'}
        </div>
    `;
    citationResults.appendChild(summaryContainer);

    // Automatically play summary audio using streaming
    audioManager.playStreamedAudio(summary);

    // Add individual citation cards
    citations.forEach(citation => {
        const card = document.createElement('div');
        card.className = 'citation-card';
        card.innerHTML = `
            <img src="${citation.image}" alt="Citation evidence" style="width: 100%; height: auto; margin-bottom: 12px;">
            <h3><a href="${citation.url}" target="_blank">Section ${citation.section}</a></h3>
            <div style="margin-bottom: 12px;">
                <h4>Regulation:</h4>
                <p>${citation.text}</p>
            </div>
            <div>
                <h4>Reason:</h4>
                <p>${citation.reason}</p>
            </div>
        `;
        citationResults.appendChild(card);
    });
}

// Event Listeners
cameraToggle.addEventListener('click', toggleCamera);
micButton.addEventListener('click', toggleMicrophone);
captureButton.addEventListener('click', captureFrame);
retakeButton.addEventListener('click', retakePhoto);
processButton.addEventListener('click', processInspection);

// Wait for Firebase to initialize before starting the app
window.addEventListener('firebaseReady', () => {
    // Initialize first view
    switchView('precheck');

    // Handle location selection for precheck
    document.getElementById('coordinates').addEventListener('change', async (e) => {
        const address = e.target.value;
        if (!address) return;
        
        audioManager.stopAudio(); // Stop any playing audio immediately
        
        // The analyzeLocation function will handle cancelling any ongoing analysis
        await analyzeLocation(address);
    });
});

// Add event listener for page navigation
window.addEventListener('popstate', () => {
    audioManager.stopAudio();
});

// Add error handling for Firebase initialization
window.addEventListener('error', (event) => {
    if (event.error?.message?.includes('Firebase')) {
        console.error('Firebase initialization error:', event.error);
        const resultElement = document.getElementById('precheckResult');
        if (resultElement) {
            resultElement.innerHTML = `
                <div style="padding: 16px; color: var(--error);">
                    Error initializing application. Please try refreshing the page.
                </div>
            `;
        }
    }
});
