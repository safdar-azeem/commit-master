import { ClipboardInterruptedError } from './CommitMasterErrors.js'
import type { ExtractableDocumentType } from './CommitMasterChangedFiles.js'

export const MAX_DOCUMENT_SOURCE_BYTES = 32 * 1024 * 1024
export const MAX_EXTRACTED_DOCUMENT_BYTES = 1024 * 1024

const SKIPPED_NODE_TYPES = new Set(['image', 'chart', 'embed', 'break'])
const EXTRACTED_CONTENT_TRUNCATED = '\n\n[Extracted content truncated]'

interface DocumentNode {
   type?: string
   text?: string
   children?: DocumentNode[]
   notes?: DocumentNode[]
   metadata?: { pageNumber?: number; slideNumber?: number; noteId?: string; noteType?: string }
}

interface ParsedDocument {
   content?: DocumentNode[]
   auxiliary?: {
      headers?: DocumentNode[]
      footers?: DocumentNode[]
   }
}

type ParseOffice = (
   source: string | Buffer | Uint8Array,
   config?: Record<string, unknown>
) => Promise<ParsedDocument>

interface ExtractDocumentOptions {
   signal?: AbortSignal
   maxExtractedBytes?: number
   parseOffice?: ParseOffice
}

type FileContentResult =
   | { kind: 'content'; content: string; language: string }
   | { kind: 'placeholder'; content: string }

let parseOfficePromise: Promise<ParseOffice> | undefined

const throwIfAborted = (signal?: AbortSignal): void => {
   if (signal?.aborted) throw new ClipboardInterruptedError({ cause: signal.reason })
}

const isAbortError = (error: unknown): boolean => {
   if (error instanceof ClipboardInterruptedError) return true
   return error instanceof Error && error.name === 'AbortError'
}

const loadParseOffice = async (): Promise<ParseOffice> => {
   parseOfficePromise ??= import('officeparser')
      .then((module) => {
         const parseOffice = module.parseOffice
         if (typeof parseOffice !== 'function') {
            throw new Error('officeparser parseOffice export is unavailable.')
         }
         return parseOffice as unknown as ParseOffice
      })
      .catch((error: unknown) => {
         parseOfficePromise = undefined
         throw error
      })
   if (!parseOfficePromise) throw new Error('officeparser parseOffice export is unavailable.')
   return parseOfficePromise
}

const documentLabel = (type: ExtractableDocumentType): string => type.toUpperCase()

export const documentExtractionFailurePlaceholder = (type: ExtractableDocumentType): string =>
   `[${documentLabel(type)} content could not be extracted]`

export const documentSourceTooLargePlaceholder = (type: ExtractableDocumentType): string =>
   `[${documentLabel(type)} source exceeds the 32 MiB extraction limit]`

export const pdfWithoutExtractableTextPlaceholder =
   '[PDF contains no extractable text - OCR not enabled]'

const collectLines = (nodes: readonly DocumentNode[] | undefined): string[] => {
   if (!nodes) return []
   const lines: string[] = []
   for (const node of nodes) {
      if (!node || (node.type !== undefined && SKIPPED_NODE_TYPES.has(node.type))) continue
      if (node.type === 'page' || node.type === 'slide') {
         lines.push(...collectLines(node.children))
         continue
      }
      if (node.type === 'table') {
         const table = tableToText(node)
         if (table) lines.push(table)
         continue
      }
      if (node.children?.some((child) => child.type === 'row' || child.type === 'table')) {
         lines.push(...collectLines(node.children))
         continue
      }
      const text = node.text?.replace(/\r\n/g, '\n').trim()
      if (text) lines.push(text)
      else lines.push(...collectLines(node.children))
   }
   return lines
}

const tableToText = (table: DocumentNode): string => {
   const rows = (table.children ?? []).filter((node) => node.type === 'row')
   return rows
      .map((row) =>
         (row.children ?? [])
            .filter((node) => node.type === 'cell')
            .map((cell) => (cell.text ?? collectLines(cell.children).join(' ')).replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join(' | ')
      )
      .filter(Boolean)
      .join('\n')
}

const countLabel = (count: number, singular: string, plural: string): string =>
   `${count} ${count === 1 ? singular : plural}`

const nodeBody = (node: DocumentNode): string =>
   collectLines(node.children).join('\n\n') || node.text?.replace(/\r\n/g, '\n').trim() || ''

const formatPdf = (content: readonly DocumentNode[]): string | undefined => {
   const pages = content.filter((node) => node.type === 'page')
   const pageNodes = pages.length > 0 ? pages : content.length > 0 ? [{ children: [...content] }] : []
   const sections = pageNodes.map((page, index) => {
      const body = nodeBody(page)
      return body ? `--- Page ${index + 1} ---\n\n${body}` : `--- Page ${index + 1} ---`
   })
   const hasText = sections.some((section) => section.includes('\n\n'))
   if (!hasText) return undefined
   return `[Extracted PDF content: ${countLabel(pageNodes.length, 'page', 'pages')}]\n\n${sections.join('\n\n')}`
}

const formatPptx = (content: readonly DocumentNode[]): string => {
   const slides = content.filter((node) => node.type === 'slide')
   const slideNodes =
      slides.length > 0 ? slides : content.length > 0 ? [{ children: [...content], notes: undefined }] : []
   const sections = slideNodes.map((slide, index) => {
      const body = nodeBody(slide)
      const notes = collectLines(slide.notes)
      const notesBlock = notes.length > 0 ? `\n\nSpeaker Notes:\n\n${notes.join('\n\n')}` : ''
      const heading = `--- Slide ${index + 1} ---`
      return body ? `${heading}\n\n${body}${notesBlock}` : `${heading}${notesBlock}`
   })
   return `[Extracted PPTX content: ${countLabel(slideNodes.length, 'slide', 'slides')}]\n\n${sections.join('\n\n')}`
}

const uniqueLines = (lines: readonly string[]): string[] => {
   const seen = new Set<string>()
   const unique: string[] = []
   for (const line of lines) {
      if (seen.has(line)) continue
      seen.add(line)
      unique.push(line)
   }
   return unique
}

const formatSection = (title: string, lines: readonly string[]): string | undefined => {
   if (lines.length === 0) return undefined
   return `${title}:\n\n${lines.join('\n\n')}`
}

const collectAttachedNotes = (nodes: readonly DocumentNode[] | undefined): DocumentNode[] => {
   if (!nodes) return []
   const notes: DocumentNode[] = []
   for (const node of nodes) {
      if (!node) continue
      if (node.notes?.length) {
         notes.push(...node.notes)
         notes.push(...collectAttachedNotes(node.notes))
      }
      notes.push(...collectAttachedNotes(node.children))
   }
   return notes
}

const noteText = (note: DocumentNode): string =>
   collectLines(note.children).join('\n\n') || note.text?.replace(/\r\n/g, '\n').trim() || ''

const formatDocumentNotes = (
   nodes: readonly DocumentNode[] | undefined,
   represented: ReadonlySet<string>
): string[] => {
   const unique = uniqueLines(collectAttachedNotes(nodes).map(noteText).filter(Boolean))
   return unique.filter((text) => !represented.has(text)).map((text, index) => `${index + 1}. ${text}`)
}

const formatDocx = (ast: ParsedDocument): string => {
   const headers = uniqueLines(collectLines(ast.auxiliary?.headers))
   const footers = uniqueLines(collectLines(ast.auxiliary?.footers))
   const bodyLines = collectLines(ast.content)
   const body = bodyLines.join('\n\n')
   const represented = new Set([...headers, ...footers, ...bodyLines])
   const notes = formatDocumentNotes(
      [...(ast.content ?? []), ...(ast.auxiliary?.headers ?? []), ...(ast.auxiliary?.footers ?? [])],
      represented
   )
   const sections = [
      '[Extracted DOCX content]',
      formatSection('Document Header', headers),
      body || headers.length > 0 || footers.length > 0 || notes.length > 0
         ? body
            ? `Document Body:\n\n${body}`
            : 'Document Body:'
         : undefined,
      formatSection('Document Notes', notes),
      formatSection('Document Footer', footers),
   ].filter((section): section is string => section !== undefined)
   return sections.join('\n\n')
}

const formatExtractedDocument = (
   type: ExtractableDocumentType,
   ast: ParsedDocument
): string | undefined => {
   const content = Array.isArray(ast.content) ? ast.content : []
   if (type === 'pdf') return formatPdf(content)
   if (type === 'pptx') return formatPptx(content)
   return formatDocx(ast)
}

const truncateExtractedText = (text: string, maxBytes: number): string => {
   const encoded = Buffer.from(text)
   if (encoded.byteLength <= maxBytes) return text
   const markerBytes = Buffer.byteLength(EXTRACTED_CONTENT_TRUNCATED)
   const budget = Math.max(0, maxBytes - markerBytes)
   let end = Math.min(encoded.byteLength, budget)
   while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1
   return `${encoded.subarray(0, end).toString('utf8').trimEnd()}${EXTRACTED_CONTENT_TRUNCATED}`
}

export const extractDocumentContent = async (
   source: Buffer,
   type: ExtractableDocumentType,
   options: ExtractDocumentOptions = {}
): Promise<FileContentResult> => {
   throwIfAborted(options.signal)
   try {
      const parseOffice = options.parseOffice ?? (await loadParseOffice())
      throwIfAborted(options.signal)
      const ast = await parseOffice(source, {
         fileType: type,
         ocr: false,
         extractAttachments: false,
         includeRawContent: false,
         ignoreNotes: false,
         ignoreComments: true,
         ignoreHeadersAndFooters: false,
         ignoreSlideMasters: true,
         newlineDelimiter: '\n',
         abortSignal: options.signal ?? null,
         decompressionLimits: {
            maxUncompressedBytes: MAX_DOCUMENT_SOURCE_BYTES,
            maxZipEntries: 2000,
            maxTableCells: 100_000,
         },
      })
      throwIfAborted(options.signal)
      const formatted = formatExtractedDocument(type, ast)
      if (formatted === undefined) {
         return {
            kind: 'placeholder',
            content:
               type === 'pdf'
                  ? pdfWithoutExtractableTextPlaceholder
                  : documentExtractionFailurePlaceholder(type),
         }
      }
      const maxExtractedBytes = options.maxExtractedBytes ?? MAX_EXTRACTED_DOCUMENT_BYTES
      return {
         kind: 'content',
         content: truncateExtractedText(formatted, maxExtractedBytes),
         language: 'text',
      }
   } catch (error) {
      if (isAbortError(error)) throw new ClipboardInterruptedError({ cause: error })
      return { kind: 'placeholder', content: documentExtractionFailurePlaceholder(type) }
   }
}
