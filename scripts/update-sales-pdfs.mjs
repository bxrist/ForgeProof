// Updates AI model names in the two sales PDFs (attached_assets/*.pdf)
// by rewriting text in the pdfkit-generated content streams, preserving
// the original layout exactly. Fonts are standard non-embedded Helvetica
// (WinAnsi), so any ASCII char (plus em dash 0x97) can be substituted.
//
// Usage: node scripts/update-sales-pdfs.mjs
import fs from "node:fs";
import zlib from "node:zlib";

const EMDASH = "\x97"; // WinAnsi em dash

// [oldDecodedText, newText] — matched against the concatenated text of each TJ array.
const REPLACEMENTS = {
  "attached_assets/ForgeProof_Sales_Sheet.pdf": [
    ["GPT-4, Claude, Gemini, Copilot, ", "GPT-5, Claude Sonnet 5, Gemini "],
    [`Replit AI ${EMDASH} any model, one unified `, `2.5, Copilot, Replit AI ${EMDASH} one `],
    ["attestation API.", "unified attestation API."],
  ],
  "attached_assets/ForgeProof_Technical_Overview.pdf": [
    [
      "Every day, AI models generate production code across thousands of repositories. GPT-4 writes a payment ",
      "Every day, AI models generate production code across thousands of repositories. GPT-5 writes a payment ",
    ],
    [
      "Which AI model produced it (GPT-4-turbo, Claude 3.5 ",
      "Which AI model produced it (GPT-5, gpt-5.6, Claude ",
    ],
    [
      "Sonnet, etc.) and which provider operated that model.",
      "Sonnet 5, etc.) and which provider operated that model.",
    ],
  ],
};

const decHex = (hex) => {
  let s = "";
  for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return s;
};
const encHex = (s) =>
  [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");

function rewriteStreamText(content, replacements, applied) {
  return content.replace(/\[((?:<[0-9a-fA-F]+>|\s|-?[\d.]+)+)\]\s*TJ/g, (whole, arr) => {
    const text = [...arr.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => decHex(m[1])).join("");
    for (const [oldT, newT] of replacements) {
      if (text === oldT) {
        applied.add(oldT);
        return `[<${encHex(newT)}> 0] TJ`;
      }
    }
    return whole;
  });
}

function processPdf(path, replacements) {
  const src = fs.readFileSync(path).toString("latin1");
  const applied = new Set();

  // Split into header + objects + tail; rewrite matching content streams.
  const objRe = /(\d+) 0 obj([\s\S]*?)endobj\r?\n?/g;
  const header = src.slice(0, src.search(/\d+ 0 obj/));
  const objects = [];
  let m;
  while ((m = objRe.exec(src)) !== null) {
    objects.push({ num: Number(m[1]), body: m[2] });
  }

  for (const obj of objects) {
    const sIdx = obj.body.indexOf("stream");
    if (sIdx === -1) continue;
    let dataStart = sIdx + 6;
    if (obj.body[dataStart] === "\r") dataStart++;
    if (obj.body[dataStart] === "\n") dataStart++;
    const dataEnd = obj.body.lastIndexOf("endstream");
    const raw = Buffer.from(obj.body.slice(dataStart, dataEnd), "latin1");
    let inflated;
    try {
      inflated = zlib.inflateSync(raw).toString("latin1");
    } catch {
      continue; // image or non-flate stream
    }
    if (!inflated.includes("TJ")) continue;
    const rewritten = rewriteStreamText(inflated, replacements, applied);
    if (rewritten === inflated) continue;
    const deflated = zlib.deflateSync(Buffer.from(rewritten, "latin1"));
    const dict = obj.body
      .slice(0, sIdx)
      .replace(/\/Length \d+/, `/Length ${deflated.length}`);
    obj.body = `${dict}stream\n${deflated.toString("latin1")}\nendstream\n`;
  }

  for (const [oldT] of replacements) {
    if (!applied.has(oldT)) throw new Error(`${path}: replacement not applied: ${JSON.stringify(oldT)}`);
  }

  // Reassemble with a fresh xref table.
  const maxNum = Math.max(...objects.map((o) => o.num));
  const offsets = new Array(maxNum + 1).fill(null);
  let out = header;
  for (const obj of objects.sort((a, b) => a.num - b.num)) {
    offsets[obj.num] = out.length;
    out += `${obj.num} 0 obj${obj.body}endobj\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxNum; i++) {
    if (offsets[i] === null) throw new Error(`${path}: missing object ${i}`);
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailerMatch = src.match(/trailer\r?\n?(<<[\s\S]*?>>)/);
  if (!trailerMatch) throw new Error(`${path}: trailer not found`);
  const trailer = trailerMatch[1].replace(/\/Size \d+/, `/Size ${maxNum + 1}`);
  out += `trailer\n${trailer}\nstartxref\n${xrefPos}\n%%EOF\n`;

  fs.writeFileSync(path, Buffer.from(out, "latin1"));
  console.log(`Updated ${path} (${applied.size} text replacements)`);
}

for (const [path, replacements] of Object.entries(REPLACEMENTS)) {
  processPdf(path, replacements);
}
