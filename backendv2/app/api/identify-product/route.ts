import { NextRequest, NextResponse } from "next/server";
import cloudinary from "@/lib/cloudinary";
import { getEnhancedImageUrl } from "@/lib/enhance";
import { extractText } from "@/lib/ocr";
import { parseProduct } from "@/lib/parse-product";
import { lookupProduct, type Product } from "@/lib/lookup-product";
import { identifyWithGemini } from "@/lib/identify-gemini";

interface IdentifyResponse {
  product: Product | null;
  source: "ocr" | "gemini" | "none";
  ocrText?: string;
  parsedBrand?: string;
  parsedModel?: string;
}

export async function POST(req: NextRequest) {
  try {
    let imageUrl: string | null = null;

    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const body = await req.json();
      imageUrl = body?.imageUrl ?? null;
    } else {
      const formData = await req.formData();
      const file = formData.get("file");
      const urlField = formData.get("imageUrl");

      if (typeof urlField === "string") {
        imageUrl = urlField;
      } else if (file && file instanceof File) {
        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);

        const uploadResult = await new Promise<Record<string, unknown>>(
          (resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
              {
                folder: "fixlens/uploads",
                resource_type: "image",
                use_filename: true,
                unique_filename: true,
                overwrite: false,
                tags: ["fixlens", "identify"],
              },
              (error, result) => {
                if (error) reject(error);
                else resolve(result as Record<string, unknown>);
              },
            );
            stream.end(buffer);
          },
        );

        imageUrl = uploadResult.secure_url as string;
      }
    }

    if (!imageUrl) {
      return NextResponse.json(
        { error: "Provide imageUrl (JSON body) or file (FormData)" },
        { status: 400 },
      );
    }

    // Step 1: Enhance the image
    const enhancedUrl = getEnhancedImageUrl(imageUrl);

    // Step 2: OCR
    let ocrText = "";
    try {
      ocrText = await extractText(enhancedUrl);
    } catch (e) {
      console.warn("OCR failed, will try Gemini fallback:", e);
    }

    // Step 3: Parse brand and model from OCR text
    const parsed = ocrText ? parseProduct(ocrText) : { company: undefined, modelNumber: undefined };

    // Step 4: DB lookup with OCR results
    let product: Product | null = null;
    let source: IdentifyResponse["source"] = "none";

    if (parsed.company || parsed.modelNumber) {
      product = await lookupProduct(parsed.company, parsed.modelNumber);
      if (product) {
        source = "ocr";
      }
    }

    // Step 5: Gemini fallback if OCR path didn't find a product
    if (!product) {
      try {
        const geminiResult = await identifyWithGemini(enhancedUrl);
        if (geminiResult.company || geminiResult.modelNumber) {
          product = await lookupProduct(
            geminiResult.company,
            geminiResult.modelNumber,
          );
          if (product) {
            source = "gemini";
          } else {
            // No DB match, but Gemini did identify something — return the suggestion
            return NextResponse.json({
              product: null,
              source: "gemini",
              ocrText: ocrText || undefined,
              parsedBrand: geminiResult.company ?? parsed.company,
              parsedModel: geminiResult.modelNumber ?? parsed.modelNumber,
            } satisfies IdentifyResponse);
          }
        }
      } catch (e) {
        console.warn("Gemini fallback failed:", e);
      }
    }

    const response: IdentifyResponse = {
      product,
      source,
      ocrText: ocrText || undefined,
      parsedBrand: parsed.company,
      parsedModel: parsed.modelNumber,
    };

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("identify-product failed:", error);
    return NextResponse.json(
      { error: "Identification pipeline failed", detail: message },
      { status: 500 },
    );
  }
}
