#!/usr/bin/env python3
"""
MarkItDown + Multi-PSM Tesseract Japanese OCR Pipeline for AnythingLLM Collector.
Converts PDFs to clean Markdown using MarkItDown, automatically performing Tesseract OCR with
Dual-PSM (Horizontal + Vertical PSM 5) on scanned pages, diagrams, or vertical Japanese text,
NFKC Unicode normalization, and CJK whitespace collapsing.
Enforces Zero-Hardcoding Architecture: dynamically loads operational parameters from config/app_config.json.
"""

import sys
import os
import re
import io
import json
import unicodedata
import fitz  # PyMuPDF
import pymupdf4llm
import pytesseract
from PIL import Image, ImageEnhance

CID_PATTERN = re.compile(r"\(cid:\d+\)")
JP_CHAR_PATTERN = r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]"

def load_ocr_config():
    """Dynamically load OCR parameters from config/app_config.json with safe fallbacks (Zero-Hardcoding)."""
    config_path = os.path.join(os.path.dirname(__file__), "..", "..", "..", "config", "app_config.json")
    config_path = os.path.abspath(config_path)
    
    defaults = {
        "dpi": 300,
        "contrast_enhancement": 1.8,
        "min_readable_chars": 50,
        "cid_threshold": 3,
        "vertical_psm": "--psm 5",
        "horizontal_psm": "--psm 6",
        "lang_horizontal": "jpn",
        "lang_vertical": "jpn_vert+jpn"
    }
    
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                app_cfg = json.load(f)
                if isinstance(app_cfg, dict) and "ocr" in app_cfg:
                    defaults.update(app_cfg["ocr"])
        except Exception as e:
            sys.stderr.write(f"[markitdown_ocr] Warning: Failed to read {config_path}: {e}\n")
            
    return defaults

def collapse_cjk_spacing(text: str) -> str:
    """Collapse whitespace between CJK/Kana characters incorrectly inserted by Tesseract word segmentation."""
    if not text:
        return ""
    return re.sub(r'(?<=[\u4E00-\u9FFF\u3040-\u30FF])\s+(?=[\u4E00-\u9FFF\u3040-\u30FF])', '', text)

def clean_text(text: str) -> str:
    """Remove garbled CID font artifacts, parser status lines, perform NFKC normalization, CJK whitespace collapsing, and space cleanup."""
    if not text:
        return ""
    normalized = unicodedata.normalize('NFKC', text)
    cleaned = CID_PATTERN.sub("", normalized)
    cleaned = cleaned.replace('\x00', '')
    cleaned = cleaned.replace('\0', '')
    import re
    cleaned = re.sub(r"=== Document parser messages ===[\s\S]*?=== Document parser messages ===", "", cleaned)
    cleaned = re.sub(r"Using Tesseract for OCR processing\.?\n*", "", cleaned)
    cleaned = re.sub(r"=== Document parser messages ===.*", "", cleaned)
    cleaned = re.sub(r"Using Tesseract for OCR processing.*", "", cleaned)
    cleaned = re.sub(r"OCR on page\.number=.*", "", cleaned)
    cleaned = re.sub(r"<!-- Start of picture text -->[\s\S]*?<!-- End of picture text -->", "", cleaned)
    cleaned = re.sub(r"<!-- Start of picture text -->", "", cleaned)
    cleaned = re.sub(r"<!-- End of picture text -->", "", cleaned)
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    cleaned = collapse_cjk_spacing(cleaned)
    return cleaned.strip()

def format_vertical_to_horizontal(text: str) -> str:
    """
    Post-process OCR output from vertical Japanese text recognition (jpn_vert).
    Converts vertical line-broken characters into natural, continuous horizontal Japanese sentences
    so LLMs can read and understand the Markdown context effortlessly.
    """
    if not text:
        return ""
    
    # 1. Clean HTML <br> tags between text
    cleaned = re.sub(r"<br\s*/?>", "", text)
    
    # 2. Join lines where vertical characters are broken line-by-line into horizontal sentences
    for _ in range(6):
        cleaned = re.sub(f"({JP_CHAR_PATTERN})\n({JP_CHAR_PATTERN})", r"\1\2", cleaned)
        
    # 3. Clean remaining table borders or artifacts and collapse CJK spacing
    cleaned = re.sub(r"\|[ \t]*\|", "", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    cleaned = collapse_cjk_spacing(cleaned)
    return cleaned.strip()

def ocr_pdf_page(page, page_num: int) -> str:
    """Render a PDF page to image and perform Dual-PSM (Horizontal + Vertical) Tesseract OCR."""
    cfg = load_ocr_config()
    try:
        # Render page at configured DPI for high-accuracy OCR
        dpi_val = cfg.get("dpi", 300)
        pix = page.get_pixmap(dpi=dpi_val)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)

        # Image enhancement for contrast
        gray = img.convert("L")
        enhancer = ImageEnhance.Contrast(gray)
        enhanced_img = enhancer.enhance(cfg.get("contrast_enhancement", 1.8))

        # Pass A: Horizontal / Block Layout
        lang_h = cfg.get("lang_horizontal", "jpn")
        psm_h = cfg.get("horizontal_psm", "--psm 6")
        text_horiz = pytesseract.image_to_string(enhanced_img, lang=lang_h, config=psm_h).strip()
        text_horiz = clean_text(text_horiz)

        # Pass B: Vertical Japanese Layout
        lang_v = cfg.get("lang_vertical", "jpn_vert+jpn")
        psm_v = cfg.get("vertical_psm", "--psm 5")
        text_vert_raw = pytesseract.image_to_string(enhanced_img, lang=lang_v, config=psm_v).strip()
        text_vert_raw = clean_text(text_vert_raw)
        
        # Convert vertical OCR text into natural horizontal Japanese format
        text_vert = format_vertical_to_horizontal(text_vert_raw)

        # Count Japanese characters in both passes
        jp_vert_count = len(re.findall(JP_CHAR_PATTERN, text_vert))
        jp_horiz_count = len(re.findall(JP_CHAR_PATTERN, text_horiz))

        # Select vertical pass whenever vertical Japanese text is recognized, otherwise horizontal
        if jp_vert_count >= jp_horiz_count or len(text_vert) >= len(text_horiz):
            return text_vert
        else:
            return text_horiz

    except Exception as e:
        sys.stderr.write(f"[markitdown_ocr] Page {page_num} OCR error: {e}\n")
        return ""

def process_pdf(pdf_path: str) -> str:
    """Process a PDF file through MarkItDown + Multi-PSM Tesseract OCR pipeline in page sequence."""
    if not os.path.exists(pdf_path):
        sys.stderr.write(f"[markitdown_ocr] File not found: {pdf_path}\n")
        sys.exit(1)

    cfg = load_ocr_config()
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    page_outputs = []

    cid_thresh = cfg.get("cid_threshold", 3)
    min_chars = cfg.get("min_readable_chars", 50)

    for i in range(total_pages):
        page = doc[i]
        page_num = i + 1
        
        # Write progress to file
        progress_path = pdf_path + ".progress"
        try:
            with open(progress_path, "w") as f:
                json.dump({"current": page_num, "total": total_pages, "message": f"Parsing page {page_num} of {total_pages}... (Tesseract OCR)"}, f)
        except Exception:
            pass
        
        # Suppress PyMuPDF4LLM stdout logging messages
        old_stdout = sys.stdout
        sys.stdout = io.StringIO()
        try:
            page_md = pymupdf4llm.to_markdown(pdf_path, pages=[i], write_images=False, embed_images=False)
        except Exception:
            page_md = ""
        finally:
            sys.stdout = old_stdout

        # Check if page text is heavily garbled with (cid:xxxx) or contains minimal Japanese text
        cid_count = len(CID_PATTERN.findall(page_md))
        cleaned_md = clean_text(page_md)
        jp_count = len(re.findall(JP_CHAR_PATTERN, cleaned_md))

        # If page has CID garble or < min_chars Japanese characters, run Dual-PSM Tesseract OCR
        if cid_count > cid_thresh or jp_count < min_chars:
            ocr_text = ocr_pdf_page(page, page_num)
            ocr_text_clean = clean_text(ocr_text)
            ocr_jp_count = len(re.findall(JP_CHAR_PATTERN, ocr_text_clean))
            if ocr_jp_count > jp_count:
                cleaned_md = ocr_text_clean

        # Ensure all Markdown outputs are formatted as clean horizontal text
        cleaned_md = format_vertical_to_horizontal(cleaned_md)

        if cleaned_md:
            page_outputs.append(f"<!-- Page {page_num} -->\n{cleaned_md}")

    doc.close()
    return "\n\n".join(page_outputs)

def main():
    if len(sys.argv) < 2:
        sys.argv.append("/Users/baizid_alhamid/Downloads/GeoRhizome/GeoRhizome PDF/b_dourokeikan_reikisyu.pdf")

    pdf_path = sys.argv[1]
    result_md = process_pdf(pdf_path)
    print(result_md)

if __name__ == "__main__":
    main()
