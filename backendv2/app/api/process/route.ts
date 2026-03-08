import { NextRequest, NextResponse } from "next/server";
import cloudinary, {
  getLocalizeDimensions,
  LOCALIZE_TRANSFORMATION,
} from "@/lib/cloudinary";
import { planLocalization } from "@/lib/plan-localization";
import { localizePart } from "@/lib/localize";
import { buildAnnotatedUrl } from "@/lib/annotate";
import { RepairStep } from "@/lib/types";

const DEFAULT_STEP: RepairStep = {
  step: 5,
  category: "tool|screw",
  action:
    "Using a 1/4-in. driver, remove the two screws securing the igniter mounting bracket to the burner assembly.",
  caution: "None",
  visual_description:
    "Line drawing showing a screwdriver removing screws from the igniter mounting bracket on the burner assembly.",
};

export async function POST(req: NextRequest) {
  try {
    let step = DEFAULT_STEP;
    let uploadData:
      | {
          publicId: string;
          secureUrl: string;
          width: number;
          height: number;
          localizeUrl: string;
          localizeWidth: number;
          localizeHeight: number;
          format: string;
        }
      | null = null;

    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const body = await req.json();
      const stepRaw = body?.step;
      const upload = body?.upload;

      if (typeof stepRaw === "string" && stepRaw.trim().length > 0) {
        try {
          step = JSON.parse(stepRaw) as RepairStep;
        } catch {
          return NextResponse.json({ error: "Invalid step JSON" }, { status: 400 });
        }
      } else if (stepRaw && typeof stepRaw === "object") {
        step = stepRaw as RepairStep;
      }

      if (
        !upload ||
        typeof upload.publicId !== "string" ||
        typeof upload.secureUrl !== "string" ||
        typeof upload.width !== "number" ||
        typeof upload.height !== "number" ||
        typeof upload.format !== "string" ||
        upload.width <= 0 ||
        upload.height <= 0
      ) {
        return NextResponse.json(
          { error: "Invalid upload metadata in JSON body" },
          { status: 400 }
        );
      }

      const { localizeWidth, localizeHeight } = getLocalizeDimensions(
        upload.width,
        upload.height
      );

      uploadData = {
        publicId: upload.publicId,
        secureUrl: upload.secureUrl,
        width: upload.width,
        height: upload.height,
        localizeUrl: cloudinary.url(upload.publicId, {
          secure: true,
          transformation: [LOCALIZE_TRANSFORMATION],
        }),
        localizeWidth,
        localizeHeight,
        format: upload.format,
      };
    } else {
      const formData = await req.formData();
      const file = formData.get("file");

      if (!file || !(file instanceof File)) {
        return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
      }

      const stepRaw = formData.get("step");
      if (typeof stepRaw === "string" && stepRaw.trim().length > 0) {
        try {
          step = JSON.parse(stepRaw) as RepairStep;
        } catch {
          return NextResponse.json({ error: "Invalid step JSON" }, { status: 400 });
        }
      }

      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);

      const uploadResult = await new Promise<any>((resolve, reject) => {
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

      const originalWidth = Number(uploadResult.width);
      const originalHeight = Number(uploadResult.height);
      const { localizeWidth, localizeHeight } = getLocalizeDimensions(
        originalWidth,
        originalHeight
      );

      uploadData = {
        publicId: uploadResult.public_id as string,
        secureUrl: uploadResult.secure_url as string,
        width: originalWidth,
        height: originalHeight,
        localizeUrl: cloudinary.url(uploadResult.public_id, {
          secure: true,
          transformation: [LOCALIZE_TRANSFORMATION],
        }),
        localizeWidth,
        localizeHeight,
        format: uploadResult.format as string,
      };
    }

    if (!uploadData) {
      return NextResponse.json({ error: "Upload data not available" }, { status: 500 });
    }

    const planData = await planLocalization(step);

    const localizeData = await localizePart({
      imageUrl: uploadData.localizeUrl,
      width: uploadData.localizeWidth,
      height: uploadData.localizeHeight,
      localizationPlan: planData,
    });

    let annotateData: { annotatedUrl: string } | null = null;

    if (localizeData.found && localizeData.pixelBox) {
      annotateData = {
        annotatedUrl: buildAnnotatedUrl(
          uploadData.publicId,
          localizeData.pixelBox,
          planData.overlayText
        ),
      };
    }

    return NextResponse.json({
      upload: uploadData,
      plan: planData,
      localize: localizeData,
      annotate: annotateData,
      annotatedUrl: annotateData?.annotatedUrl ?? null,
    });
  } catch (error) {
    console.error("process failed:", error);
    return NextResponse.json({ error: "Process pipeline failed" }, { status: 500 });
  }
}
