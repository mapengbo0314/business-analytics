// Broker-document uploads, backed by Vercel Blob (free tier).
//
// The browser uploads files DIRECTLY to Blob storage (client upload flow), so
// big PDFs/spreadsheets bypass the 4.5MB serverless body limit. This endpoint
// only exchanges the upload token (POST) and deletes blobs (DELETE). File
// metadata (name/url/size) is attached to the deal via /api/saved, so the
// document list is shared like everything else.
//
// Setup: Vercel dashboard → Storage → Create → Blob → connect to this project
// (adds BLOB_READ_WRITE_TOKEN automatically). GET reports whether that's done.
//
// Note: blob URLs are public-but-unguessable (random suffix). Fine for a small
// trusted group; don't post the links anywhere.

import { handleUpload } from "@vercel/blob/client";
import { del } from "@vercel/blob";

const enabled = () => !!process.env.BLOB_READ_WRITE_TOKEN;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      enabled: enabled(),
      ...(enabled() ? {} : { message: "Add a Blob store in Vercel (Storage → Blob) to enable document uploads." }),
    });
  }

  if (!enabled()) {
    return res.status(501).json({ enabled: false, error: "no_blob_store" });
  }

  if (req.method === "DELETE") {
    const url = String((req.query && req.query.url) || "");
    if (!url.includes(".blob.vercel-storage.com/")) return res.status(400).json({ error: "blob url required" });
    try {
      await del(url);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(502).json({ error: "delete_failed", detail: String(err) });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "GET, POST or DELETE only" });

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async () => ({
        addRandomSuffix: true,
        maximumSizeInBytes: 100 * 1024 * 1024,
        allowedContentTypes: [
          "application/pdf",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-excel.sheet.macroEnabled.12",
          "text/csv",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "text/plain",
          "application/zip",
          "image/png",
          "image/jpeg",
          "image/webp",
        ],
      }),
      // Fires server-side after the browser finishes uploading; the frontend
      // records the file on the deal itself, so nothing to do here.
      onUploadCompleted: async () => {},
    });
    return res.status(200).json(jsonResponse);
  } catch (err) {
    return res.status(400).json({ error: "upload_failed", detail: String(err) });
  }
}
