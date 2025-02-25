// DOM Elements
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
            <img src="${mapImage}" alt="Satellite view" class="w-full h-full object-cover rounded-lg">
        `;
        
        return { mapImage, locationDetails };
    } catch (err) {
        console.error('Error loading satellite image:', err);
        mapContainer.innerHTML = '<div class="p-4 text-red-600">Error loading satellite image</div>';
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
            totalVehicles: analysisData.vehicle_analysis?.total_vehicles,
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

        if (!vehicle_analysis.activity_level || !['low', 'high'].includes(vehicle_analysis.activity_level)) {
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

// Analyze a location
async function analyzeLocation(address) {
    const resultElement = document.getElementById('precheckResult');
    resultElement.textContent = 'Loading satellite image...';

    try {
        // First load the satellite image
        const { mapImage, locationDetails } = await loadSatelliteImage(address);
        
        // Show initial location info while analysis runs
        resultElement.innerHTML = `
            <div class="mb-2">
                <span class="font-semibold">Location:</span>
                <div class="text-sm font-bold">${locationDetails.name}</div>
                <div class="text-sm">${locationDetails.address}</div>
                <div class="text-sm text-gray-600">Coordinates: ${locationDetails.lat}, ${locationDetails.lon}</div>
            </div>
            <div class="animate-pulse mt-4">
                <div class="text-sm">Analyzing site activity...</div>
            </div>
        `;
        
        // Initialize streaming output
        resultElement.innerHTML = `
            <div class="mb-2">
                <span class="font-semibold">Location:</span>
                <div class="text-sm font-bold">${locationDetails.name}</div>
                <div class="text-sm">${locationDetails.address}</div>
            </div>
            <div id="streamingOutput" class="mb-4 p-4 bg-blue-50 border-l-4 border-blue-500 text-blue-700">
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
        });

        // Wait for analysis to complete
        const analysisResult = await analysisPromise;
        
        // Update map with annotated image
        mapContainer.innerHTML = `
            <img src="${analysisResult.annotated_image}" alt="Analyzed satellite view" class="w-full h-full object-cover rounded-lg">
        `;

        // Update streaming output with final results
        const { activity_level, clusters, observations } = analysisResult.vehicle_analysis;
        let activityDescription;
        
        if (activity_level === "low") {
            activityDescription = "Limited vehicle activity detected (6 or fewer vehicles), suggesting minimal or intermittent site usage.";
        } else {
            activityDescription = "Significant vehicle activity detected (more than 6 vehicles), indicating active site operations.";
        }

        // Add a slight delay to ensure streaming messages are visible
        await new Promise(resolve => setTimeout(resolve, 500));

        const finalResults = `
            <div class="mt-4">
                <div class="font-bold mb-2">Activity Level: ${activity_level === "low" ? "Low" : "High"}</div>
                <div class="mb-4">${activityDescription}</div>
                <div class="mt-4 text-gray-600">
                ${observations.map(obs => `
                    <div class="mt-2">• ${obs}</div>
                `).join('')}
                </div>
            </div>
        `;
        
        // Update with final results
        streamingOutput.innerHTML = `
            <div class="text-sm text-blue-600 mb-2">Analysis complete</div>
            ${finalResults}
        `;

        // Automatically play audio
        (async () => {
            try {
                const speechText = `Activity Level: ${activity_level === "low" ? "Low" : "High"}. ${activityDescription} ${observations.join('. ')}`;
                const response = await fetch('https://us-central1-gemini-med-lit-review.cloudfunctions.net/fda-generate-audio', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ text: speechText })
                });

                if (!response.ok) {
                    throw new Error('Failed to generate audio');
                }

                const { audio } = await response.json();
                const audioElement = new Audio(`data:audio/wav;base64,${audio}`);
                audioElement.play();
            } catch (error) {
                console.error('Error playing audio:', error);
            }
        })();
    } catch (error) {
        console.error('Error analyzing location:', error);
        resultElement.innerHTML = `
            <div class="p-4 text-red-600">
                Error: ${error.message}
            </div>
        `;
    }
}

// Menu Toggle
menuButton.addEventListener('click', () => {
    isMenuOpen = !isMenuOpen;
    menuPanel.classList.toggle('hidden');
    menuPanel.classList.toggle('visible');
});

// View Switching
menuItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const view = e.target.dataset.view;
        switchView(view);
        isMenuOpen = false;
        menuPanel.classList.add('hidden');
        menuPanel.classList.remove('visible');
    });
});

function switchView(view) {
    if (currentView === view) return;
    
    // Hide all views
    precheckView.classList.add('hidden');
    inspectionView.classList.add('hidden');
    
    // Show selected view
    if (view === 'precheck') {
        precheckView.classList.remove('hidden');
        initMap();
    } else if (view === 'inspection') {
        inspectionView.classList.remove('hidden');
        // Initialize inspection view buttons
        captureButton.style.display = 'flex';
        retakeButton.style.display = 'none';
        // Clear any existing preview or results
        const preview = document.getElementById('preview');
        if (preview) preview.remove();
        citationResults.innerHTML = '';
        inspectionInput.value = '';
    }
    
    currentView = view;
    
    // Update active menu item
    menuItems.forEach(item => {
        item.classList.toggle('active', item.dataset.view === view);
    });
}

// Camera Controls
async function toggleCamera() {
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
            cameraToggle.classList.remove('bg-blue-500');
            cameraToggle.classList.add('bg-red-500');
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
        cameraToggle.classList.remove('bg-red-500');
        cameraToggle.classList.add('bg-blue-500');
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
        reader.onload = (e) => {
            capturedImage = e.target.result;
            showPreview(capturedImage);
        };
        reader.readAsDataURL(file);
    }
});

// Capture frame
function captureFrame() {
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
    capturedImage = canvas.toDataURL('image/jpeg');
    showPreview(capturedImage);
}

// Show preview
function showPreview(imageData) {
    // Show preview
    const preview = document.createElement('img');
    preview.src = imageData;
    preview.className = 'absolute inset-0 w-full h-full object-contain bg-black';
    preview.style.zIndex = '10';
    preview.id = 'preview';
    
    // Remove any existing preview
    const existingPreview = document.getElementById('preview');
    if (existingPreview) {
        existingPreview.remove();
    }
    
    // Hide the camera
    camera.style.display = 'none';
    
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
    
    // Ensure camera is visible
    camera.style.display = 'block';
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

        // Generate a unique request ID
        const requestId = Date.now().toString();

        // Clear previous results and show status container
        citationResults.innerHTML = `
            <div id="inspectionStatus" class="mb-4 p-4 bg-blue-50 border-l-4 border-blue-500 text-blue-700">
                <div class="streaming-loading">
                    <span>Connecting to server...</span>
                    <div class="loading-dots">
                        <span>.</span><span>.</span><span>.</span>
                    </div>
                </div>
            </div>
        `;
        
        // Connect to the streaming endpoint first with the request ID
        const statusElement = document.getElementById('inspectionStatus');
        const streamUrl = `https://us-central1-gemini-med-lit-review.cloudfunctions.net/process-inspection?stream=true&request_id=${requestId}`;
        console.log('Connecting to stream URL:', streamUrl);
        let analysisStream = null;
        
        // Initialize processing promise to be awaited later
        const processingPromise = new Promise((resolve, reject) => {
            analysisStream = new EventSource(streamUrl);
            console.log('EventSource created');
            
            // Listen for stream messages
            analysisStream.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'status') {
                        statusElement.innerHTML = `
                            <div class="streaming-loading">
                                <span>${data.content}</span>
                                <div class="loading-dots">
                                    <span>.</span><span>.</span><span>.</span>
                                </div>
                            </div>
                        `;
                        
                        // If we receive the final message, resolve the promise
                        if (data.content === 'Analysis complete') {
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
            
            // Handle stream errors
            analysisStream.onerror = (error) => {
                console.error('Stream error:', error);
                console.error('EventSource readyState:', analysisStream.readyState);
                console.error('EventSource URL:', analysisStream.url);
                statusElement.innerHTML = `
                    <div class="error-message">
                        Error connecting to status stream. Processing will continue.
                    </div>
                `;
                analysisStream.close();
                // Resolve the promise to allow processing to continue
                resolve();
            };
        });
        
        // Send the actual processing request in parallel with the request ID
        const processingRequest = fetch('https://us-central1-gemini-med-lit-review.cloudfunctions.net/process-inspection', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                image: capturedImage,
                background: background,
                request_id: requestId
            })
        });
        
        // Set up a timeout for the entire process
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Processing timed out')), 120000) // 2 minute timeout
        );
        
        try {
            // Wait for both the stream and the processing request, with a timeout
            const [streamResult, response] = await Promise.all([
                Promise.race([processingPromise, timeoutPromise]),
                Promise.race([processingRequest, timeoutPromise])
            ]);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
        } catch (error) {
            console.error('Error during processing:', error);
            statusElement.innerHTML = `
                <div class="error-message">
                    An error occurred during processing: ${error.message}
                </div>
            `;
            throw error;
        } finally {
            // Ensure the stream is closed
            if (analysisStream) {
                analysisStream.close();
            }
        }
        
        // Display the final results
        displayCitations(result.citations, result.summary);
        
        // Keep retake button visible after processing
        retakeButton.style.display = 'flex';
        captureButton.style.display = 'none';

    } catch (err) {
        console.error('Error processing inspection:', err);
        alert('An error occurred while processing the inspection.');
    } finally {
        processButton.disabled = false;
        processButton.textContent = 'Process';
    }
}

// Display Citations
function displayCitations(citations, summary) {
    citationResults.innerHTML = '';

    // Create and add summary container
    const summaryContainer = document.createElement('div');
    summaryContainer.className = 'summary-container';
    summaryContainer.innerHTML = `
        <div id="streamingOutput" class="mb-4 p-4 bg-blue-50 border-l-4 border-blue-500 text-blue-700">
            ${summary || 'No summary available for these citations.'}
        </div>
    `;
    citationResults.appendChild(summaryContainer);

    // Automatically play summary audio
    (async () => {
        try {
            const response = await fetch('https://us-central1-gemini-med-lit-review.cloudfunctions.net/fda-generate-audio', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ text: summary })
            });

            if (!response.ok) {
                throw new Error('Failed to generate audio');
            }

            const { audio } = await response.json();
            const audioElement = new Audio(`data:audio/wav;base64,${audio}`);
            audioElement.play();
        } catch (error) {
            console.error('Error playing audio:', error);
        }
    })();

    // Add individual citation cards
    citations.forEach(citation => {
        const card = document.createElement('div');
        card.className = 'citation-card';
        card.innerHTML = `
            <img src="${citation.image}" alt="Citation evidence">
            <h3><a href="${citation.url}" target="_blank" class="text-blue-600 hover:text-blue-800">Section ${citation.section}</a></h3>
            <div class="mt-3">
                <h4 class="font-semibold text-gray-700">Regulation:</h4>
                <p class="text-gray-600 mb-2">${citation.text}</p>
            </div>
            <div class="mt-3">
                <h4 class="font-semibold text-gray-700">Reason:</h4>
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
        await analyzeLocation(address);
    });
});

// Add error handling for Firebase initialization
window.addEventListener('error', (event) => {
    if (event.error?.message?.includes('Firebase')) {
        console.error('Firebase initialization error:', event.error);
        const resultElement = document.getElementById('precheckResult');
        if (resultElement) {
            resultElement.innerHTML = `
                <div class="p-4 text-red-600">
                    Error initializing application. Please try refreshing the page.
                </div>
            `;
        }
    }
});
