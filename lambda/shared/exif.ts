import exifr from 'exifr';

const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 32;

/** Converts parsed EXIF into values DynamoDB can store (no Date, Buffer, NaN or empty strings). */
export const sanitizeExif = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined || depth > 4) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.replace(/\0/g, '').trim();
    return text ? text.slice(0, MAX_STRING_LENGTH) : undefined;
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const entries = Array.from(value as ArrayLike<unknown>);
    if (entries.length > MAX_ARRAY_LENGTH || entries.some((e) => typeof e !== 'number' && typeof e !== 'string')) {
      return undefined;
    }
    return entries.map((entry) => sanitizeExif(entry, depth + 1)).filter((entry) => entry !== undefined);
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, sanitizeExif(entry, depth + 1)] as const)
      .filter(([, entry]) => entry !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return undefined;
};

/** EXIF lives in the file header, so a prefix of the file is enough. */
export const extractExif = async (header: Uint8Array): Promise<Record<string, unknown>> => {
  try {
    const parsed = await exifr.parse(header, {
      tiff: true,
      exif: true,
      gps: true,
      makerNote: false,
      userComment: false,
      xmp: false,
      icc: false,
      iptc: false,
      translateValues: true,
      reviveValues: true,
    });
    return (sanitizeExif(parsed) as Record<string, unknown> | undefined) ?? {};
  } catch (error) {
    console.warn('EXIF extraction failed', error);
    return {};
  }
};
