"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import type { ActionResult } from "@/app/actions";

/**
 * Shrinks a phone photo before upload (long edge 1600 px, JPEG): faster on shop Wi-Fi,
 * cheaper to read, and still sharp enough for handwriting. Falls back to the original file.
 */
async function downscale(file: File, maxEdge = 1600, quality = 0.85): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", quality));
  } finally {
    bitmap.close();
  }
}

export function NoteUpload({ action, readerReady }: {
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
  readerReady: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  async function read() {
    if (!file) return;
    setPreparing(true);
    let photo: Blob = file;
    try { photo = await downscale(file); } catch { photo = file; }
    const fd = new FormData();
    fd.set("photo", new File([photo], photo === file ? file.name : "card.jpg", { type: photo.type || file.type }));
    setPreparing(false);
    startTransition(() => formAction(fd));
  }

  const busy = pending || preparing;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" onClick={() => camera.current?.click()} disabled={busy}>Take photo</button>
        <button type="button" className="btn" onClick={() => library.current?.click()} disabled={busy}>Choose photo</button>
        <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" onChange={pick} aria-label="Take a photo of the card" />
        <input ref={library} type="file" accept="image/*" className="sr-only" onChange={pick} aria-label="Choose a photo of the card" />
      </div>
      {preview ? (
        <div className="flex flex-col gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="The photo to read" className="max-h-80 w-auto self-start rounded border border-line object-contain" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" onClick={read} disabled={busy}>
              {preparing ? "Preparing photo…" : pending ? "Reading the card…" : readerReady ? "Read this card" : "Save photo and type it"}
            </button>
            <span className="text-xs text-muted">{busy ? "This takes a few seconds." : file?.name}</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted">Fill the whole frame with one card, flat and in good light.</p>
      )}
      {!readerReady ? <p className="text-xs text-wait">The card reader is not set up on this server (GEMINI_API_KEY), so photos are kept and you type what they say.</p> : null}
      {state && !state.ok ? <p role="alert" className="rounded border border-stop/30 bg-red-50 p-3 text-sm">{state.message}</p> : null}
    </div>
  );
}
