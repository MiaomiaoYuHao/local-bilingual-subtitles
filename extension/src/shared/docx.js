// 最小可用的 .docx 生成器（OOXML + ZIP(store)），不依赖任何库。
// 同时也提供"从自己生成的 docx 里读回文本"的能力，用于下次追加。
(() => {
  const ST = (globalThis.ST = globalThis.ST || {});

  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /** ZIP（仅 store，不压缩）——docx 本质就是个 zip */
  function zip(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const crc = crc32(data);

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);      // UTF-8 名字
      lv.setUint16(8, 0, true);           // 存储方式：store
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0x2821, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      parts.push(local, data);

      const cd = new Uint8Array(46 + name.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x2821, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cd.set(name, 46);
      central.push(cd);

      offset += local.length + data.length;
    }
    const centralSize = central.reduce((a, b) => a + b.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    const all = [...parts, ...central, eocd];
    const total = all.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const chunk of all) { out.set(chunk, p); p += chunk.length; }
    return out;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function documentXml(text) {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const body = lines.map((line) => {
      const t = line.replace(/\s+$/, "");
      if (!t.trim()) return "<w:p/>";
      return `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  }

  const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

  const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  /** 笔记文本里最后一组（一组 = 一次保存的几行，组与组之间一个空行） */
  function lastGroup(text) {
    const t = String(text == null ? "" : text).replace(/\s+$/, "");
    if (!t) return "";
    const i = t.lastIndexOf("\n\n");
    return (i >= 0 ? t.slice(i + 2) : t).trim();
  }

  /** 这一组是不是和最后存过的那组一模一样（避免同一段被反复存进去） */
  function isDuplicateGroup(prevText, body) {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const last = norm(lastGroup(prevText));
    const next = norm(body);
    return !!last && !!next && last === next;
  }

  /** 纯文本 → docx 字节 */
  function buildFromText(text) {
    return zip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: RELS },
      { name: "word/document.xml", data: documentXml(text) },
    ]);
  }

  /** 从 document.xml 里把段落抽成纯文本 */
  function paragraphsFromXml(xml) {
    const texts = [];
    const rePara = /<w:p\/>|<w:p[^>]*>([\s\S]*?)<\/w:p>/g;
    let mp;
    while ((mp = rePara.exec(xml))) {
      if (mp[0].indexOf("<w:p/") === 0) { texts.push(""); continue; }
      const inner = mp[1] || "";
      let t = "";
      const reT = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
      let mt;
      while ((mt = reT.exec(inner))) t += mt[1];
      texts.push(t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    }
    return texts.join("\n");
  }

  /** deflate-raw 解压（Chrome 原生能力） */
  async function inflateRaw(data) {
    if (typeof DecompressionStream !== "function") return null;
    try {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch { return null; }
  }

  /** 读回 docx 文本：既能读本工具写的（store），也能读 Word/WPS 重存过的（deflate） */
  async function extractTextFromDocx(bytes) {
    try {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      let p = 0;
      while (p + 30 <= u8.length) {
        if (dv.getUint32(p, true) !== 0x04034b50) break;
        const method = dv.getUint16(p + 8, true);
        const size = dv.getUint32(p + 18, true);
        const nameLen = dv.getUint16(p + 26, true);
        const extraLen = dv.getUint16(p + 28, true);
        const name = dec.decode(u8.subarray(p + 30, p + 30 + nameLen));
        const dataStart = p + 30 + nameLen + extraLen;
        const raw = u8.subarray(dataStart, dataStart + (size || 0));
        if (name === "word/document.xml") {
          if (method === 0) return paragraphsFromXml(dec.decode(raw));
          if (method === 8) {
            const inflated = await inflateRaw(raw);
            return inflated ? paragraphsFromXml(dec.decode(inflated)) : null;
          }
          return null;
        }
        if (!size && (dv.getUint16(p + 6, true) & 0x08)) break;   // 数据描述符：长度只在中央目录里，别乱猜
        p = dataStart + size;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 读回"本工具生成"的 docx 文本（store 方式，可直接扫描；别的工具生成的压缩 docx 读不了） */
  function extractTextFromStoredDocx(bytes) {
    try {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      let p = 0;
      while (p + 30 <= u8.length) {
        if (dv.getUint32(p, true) !== 0x04034b50) break;
        const method = dv.getUint16(p + 8, true);
        const size = dv.getUint32(p + 18, true);
        const nameLen = dv.getUint16(p + 26, true);
        const extraLen = dv.getUint16(p + 28, true);
        const name = dec.decode(u8.subarray(p + 30, p + 30 + nameLen));
        const dataStart = p + 30 + nameLen + extraLen;
        const data = u8.subarray(dataStart, dataStart + size);
        if (name === "word/document.xml") {
          if (method !== 0) return null;      // 被压缩过（可能是 Word 自己存的）
          const xml = dec.decode(data);
          const texts = [];
          // 逐段落解析：<w:p/> = 空行，<w:p>…</w:p> = 一行
          const rePara = /<w:p\/>|<w:p[^>]*>([\s\S]*?)<\/w:p>/g;
          let mp;
          while ((mp = rePara.exec(xml))) {
            if (mp[0].indexOf("<w:p/") === 0) { texts.push(""); continue; }
            const inner = mp[1] || "";
            let t = "";
            const reT = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
            let mt;
            while ((mt = reT.exec(inner))) t += mt[1];
            texts.push(t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
          }
          return texts.join("\n");
        }
        p = dataStart + size;
      }
      return null;
    } catch {
      return null;
    }
  }

  ST.docx = { buildFromText, extractTextFromStoredDocx, extractTextFromDocx, paragraphsFromXml, lastGroup, isDuplicateGroup, zip, crc32, DOCX_EXT: ".docx" };
})();