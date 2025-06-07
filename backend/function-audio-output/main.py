import functions_framework
from flask import jsonify
import base64
import logging
import os
import mimetypes
import struct
import time
from google import genai
from google.genai import types

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def parse_audio_mime_type(mime_type: str) -> dict[str, int | None]:
    """Parses bits per sample and rate from an audio MIME type string.

    Assumes bits per sample is encoded like "L16" and rate as "rate=xxxxx".

    Args:
        mime_type: The audio MIME type string (e.g., "audio/L16;rate=24000").

    Returns:
        A dictionary with "bits_per_sample" and "rate" keys. Values will be
        integers if found, otherwise None.
    """
    bits_per_sample = 16
    rate = 24000

    # Extract rate from parameters
    parts = mime_type.split(";")
    for param in parts: # Skip the main type part
        param = param.strip()
        if param.lower().startswith("rate="):
            try:
                rate_str = param.split("=", 1)[1]
                rate = int(rate_str)
            except (ValueError, IndexError):
                # Handle cases like "rate=" with no value or non-integer value
                pass # Keep rate as default
        elif param.startswith("audio/L"):
            try:
                bits_per_sample = int(param.split("L", 1)[1])
            except (ValueError, IndexError):
                pass # Keep bits_per_sample as default if conversion fails

    return {"bits_per_sample": bits_per_sample, "rate": rate}


def convert_to_wav(audio_data: bytes, mime_type: str) -> bytes:
    """Generates a WAV file header for the given audio data and parameters.

    Args:
        audio_data: The raw audio data as a bytes object.
        mime_type: Mime type of the audio data.

    Returns:
        A bytes object representing the WAV file.
    """
    parameters = parse_audio_mime_type(mime_type)
    bits_per_sample = parameters["bits_per_sample"]
    sample_rate = parameters["rate"]
    num_channels = 1
    data_size = len(audio_data)
    bytes_per_sample = bits_per_sample // 8
    block_align = num_channels * bytes_per_sample
    byte_rate = sample_rate * block_align
    chunk_size = 36 + data_size  # 36 bytes for header fields before data chunk size

    # http://soundfile.sapp.org/doc/WaveFormat/

    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",          # ChunkID
        chunk_size,       # ChunkSize (total file size - 8 bytes)
        b"WAVE",          # Format
        b"fmt ",          # Subchunk1ID
        16,               # Subchunk1Size (16 for PCM)
        1,                # AudioFormat (1 for PCM)
        num_channels,     # NumChannels
        sample_rate,      # SampleRate
        byte_rate,        # ByteRate
        block_align,      # BlockAlign
        bits_per_sample,  # BitsPerSample
        b"data",          # Subchunk2ID
        data_size         # Subchunk2Size (size of audio data)
    )
    return header + audio_data


def generate_gemini_audio(text: str) -> bytes | None:
    """Generate audio content for the given text using Gemini API."""
    try:
        start_time = time.time()
        
        # Initialize Gemini client
        client_init_start = time.time()
        client = genai.Client(
            api_key=os.environ.get("GEMINI_API_KEY"),
        )
        logger.info(f"[PERF] Gemini client initialization: {time.time() - client_init_start:.4f}s")

        model = "gemini-2.5-flash-preview-tts"
        
        # Prepare contents
        contents = [
            types.Content(
                role="user",
                parts=[
                    types.Part.from_text(text=text),
                ],
            ),
        ]
        
        # Configure generation
        generate_content_config = types.GenerateContentConfig(
            temperature=1,
            response_modalities=[
                "audio",
            ],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name="Zubenelgenubi"
                    )
                )
            ),
        )

        # Collect audio chunks
        audio_chunks = []
        mime_type = None
        
        stream_start_time = time.time()
        chunk_count = 0
        
        for chunk in client.models.generate_content_stream(
            model=model,
            contents=contents,
            config=generate_content_config,
        ):
            chunk_count += 1
            if (
                chunk.candidates is None
                or chunk.candidates[0].content is None
                or chunk.candidates[0].content.parts is None
            ):
                continue
                
            if chunk.candidates[0].content.parts[0].inline_data and chunk.candidates[0].content.parts[0].inline_data.data:
                inline_data = chunk.candidates[0].content.parts[0].inline_data
                audio_chunks.append(inline_data.data)
                
                # Get mime type from first chunk
                if mime_type is None:
                    mime_type = inline_data.mime_type
                    logger.info(f"Audio mime type: {mime_type}")

        logger.info(f"[PERF] Audio streaming complete: {time.time() - stream_start_time:.4f}s, chunks received: {chunk_count}")
        
        if not audio_chunks:
            logger.error("No audio data generated")
            return None
            
        # Concatenate all audio chunks
        concat_start_time = time.time()
        audio_data = b"".join(audio_chunks)
        logger.info(f"[PERF] Audio chunk concatenation: {time.time() - concat_start_time:.4f}s, total size: {len(audio_data)} bytes")
        
        # Convert to WAV if necessary
        file_extension = mimetypes.guess_extension(mime_type)
        if file_extension is None or file_extension != ".wav":
            logger.info("Converting audio to WAV format")
            conversion_start_time = time.time()
            audio_data = convert_to_wav(audio_data, mime_type)
            logger.info(f"[PERF] WAV conversion: {time.time() - conversion_start_time:.4f}s")
        
        logger.info(f"[PERF] Total generate_gemini_audio time: {time.time() - start_time:.4f}s")
        return audio_data
        
    except Exception as e:
        logger.error(f"Error generating audio with Gemini: {e}")
        return None


@functions_framework.http
def fda_generate_audio(request):
    # Set CORS headers for preflight requests
    if request.method == 'OPTIONS':
        headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '3600'
        }
        return ('', 204, headers)

    # Set CORS headers for main requests
    headers = {
        'Access-Control-Allow-Origin': '*'
    }

    try:
        overall_start_time = time.time()
        
        request_json = request.get_json()
        if not request_json or 'text' not in request_json:
            return (jsonify({'error': 'Text is required'}), 400, headers)

        text = request_json['text']
        logger.info(f"Generating audio for text: {text[:50]}... (length: {len(text)} chars)")
        
        # Generate audio
        audio_gen_start = time.time()
        audio_data = generate_gemini_audio(text)
        logger.info(f"[PERF] Audio generation call: {time.time() - audio_gen_start:.4f}s")
        
        if not audio_data:
            return (jsonify({'error': 'Failed to generate audio'}), 500, headers)

        # Convert to base64
        b64_start_time = time.time()
        audio_content_base64 = base64.b64encode(audio_data).decode('utf-8')
        logger.info(f"[PERF] Base64 encoding: {time.time() - b64_start_time:.4f}s, encoded size: {len(audio_content_base64)} chars")
        
        logger.info(f"[PERF] Total request handling time: {time.time() - overall_start_time:.4f}s")
        
        return (jsonify({
            'audio': audio_content_base64  # Base64 encoded audio content
        }), 200, headers)
        
    except Exception as e:
        logger.error(f"Error processing request: {e}")
        return (jsonify({'error': str(e)}), 500, headers)
