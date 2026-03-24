"""
Shared utilities: DOCX→PDF conversion and PDF→page images extraction.
"""

import os
import tempfile
from pathlib import Path

import fitz  # pymupdf
from PIL import Image


# ---------------------------------------------------------------------------
# DOCX / DOC → PDF
# ---------------------------------------------------------------------------

def convert_docx_to_pdf(input_path: str | Path) -> Path:
    """
    Convert a .docx or .doc file to PDF using docx2pdf.

    On Windows docx2pdf delegates to Microsoft Word via COM, so Word must be
    installed.  On macOS/Linux it uses LibreOffice.

    Returns the path of the generated PDF (written next to the source file in
    a temp directory so the original is never modified).
    """
    input_path = Path(input_path).resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"Source file not found: {input_path}")

    tmp_dir = Path(tempfile.mkdtemp())
    pdf_path = tmp_dir / (input_path.stem + ".pdf")

    try:
        from docx2pdf import convert  # type: ignore
    except ImportError as exc:
        raise ImportError(
            "docx2pdf is not installed. Run: pip install docx2pdf"
        ) from exc

    convert(str(input_path), str(pdf_path))

    if not pdf_path.exists():
        raise RuntimeError(
            f"docx2pdf did not produce a PDF at {pdf_path}. "
            "Ensure Microsoft Word (Windows/macOS) or LibreOffice (Linux) is installed."
        )
    return pdf_path


# ---------------------------------------------------------------------------
# PDF → list of PIL Images (one per page)
# ---------------------------------------------------------------------------

def pdf_to_images(
    pdf_path: str | Path,
    dpi: int = 200,
) -> list[Image.Image]:
    """
    Rasterise every page of *pdf_path* and return a list of RGB PIL Images.

    Args:
        pdf_path: Path to the PDF file.
        dpi:      Rendering resolution. 200 dpi is a good balance between
                  OCR accuracy and memory usage.
    """
    pdf_path = Path(pdf_path).resolve()
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    doc = fitz.open(str(pdf_path))
    scale = dpi / 72
    mat = fitz.Matrix(scale, scale)
    images = []
    for page in doc:
        pix = page.get_pixmap(matrix=mat, colorspace=fitz.csRGB)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        images.append(img)
    doc.close()
    return images


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def save_image_tmp(image: Image.Image, suffix: str = ".png") -> Path:
    """Save a PIL Image to a temporary file and return its path."""
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    image.save(path)
    return Path(path)


def supported_extensions() -> tuple[str, ...]:
    return (".pdf", ".docx", ".doc")
