/* Restricted raster-image loading. Never follow redirects or forward cookies. */
(() => {
  'use strict';
  const { LIMITS, allowedImageUrl } = globalThis.LinkedInRuntime;
  const TYPES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif'
  ]);

  async function fetchBinary(url) {
    if (!allowedImageUrl(url)) {
      throw new Error('Image URL is outside the permitted LinkedIn hosts.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let reader;
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Image request failed (${response.status}).`);
      }
      const contentType = String(response.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!TYPES.has(contentType)) {
        throw new Error('Unsupported image type.');
      }
      if (Number(response.headers.get('content-length') || 0) > LIMITS.imageBytes) {
        throw new Error('Image exceeds the 20 MB limit.');
      }
      reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Image response cannot be read safely.');
      }
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > LIMITS.imageBytes) {
          throw new Error('Image exceeds the 20 MB limit.');
        }
        chunks.push(value);
      }
      if (!size) {
        throw new Error('Image is empty.');
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return { bytes, contentType };
    } finally {
      clearTimeout(timeout);
      if (reader) {
        await reader.cancel().catch(() => {});
      }
      controller.abort();
    }
  }

  async function toJpeg(bytes, contentType) {
    // Decode even JPEG input: an image MIME label is not proof of image content.
    const bitmap = await createImageBitmap(new Blob([bytes], { type: contentType }));
    try {
      if (
        !bitmap.width ||
        !bitmap.height ||
        bitmap.width > LIMITS.imageSide ||
        bitmap.height > LIMITS.imageSide ||
        bitmap.width * bitmap.height > LIMITS.imagePixels
      ) {
        throw new Error('Image dimensions exceed the safety limit.');
      }
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) {
        throw new Error('Image conversion is unavailable.');
      }
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94));
      if (!blob || blob.type !== 'image/jpeg' || blob.size > LIMITS.imageBytes) {
        throw new Error('Image conversion failed or exceeded the size limit.');
      }
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      bitmap.close();
    }
  }

  async function addImage(zip, url, label) {
    if (!url) {
      return `${label}: not present on the profile`;
    }
    try {
      const { bytes, contentType } = await fetchBinary(url);
      zip.add(`${label}.jpg`, await toJpeg(bytes, contentType));
      return '';
    } catch (error) {
      return `${label}: ${error.name === 'AbortError' ? 'image request timed out' : error.message || 'could not read image'}`;
    }
  }

  globalThis.LinkedInImages = { fetchBinary, toJpeg, addImage };
})();
