import { open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { DOCS } from "./admin-documents.js";
import { WorkflowError } from "./admin-workflows.js";
const mimeTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
};
export async function uploadImage(w, a) {
    if (Boolean(a.imageFile) === Boolean(a.sourceUrl))
        throw Error("Supply exactly one imageFile or sourceUrl.");
    await w.requireScopes(["write_files"]);
    let source = a.sourceUrl;
    if (a.imageFile) {
        if (!isAbsolute(a.imageFile))
            throw Error("imageFile must be an absolute path.");
        const filename = a.filename ?? basename(a.imageFile);
        if (basename(filename) !== filename)
            throw Error("filename must not include a path.");
        const mimeType = mimeTypes[extname(filename).toLowerCase()];
        if (!mimeType)
            throw Error("Supported image extensions: png, jpg, jpeg, webp, gif.");
        const file = await open(a.imageFile, "r");
        let bytes;
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size <= 0 || stat.size > 20 * 1024 * 1024)
                throw Error("Image must be a regular file between 1 byte and 20 MiB.");
            bytes = await file.readFile();
            if (bytes.length > 20 * 1024 * 1024)
                throw Error("Image exceeds 20 MiB.");
        }
        finally {
            await file.close();
        }
        const staged = await w.run(DOCS.stage, {
            input: [
                {
                    filename,
                    mimeType,
                    resource: "IMAGE",
                    httpMethod: "POST",
                    fileSize: String(bytes.length),
                },
            ],
        });
        const target = staged.stagedUploadsCreate?.stagedTargets?.[0];
        if (!target)
            throw Error("Shopify did not return an upload target.");
        const url = new URL(target.url);
        // Only the storage hosts used by Shopify staged uploads receive local bytes.
        if (url.protocol !== "https:" ||
            !/(^|\.)shopify\.com$|(^|\.)shopifycloud\.com$|(^|\.)googleapis\.com$|(^|\.)amazonaws\.com$/.test(url.hostname))
            throw Error("Unexpected staged upload host.");
        const form = new FormData();
        for (const p of target.parameters)
            form.append(p.name, p.value);
        form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
        const response = await fetch(url, {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(60_000),
            redirect: "error",
        });
        if (!response.ok)
            throw Error(`Staged upload failed with HTTP ${response.status}.`);
        source = target.resourceUrl;
    }
    const created = await w.run(DOCS.file, {
        files: [
            {
                originalSource: source,
                contentType: "IMAGE",
                alt: a.alt,
                ...(a.filename ? { filename: a.filename } : {}),
            },
        ],
    });
    const id = created.fileCreate?.files?.[0]?.id;
    if (!id)
        throw Error("Shopify did not return a file ID.");
    for (let i = 0; i < 10; i++) {
        const data = await w.run(DOCS.fileRead, { id });
        const f = data.node;
        if (f?.fileStatus === "FAILED" || f?.fileErrors?.length)
            throw new WorkflowError("Shopify image processing failed.", {
                fileId: id,
                file: f,
            });
        if (f?.fileStatus === "READY" && f.image?.url)
            return {
                fileId: id,
                url: f.image.url,
                alt: f.image.altText,
                status: "READY",
            };
        if (i < 9)
            await new Promise((r) => setTimeout(r, 1000));
    }
    return {
        fileId: id,
        status: "PROCESSING",
        complete: false,
        notice: "Use shopify_get_uploaded_image with this file ID. Do not upload it again.",
    };
}
//# sourceMappingURL=media.js.map