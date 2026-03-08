"""
Cloudinary Media Upload Pipeline
Handles image and video uploads for the technician equipment inspection workflow.

Usage:
    python cloudinary_upload.py path/to/image.jpg
    python cloudinary_upload.py path/to/video.mp4
"""

import os
import sys
import json
import mimetypes
from dotenv import load_dotenv

import cloudinary
import cloudinary.uploader
from cloudinary.utils import cloudinary_url

load_dotenv()

# Configuration
cloudinary.config(
    cloud_name=os.environ["CLOUDINARY_CLOUD_NAME"],
    api_key=os.environ["CLOUDINARY_API_KEY"],
    api_secret=os.environ["CLOUDINARY_API_SECRET"],
    secure=True
)

# Supported file extensions
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".gif", ".heic"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".flv"}

# Keyframe intervals in seconds (for a ~15s video)
KEYFRAME_OFFSETS = [0, 3, 6, 9, 12]


def detect_media_type(file_path):
    """Detect whether a file is an image or video based on its extension."""
    ext = os.path.splitext(file_path)[1].lower()
    if ext in IMAGE_EXTENSIONS:
        return "image"
    elif ext in VIDEO_EXTENSIONS:
        return "video"
    else:
        raise ValueError(f"Unsupported file type: {ext}")


def process_image(file_path):
    """
    Upload an image to Cloudinary and return optimized URLs.
    
    Applies: auto-format, auto-quality, and auto-enhance (lighten/improve).
    
    Returns dict with:
        - public_id: Cloudinary public ID
        - original_url: direct upload URL
        - optimized_url: enhanced + optimized delivery URL
    """
    print(f"📷 Uploading image: {os.path.basename(file_path)}")

    # Upload
    result = cloudinary.uploader.upload(
        file_path,
        resource_type="image",
        use_filename=True,
        unique_filename=True,
    )

    public_id = result["public_id"]
    original_url = result["secure_url"]

    # Generate optimized URL: auto-format, auto-quality, auto-enhance
    optimized_url, _ = cloudinary_url(
        public_id,
        fetch_format="auto",
        quality="auto",
        effect="improve",
    )

    output = {
        "type": "image",
        "public_id": public_id,
        "original_url": original_url,
        "optimized_url": optimized_url,
    }

    print(f"✅ Image uploaded: {public_id}")
    print(f"   Original:  {original_url}")
    print(f"   Optimized: {optimized_url}")

    return output


def process_video(file_path):
    """
    Upload a video to Cloudinary, extract keyframes at set intervals.
    
    Extracts frames at 0s, 3s, 6s, 9s, 12s as JPG images via Cloudinary URL API.
    Each keyframe URL can be passed directly to Gemini Vision for analysis.
    
    Returns dict with:
        - public_id: Cloudinary public ID
        - video_url: direct video URL
        - keyframes: list of { offset_seconds, url }
    """
    print(f"🎬 Uploading video: {os.path.basename(file_path)}")

    # Upload as video
    result = cloudinary.uploader.upload(
        file_path,
        resource_type="video",
        use_filename=True,
        unique_filename=True,
    )

    public_id = result["public_id"]
    video_url = result["secure_url"]
    duration = result.get("duration", 15)

    print(f"✅ Video uploaded: {public_id} ({duration:.1f}s)")
    print(f"   Video URL: {video_url}")

    # Extract keyframes at each offset
    # Pattern: use resource_type="video" with format="jpg" and start_offset
    keyframes = []
    for offset in KEYFRAME_OFFSETS:
        if offset > duration:
            break

        frame_url, _ = cloudinary_url(
            public_id,
            resource_type="video",
            format="jpg",
            start_offset=str(offset),
            quality="auto",
            fetch_format="auto",
        )

        keyframes.append({
            "offset_seconds": offset,
            "url": frame_url,
        })
        print(f"   Frame @{offset}s: {frame_url}")

    output = {
        "type": "video",
        "public_id": public_id,
        "video_url": video_url,
        "duration": duration,
        "keyframes": keyframes,
    }

    return output


def process_media(file_path):
    """
    Main entry point: auto-detect media type and process accordingly.
    
    - Image → upload + optimize/lighten
    - Video → upload + extract keyframes
    
    Returns structured dict with URLs ready for Gemini Vision API.
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")

    media_type = detect_media_type(file_path)

    if media_type == "image":
        return process_image(file_path)
    else:
        return process_video(file_path)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python cloudinary_upload.py <file_path>")
        print("  Supports images (.jpg, .png, .webp, etc.) and videos (.mp4, .mov, etc.)")
        sys.exit(1)

    file_path = sys.argv[1]

    try:
        result = process_media(file_path)
        print("\n" + "=" * 60)
        print("📋 Result (JSON):")
        print("=" * 60)
        print(json.dumps(result, indent=2))
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)
