import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
   const table = new Uint32Array(256)
   for (let index = 0; index < 256; index++) {
      let crc = index
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
      table[index] = crc
   }
   return table
})()

const crc32 = (data: Buffer): number => {
   let crc = 0xffffffff
   for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
   return (crc ^ 0xffffffff) >>> 0
}

const u16 = (value: number): Buffer => {
   const buffer = Buffer.allocUnsafe(2)
   buffer.writeUInt16LE(value)
   return buffer
}

const u32 = (value: number): Buffer => {
   const buffer = Buffer.allocUnsafe(4)
   buffer.writeUInt32LE(value)
   return buffer
}

export const createZipArchive = (
   entries: Record<string, string | Buffer>,
   options: { dataDescriptors?: boolean } = {}
): Buffer => {
   const locals: Buffer[] = []
   const centrals: Buffer[] = []
   let offset = 0
   const dataDescriptors = options.dataDescriptors === true
   const localFlags = dataDescriptors ? 0x8 : 0
   for (const [name, value] of Object.entries(entries)) {
      const uncompressed = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
      const compressed = deflateRawSync(uncompressed)
      const checksum = crc32(uncompressed)
      const nameBuffer = Buffer.from(name, 'utf8')
      const descriptor = dataDescriptors
         ? Buffer.concat([
              Buffer.from('PK\u0007\u0008', 'binary'),
              u32(checksum),
              u32(compressed.length),
              u32(uncompressed.length),
           ])
         : Buffer.alloc(0)
      const local = Buffer.concat([
         Buffer.from('PK\u0003\u0004', 'binary'),
         u16(20),
         u16(localFlags),
         u16(8),
         u16(0),
         u16(0),
         u32(dataDescriptors ? 0 : checksum),
         u32(dataDescriptors ? 0 : compressed.length),
         u32(dataDescriptors ? 0 : uncompressed.length),
         u16(nameBuffer.length),
         u16(0),
         nameBuffer,
         compressed,
         descriptor,
      ])
      const central = Buffer.concat([
         Buffer.from('PK\u0001\u0002', 'binary'),
         u16(20),
         u16(20),
         u16(localFlags),
         u16(8),
         u16(0),
         u16(0),
         u32(checksum),
         u32(compressed.length),
         u32(uncompressed.length),
         u16(nameBuffer.length),
         u16(0),
         u16(0),
         u16(0),
         u16(0),
         u32(0),
         u32(offset),
         nameBuffer,
      ])
      locals.push(local)
      centrals.push(central)
      offset += local.length
   }
   const centralDirectory = Buffer.concat(centrals)
   const end = Buffer.concat([
      Buffer.from('PK\u0005\u0006', 'binary'),
      u16(0),
      u16(0),
      u16(centrals.length),
      u16(centrals.length),
      u32(centralDirectory.length),
      u32(offset),
      u16(0),
   ])
   return Buffer.concat([...locals, centralDirectory, end])
}

const escapePdfText = (value: string): string =>
   value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

export const createMinimalPdf = (pages: readonly string[]): Buffer => {
   const pageCount = Math.max(1, pages.length)
   const pageIds = Array.from({ length: pageCount }, (_, index) => 3 + index)
   const contentIds = Array.from({ length: pageCount }, (_, index) => 3 + pageCount + index)
   const fontId = 3 + pageCount * 2
   const objects = [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      `2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>\nendobj\n`,
   ]
   for (let index = 0; index < pageCount; index++) {
      objects.push(
         `${pageIds[index]} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentIds[index]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>\nendobj\n`
      )
   }
   for (let index = 0; index < pageCount; index++) {
      const text = pages[index] ?? ''
      const stream = text
         ? `BT /F1 24 Tf 72 720 Td (${escapePdfText(text)}) Tj ET\n`
         : 'BT ET\n'
      objects.push(
         `${contentIds[index]} 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`
      )
   }
   objects.push(
      `${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`
   )

   let body = '%PDF-1.4\n'
   const offsets = [0]
   for (const object of objects) {
      offsets.push(Buffer.byteLength(body))
      body += object
   }
   const xrefOffset = Buffer.byteLength(body)
   let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
   for (let index = 1; index <= objects.length; index++) {
      xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
   }
   const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
   return Buffer.from(`${body}${xref}${trailer}`)
}

const escapeXml = (value: string): string =>
   value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

const TINY_PNG = Buffer.from(
   'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQG/wfQNngAAAABJRU5ErkJggg==',
   'base64'
)

export type DocxBodyBlock =
   | { type: 'paragraph'; text: string; imageFileName?: string; after?: string }
   | { type: 'image'; fileName: string }
   | { type: 'chart' }
   | { type: 'table'; rows: ReadonlyArray<ReadonlyArray<{ text?: string; imageFileName?: string }>> }

const drawingXml = (relId: string, fileName: string): string => `<w:r><w:drawing>
  <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
    <wp:extent cx="100" cy="100"/>
    <wp:docPr id="1" name="${escapeXml(fileName)}"/>
    <a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic>
          <pic:nvPicPr><pic:cNvPr id="0" name="${escapeXml(fileName)}"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="${escapeXml(relId)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing></w:r>`

const chartDrawingXml = (relId: string): string => `<w:r><w:drawing>
  <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
    <wp:extent cx="100" cy="100"/>
    <wp:docPr id="1" name="Chart 1"/>
    <a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
        <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${escapeXml(relId)}"/>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing></w:r>`

const paragraphXml = (text: string, heading: boolean, extraRuns = ''): string =>
   `<w:p>${heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ''}${text ? `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>` : ''}${extraRuns}</w:p>`

const tableXml = (
   rows: ReadonlyArray<ReadonlyArray<{ text?: string; imageFileName?: string }>>,
   imageRel: (fileName: string) => string
): string =>
   `<w:tbl>${rows
      .map(
         (row) =>
            `<w:tr>${row
               .map((cell) => {
                  const image = cell.imageFileName
                     ? drawingXml(imageRel(cell.imageFileName), cell.imageFileName)
                     : ''
                  return `<w:tc>${paragraphXml(cell.text ?? '', false, image)}</w:tc>`
               })
               .join('')}</w:tr>`
      )
      .join('')}</w:tbl>`

const notesPartXml = (kind: 'footnotes' | 'endnotes', items: readonly string[]): string => {
   const itemTag = kind === 'footnotes' ? 'footnote' : 'endnote'
   const separators = [
      `<w:${itemTag} w:type="separator" w:id="-1"><w:p><w:r></w:r></w:p></w:${itemTag}>`,
      `<w:${itemTag} w:type="continuationSeparator" w:id="0"><w:p><w:r></w:r></w:p></w:${itemTag}>`,
   ]
   const notes = items.map(
      (text, index) =>
         `<w:${itemTag} w:id="${index + 1}"><w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p></w:${itemTag}>`
   )
   return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:${kind} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  ${[...separators, ...notes].join('\n  ')}
</w:${kind}>
`
}

const noteAnchorParagraphs = (
   kind: 'footnote' | 'endnote',
   items: readonly string[]
): string =>
   items
      .map((_, index) => {
         const body =
            kind === 'footnote'
               ? index === 0
                  ? 'The treatment demonstrated improved healing.'
                  : `Footnote ${index + 1} reference.`
               : index === 0
                 ? 'Study limitations are documented separately.'
                 : `Endnote ${index + 1} reference.`
         return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(body)}</w:t></w:r><w:r><w:${kind}Reference w:id="${index + 1}"/></w:r></w:p>`
      })
      .join('')

export const createMinimalDocx = (
   paragraphs: readonly string[],
   extraEntries: Record<string, string | Buffer> = {},
   sections: {
      header?: string
      footer?: string
      headerImageFileName?: string
      footerImageFileName?: string
      footnotes?: readonly string[]
      endnotes?: readonly string[]
      bodyBlocks?: readonly DocxBodyBlock[]
      dataDescriptors?: boolean
   } = {}
): Buffer => {
   const footnotes = sections.footnotes ?? []
   const endnotes = sections.endnotes ?? []
   const blocks: readonly DocxBodyBlock[] =
      sections.bodyBlocks ?? paragraphs.map((text) => ({ type: 'paragraph', text }))
   const imageNames = new Set<string>()
   let chartCount = 0
   const rememberImage = (fileName: string): string => {
      imageNames.add(fileName)
      return `rIdImg${[...imageNames].indexOf(fileName) + 1}`
   }
   const bodyBlocksXml = blocks
      .map((block, index) => {
         if (block.type === 'paragraph') {
            const image = block.imageFileName
               ? drawingXml(rememberImage(block.imageFileName), block.imageFileName)
               : ''
            const after = block.after
               ? `<w:r><w:t xml:space="preserve">${escapeXml(block.after)}</w:t></w:r>`
               : ''
            return paragraphXml(block.text, index === 0 && !sections.bodyBlocks, `${image}${after}`)
         }
         if (block.type === 'image') {
            return paragraphXml('', false, drawingXml(rememberImage(block.fileName), block.fileName))
         }
         if (block.type === 'chart') {
            chartCount += 1
            return paragraphXml('', false, chartDrawingXml(`rIdChart${chartCount}`))
         }
         return tableXml(block.rows, rememberImage)
      })
      .join('')
   const body = `${bodyBlocksXml}${noteAnchorParagraphs('footnote', footnotes)}${noteAnchorParagraphs('endnote', endnotes)}`
   const headerImageRel = sections.headerImageFileName
      ? rememberImage(sections.headerImageFileName)
      : undefined
   const footerImageRel = sections.footerImageFileName
      ? rememberImage(sections.footerImageFileName)
      : undefined
   const headerXml =
      sections.header || headerImageRel
         ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p>${headerImageRel && sections.headerImageFileName ? drawingXml(headerImageRel, sections.headerImageFileName) : ''}${
       sections.header ? `<w:r><w:t xml:space="preserve">${escapeXml(sections.header)}</w:t></w:r>` : ''
    }</w:p>
</w:hdr>
`
         : undefined
   const footerXml =
      sections.footer || footerImageRel
         ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p>${footerImageRel && sections.footerImageFileName ? drawingXml(footerImageRel, sections.footerImageFileName) : ''}${
       sections.footer ? `<w:r><w:t xml:space="preserve">${escapeXml(sections.footer)}</w:t></w:r>` : ''
    }</w:p>
</w:ftr>
`
         : undefined
   const footnotesXml = footnotes.length > 0 ? notesPartXml('footnotes', footnotes) : undefined
   const endnotesXml = endnotes.length > 0 ? notesPartXml('endnotes', endnotes) : undefined
   const imageList = [...imageNames]
   const partOverrides = [
      headerXml
         ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
         : '',
      footerXml
         ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
         : '',
      footnotesXml
         ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>'
         : '',
      endnotesXml
         ? '<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>'
         : '',
   ]
      .filter(Boolean)
      .join('\n  ')
   const relationships = [
      headerXml
         ? '<Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'
         : '',
      footerXml
         ? '<Relationship Id="rIdFtr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
         : '',
      footnotesXml
         ? '<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>'
         : '',
      endnotesXml
         ? '<Relationship Id="rIdEndnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>'
         : '',
      ...imageList.map(
         (fileName, index) =>
            `<Relationship Id="rIdImg${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fileName}"/>`
      ),
      ...Array.from({ length: chartCount }, (_, index) =>
         `<Relationship Id="rIdChart${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart${index + 1}.xml"/>`
      ),
   ]
      .filter(Boolean)
      .join('\n  ')
   const sectPrRefs = [
      headerXml ? '<w:headerReference w:type="default" r:id="rIdHdr"/>' : '',
      footerXml ? '<w:footerReference w:type="default" r:id="rIdFtr"/>' : '',
   ]
      .filter(Boolean)
      .join('')
   const mediaEntries = Object.fromEntries(
      imageList.map((fileName) => [`word/media/${fileName}`, TINY_PNG])
   )
   return createZipArchive({
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  ${partOverrides}
</Types>
`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`,
      ...(relationships
         ? {
              'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relationships}
</Relationships>
`,
           }
         : {}),
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${body}<w:sectPr>${sectPrRefs}</w:sectPr></w:body>
</w:document>
`,
      ...(headerXml ? { 'word/header1.xml': headerXml } : {}),
      ...(headerImageRel && sections.headerImageFileName
         ? {
              'word/_rels/header1.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="${headerImageRel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${sections.headerImageFileName}"/>
</Relationships>
`,
           }
         : {}),
      ...(footerXml ? { 'word/footer1.xml': footerXml } : {}),
      ...(footerImageRel && sections.footerImageFileName
         ? {
              'word/_rels/footer1.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="${footerImageRel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${sections.footerImageFileName}"/>
</Relationships>
`,
           }
         : {}),
      ...(footnotesXml ? { 'word/footnotes.xml': footnotesXml } : {}),
      ...(endnotesXml ? { 'word/endnotes.xml': endnotesXml } : {}),
      ...mediaEntries,
      ...extraEntries,
   }, sections.dataDescriptors ? { dataDescriptors: true } : undefined)
}

const pictureXml = (relId: string, fileName: string): string => `
      <p:pic>
        <p:nvPicPr>
          <p:cNvPr id="4" name="${escapeXml(fileName)}"/>
          <p:cNvPicPr/>
          <p:nvPr/>
        </p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="${escapeXml(relId)}"/>
          <a:stretch><a:fillRect/></a:stretch>
        </p:blipFill>
        <p:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:pic>`

const chartFrameXml = (relId: string): string => `
      <p:graphicFrame>
        <p:nvGraphicFramePr>
          <p:cNvPr id="5" name="Chart 1"/>
          <p:cNvGraphicFramePr/>
          <p:nvPr/>
        </p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
            <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${escapeXml(relId)}"/>
          </a:graphicData>
        </a:graphic>
      </p:graphicFrame>`

const slideXml = (
   title: string,
   body: string,
   extras: { imageFileName?: string; chart?: boolean } = {}
): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(title)}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(body)}</a:t></a:r></a:p></p:txBody>
      </p:sp>${extras.imageFileName ? pictureXml('rIdImg', extras.imageFileName) : ''}${extras.chart ? chartFrameXml('rIdChart') : ''}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>
`

const notesSlideXml = (notes: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(notes)}</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>
`

export const createMinimalPptx = (
   slides: ReadonlyArray<{ title: string; body: string; notes?: string; imageFileName?: string; chart?: boolean }>
): Buffer => {
   const entries: Record<string, string | Buffer> = {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${slides
     .map(
        (_, index) =>
           `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
     )
     .join('\n  ')}
  ${slides.some((slide) => slide.notes)
     ? slides
          .map((slide, index) =>
             slide.notes
                ? `<Override PartName="/ppt/notesSlides/notesSlide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`
                : ''
          )
          .filter(Boolean)
          .join('\n  ')
     : ''}
</Types>
`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>
`,
      'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
    ${slides
       .map(
          (_, index) =>
             `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`
       )
       .join('\n    ')}
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>
`,
      'ppt/_rels/presentation.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${slides
     .map(
        (_, index) =>
           `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`
     )
     .join('\n  ')}
</Relationships>
`,
   }

   for (const [index, slide] of slides.entries()) {
      const slideNumber = index + 1
      entries[`ppt/slides/slide${slideNumber}.xml`] = slideXml(slide.title, slide.body, {
         imageFileName: slide.imageFileName,
         chart: slide.chart,
      })
      const slideRelationships = [
         slide.notes
            ? `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${slideNumber}.xml"/>`
            : '',
         slide.imageFileName
            ? `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${slide.imageFileName}"/>`
            : '',
         slide.chart
            ? '<Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>'
            : '',
      ]
         .filter(Boolean)
         .join('\n  ')
      if (slideRelationships) {
         entries[`ppt/slides/_rels/slide${slideNumber}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${slideRelationships}
</Relationships>
`
      }
      if (slide.notes) {
         entries[`ppt/notesSlides/notesSlide${slideNumber}.xml`] = notesSlideXml(slide.notes)
      }
      if (slide.imageFileName) {
         entries[`ppt/media/${slide.imageFileName}`] = TINY_PNG
      }
   }

   return createZipArchive(entries)
}
