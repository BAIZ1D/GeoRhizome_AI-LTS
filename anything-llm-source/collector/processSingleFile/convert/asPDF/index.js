const path = require("path");
const fs = require("fs");
const { v4 } = require("uuid");
const {
  createdDate,
  trashFile,
  writeToServerDocuments,
} = require("../../../utils/files");
const { tokenizeString } = require("../../../utils/tokenizer");
const { default: slugify } = require("slugify");
const PDFLoader = require("./PDFLoader");
const OCRLoader = require("../../../utils/OCRLoader");

function resolvePythonExecutable() {
  if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) {
    return process.env.PYTHON_PATH;
  }
  const localVenv = path.resolve(__dirname, "../../../../../.venv/bin/python3");
  if (fs.existsSync(localVenv)) {
    return localVenv;
  }
  return "python3";
}

async function asPdf({
  fullFilePath = "",
  filename = "",
  options = {},
  metadata = {},
}) {
  console.log(`-- Working ${filename} --`);
  
  let content = "";
  let docs = [];
  let parsedViaMarkItDown = false;
  let docAuthor = "no author found";
  let docDescription = "No description found.";

  try {
    const pythonPath = resolvePythonExecutable();
    const scriptPath = path.resolve(__dirname, "../../../utils/markitdown_ocr_pipeline.py");
    const command = `"${pythonPath}" "${scriptPath}" "${fullFilePath}"`;
    console.log(`[asPDF] Attempting conversion via MarkItDown + Tesseract OCR Pipeline: ${command}`);
    const { exec } = require("child_process");
    const util = require("util");
    const execPromise = util.promisify(exec);
    const { stdout } = await execPromise(command, { maxBuffer: 1024 * 1024 * 200 });
    if (stdout && stdout.trim().length > 0) {
      content = stdout;
      parsedViaMarkItDown = true;
      docDescription = "Parsed via MarkItDown + Tesseract Japanese OCR Pipeline.";
      console.log(`[asPDF] MarkItDown + Tesseract Japanese OCR conversion successful.`);
    }
  } catch (error) {
    console.warn(
      `[asPDF] MarkItDown + Tesseract OCR pipeline failed. Falling back to native PDFLoader. Error: ${error.message}`
    );
  }

  if (!parsedViaMarkItDown) {
    const pdfLoader = new PDFLoader(fullFilePath, {
      splitPages: true,
    });
    docs = await pdfLoader.load();

    if (docs.length === 0) {
      console.log(
        `[asPDF] No text content found for ${filename}. Will attempt OCR parse.`
      );
      docs = await new OCRLoader({
        targetLanguages: options?.ocr?.langList,
      }).ocrPDF(fullFilePath);
    }

    const pageContent = [];
    for (const doc of docs) {
      console.log(
        `-- Parsing content from pg ${
          doc.metadata?.loc?.pageNumber || "unknown"
        } --`
      );
      if (!doc.pageContent || !doc.pageContent.length) continue;
      pageContent.push(doc.pageContent);
    }
    content = pageContent.join("");
    
    docAuthor = docs[0]?.metadata?.pdf?.info?.Creator || "no author found";
    docDescription = docs[0]?.metadata?.pdf?.info?.Title || "No description found.";
  }

  if (!content.trim().length) {
    console.error(`[asPDF] Resulting text content was empty for ${filename}.`);
    if (!options.absolutePath) trashFile(fullFilePath);
    return {
      success: false,
      reason: `No text content found in ${filename}.`,
      documents: [],
    };
  }

  const data = {
    id: v4(),
    url: "file://" + fullFilePath,
    title: metadata.title || filename,
    docAuthor: metadata.docAuthor || docAuthor,
    description: metadata.description || docDescription,
    docSource: metadata.docSource || "pdf file uploaded by the user.",
    chunkSource: metadata.chunkSource || "",
    published: createdDate(fullFilePath),
    wordCount: content.split(/\s+/).length,
    pageContent: content,
    token_count_estimate: tokenizeString(content),
  };

  const safeFilename = `${slugify(filename)}-${data.id}`;
  const document = writeToServerDocuments({
    data,
    filename: safeFilename,
    options: { parseOnly: options.parseOnly },
  });

  // Also write a raw .md file for the user to keep
  try {
    const mdDestination = path.resolve(__dirname, "../../../../server/storage/documents/custom-documents", safeFilename + ".md");
    fs.writeFileSync(mdDestination, content, "utf8");
    console.log(`[asPDF] Successfully wrote raw markdown export to: ${mdDestination}`);
  } catch (e) {
    console.error(`[asPDF] Failed to write raw markdown export: ${e.message}`);
  }

  if (!options.absolutePath) trashFile(fullFilePath);
  console.log(`[SUCCESS]: ${filename} converted & ready for embedding.\n`);
  return { success: true, reason: null, documents: [document] };
}

module.exports = asPdf;
