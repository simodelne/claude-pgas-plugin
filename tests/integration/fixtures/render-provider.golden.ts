import type {
  DeclarativeRenderRequest,
  RenderProvider,
} from '@simodelne/pgas-server/create-server.js';

// GENERIC RenderProvider — the ONLY consumer code in the #992 declarative render
// path. It is a pure byte serializer over the engine-RESOLVED
// `DeclarativeRenderRequest` IR (= `ProviderRenderRequest`): the engine has
// already read every authored world path and handed us concrete strings.
//
// LOAD-BEARING INVARIANT (do NOT weaken): this file MUST NOT read world/domain
// state, author/normalize/rewrite/strip content, branch on a program domain, or
// hold any per-program logic. It only maps IR nodes → OOXML format mechanics
// over the concrete strings the engine supplies. All content authoring is the
// LLM's; all world→IR projection + artifact persistence is engine-native. This
// keeps the generated program's deliverable 100% declaratively authored with
// ZERO governable TypeScript.

interface ProviderParagraphBlock {
  readonly kind: 'paragraph';
  readonly text: string;
  readonly bold?: boolean;
}
interface ProviderTableBlock {
  readonly kind: 'table';
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly caption?: string;
}
interface ProviderKeyValueBlock {
  readonly kind: 'keyvalue';
  readonly pairs: readonly (readonly [string, string])[];
}
type ProviderBlock = ProviderParagraphBlock | ProviderTableBlock | ProviderKeyValueBlock;
interface ProviderSection {
  readonly heading?: string;
  readonly level?: 1 | 2 | 3 | 4;
  readonly numbered?: boolean;
  readonly blocks: readonly ProviderBlock[];
}
interface ProviderDocument {
  readonly title?: string;
  readonly cover?: boolean;
  readonly toc?: boolean;
  readonly sections: readonly ProviderSection[];
}

const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * The generic declarative-render provider. Wire it into `createPgasServer`
 * config `renderProvider` for any generated program that declares
 * `capability: render`. The engine dispatches the resolved IR here; this
 * returns real OOXML bytes that the engine persists as a first-class artifact.
 */
export function createDeclarativeRenderProvider(): RenderProvider {
  return {
    async render(request: unknown): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
      const document = documentFromRequest(request);
      const bytes = buildDocx(document);
      return { bytes, contentType: DOCX_CONTENT_TYPE, filename: 'document.docx' };
    },
  };
}

function documentFromRequest(request: unknown): ProviderDocument {
  if (!isRecord(request) || (request as { format?: unknown }).format !== 'docx') {
    throw new Error('RenderProvider: request.format must be "docx"');
  }
  const doc = (request as { document?: unknown }).document;
  if (!isRecord(doc)) {
    throw new Error('RenderProvider: request.document must be an object');
  }
  const rawSections = (doc as { sections?: unknown }).sections;
  if (!Array.isArray(rawSections)) {
    throw new Error('RenderProvider: request.document.sections must be an array');
  }
  const sections = rawSections.map(sectionFromValue);
  const title = typeof (doc as { title?: unknown }).title === 'string' ? (doc as { title: string }).title : undefined;
  return {
    ...(title !== undefined ? { title } : {}),
    sections,
  };
}

function sectionFromValue(value: unknown): ProviderSection {
  if (!isRecord(value) || !Array.isArray((value as { blocks?: unknown }).blocks)) {
    throw new Error('RenderProvider: each section must carry a blocks array');
  }
  const heading = typeof (value as { heading?: unknown }).heading === 'string' ? (value as { heading: string }).heading : undefined;
  const blocks = ((value as { blocks: unknown[] }).blocks).map(blockFromValue);
  return { ...(heading !== undefined ? { heading } : {}), blocks };
}

function blockFromValue(value: unknown): ProviderBlock {
  if (!isRecord(value)) {
    throw new Error('RenderProvider: block must be an object');
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'paragraph') {
    return {
      kind: 'paragraph',
      text: String((value as { text?: unknown }).text ?? ''),
      ...(value.bold === true ? { bold: true } : {}),
    };
  }
  if (kind === 'table') {
    const headers = Array.isArray(value.headers) ? value.headers.map((cell) => String(cell)) : [];
    const rows = Array.isArray(value.rows)
      ? value.rows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell)) : []))
      : [];
    return {
      kind: 'table',
      headers,
      rows,
      ...(typeof value.caption === 'string' ? { caption: value.caption } : {}),
    };
  }
  if (kind === 'keyvalue') {
    const pairs = Array.isArray(value.pairs)
      ? value.pairs
          .filter((pair): pair is [unknown, unknown] => Array.isArray(pair) && pair.length === 2)
          .map((pair) => [String(pair[0]), String(pair[1])] as [string, string])
      : [];
    return { kind: 'keyvalue', pairs };
  }
  throw new Error(`RenderProvider: unknown block kind ${JSON.stringify(kind)}`);
}

// ─────────────────────────── OOXML mechanics (pure) ───────────────────────────

function buildDocx(document: ProviderDocument): Uint8Array {
  const body: string[] = [];
  if (document.title !== undefined) {
    body.push(paragraph(document.title, 'Title'));
  }
  for (const section of document.sections) {
    if (section.heading !== undefined) {
      body.push(paragraph(section.heading, 'Heading1'));
    }
    for (const block of section.blocks) {
      body.push(...blockXml(block));
    }
  }
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body>',
    ...body,
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>',
    '</w:body></w:document>',
  ].join('');

  return zipStore({
    '[Content_Types].xml': contentTypesXml(),
    '_rels/.rels': relsXml(),
    'docProps/app.xml': appXml(),
    'docProps/core.xml': coreXml(document.title ?? 'Document'),
    'word/document.xml': documentXml,
    'word/styles.xml': stylesXml(),
  });
}

function blockXml(block: ProviderBlock): string[] {
  if (block.kind === 'paragraph') {
    return toParagraphs(block.text).map((line) => paragraph(line, 'Normal', block.bold === true));
  }
  if (block.kind === 'keyvalue') {
    return block.pairs.map(([label, value]) => keyValueParagraph(label, value));
  }
  return [tableXml(block)];
}

function toParagraphs(body: string): string[] {
  const lines = body.split(/\n+/u).filter((line) => line.length > 0);
  return lines.length > 0 ? lines : [''];
}

function paragraph(text: string, style: 'Title' | 'Heading1' | 'Normal', bold = false): string {
  const styleRun = style === 'Normal' ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  const runProps = bold ? '<w:rPr><w:b/></w:rPr>' : '';
  return `<w:p>${styleRun}<w:r>${runProps}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function keyValueParagraph(label: string, value: string): string {
  return `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(label)}: </w:t></w:r><w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p>`;
}

function tableXml(block: ProviderTableBlock): string {
  const parts: string[] = ['<w:tbl>'];
  parts.push('<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr>');
  if (block.headers.length > 0) {
    parts.push(tableRow(block.headers, true));
  }
  for (const row of block.rows) {
    parts.push(tableRow(row, false));
  }
  parts.push('</w:tbl>');
  if (block.caption !== undefined) {
    parts.push(paragraph(block.caption, 'Normal'));
  }
  return parts.join('');
}

function tableRow(cells: readonly string[], header: boolean): string {
  const tcs = cells
    .map((cell) => {
      const runProps = header ? '<w:rPr><w:b/></w:rPr>' : '';
      return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:r>${runProps}<w:t xml:space="preserve">${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`;
    })
    .join('');
  return `<w:tr>${tcs}</w:tr>`;
}

function contentTypesXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
}

function relsXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
}

function appXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>PGAS</Application></Properties>';
}

function coreXml(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(title)}</dc:title><dc:creator>PGAS</dc:creator></cp:coreProperties>`;
}

function stylesXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>';
}

function zipStore(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
      u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, data,
    ]);
    chunks.push(local);
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
      u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBytes,
    ]));
    offset += local.length;
  }

  const centralOffset = offset;
  const centralBytes = concat(central);
  const end = concat([
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(centralBytes.length), u32(centralOffset), u16(0),
  ]);
  return concat([...chunks, centralBytes, end]);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function u16(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u32(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
