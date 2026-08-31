/** An image staged in the composer, ready to send. */
export interface Attachment {
  id: string
  name: string
  mediaType: string
  /** Base64 payload without the data-URL prefix. */
  data: string
  /** Data URL for the thumbnail. */
  previewUrl: string
  bytes: number
}

const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * Longest edge kept when an image is re-encoded.
 *
 * Anthropic's vision models gain nothing from more than about 1568 pixels on the long
 * edge, so a full-resolution retina screenshot costs tokens and upload time without
 * telling Claude anything more.
 */
const MAX_EDGE = 1568

/** Images below this go through untouched, which keeps a small paste lossless. */
const SEND_AS_IS = 1.5 * 1024 * 1024

export function isImageFile(file: File): boolean {
  return ACCEPTED.has(file.type)
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`could not read ${blob instanceof File ? blob.name : 'image'}`))
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('could not decode image'))
    image.src = url
  })
}

/**
 * Turn a pasted or dropped file into an attachment.
 *
 * A large image is scaled down and re-encoded as JPEG. A small one is sent exactly as it
 * arrived, so a screenshot with fine text is not resampled for no reason.
 */
export async function readImageFile(file: File): Promise<Attachment> {
  const id = crypto.randomUUID()
  const name = file.name || 'pasted image'

  if (file.size <= SEND_AS_IS) {
    const data = await toBase64(file)
    return {
      id,
      name,
      mediaType: file.type,
      data,
      previewUrl: `data:${file.type};base64,${data}`,
      bytes: file.size,
    }
  }

  const source = await loadImage(URL.createObjectURL(file))
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(source.width, source.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(source.width * scale)
    canvas.height = Math.round(source.height * scale)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas is unavailable')
    context.drawImage(source, 0, 0, canvas.width, canvas.height)

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85),
    )
    if (!blob) throw new Error('could not re-encode image')
    const data = await toBase64(blob)
    return {
      id,
      name,
      mediaType: 'image/jpeg',
      data,
      previewUrl: `data:image/jpeg;base64,${data}`,
      bytes: blob.size,
    }
  } finally {
    URL.revokeObjectURL(source.src)
  }
}

/** Format a byte count for the attachment strip. */
export function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}
