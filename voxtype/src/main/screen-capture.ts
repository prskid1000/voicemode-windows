import { desktopCapturer, nativeImage, screen } from 'electron';

// Max dimension we send to the LLM — vision models downsample to ~1024px tiles
// anyway, and smaller JPEGs keep first-token latency low.
const MAX_DIM = 1280;
const JPEG_QUALITY = 70;

// Cursor marker geometry (in thumbnail pixels). A red ring with a dot at the
// centre — hollow so the content under the cursor stays visible to the LLM.
const RING_RADIUS = 16;
const RING_THICKNESS = 3;
const DOT_RADIUS = 3;

/**
 * Capture the full display under the cursor as a base64 JPEG, with a red
 * cursor marker painted onto it so the LLM can resolve deictic references
 * ("this", "that", "here"). Returns null on failure so the enhance pipeline
 * falls back to text-only cleanup.
 */
export async function captureActiveScreen(): Promise<string | null> {
    try {
        const cursor = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(cursor);
        const { width, height } = display.size;

        const scale = Math.min(1, MAX_DIM / Math.max(width, height));
        const thumbnailSize = {
            width: Math.round(width * scale),
            height: Math.round(height * scale),
        };

        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize,
        });
        if (sources.length === 0) return null;

        const source =
            sources.find((s) => s.display_id === String(display.id)) ?? sources[0];

        // Compute cursor position in thumbnail coordinates.
        const cx = Math.round((cursor.x - display.bounds.x) * scale);
        const cy = Math.round((cursor.y - display.bounds.y) * scale);

        const marked = drawCursorMarker(source.thumbnail, cx, cy);
        const jpeg = marked.toJPEG(JPEG_QUALITY);
        if (!jpeg || jpeg.length === 0) return null;

        return jpeg.toString('base64');
    } catch (e) {
        console.log('[VoxType] Screen capture failed:', (e as Error).message);
        return null;
    }
}

/**
 * Paint a red ring + dot onto the NativeImage's bitmap at (cx, cy) and
 * return a new NativeImage. Works directly on the BGRA buffer — no native
 * image libs needed.
 */
function drawCursorMarker(
    img: Electron.NativeImage,
    cx: number,
    cy: number,
): Electron.NativeImage {
    const size = img.getSize();
    const { width, height } = size;
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) {
        // Cursor is off-display (rare, e.g. during display change). Skip marker.
        return img;
    }

    // getBitmap() returns a Buffer of raw BGRA bytes on Windows/Linux.
    const bitmap = Buffer.from(img.getBitmap());

    const paint = (x: number, y: number) => {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        const i = (y * width + x) * 4;
        bitmap[i] = 0;       // B
        bitmap[i + 1] = 0;   // G
        bitmap[i + 2] = 255; // R
        bitmap[i + 3] = 255; // A
    };

    // Red ring: filled annulus between (RING_RADIUS - RING_THICKNESS) and RING_RADIUS.
    const outer2 = RING_RADIUS * RING_RADIUS;
    const inner2 = (RING_RADIUS - RING_THICKNESS) * (RING_RADIUS - RING_THICKNESS);
    for (let dy = -RING_RADIUS; dy <= RING_RADIUS; dy++) {
        for (let dx = -RING_RADIUS; dx <= RING_RADIUS; dx++) {
            const d2 = dx * dx + dy * dy;
            if (d2 <= outer2 && d2 >= inner2) paint(cx + dx, cy + dy);
        }
    }

    // Solid red dot at the exact cursor tip.
    const dot2 = DOT_RADIUS * DOT_RADIUS;
    for (let dy = -DOT_RADIUS; dy <= DOT_RADIUS; dy++) {
        for (let dx = -DOT_RADIUS; dx <= DOT_RADIUS; dx++) {
            if (dx * dx + dy * dy <= dot2) paint(cx + dx, cy + dy);
        }
    }

    return nativeImage.createFromBitmap(bitmap, { width, height });
}
