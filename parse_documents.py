"""
parse_documents.py — Document-to-Markdown pipeline
=====================================================

Converts PDF and DOCX/DOC files to Markdown using vision-language OCR models:

  • Non-Chinese documents → lightonai/LightOnOCR-2-1B
  • Chinese documents     → PaddleOCR-VL-1.5

Knowledge base layout
---------------------
  knowledge_base/
    chinese/        ← put Chinese PDFs / DOCXs here
    non_chinese/    ← put non-Chinese PDFs / DOCXs here
  output/           ← Markdown files are written here

Usage
-----
  # Process every file in knowledge_base/
  python parse_documents.py --all

  # Process a single file (language inferred from parent folder)
  python parse_documents.py --input knowledge_base/chinese/report.pdf

  # Process a single file with explicit language
  python parse_documents.py --input ./invoice.pdf --lang non_chinese

  # Enable flash_attention_2 for LightOnOCR-2-1B (Ampere+ GPUs only)
  python parse_documents.py --all --flash-attention

  # Custom DPI for PDF rasterisation (default: 200)
  python parse_documents.py --all --dpi 300
"""

from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

# ---------------------------------------------------------------------------
# Project paths
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent
KB_ROOT = ROOT / "knowledge_base"
KB_CHINESE = KB_ROOT / "chinese"
KB_NON_CHINESE = KB_ROOT / "non_chinese"
OUTPUT_DIR = ROOT / "output"

for _d in (KB_CHINESE, KB_NON_CHINESE, OUTPUT_DIR):
    _d.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Imports (deferred to avoid loading torch before needed)
# ---------------------------------------------------------------------------

def _import_base():
    from parsers.base_parser import (
        convert_docx_to_pdf,
        pdf_to_images,
        supported_extensions,
    )
    return convert_docx_to_pdf, pdf_to_images, supported_extensions


# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------

def detect_language(file_path: Path) -> str:
    """
    Infer language mode from the file's parent folder name.

    Returns ``"chinese"`` or ``"non_chinese"``.
    Raises ``ValueError`` if the parent cannot be mapped.
    """
    parts = {p.lower() for p in file_path.parts}
    if "chinese" in parts and "non_chinese" not in parts:
        return "chinese"
    if "non_chinese" in parts:
        return "non_chinese"
    raise ValueError(
        f"Cannot determine language for '{file_path}'.  "
        "Use --lang chinese|non_chinese or place the file under "
        "knowledge_base/chinese/ or knowledge_base/non_chinese/."
    )


# ---------------------------------------------------------------------------
# Core processing
# ---------------------------------------------------------------------------

def process_file(
    file_path: Path,
    lang: str,
    *,
    dpi: int = 200,
    flash_attention: bool = False,
    overwrite: bool = False,
) -> Path | None:
    """
    Parse *file_path* to Markdown and save the result in *OUTPUT_DIR*.

    Returns the output path on success, or ``None`` if the file was skipped.
    """
    convert_docx_to_pdf, pdf_to_images, supported_extensions = _import_base()

    ext = file_path.suffix.lower()
    if ext not in supported_extensions():
        print(f"[skip] Unsupported extension '{ext}': {file_path.name}")
        return None

    out_path = OUTPUT_DIR / (file_path.stem + ".md")
    if out_path.exists() and not overwrite:
        print(f"[skip] Output already exists (use --overwrite): {out_path.name}")
        return out_path

    print(f"\n{'='*60}")
    print(f" File : {file_path.name}")
    print(f" Lang : {lang}")
    print(f" Out  : {out_path}")
    print(f"{'='*60}")

    # Step 1: DOCX/DOC → PDF
    pdf_path = file_path
    if ext in (".docx", ".doc"):
        print("[1/3] Converting DOCX → PDF …")
        pdf_path = convert_docx_to_pdf(file_path)
    else:
        print("[1/3] Input is already a PDF, skipping conversion.")

    # Step 2: PDF → page images
    print(f"[2/3] Rasterising PDF at {dpi} dpi …")
    images = pdf_to_images(pdf_path, dpi=dpi)
    print(f"      {len(images)} page(s) extracted.")

    # Step 3: OCR via the selected model
    print("[3/3] Running OCR …")
    if lang == "chinese":
        from parsers.paddleocr_vl_parser import PaddleOCRVLParser
        parser = PaddleOCRVLParser()
    else:
        from parsers.lighton_parser import LightOnParser
        parser = LightOnParser()

    try:
        markdown = parser.parse_pages(images)
    finally:
        parser.unload()

    # Write output
    out_path.write_text(markdown, encoding="utf-8")
    print(f"\n[done] Markdown saved → {out_path}")
    return out_path


# ---------------------------------------------------------------------------
# Batch processing
# ---------------------------------------------------------------------------

def process_all(
    *,
    dpi: int = 200,
    flash_attention: bool = False,
    overwrite: bool = False,
) -> None:
    """Process all files in knowledge_base/chinese/ and knowledge_base/non_chinese/."""
    convert_docx_to_pdf, pdf_to_images, supported_extensions = _import_base()
    exts = supported_extensions()

    pairs = [
        (KB_CHINESE, "chinese"),
        (KB_NON_CHINESE, "non_chinese"),
    ]

    found: list[tuple[Path, str]] = []
    for folder, lang in pairs:
        for f in sorted(folder.iterdir()):
            if f.is_file() and f.suffix.lower() in exts:
                found.append((f, lang))

    if not found:
        print(
            "No documents found in knowledge_base/chinese/ or knowledge_base/non_chinese/.\n"
            "Place your .pdf, .docx, or .doc files there and re-run."
        )
        return

    print(f"Found {len(found)} document(s) to process.\n")
    succeeded, failed = 0, 0
    for file_path, lang in found:
        try:
            process_file(
                file_path,
                lang,
                dpi=dpi,
                flash_attention=flash_attention,
                overwrite=overwrite,
            )
            succeeded += 1
        except Exception:
            print(f"\n[ERROR] Failed to process {file_path.name}:")
            traceback.print_exc()
            failed += 1

    print(f"\n{'='*60}")
    print(f" Done: {succeeded} succeeded, {failed} failed.")
    print(f" Output directory: {OUTPUT_DIR}")
    print(f"{'='*60}\n")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Parse PDF/DOCX documents to Markdown using OCR models.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--all",
        action="store_true",
        help="Process every file in knowledge_base/chinese/ and knowledge_base/non_chinese/.",
    )
    mode.add_argument(
        "--input",
        metavar="FILE",
        help="Path to a single PDF, DOCX, or DOC file.",
    )

    p.add_argument(
        "--lang",
        choices=["chinese", "non_chinese"],
        default=None,
        help=(
            "Language mode.  Required when --input points to a file outside "
            "the knowledge_base/ folders.  Auto-detected otherwise."
        ),
    )
    p.add_argument(
        "--dpi",
        type=int,
        default=200,
        metavar="N",
        help="PDF rendering resolution in DPI (default: 200).",
    )
    p.add_argument(
        "--flash-attention",
        action="store_true",
        help="Enable flash_attention_2 for LightOnOCR-2-1B (requires Ampere+ GPU).",
    )
    p.add_argument(
        "--overwrite",
        action="store_true",
        help="Re-process and overwrite existing output files.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.all:
        process_all(
            dpi=args.dpi,
            flash_attention=args.flash_attention,
            overwrite=args.overwrite,
        )
        return 0

    # Single file mode
    file_path = Path(args.input).resolve()
    if not file_path.exists():
        print(f"[error] File not found: {file_path}", file=sys.stderr)
        return 1

    lang = args.lang
    if lang is None:
        try:
            lang = detect_language(file_path)
        except ValueError as exc:
            print(f"[error] {exc}", file=sys.stderr)
            return 1

    try:
        process_file(
            file_path,
            lang,
            dpi=args.dpi,
            flash_attention=args.flash_attention,
            overwrite=args.overwrite,
        )
    except Exception:
        traceback.print_exc()
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
