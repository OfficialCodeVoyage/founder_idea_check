import { createHash, timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getAllAttachmentUrls } from "@/lib/db/queries";
import { env } from "@/lib/env";
import { deleteFilesByUrls, listFiles } from "@/lib/file-storage";
import { keyFromFileUrl, ownerTagFromFileKey } from "@/lib/file-url";

const ORPHANED_ATTACHMENTS_RETENTION_TIME = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. `CRON_SECRET` is
 * optional, so an unset secret must refuse every caller: comparing against a
 * template string would accept the literal `Bearer undefined`. Hashing both
 * sides gives equal-length buffers, so timingSafeEqual leaks neither the
 * secret's bytes nor its length.
 */
function isAuthorizedCronRequest(request: NextRequest): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) {
    return false;
  }
  const header = request.headers.get("authorization") ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

export async function GET(request: NextRequest) {
  try {
    if (!isAuthorizedCronRequest(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const results = {
      orphanedAttachments: await cleanupOrphanedAttachments(),
      // Add other cleanup tasks here in the future
    };

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      results,
    });
  } catch (error) {
    console.error("Cleanup cron job failed:", error);
    return NextResponse.json(
      {
        error: "Cleanup failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

async function cleanupOrphanedAttachments() {
  // Skip cleanup if neither image tool nor attachments is enabled
  const imageGenerationEnabled = config.ai.tools.image.enabled;
  const attachmentsEnabled = config.features.attachments;
  if (!(imageGenerationEnabled || attachmentsEnabled)) {
    return { deletedCount: 0, deletedUrls: [], skipped: true };
  }

  try {
    const attachmentUrls = await getAllAttachmentUrls();
    const usedAttachmentKeys = new Set(
      attachmentUrls
        .map(keyFromFileUrl)
        .filter((key): key is string => key !== null)
    );

    // Get all files from the configured storage provider
    const { files } = await listFiles();

    // Find old files that are not referenced in any message
    const retentionCutoff = new Date(
      Date.now() - ORPHANED_ATTACHMENTS_RETENTION_TIME
    );
    const orphanedUrls: string[] = [];

    for (const file of files) {
      // Only tagged keys: an untagged pre-tag file is never deleted
      // automatically (lib/file-url.ts::ownerTagFromFileKey), as before pre-tag
      // keys were readmitted as managed keys.
      if (ownerTagFromFileKey(file.pathname) === null) {
        continue;
      }
      const fileDate = new Date(file.uploadedAt);
      const isOld = fileDate < retentionCutoff;
      const isUnused = !usedAttachmentKeys.has(file.pathname);

      if (isOld && isUnused) {
        orphanedUrls.push(file.url);
      }
    }

    // Delete orphaned attachments
    if (orphanedUrls.length > 0) {
      await deleteFilesByUrls(orphanedUrls);
      console.log(`Deleted ${orphanedUrls.length} orphaned attachments`);
    }

    return {
      deletedCount: orphanedUrls.length,
      deletedUrls: orphanedUrls,
    };
  } catch (error) {
    console.error("Failed to cleanup orphaned attachments:", error);
    throw error;
  }
}
