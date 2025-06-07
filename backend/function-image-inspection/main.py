import base64
import io
import os
import json
import logging
import queue
import threading
import time
from datetime import datetime

import flask
import functions_framework
from flask import jsonify, request
from PIL import Image, ImageDraw, ImageFont

from google import genai
from google.api_core.client_options import ClientOptions
from google.api_core.exceptions import NotFound, PermissionDenied, ResourceExhausted
from google.cloud import discoveryengine
from google.genai import types

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class StreamLogger(logging.Logger):
    def __init__(self, name, level=logging.NOTSET):
        super().__init__(name, level)
        self.queue = queue.Queue()

    def _log(self, level, msg, args, exc_info=None, extra=None, stack_info=False):
        super()._log(level, msg, args, exc_info, extra, stack_info)
        self.queue.put(json.dumps({"type": "status", "content": msg % args}))

stream_logger = StreamLogger('stream_logger')

# Global variables for tracking processing status
current_request_id = None
current_processing_stage = "idle"
processing_lock = threading.Lock()

# Discovery Engine setup
PROJECT_ID = "gemini-med-lit-review"
LOCATION = "global"
DATA_STORE_ID = "fda-title21_6"

client_options = ClientOptions(api_endpoint=f"{LOCATION}-discoveryengine.googleapis.com")
search_client = discoveryengine.SearchServiceClient(client_options=client_options)
doc_client = discoveryengine.DocumentServiceClient(client_options=client_options)

# Initialize Gemini 2.5 client
gemini_2_5_client = genai.Client(
    vertexai=True,
    project="gemini-med-lit-review",
    location="global"
)

# Model name
GEMINI_2_5_MODEL_NAME = "gemini-2.5-pro-preview-06-05"

# Common safety settings
COMMON_SAFETY_SETTINGS = [
    types.SafetySetting(
        category="HARM_CATEGORY_HATE_SPEECH",
        threshold="OFF"
    ),
    types.SafetySetting(
        category="HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold="OFF"
    ),
    types.SafetySetting(
        category="HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold="OFF"
    ),
    types.SafetySetting(
        category="HARM_CATEGORY_HARASSMENT",
        threshold="OFF"
    )
]

# Grounding tool for Google Search
GROUNDING_TOOL = [types.Tool(google_search=types.GoogleSearch())]

# RAG Utility Functions
def search_datastore(query: str, data_store_id: str) -> list:
    serving_config = search_client.serving_config_path(
        project=PROJECT_ID,
        location=LOCATION,
        data_store=data_store_id,
        serving_config="default_config",
    )

    request = discoveryengine.SearchRequest(
        serving_config=serving_config,
        query=query,
        page_size=7,
        query_expansion_spec=discoveryengine.SearchRequest.QueryExpansionSpec(
            condition=discoveryengine.SearchRequest.QueryExpansionSpec.Condition.AUTO
        ),
        spell_correction_spec=discoveryengine.SearchRequest.SpellCorrectionSpec(
            mode=discoveryengine.SearchRequest.SpellCorrectionSpec.Mode.AUTO
        )
    )

    try:
        response = search_client.search(request)
        logging.info(f"Search returned {len(response.results)} results")
        return response.results
    except Exception as e:
        logging.error(f"Error during search: {str(e)}")
        return []

def get_document_by_id(doc_id: str, data_store_id: str) -> discoveryengine.Document:
    parent = f"projects/{PROJECT_ID}/locations/{LOCATION}/collections/default_collection/dataStores/{data_store_id}/branches/default_branch"
    name = f"{parent}/documents/{doc_id}"
    try:
        document = doc_client.get_document(name=name)
        logging.info(f"Successfully retrieved document: {doc_id}")
        return document
    except NotFound:
        logging.error(f"Document not found: {doc_id}")
    except Exception as e:
        logging.error(f"Error retrieving document {doc_id}: {str(e)}")
    return None

def extract_safe(obj: object, *keys: str) -> object:
    for key in keys:
        if isinstance(obj, dict):
            obj = obj.get(key)
        elif hasattr(obj, key):
            obj = getattr(obj, key)
        else:
            return None
    return obj

def process_search_results(search_results: list, target_string: str) -> list:
    matching_documents = []
    for i, result in enumerate(search_results):
        logging.debug(f"Processing search result {i+1}: {result}")

        doc_id = extract_safe(result, 'document', 'id')
        full_doc = get_document_by_id(doc_id, DATA_STORE_ID)
        
        if full_doc and full_doc.content and full_doc.content.raw_bytes:
            content = full_doc.content.raw_bytes.decode('utf-8')
            section_id = full_doc.struct_data.get('section_id', 'N/A')
            section_name = full_doc.struct_data.get('section_name', 'N/A')
            
            if any(word.lower() in content.lower() for word in target_string.split()):
                matching_documents.append({
                    'id': doc_id,
                    'section_id': section_id,
                    'section': section_name,
                    'content': content
                })
        else:
            logging.warning(f"No content found for document {doc_id}")

    return matching_documents

def get_relevant_codes(query: str, data_store_id: str) -> str:
    search_results = search_datastore(query, data_store_id)
    matching_documents = process_search_results(search_results, query)
    
    relevant_codes = []
    for doc in matching_documents:
        relevant_codes.append(f"Section {doc['section_id']}: {doc['content']}")
    
    return "\n".join(relevant_codes)

def plot_bounding_box(img, citation, verified_section, index):
    draw = ImageDraw.Draw(img)
    width, height = img.size

    color = 'red'
    outline_thickness = 5

    try:
        # Try system-specific default font paths
        if os.name == 'nt':  # Windows
            font = ImageFont.truetype("C:\\Windows\\Fonts\\arial.ttf", 36)
        else:  # Linux/Mac
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 36)
    except OSError:
        # If all else fails, use default font
        font = ImageFont.load_default()

    y1, x1, y2, x2 = citation['box_2d']
    x1 = int(x1 * width / 1000)
    y1 = int(y1 * height / 1000)
    x2 = int(x2 * width / 1000)
    y2 = int(y2 * height / 1000)

    for i in range(outline_thickness):
        draw.rectangle([x1+i, y1+i, x2-i, y2-i], outline=color)

    # Draw text at top of image, independent of bounding box
    label = f"Section {verified_section}"
    text_bbox = draw.textbbox((0, 0), label, font=font)
    text_width = text_bbox[2] - text_bbox[0]
    text_height = text_bbox[3] - text_bbox[1]
    
    # Fixed position at top of image
    text_x = 10  # Left margin
    text_y = 10  # Top margin
    
    # Draw white background for text
    draw.rectangle([text_x, text_y, text_x + text_width + 20, text_y + text_height + 10], fill='white')
    
    # Draw text
    draw.text((text_x + 10, text_y + 5), label, fill=color, font=font)

    # Save to memory instead of file
    img_byte_arr = io.BytesIO()
    img.save(img_byte_arr, format='JPEG')
    img_byte_arr.seek(0)
    
    return base64.b64encode(img_byte_arr.getvalue()).decode('utf-8')

def generate_initial_response(inspection_type, image_data):
    print(f"Starting generate_initial_response for {inspection_type}")
    stream_logger.info("Initializing image analysis...")
    text_prompt = f"""As an FDA inspector performing a {inspection_type} inspection, analyze the given image.
    Based on Title 21 regulations, identify potential citation opportunities and reference 
    the specific sections of Title 21 that apply. Provide a detailed explanation for each 
    potential citation, including what is observed in the image and how it relates to the 
    regulation. Format your response as a JSON object with the following structure:
    {{
        "citations": [
            {{
                "section": "Cited Title 21 section number",
                "text": "Relevant text from the cited section",
                "reason": "Detailed explanation of why this citation applies based on the image",
                "box_2d": [y1, x1, y2, x2]
            }},
            // Additional citations...
        ]
    }}
    Ensure that the JSON is valid and properly formatted. For each citation, provide specific 
    bounding box coordinates (normalized to 1000x1000) that focus only on the area of the image 
    relevant to that particular citation. Do not use the entire image for every citation.
    Also, more likely the image will show a picture presented on a phone or screen. Do not remark about the act of showing the screen, it's the content's of the image being shown that matters, because this is for demonstration purposes and we won't be able to go to an inspection site often."""

    contents = [
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(text=text_prompt),
                types.Part.from_bytes(data=base64.b64decode(image_data), mime_type="image/jpeg")
            ]
        )
    ]

    print(f"Sending request to Gemini model with prompt length: {len(text_prompt)}")
    stream_logger.info("Processing visual elements...")
    
    # Generate content with streaming
    response_text = ""
    for chunk in gemini_2_5_client.models.generate_content_stream(
        model=GEMINI_2_5_MODEL_NAME,
        contents=contents,
        config=types.GenerateContentConfig(
            temperature=1,
            top_p=0.95,
            max_output_tokens=8192,
            safety_settings=COMMON_SAFETY_SETTINGS,
            tools=GROUNDING_TOOL,
            system_instruction=[types.Part.from_text(text="""Return bounding boxes as a JSON array with labels. Never return masks or code fencing. Limit to 25 objects.
If an object is present multiple times, name them according to their unique characteristic (colors, size, position, unique characteristics, etc..).""")],
            thinking_config=types.ThinkingConfig(
                thinking_budget=128,
            )
        )
    ):
        if chunk.text:
            response_text += chunk.text
    
    print(f"Received response from Gemini model with length: {len(response_text)}")
    stream_logger.info("Identifying potential violations...")

    try:
        response_text = response_text.strip()
        start = response_text.find('{')
        end = response_text.rfind('}') + 1
        if start != -1 and end != -1:
            json_str = response_text[start:end]
            parsed_response = json.loads(json_str)
            print(f"Parsed JSON response with {len(parsed_response['citations'])} citations")
            return parsed_response
        else:
            raise ValueError("No valid JSON object found in the response")
    except Exception as e:
        logger.error(f"Error formatting response: {str(e)}")
        return {"error": "Failed to parse response"}

def strip_image_from_citations(citations):
    return [{k: v for k, v in citation.items() if k != 'image'} for citation in citations]

def verify_and_complete_response(initial_response, img):
    print(f"Starting verify_and_complete_response with {len(initial_response.get('citations', []))} citations")
    stream_logger.info("Cross-referencing FDA regulations...")
    verified_citations = []
    for index, citation in enumerate(initial_response.get('citations', [])):
        print(f"Processing citation {index + 1}")
        relevant_codes = get_relevant_codes(citation['reason'], DATA_STORE_ID)
        print(f"Retrieved relevant codes with length: {len(relevant_codes)}")
        
        print(f"Generating verification prompt for citation {index + 1}")
        stream_logger.info(f"Validating citation {index + 1}...")
        verification_prompt = f"""Given the following citation and other relevant codes retrieved from the FDA Title 21 regulations, 
        decide which is better and more relevant for the given citation "reason": the original cited section OR another section from the retrieved relevant codes. Use chain of thought. If there is a better section code from the retrieved relevant codes, replace the original cited "section" and "text" fields with the better option from the retrieved relevant codes. 
        Then, generate a valid URL for the (corrected) section.

        Original Citation:
        {json.dumps(citation, indent=2)}

        Relevant Codes:
        {relevant_codes}

        Provide your response as a JSON object with the following structure:
        {{
            "section": "Verified or corrected Title 21 section number",
            "text": "Verified or corrected text from the cited section",
            "reason": "Original reason for the citation",
            "url": "Generated URL of the Title 21 eCFR regulation"
        }}

        For the 'url' field, generate a valid URL to the specific section of the Title 21 eCFR regulation. 
        The URL should follow this format: 
        https://www.ecfr.gov/current/title-21/chapter-[CHAPTER]/subchapter-[SUB CHAPTER]/part-[PART]#p-[PART].[SECTION]

        For example, if citing section 110.80(b)(1), the URL should be:
        https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-110#p-110.80(b)(1)

        Note: The '#p-' prefix is required before the section number in the URL.
        
        Ensure that the generated URL is correct and points to the specific section cited."""
        print(f"Verification prompt length: {len(verification_prompt)}")

        # Generate verification with streaming
        response_text = ""
        for chunk in gemini_2_5_client.models.generate_content_stream(
            model=GEMINI_2_5_MODEL_NAME,
            contents=[types.Content(role="user", parts=[types.Part.from_text(text=verification_prompt)])],
            config=types.GenerateContentConfig(
                temperature=1,
                top_p=0.95,
                max_output_tokens=8192,
                safety_settings=COMMON_SAFETY_SETTINGS,
                tools=GROUNDING_TOOL,
                thinking_config=types.ThinkingConfig(
                    thinking_budget=128,
                )
            )
        ):
            if chunk.text:
                response_text += chunk.text
        
        print(f"Received verification response for citation {index + 1}")

        try:
            response_text = response_text.strip()
            start = response_text.find('{')
            end = response_text.rfind('}') + 1
            if start != -1 and end != -1:
                json_str = response_text[start:end]
                verified_citation = json.loads(json_str)
                print(f"Parsed verification response for citation {index + 1}")
                if verified_citation:
                    # Convert image to PIL Image for bounding box
                    img_bytes = io.BytesIO(base64.b64decode(img))
                    pil_img = Image.open(img_bytes)
                    # Convert to RGB mode if needed
                    if pil_img.mode in ('RGBA', 'LA', 'P'):
                        pil_img = pil_img.convert('RGB')
                    
                    # Plot bounding box and get base64 image
                    image_base64 = plot_bounding_box(pil_img.copy(), citation, verified_citation['section'], index)
                    verified_citation['image'] = f"data:image/jpeg;base64,{image_base64}"
                    verified_citations.append(verified_citation)
            else:
                logger.error("No valid JSON found in verification response")
        except Exception as e:
            logger.error(f"Error processing verification response: {str(e)}")

    # Generate summary after citations are verified
    if verified_citations:
        print("Verified citations content (with images):")
        citations_json_with_images = json.dumps(verified_citations, indent=2)
        print(citations_json_with_images)
        print(f"Total length of verified_citations JSON (with images): {len(citations_json_with_images)}")

        # Strip images for summary generation
        citations_without_images = strip_image_from_citations(verified_citations)
        print("Verified citations content (without images):")
        citations_json_without_images = json.dumps(citations_without_images, indent=2)
        print(citations_json_without_images)
        print(f"Total length of verified_citations JSON (without images): {len(citations_json_without_images)}")

        print("Generating summary")
        stream_logger.info("Generating inspection report...")
        summary_prompt = f"""Generate a brief summary of the following FDA citations in 2-3 sentences. Focus on the key issues identified and their potential impact on food safety or compliance.

        Citations:
        {citations_json_without_images}

        Provide your response as a simple string without any JSON formatting or additional markup."""

        # Generate summary with streaming
        summary_text = ""
        for chunk in gemini_2_5_client.models.generate_content_stream(
            model=GEMINI_2_5_MODEL_NAME,
            contents=[types.Content(role="user", parts=[types.Part.from_text(text=summary_prompt)])],
            config=types.GenerateContentConfig(
                temperature=1,
                top_p=0.95,
                max_output_tokens=8192,
                safety_settings=COMMON_SAFETY_SETTINGS,
                tools=GROUNDING_TOOL,
                thinking_config=types.ThinkingConfig(
                    thinking_budget=128,
                )
            )
        ):
            if chunk.text:
                summary_text += chunk.text
        print(f"Generated summary with length: {len(summary_text)}")
        stream_logger.info("Finalizing analysis...")

        return {
            "citations": verified_citations,
            "summary": summary_text.strip()
        }
    
    return {"citations": verified_citations, "summary": ""}

def generate_status_stream():
    """Generate status stream from StreamLogger queue"""
    while True:
        try:
            message = stream_logger.queue.get(timeout=1)
            yield f"data: {message}\n\n"
        except queue.Empty:
            yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"

def generate_status_stream():
    """Generate status stream for inspection process"""
    messages = [
        "Initializing image analysis...",
        "Processing visual elements...",
        "Identifying potential violations...",
        "Cross-referencing FDA regulations...",
        "Validating citations...",
        "Generating inspection report...",
        "Finalizing analysis..."
    ]
    for msg in messages:
        yield f"data: {json.dumps({'type': 'status', 'content': msg})}\n\n"
        time.sleep(7)  # Simulate processing time

@functions_framework.http
def process_inspection(request):
    print("Starting process_inspection")
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
        
        return flask.Response(generate_status_stream(), 200, headers)

    # Handle regular POST request for image analysis
    if request.method == 'POST':
        headers['Content-Type'] = 'application/json'
        try:
            request_json = request.get_json()
            if not request_json:
                return jsonify({'error': 'No JSON data received'}), 400, headers

            image_data = request_json.get('image', '').split(',')[1]  # Remove data URL prefix
            inspection_type = request_json.get('background', '')

            if not image_data or not inspection_type:
                return jsonify({'error': 'Missing required fields'}), 400, headers

            # Generate initial response
            initial_response = generate_initial_response(inspection_type, image_data)
            if 'error' in initial_response:
                return jsonify(initial_response), 500, headers

            # Verify and complete response
            verified_response = verify_and_complete_response(initial_response, image_data)

            return jsonify(verified_response), 200, headers

        except Exception as e:
            logger.error(f"Error processing request: {str(e)}")
            return jsonify({"error": str(e)}), 500, headers

    # If not OPTIONS, GET /stream, or POST, return method not allowed
    return jsonify({"error": "Method not allowed"}), 405, headers

if __name__ == "__main__":
    # This is used when running locally only. When deploying to Google Cloud Functions,
    # a webserver will be used to run the app instead
    app = functions_framework.create_app(target="process_inspection")
    port = int(os.environ.get('PORT', 8080))
    app.run(host="0.0.0.0", port=port, debug=True)

    # Test the streaming endpoint
    import requests
    stream_url = f"http://localhost:{port}/stream"
    print(f"Testing streaming endpoint at {stream_url}")
    response = requests.get(stream_url, stream=True)
    for line in response.iter_lines():
        if line:
            print(line.decode('utf-8'))
