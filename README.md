# Doc Parser

Doc Parser is a local document ingestion tool for building Markdown-ready knowledge bases from PDFs, DOCX files, and web pages.

The project is centered around a FastAPI backend and a static single-page web app. It lets you:

- create knowledge bases
- upload PDF, DOCX, and DOC files
- fetch web pages into a knowledge base as Markdown
- parse documents with LightOnOCR-2-1B
- watch live parsing progress over Server-Sent Events (SSE)
- preview the original document beside the generated Markdown
- edit and save the generated Markdown in the browser

The primary supported workflow in this repository is the web app in `server.py`.

## Features

- Web UI for managing multiple knowledge bases
- Local model detection from `models/LightOnOCR-2-1B`
- Model download from Hugging Face through the UI when the model is not already present
- File parsing pipeline:
  - `DOCX`/`DOC` -> PDF conversion
  - PDF rasterisation with PyMuPDF
  - page-by-page OCR to Markdown with LightOnOCR
- URL ingestion using `trafilatura`
- Live job progress and streamed tokens via SSE
- Side-by-side original/markdown document view
- In-browser Markdown editing and saving

## Architecture

The app has three main parts:

1. `server.py`
   FastAPI app that serves the SPA, exposes the API, manages background jobs, and streams job events.

2. `parsers/`
   Parsing utilities and model wrappers.
   - `base_parser.py`: DOCX conversion and PDF page rasterisation
   - `lighton_parser.py`: LightOnOCR model loading and inference

3. `static/`
   HTML/CSS/JS frontend for knowledge base management, parsing, previews, and Markdown review.

## Requirements

## Runtime

- Windows is supported and is the best fit for the current DOCX workflow.
- Python environment with the dependencies from `pyproject.toml` or `requirements.txt`
- Enough RAM or VRAM for `LightOnOCR-2-1B`

## Document conversion

- PDF parsing works directly.
- DOCX and DOC conversion uses `docx2pdf`.
- On Windows, `docx2pdf` requires Microsoft Word to be installed.

## Model

- The parser uses `lightonai/LightOnOCR-2-1B`.
- If `models/LightOnOCR-2-1B/config.json` exists, the app uses the local copy automatically.
- If not, you can download the model from the Models page in the UI.

## Installation

You can install dependencies with `uv` or `pip`.

### Option 1: uv

```powershell
uv sync
```

### Option 2: pip

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Running the app

### Start the server

```powershell
python server.py
```

or

```powershell
uvicorn server:app --host 0.0.0.0 --port 7860 --reload
```

Then open:

```text
http://127.0.0.1:7860
```

## Typical workflow

1. Open the app.
2. Create a knowledge base.
3. Upload PDF, DOCX, or DOC files, or add one or more URLs.
4. If needed, download the OCR model from the Models page.
5. Click Parse or Parse All.
6. Review the streamed Markdown output.
7. Edit the raw Markdown in the document view and save it back to disk.

## Knowledge base layout

The web app stores data under `knowledge_bases/<name>/`.

Example:

```text
knowledge_bases/
  my-kb/
    files/          # uploaded source documents
    output/         # generated markdown files
    preview/        # cached PDF previews for DOC/DOCX
    sources/
      urls.json     # tracked URL sources
    status.json     # per-file and per-URL status
```

## Supported inputs

- `.pdf`
- `.docx`
- `.doc`
- `http://` and `https://` URLs

## Output

- Parsed documents are written as Markdown files under each knowledge base's `output/` directory.
- Uploaded file outputs use the source filename stem.
- URL outputs use a slug derived from the URL.

## API overview

The frontend uses these backend capabilities:

- knowledge base CRUD
- file upload, listing, preview, and deletion
- parse single file or all files in a knowledge base
- cancel running jobs
- add, list, re-fetch, and delete URL sources
- fetch and save generated Markdown
- subscribe to job events over SSE
- inspect and download available models

The server listens on port `7860` by default.

## Project structure

```text
Doc parser/
  server.py                 # FastAPI app and background job orchestration
  parse_documents.py        # standalone CLI parser script
  parsers/
    base_parser.py          # document conversion and PDF rasterisation
    lighton_parser.py       # LightOnOCR model wrapper
  static/
    index.html              # SPA shell
    css/                    # frontend styles
    js/                     # frontend modules
  knowledge_bases/          # runtime data storage
  models/                   # local model storage
```

## Notes and limitations

- DOCX and DOC parsing depends on successful conversion to PDF.
- On Windows, Microsoft Word is typically required for DOCX conversion through `docx2pdf`.
- Some external sites block iframe embedding. In the document viewer, URL previews may need to be opened in a new tab instead.
- Parsing can be slow on CPU. GPU inference is strongly preferred for the LightOnOCR model.

## CLI script status

This repository also includes `parse_documents.py`, but it does not currently match the web app's storage layout:

- it uses `knowledge_base/` and `output/` instead of `knowledge_bases/`
- it references a Chinese parser module that is not present in this repository

Treat `parse_documents.py` as an experimental or incomplete standalone path unless you plan to update it.

For normal use, start the web app with `server.py`.

## Troubleshooting

### DOCX preview or parsing fails

- Confirm Microsoft Word is installed.
- Confirm `docx2pdf` is installed in the active environment.
- Try converting the file manually to PDF and upload the PDF instead.

### Model is not found

- Check whether `models/LightOnOCR-2-1B/config.json` exists.
- If it does not, download the model from the Models page.

### URLs do not preview inline

- This is often caused by the target site's iframe restrictions.
- Use the Open in browser action from the document view.

### Parsing is very slow

- Check whether the model is running on CPU instead of CUDA.
- Reduce concurrent work and parse one file at a time if resources are limited.

## Development

Useful entry points:

- `server.py` for backend routes and job flow
- `parsers/lighton_parser.py` for model loading and generation
- `static/js/pages/kb-sources.js` for upload, URL, and parse interactions
- `static/js/pages/doc-view.js` for live streaming and Markdown editing
