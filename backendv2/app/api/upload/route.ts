import { NextRequest, NextResponse } from "next/server";
import cloudinary, {
  getLocalizeDimensions,
  LOCALIZE_TRANSFORMATION,
} from "@/lib/cloudinary";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No file uploaded" },
        { status: 400 }
      );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const result = await new Promise<any>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "fixlens/uploads",
          resource_type: "image",
          use_filename: true,
          unique_filename: true,
          overwrite: false,
          tags: ["fixlens", "upload"],
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );

      stream.end(buffer);
    });

    const originalWidth = Number(result.width);
    const originalHeight = Number(result.height);
    const { localizeWidth, localizeHeight } = getLocalizeDimensions(
      originalWidth,
      originalHeight
    );
    const localizeUrl = cloudinary.url(result.public_id, {
      secure: true,
      transformation: [LOCALIZE_TRANSFORMATION],
    });

    return NextResponse.json({
      publicId: result.public_id,
      secureUrl: result.secure_url,
      width: originalWidth,
      height: originalHeight,
      localizeUrl,
      localizeWidth,
      localizeHeight,
      format: result.format,
    });
  } catch (error) {
    console.error("Upload failed:", error);
    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500 }
    );
  }
}
