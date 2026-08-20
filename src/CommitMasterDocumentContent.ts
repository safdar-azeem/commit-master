import { inflateRawSync } from 'node:zlib'
import { ClipboardInterruptedError } from './CommitMasterErrors.js'
import type { ExtractableDocumentType } from './CommitMasterChangedFiles.js'

export const MAX_DOCUMENT_SOURCE_BYTES = 32 * 1024 * 1024
export const MAX_EXTRACTED_DOCUMENT_BYTES = 1024 * 1024

const SKIPPED_NODE_TYPES = new Set(['break'])
const VISUAL_NODE_TYPES = new Set(['image', 'chart', 'embed'])
const EXTRACTED_CONTENT_TRUNCATED = '\n\n[Extracted content truncated]'
const IMAGE_FILENAME = /^[\w][\w. -]*\.(png|jpe?g|gif|webp|bmp|svg|tif{1,2}|emf|wmf|heic)$/i

interface DocumentNode {
   type?: string
   text?: string
   name?: string
   children?: DocumentNode[]
   notes?: DocumentNode[]
   metadata?: {
      pageNumber?: number
      slideNumber?: number
      noteId?: string
      noteType?: string
      attachmentName?: string
      altText?: string
      name?: string
      title?: string
   }
}

interface VisualHint {
   type: 'image' | 'chart' | 'embed'
   attachmentName?: string
   name?: string
   title?: string
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

const metadataString = (node: DocumentNode, key: keyof NonNullable<DocumentNode['metadata']>): string | undefined => {
   const value = node.metadata?.[key]
   return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const basename = (value: string): string => value.replace(/\\/g, '/').split('/').pop()?.trim() ?? ''

const trustworthyImageFilename = (value: string | undefined): string | undefined => {
   if (!value) return undefined
   const fileName = basename(value)
   if (!IMAGE_FILENAME.test(fileName)) return undefined
   return fileName
}

const trustworthyChartLabel = (value: string | undefined): string | undefined => {
   if (!value) return undefined
   const label = value.trim()
   if (!label || label.length > 80) return undefined
   if (/[/\\]/.test(label)) return undefined
   if (/^rId\d+$/i.test(label)) return undefined
   if (/\.xml$/i.test(label)) return undefined
   if (/^(drawing|pic|graphicFrame|chart|embed)$/i.test(label)) return undefined
   if (IMAGE_FILENAME.test(basename(label))) return undefined
   return label
}

const visualPlaceholder = (node: DocumentNode): string | undefined => {
   if (!node.type || !VISUAL_NODE_TYPES.has(node.type)) return undefined
   if (node.type === 'image') {
      const fileName = trustworthyImageFilename(
         metadataString(node, 'attachmentName') ?? metadataString(node, 'name') ?? node.name
      )
      return fileName ? `[Embedded image omitted: ${fileName}]` : '[Embedded image omitted]'
   }
   if (node.type === 'chart') {
      const label = trustworthyChartLabel(
         metadataString(node, 'title') ?? metadataString(node, 'name') ?? node.name
      )
      return label ? `[Embedded chart omitted: ${label}]` : '[Embedded chart omitted]'
   }
   return '[Embedded visual content omitted]'
}

const hasVisualDescendant = (nodes: readonly DocumentNode[] | undefined): boolean => {
   if (!nodes) return false
   for (const node of nodes) {
      if (!node) continue
      if (node.type && VISUAL_NODE_TYPES.has(node.type)) return true
      if (hasVisualDescendant(node.children)) return true
   }
   return false
}

const collectMixedLines = (nodes: readonly DocumentNode[]): string[] => {
   const lines: string[] = []
   let textParts: string[] = []
   const flushText = (): void => {
      const text = textParts.join('').replace(/\r\n/g, '\n').trim()
      if (text) lines.push(text)
      textParts = []
   }
   for (const node of nodes) {
      if (!node || (node.type !== undefined && SKIPPED_NODE_TYPES.has(node.type))) continue
      const placeholder = visualPlaceholder(node)
      if (placeholder) {
         flushText()
         lines.push(placeholder)
         continue
      }
      if (node.type === 'table' || node.type === 'row' || node.type === 'page' || node.type === 'slide') {
         flushText()
         lines.push(...collectLines([node]))
         continue
      }
      if (node.children?.some((child) => child.type === 'row' || child.type === 'table') || hasVisualDescendant(node.children)) {
         flushText()
         lines.push(...collectLines(node.children))
         continue
      }
      const text = node.text?.replace(/\r\n/g, '\n')
      if (text) textParts.push(text)
      else if (node.children?.length) {
         flushText()
         lines.push(...collectLines(node.children))
      }
   }
   flushText()
   return lines
}

const collectLines = (nodes: readonly DocumentNode[] | undefined): string[] => {
   if (!nodes) return []
   const lines: string[] = []
   for (const node of nodes) {
      if (!node || (node.type !== undefined && SKIPPED_NODE_TYPES.has(node.type))) continue
      const placeholder = visualPlaceholder(node)
      if (placeholder) {
         lines.push(placeholder)
         continue
      }
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
      if (hasVisualDescendant(node.children)) {
         lines.push(...collectMixedLines(node.children ?? []))
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
            .map((cell) => {
               const childText = collectLines(cell.children).join(' ').replace(/\s+/g, ' ').trim()
               return (childText || cell.text || '').replace(/\s+/g, ' ').trim()
            })
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

const LOCAL_FILE_HEADER = 0x04034b50
const CENTRAL_DIRECTORY_HEADER = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const MAX_ZIP_COMMENT_BYTES = 65535
const MAX_DOCX_ZIP_ENTRIES = 2000
const STRUCTURAL_DOCX_XML =
   /^(word\/document\.xml|word\/_rels\/document\.xml\.rels|word\/header\d+\.xml|word\/footer\d+\.xml|word\/_rels\/header\d+\.xml\.rels|word\/_rels\/footer\d+\.xml\.rels)$/i

const findZipEocdOffset = (source: Buffer): number | undefined => {
   if (source.length < 22) return undefined
   const earliest = Math.max(0, source.length - 22 - MAX_ZIP_COMMENT_BYTES)
   for (let offset = source.length - 22; offset >= earliest; offset -= 1) {
      if (source.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
      const commentLength = source.readUInt16LE(offset + 20)
      if (offset + 22 + commentLength === source.length) return offset
   }
   return undefined
}

const inflateXmlEntry = (compressed: Buffer, method: number, maxOutputBytes: number): string | undefined => {
   if (maxOutputBytes <= 0) return undefined
   if (compressed.length === 0) return ''
   if (method === 0) {
      if (compressed.length > maxOutputBytes) return undefined
      return compressed.toString('utf8')
   }
   if (method !== 8) return undefined
   try {
      return inflateRawSync(compressed, { maxOutputLength: maxOutputBytes }).toString('utf8')
   } catch {
      return undefined
   }
}

const readZipXmlEntries = (source: Buffer, signal?: AbortSignal): Map<string, string> => {
   const entries = new Map<string, string>()
   const eocd = findZipEocdOffset(source)
   if (eocd === undefined) return entries
   const entryCount = source.readUInt16LE(eocd + 10)
   const cdSize = source.readUInt32LE(eocd + 12)
   const cdOffset = source.readUInt32LE(eocd + 16)
   if (entryCount > MAX_DOCX_ZIP_ENTRIES) return entries
   if (cdOffset + cdSize > source.length || cdOffset + cdSize > eocd) return entries
   let cursor = cdOffset
   let remaining = MAX_DOCUMENT_SOURCE_BYTES
   for (let index = 0; index < entryCount; index += 1) {
      throwIfAborted(signal)
      if (cursor + 46 > cdOffset + cdSize) return entries
      if (source.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER) return entries
      const method = source.readUInt16LE(cursor + 10)
      const compressedSize = source.readUInt32LE(cursor + 20)
      const nameLength = source.readUInt16LE(cursor + 28)
      const extraLength = source.readUInt16LE(cursor + 30)
      const commentLength = source.readUInt16LE(cursor + 32)
      const localOffset = source.readUInt32LE(cursor + 42)
      const nameStart = cursor + 46
      const nameEnd = nameStart + nameLength
      if (nameEnd + extraLength + commentLength > cdOffset + cdSize) return entries
      const name = source.subarray(nameStart, nameEnd).toString('utf8').replace(/\\/g, '/').replace(/^\//, '')
      cursor = nameEnd + extraLength + commentLength
      if (!STRUCTURAL_DOCX_XML.test(name) || compressedSize === 0xffffffff) continue
      if (localOffset + 30 > source.length) continue
      if (source.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) continue
      const localNameLength = source.readUInt16LE(localOffset + 26)
      const localExtraLength = source.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      if (dataStart + compressedSize > source.length) continue
      const xml = inflateXmlEntry(source.subarray(dataStart, dataStart + compressedSize), method, remaining)
      if (xml === undefined) continue
      remaining -= Buffer.byteLength(xml)
      entries.set(name, xml)
   }
   return entries
}

const parseRelationships = (xml: string | undefined): Map<string, { target: string; type: string }> => {
   const relationships = new Map<string, { target: string; type: string }>()
   if (!xml) return relationships
   for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/gi)) {
      const attributes = match[1] ?? ''
      const id = attributes.match(/\bId="([^"]+)"/i)?.[1]
      const type = attributes.match(/\bType="([^"]+)"/i)?.[1] ?? ''
      const target = attributes.match(/\bTarget="([^"]+)"/i)?.[1] ?? ''
      if (id) relationships.set(id, { target, type })
   }
   return relationships
}

const stripFallbackContent = (xml: string): string =>
   xml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/gi, '')

const visualHintFromRel = (
   rel: { target: string; type: string } | undefined
): VisualHint | undefined => {
   if (!rel) return undefined
   if (rel.type.includes('/image')) {
      return { type: 'image', attachmentName: basename(rel.target) }
   }
   if (rel.type.includes('/chart')) {
      return { type: 'chart' }
   }
   return undefined
}

const decodeXmlText = (value: string): string =>
   value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')

const visualHintFromXml = (
   item: string,
   relationships: Map<string, { target: string; type: string }>
): VisualHint => {
   const embedId = item.match(/\br:embed="([^"]+)"/i)?.[1] ?? item.match(/\br:id="([^"]+)"/i)?.[1]
   const fromRel = visualHintFromRel(embedId ? relationships.get(embedId) : undefined)
   if (fromRel) return fromRel
   if (/<c:chart\b/i.test(item)) return { type: 'chart' }
   if (/<a:blip\b|<v:imagedata\b/i.test(item)) return { type: 'image' }
   return { type: 'embed' }
}

type ParagraphSegment = { kind: 'text'; text: string } | { kind: 'visual'; hint: VisualHint }

const parseParagraphSegments = (
   xml: string,
   relationships: Map<string, { target: string; type: string }>
): ParagraphSegment[] => {
   const fragment = stripFallbackContent(xml)
   const segments: ParagraphSegment[] = []
   const pattern =
      /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:drawing\b[\s\S]*?<\/w:drawing>|<w:pict\b[\s\S]*?<\/w:pict>|<c:chart\b[^>]*\/?>|<w:object\b[\s\S]*?<\/w:object>/gi
   for (const match of fragment.matchAll(pattern)) {
      if (match[0].startsWith('<w:t')) {
         const text = decodeXmlText(match[1] ?? '')
         if (text) segments.push({ kind: 'text', text })
         continue
      }
      segments.push({ kind: 'visual', hint: visualHintFromXml(match[0], relationships) })
   }
   return segments
}

const extractBalanced = (xml: string, start: number, localName: string): { xml: string; end: number } | undefined => {
   const open = new RegExp(`<${localName}(?=[\\s>/])`, 'g')
   const close = new RegExp(`</${localName}\\s*>`, 'g')
   open.lastIndex = start
   const opened = open.exec(xml)
   if (!opened || opened.index !== start) return undefined
   const selfClose = xml.indexOf('/>', start)
   const tagEnd = xml.indexOf('>', start)
   if (tagEnd === -1) return undefined
   if (selfClose !== -1 && selfClose < tagEnd) {
      return { xml: xml.slice(start, selfClose + 2), end: selfClose + 2 }
   }
   let depth = 1
   let cursor = tagEnd + 1
   while (depth > 0 && cursor < xml.length) {
      open.lastIndex = cursor
      close.lastIndex = cursor
      const nextOpen = open.exec(xml)
      const nextClose = close.exec(xml)
      if (!nextClose) return undefined
      if (nextOpen && nextOpen.index < nextClose.index) {
         depth += 1
         cursor = nextOpen.index + nextOpen[0].length
      } else {
         depth -= 1
         cursor = nextClose.index + nextClose[0].length
      }
   }
   return { xml: xml.slice(start, cursor), end: cursor }
}

type XmlBlock =
   | { kind: 'paragraph'; xml: string; segments: ParagraphSegment[] }
   | { kind: 'table'; xml: string; rows: XmlBlock[][][] }

const nextBlockStart = (xml: string, from: number): { index: number; kind: 'paragraph' | 'table' } | undefined => {
   const search = (pattern: RegExp): number => {
      const match = xml.slice(from).search(pattern)
      return match === -1 ? -1 : from + match
   }
   const paragraph = search(/<w:p(?=[\s>/])/)
   const table = search(/<w:tbl(?=[\s>/])/)
   if (paragraph === -1 && table === -1) return undefined
   if (table === -1 || (paragraph !== -1 && paragraph < table)) return { index: paragraph, kind: 'paragraph' }
   return { index: table, kind: 'table' }
}

const parseXmlBlocks = (xml: string, relationships: Map<string, { target: string; type: string }>): XmlBlock[] => {
   const blocks: XmlBlock[] = []
   let cursor = 0
   const body = xml.match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/i)?.[1] ?? xml
   while (cursor < body.length) {
      const start = nextBlockStart(body, cursor)
      if (!start) break
      if (start.kind === 'paragraph') {
         const extracted = extractBalanced(body, start.index, 'w:p')
         if (!extracted || extracted.end <= start.index) break
         blocks.push({
            kind: 'paragraph',
            xml: extracted.xml,
            segments: parseParagraphSegments(extracted.xml, relationships),
         })
         cursor = extracted.end
         continue
      }
      const extracted = extractBalanced(body, start.index, 'w:tbl')
      if (!extracted || extracted.end <= start.index) break
      blocks.push({
         kind: 'table',
         xml: extracted.xml,
         rows: parseTableBlocks(extracted.xml, relationships),
      })
      cursor = extracted.end
   }
   return blocks
}

const parseTableBlocks = (
   tableXml: string,
   relationships: Map<string, { target: string; type: string }>
): XmlBlock[][][] => {
   const rows: XmlBlock[][][] = []
   let cursor = 0
   while (cursor < tableXml.length) {
      const rowStart = tableXml.slice(cursor).search(/<w:tr(?=[\s>/])/)
      if (rowStart === -1) break
      const extractedRow = extractBalanced(tableXml, cursor + rowStart, 'w:tr')
      if (!extractedRow || extractedRow.end <= cursor + rowStart) break
      const cells: XmlBlock[][] = []
      let cellCursor = 0
      while (cellCursor < extractedRow.xml.length) {
         const cellStart = extractedRow.xml.slice(cellCursor).search(/<w:tc(?=[\s>/])/)
         if (cellStart === -1) break
         const extractedCell = extractBalanced(extractedRow.xml, cellCursor + cellStart, 'w:tc')
         if (!extractedCell || extractedCell.end <= cellCursor + cellStart) break
         cells.push(parseXmlBlocks(extractedCell.xml, relationships))
         cellCursor = extractedCell.end
      }
      rows.push(cells)
      cursor = extractedRow.end
   }
   return rows
}

const hintToNode = (hint: VisualHint): DocumentNode => ({
   type: hint.type,
   metadata: {
      ...(hint.attachmentName ? { attachmentName: hint.attachmentName } : {}),
      ...(hint.name ? { name: hint.name } : {}),
      ...(hint.title ? { title: hint.title } : {}),
   },
})

const isVisualNode = (node: DocumentNode | undefined): boolean =>
   Boolean(node?.type && VISUAL_NODE_TYPES.has(node.type))

const imageNameFromNode = (node: DocumentNode): string | undefined =>
   trustworthyImageFilename(
      metadataString(node, 'attachmentName') ?? metadataString(node, 'name') ?? node.name
   )

const isMatchingVisual = (node: DocumentNode | undefined, hint: VisualHint): boolean => {
   if (!node || node.type !== hint.type) return false
   if (hint.type !== 'image') return true
   const nodeName = imageNameFromNode(node)
   const hintName = trustworthyImageFilename(hint.attachmentName)
   if (nodeName && hintName) return nodeName === hintName
   return true
}

const isStructuralInline = (node: DocumentNode | undefined): boolean => {
   if (!node || isVisualNode(node)) return false
   const type = node.type
   if (type && type !== 'text' && type !== 'paragraph' && type !== 'break') return true
   if (node.notes?.length) return true
   return Boolean(node.children?.some((child) => isVisualNode(child) || isStructuralInline(child)))
}

const isPlainTextNode = (node: DocumentNode): boolean => {
   if (isVisualNode(node) || isStructuralInline(node)) return false
   return Boolean((node.text ?? '').length)
}

const normalizedNodeText = (node: DocumentNode): string =>
   (node.text ?? '').replace(/\s+/g, ' ').trim()

const xmlTextSegments = (segments: readonly ParagraphSegment[]): string[] =>
   segments.filter((segment): segment is { kind: 'text'; text: string } => segment.kind === 'text').map(
      (segment) => segment.text
   )

const splitTextByAnchors = (text: string, anchors: readonly string[]): string[] | undefined => {
   let rest = text
   const parts: string[] = []
   for (const anchor of anchors) {
      const at = rest.indexOf(anchor)
      if (at === -1) return undefined
      if (at > 0) parts.push(rest.slice(0, at))
      parts.push(anchor)
      rest = rest.slice(at + anchor.length)
   }
   if (rest) parts.push(rest)
   return parts
}

const splitCombinedTextNodes = (
   children: readonly DocumentNode[],
   segments: readonly ParagraphSegment[]
): DocumentNode[] => {
   const anchors = xmlTextSegments(segments)
   if (anchors.length < 2) return [...children]
   const split: DocumentNode[] = []
   for (const node of children) {
      if (!isPlainTextNode(node) || !node.text) {
         split.push(node)
         continue
      }
      const parts = splitTextByAnchors(node.text, anchors)
      if (!parts || parts.length === 1) {
         split.push(node)
         continue
      }
      for (const [index, part] of parts.entries()) {
         if (!part) continue
         split.push({
            ...node,
            text: part,
            notes: index === 0 ? node.notes : undefined,
            children: undefined,
         })
      }
   }
   return split
}

const findPlainTextFrom = (nodes: readonly DocumentNode[], text: string, from: number): number => {
   const want = text.replace(/\s+/g, ' ').trim()
   for (let index = from; index < nodes.length; index += 1) {
      const node = nodes[index]
      if (node && isPlainTextNode(node) && normalizedNodeText(node) === want) return index
   }
   return -1
}

const findMatchingVisualIndex = (
   nodes: readonly DocumentNode[],
   hint: VisualHint,
   used: ReadonlySet<number>
): number => {
   for (const [index, node] of nodes.entries()) {
      if (used.has(index)) continue
      if (isMatchingVisual(node, hint)) return index
   }
   return -1
}

const insertMissingVisuals = (children: readonly DocumentNode[], segments: readonly ParagraphSegment[]): DocumentNode[] => {
   const result = [...children]
   const usedVisuals = new Set<number>()
   let cursor = 0
   for (const segment of segments) {
      if (segment.kind === 'text') {
         const found = findPlainTextFrom(result, segment.text, cursor)
         if (found >= 0) cursor = found + 1
         continue
      }
      const existing = findMatchingVisualIndex(result, segment.hint, usedVisuals)
      if (existing >= 0) {
         usedVisuals.add(existing)
         cursor = Math.max(cursor, existing + 1)
         continue
      }
      while (cursor < result.length && isStructuralInline(result[cursor])) cursor += 1
      result.splice(cursor, 0, hintToNode(segment.hint))
      usedVisuals.add(cursor)
      cursor += 1
   }
   return result
}

const rebuildFromXmlSegments = (segments: readonly ParagraphSegment[]): DocumentNode[] => {
   const children: DocumentNode[] = []
   for (const segment of segments) {
      if (segment.kind === 'text') {
         if (segment.text) children.push({ text: segment.text })
         continue
      }
      children.push(hintToNode(segment.hint))
   }
   return children
}

const mergeParagraphChildren = (
   segments: readonly ParagraphSegment[],
   existingChildren: readonly DocumentNode[]
): DocumentNode[] => {
   if (existingChildren.length === 0) return rebuildFromXmlSegments(segments)
   return insertMissingVisuals(splitCombinedTextNodes(existingChildren, segments), segments)
}

const paragraphSourceChildren = (node: DocumentNode): DocumentNode[] => {
   if (isVisualNode(node)) return [node]
   if (node.children?.length) return [...node.children]
   if (node.text) return [{ text: node.text }]
   return []
}

const paragraphHasText = (segments: readonly ParagraphSegment[]): boolean =>
   segments.some((segment) => segment.kind === 'text' && segment.text.trim().length > 0)

const paragraphVisuals = (segments: readonly ParagraphSegment[]): VisualHint[] =>
   segments.filter((segment): segment is { kind: 'visual'; hint: VisualHint } => segment.kind === 'visual').map(
      (segment) => segment.hint
   )

const nodeHasMeaningfulText = (node: DocumentNode): boolean => {
   if ((node.text ?? '').trim()) return true
   for (const child of node.children ?? []) {
      if (!isVisualNode(child) && nodeHasMeaningfulText(child)) return true
   }
   return false
}

const isSkippableEmptyBlock = (node: DocumentNode | undefined): boolean => {
   if (!node || node.type === 'table' || isVisualNode(node)) return false
   return !nodeHasMeaningfulText(node) && !hasVisualDescendant(node.children)
}

const skipEmptyBlocks = (nodes: DocumentNode[], index: number): number => {
   while (index < nodes.length && isSkippableEmptyBlock(nodes[index])) index += 1
   return index
}

const preservedNotes = (node: DocumentNode): DocumentNode[] => [
   ...(node.notes ?? []),
   ...collectAttachedNotes(node.children),
]

const applyParagraphSegments = (
   nodes: DocumentNode[],
   index: number,
   segments: readonly ParagraphSegment[]
): number => {
   const visuals = paragraphVisuals(segments)
   if (visuals.length === 0) {
      index = skipEmptyBlocks(nodes, index)
      while (index < nodes.length && isVisualNode(nodes[index])) index += 1
      const current = nodes[index]
      if (current && current.type !== 'table') index += 1
      return index
   }
   if (!paragraphHasText(segments)) {
      for (const hint of visuals) {
         index = skipEmptyBlocks(nodes, index)
         const current = nodes[index]
         if (isMatchingVisual(current, hint)) {
            index += 1
            continue
         }
         nodes.splice(index, 0, hintToNode(hint))
         index += 1
      }
      return index
   }
   index = skipEmptyBlocks(nodes, index)
   const current = nodes[index]
   const children = mergeParagraphChildren(
      segments,
      current && current.type !== 'table' ? paragraphSourceChildren(current) : []
   )
   const notes = current && current.type !== 'table' ? preservedNotes(current) : []
   if (!current || current.type === 'table') {
      nodes.splice(index, 0, { type: 'paragraph', children, ...(notes.length > 0 ? { notes } : {}) })
      return index + 1
   }
   if (isVisualNode(current)) {
      nodes[index] = { type: 'paragraph', children, ...(notes.length > 0 ? { notes } : {}) }
      return index + 1
   }
   current.children = children
   current.text = undefined
   if (notes.length > 0) current.notes = notes
   return index + 1
}

const applyXmlBlocks = (nodes: DocumentNode[] | undefined, blocks: readonly XmlBlock[]): void => {
   if (!nodes) return
   let index = 0
   for (const block of blocks) {
      if (block.kind === 'table') {
         while (index < nodes.length && nodes[index]?.type !== 'table') index += 1
         const table = nodes[index]
         if (!table || table.type !== 'table') continue
         const rows = (table.children ?? []).filter((node) => node.type === 'row')
         for (const [rowIndex, xmlRow] of block.rows.entries()) {
            const row = rows[rowIndex]
            if (!row) break
            const cells = (row.children ?? []).filter((node) => node.type === 'cell')
            for (const [cellIndex, xmlCell] of xmlRow.entries()) {
               applyXmlBlocks(cells[cellIndex]?.children, xmlCell)
            }
         }
         index += 1
         continue
      }
      index = applyParagraphSegments(nodes, index, block.segments)
   }
}

const decorateDocxVisuals = (ast: ParsedDocument, source: Buffer, signal?: AbortSignal): void => {
   throwIfAborted(signal)
   try {
      const entries = readZipXmlEntries(source, signal)
      const documentXml = entries.get('word/document.xml')
      if (documentXml) {
         const relationships = parseRelationships(entries.get('word/_rels/document.xml.rels'))
         ast.content ??= []
         applyXmlBlocks(ast.content, parseXmlBlocks(documentXml, relationships))
      }
      const headerEntry = [...entries.entries()].find(([name]) => /^word\/header\d+\.xml$/i.test(name))
      if (headerEntry) {
         const headerRels = parseRelationships(
            [...entries.entries()].find(([name]) => /^word\/_rels\/header\d+\.xml\.rels$/i.test(name))?.[1]
         )
         ast.auxiliary ??= {}
         ast.auxiliary.headers ??= []
         applyXmlBlocks(ast.auxiliary.headers, parseXmlBlocks(headerEntry[1], headerRels))
      }
      const footerEntry = [...entries.entries()].find(([name]) => /^word\/footer\d+\.xml$/i.test(name))
      if (footerEntry) {
         const footerRels = parseRelationships(
            [...entries.entries()].find(([name]) => /^word\/_rels\/footer\d+\.xml\.rels$/i.test(name))?.[1]
         )
         ast.auxiliary ??= {}
         ast.auxiliary.footers ??= []
         applyXmlBlocks(ast.auxiliary.footers, parseXmlBlocks(footerEntry[1], footerRels))
      }
   } catch (error) {
      if (isAbortError(error)) throw error
   }
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
      if (type === 'docx') decorateDocxVisuals(ast, source, options.signal)
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
