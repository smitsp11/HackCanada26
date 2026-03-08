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

    result = cloudinary.uploader.upload(
        file_path,
        resource_type="image",
        use_filename=True,
        unique_filename=True,
    )

    public_id = result["public_id"]
    original_url = result["secure_url"]

    # Auto-format, auto-quality, auto-enhance
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
    Upload a video to Cloudinary with eager optimization transforms applied at
    upload time so the optimized rendition is cached and ready immediately.

    Optimizations applied:
        - vc_auto:       normalize codec + audio settings for web delivery
        - q_auto:        optimal quality/filesize tradeoff
        - f_auto:video:  deliver in best supported format (WebM/HEVC/H264)
        - fl_progressive: progressive download for short-form video

    Returns dict with:
        - public_id
        - video_url:     original upload URL
        - optimized_url: optimized delivery URL ready for Gemini
    """
    print(f"🎬 Uploading video: {os.path.basename(file_path)}")

    # Eager transformation: pre-generate optimized rendition at upload time
    # so it's cached before first request — avoids on-the-fly delay
    eager_transforms = [
        {
            "video_codec": "auto",    # normalize codec + audio for web
            "quality": "auto",        # optimal quality/size tradeoff
            "fetch_format": "auto",   # best format per browser (WebM/H264/HEVC)
            "flags": "progressive",   # progressive download for short videos
        }
    ]

    result = cloudinary.uploader.upload(
        file_path,
        resource_type="video",
        use_filename=True,
        unique_filename=True,
        eager=eager_transforms,
        eager_async=False,            # wait for eager to finish before returning
    )

    public_id = result["public_id"]
    video_url = result["secure_url"]
    duration = result.get("duration", 15)

    # Pull optimized URL from eager results if available, otherwise build manually
    if result.get("eager") and len(result["eager"]) > 0:
        optimized_url = result["eager"][0]["secure_url"]
    else:
        optimized_url, _ = cloudinary_url(
            public_id,
            resource_type="video",
            video_codec="auto",
            quality="auto",
            fetch_format="auto",
            flags="progressive",
        )

    print(f"✅ Video uploaded: {public_id} ({duration:.1f}s)")
    print(f"   Original URL:  {video_url}")
    print(f"   Optimized URL: {optimized_url}")

    return {
        "type": "video",
        "public_id": public_id,
        "video_url": video_url,
        "optimized_url": optimized_url,
        "duration": duration,
    }


def process_media(file_path):
    """
    Main entry point: auto-detect media type and process accordingly.

    - Image → upload + optimize/enhance, returns optimized image URL
    - Video → upload + optimize, returns optimized video URL

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

    file_path = "backend/videos/reddit_hvacadvice_wwvjkj.mp4"

    try:
        result = process_media(file_path)
        print("\n" + "=" * 60)
        print("📋 Result (JSON):")
        print("=" * 60)
        print(json.dumps(result, indent=2))
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)
        
        
        