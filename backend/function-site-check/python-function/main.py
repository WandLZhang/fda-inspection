import base64
import io
import os
import json
import time
import logging
import functions_framework
from PIL import Image, ImageDraw, ImageFont
from google import genai
from google.genai import types
from flask import jsonify, request

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Initialize Vertex AI clients
genai_client = genai.Client(
    vertexai=True,
    project="gemini-med-lit-review",
    location="global"
)

def compress_image(img: Image.Image, max_size_kb: int = 800) -> Image.Image:
    """Compress image to target size while maintaining quality"""
    quality = 95
    img_bytes = io.BytesIO()
    
    while quality > 5:  # Don't go below quality=5
        img_bytes.seek(0)
        img_bytes.truncate()
        img.save(img_bytes, format='JPEG', quality=quality)
        if len(img_bytes.getvalue()) <= max_size_kb * 1024:
            break
        quality -= 5
    
    img_bytes.seek(0)
    return Image.open(img_bytes)

def analyze_image_stream(img_base64: str) -> tuple[dict, str]:
    """
    Analyze image with Gemini 2.5 to detect vehicles and draw bounding boxes.
    Returns the analysis results and a new base64 image with boxes drawn.
    """
    try:
        # Convert base64 to PIL Image
        img_bytes = io.BytesIO(base64.b64decode(img_base64))
        img = Image.open(img_bytes)
        # Convert to RGB mode if needed
        if img.mode in ('RGBA', 'LA', 'P'):
            img = img.convert('RGB')
            
        # Compress image if needed
        img = compress_image(img)
        
        draw = ImageDraw.Draw(img)
        width, height = img.size

        # Prepare prompt for Gemini
        text_prompt = types.Part.from_text(text="""
    Analyze this satellite image and identify areas with vehicle activity, focusing on groups/clusters of vehicles.

    Vehicle Activity Assessment:
    1. Identify all areas where vehicles are present - parking lots, loading zones, street parking, etc.
    
    2. For each cluster of vehicles:
       - Draw ONE bounding box around the entire group
       - Include appropriate margin around the cluster
       - Use your judgment about what constitutes a meaningful cluster
    
    3. Reflection and Analysis:
       - After identifying potential clusters, reflect on their clarity, context, and relevance to overall site activity
       - Only include clusters in the final "clusters" array if you are reasonably confident they represent actual vehicle groups
       - Consider image quality, shadows, vehicle shapes, and spatial patterns in your assessment

    Coordinate System:
    - Origin (0,0) at top-left corner
    - X increases left to right (width)  
    - Y increases top to bottom (height)
    - All coordinates normalized to 0-1000 range
    
    Response Format:
    {
        "clusters": [
            {
                "box_2d": [y1, x1, y2, x2]  // [top, left, bottom, right] normalized to 0-1000
            }
        ],
        "total_clusters": number,  // Total number of clusters identified
        "activity_level": "low/high/moderate",  // Overall assessment of site vehicle activity
        "observations": [
            "Detailed reflection on the identified vehicle activity. Explain your overall confidence in the analysis.",
            "Describe why the included clusters were deemed significant and any patterns you observed.",
            "Mention any ambiguities, areas of low confidence, or reasons why some potential vehicle-like objects might have been excluded.",
            "Summarize the key characteristics of the site's vehicle presence and activity level."
        ]
    }
    """)

        # Get analysis from Gemini with streaming
        contents = [
            types.Content(
                role="user",
                parts=[text_prompt, types.Part.from_bytes(data=base64.b64decode(img_base64), mime_type="image/jpeg")]
            )
        ]

        response_schema = {
            "type": "OBJECT",
            "properties": {
                "clusters": {
                    "type": "ARRAY",
                    "items": {
                        "type": "OBJECT",
                        "properties": {
                            "box_2d": {
                                "type": "ARRAY",
                                "items": {"type": "NUMBER"}
                            }
                        },
                        "required": ["box_2d"]
                    }
                },
                "total_clusters": {"type": "NUMBER"},
                "activity_level": {"type": "STRING", "enum": ["low", "high", "moderate"]},
                "observations": {
                    "type": "ARRAY",
                    "items": {"type": "STRING"}
                }
            },
            "required": ["clusters", "total_clusters", "activity_level", "observations"]
        }

        generate_content_config = types.GenerateContentConfig(
            temperature=0.5,
            top_p=1,
            seed=0,
            max_output_tokens=65535,
            safety_settings=[
                types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH", threshold="OFF"),
                types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="OFF"),
                types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold="OFF"),
                types.SafetySetting(category="HARM_CATEGORY_HARASSMENT", threshold="OFF")
            ],
            response_mime_type="application/json",
            response_schema=response_schema
        )

        response_text = ""
        for chunk in genai_client.models.generate_content_stream(
            model="gemini-2.5-pro-preview-06-05",
            contents=contents,
            config=generate_content_config
        ):
            if not chunk.candidates or not chunk.candidates[0].content.parts:
                continue
            response_text += chunk.text

        # Parse JSON response
        analysis = json.loads(response_text.strip())
        
        # Validate expected structure
        if not isinstance(analysis, dict):
            raise ValueError("Response is not a JSON object")
        if 'clusters' not in analysis:
            raise ValueError("Response missing 'clusters' array")
        if not isinstance(analysis['clusters'], list):
            raise ValueError("'clusters' is not an array")
        if 'activity_level' not in analysis:
            raise ValueError("Response missing 'activity_level'")
        if analysis['activity_level'] not in ['low', 'high', 'moderate']:
            raise ValueError("Invalid activity_level value")

        # Draw boxes for all clusters returned by Gemini
        for cluster in analysis.get('clusters', []):
            coords = cluster['box_2d']
            # Validate coordinate ranges
            if not all(0 <= c <= 1000 for c in coords):
                logger.warning(f"Invalid coordinate range: {coords}")
                continue
                
            # First order the normalized coordinates
            x1, x2 = min(coords[1], coords[3]), max(coords[1], coords[3])
            y1, y2 = min(coords[0], coords[2]), max(coords[0], coords[2])
            
            # Validate coordinate ordering
            if x1 >= x2 or y1 >= y2:
                logger.warning(f"Invalid coordinate ordering: {[y1, x1, y2, x2]}")
                continue
            
            # Convert to image coordinates and round to integers
            x1 = max(0, min(width, int(x1 * width / 1000)))
            y1 = max(0, min(height, int(y1 * height / 1000)))
            x2 = max(0, min(width, int(x2 * width / 1000)))
            y2 = max(0, min(height, int(y2 * height / 1000)))
            
            # Draw cluster bounding box
            outline_thickness = 4  # Align with notebook's width
            draw.rectangle(
                [x1, y1, x2, y2],
                outline='lime',
                width=outline_thickness
            )

        # Convert back to base64
        img_byte_arr = io.BytesIO()
        img.save(img_byte_arr, format='JPEG')
        img_byte_arr.seek(0)
        new_base64 = base64.b64encode(img_byte_arr.getvalue()).decode('utf-8')

        return analysis, f"data:image/jpeg;base64,{new_base64}"

    except Exception as e:
        logger.error(f"Error processing image: {str(e)}")
        return {"error": str(e)}, None

def generate_status_stream():
    """Generate simple status stream with delays"""
    def generate():
        messages = [
            ("Initializing satellite image analysis...", 0.5),
            ("Processing high-resolution imagery...", 1.5),
            ("Scanning for vehicle signatures...", 2),
            ("Analyzing site activity patterns...", 2),
            ("Validating detection results...", 1.5),
            ("Generating activity report...", 1),
            ("Finalizing analysis...", 1.5)  # Changed from "Analysis complete"
        ]
        
        total_delay = sum(delay for _, delay in messages)
        logger.info(f"Total streaming delay: {total_delay} seconds")
        
        for msg, delay in messages:
            yield f'data: {{"type":"status","content":"{msg}"}}\n\n'
            time.sleep(delay)  # Longer delays to better match analysis time
            
    return generate()

@functions_framework.http
def analyze_site_precheck(request):
    """Cloud Function to analyze satellite imagery for vehicles"""
    # Enable CORS
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '3600'
    }

    if request.method == 'OPTIONS':
        return ('', 204, headers)

    # Handle streaming endpoint
    if request.method == 'GET' and request.path.endswith('/stream'):
        headers['Content-Type'] = 'text/event-stream'
        headers['Cache-Control'] = 'no-cache'
        headers['Connection'] = 'keep-alive'
        headers['X-Accel-Buffering'] = 'no'  # Disable proxy buffering
        
        return generate_status_stream(), 200, headers

    # Handle regular POST request for image analysis
    try:
        request_json = request.get_json()
        if not request_json:
            return jsonify({'error': 'No JSON data received'}), 400, headers

        image_data = request_json.get('image', '')
        if not image_data:
            return jsonify({'error': 'Missing image data'}), 400, headers

        # Remove data URL prefix if present
        if ',' in image_data:
            image_data = image_data.split(',')[1]

        # Analyze image and get vehicle boxes
        analysis, annotated_image = analyze_image_stream(image_data)
        if 'error' in analysis:
            return jsonify(analysis), 500, headers

        # Return analysis results and annotated image
        return jsonify({
            'vehicle_analysis': analysis,
            'annotated_image': annotated_image
        }), 200, headers

    except Exception as e:
        logger.error(f"Error processing request: {str(e)}")
        return jsonify({"error": str(e)}), 500, headers
