"""
Non-Chinese document parser using lightonai/LightOnOCR-2-1B.

LightOnOCR-2-1B is a Qwen2-VL–based vision-language model fine-tuned for
high-quality OCR and document-to-Markdown conversion.  It accepts a single
page image and returns its content as Markdown text.

Reference implementation (Pinokio app):
  https://github.com/TheAwaken1/LightOnOCR-2-1B-Pinokio/blob/main/app/app.py
"""

from __future__ import annotations

import gc
import time
from pathlib import Path

import torch
from PIL import Image
from transformers import LightOnOcrForConditionalGeneration, LightOnOcrProcessor, TextStreamer


class _CallbackStreamer(TextStreamer):
    """TextStreamer that forwards decoded text chunks to a callback."""

    def __init__(self, tokenizer, callback, **kwargs):
        super().__init__(tokenizer, **kwargs)
        self._cb = callback

    def on_finalized_text(self, text: str, stream_end: bool = False) -> None:
        if text:
            self._cb(text)

MODEL_ID = "lightonai/LightOnOCR-2-1B"

# Use local project directory if the model has already been downloaded there.
_LOCAL_MODEL_DIR = Path(__file__).resolve().parent.parent / "models" / "LightOnOCR-2-1B"
_MODEL_PATH = str(_LOCAL_MODEL_DIR) if (_LOCAL_MODEL_DIR / "config.json").exists() else MODEL_ID


class LightOnParser:
    """
    Wraps lightonai/LightOnOCR-2-1B for page-level OCR.

    The model is loaded lazily on the first call to ``parse_image`` to avoid
    consuming GPU memory when only the Chinese pipeline is needed.
    """

    def __init__(self, device: str | None = None):
        self._model: LightOnOcrForConditionalGeneration | None = None
        self._processor: LightOnOcrProcessor | None = None
        self._device = device  # None → let accelerate decide via device_map

    # ------------------------------------------------------------------
    # Lazy loading
    # ------------------------------------------------------------------

    def _load(self) -> None:
        if self._model is not None:
            return

        print(f"[LightOnParser] Loading {_MODEL_PATH} …")
        self._processor = LightOnOcrProcessor.from_pretrained(_MODEL_PATH)
        self._model = LightOnOcrForConditionalGeneration.from_pretrained(
            _MODEL_PATH,
            dtype=torch.bfloat16,
            device_map="auto" if self._device is None else self._device,
        )
        self._model.eval()

        # Report where the model actually landed
        actual_device = next(self._model.parameters()).device
        if actual_device.type == "cuda":
            allocated = torch.cuda.memory_allocated(actual_device) / 1024**3
            reserved  = torch.cuda.memory_reserved(actual_device)  / 1024**3
            print(
                f"[LightOnParser] Model loaded on {actual_device} "
                f"({allocated:.1f} GB allocated / {reserved:.1f} GB reserved)"
            )
        else:
            print(f"[LightOnParser] Model loaded on {actual_device} (CPU — inference will be slow)")

    def unload(self) -> None:
        """Release GPU memory after processing is complete."""
        del self._model, self._processor
        self._model = None
        self._processor = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    # ------------------------------------------------------------------
    # Core inference
    # ------------------------------------------------------------------

    def parse_image(self, image: Image.Image, token_cb=None) -> str:
        """
        Run OCR on a single PIL Image and return Markdown text.

        Args:
            image:    A single document page as an RGB PIL Image.
            token_cb: Optional callable(text: str) called with each decoded
                      token chunk during streaming generation.

        Returns:
            Markdown string produced by the model.
        """
        self._load()

        conversation = [
            {
                "role": "user",
                "content": [{"type": "image", "image": image}],
            }
        ]

        # Build tokenised inputs via processor's chat template ----------------------------
        inputs = self._processor.apply_chat_template(
            conversation,
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        )
        device = next(self._model.parameters()).device
        dtype = next(self._model.parameters()).dtype
        inputs = {
            k: v.to(device=device, dtype=dtype) if torch.is_tensor(v) and v.is_floating_point() else
               v.to(device) if torch.is_tensor(v) else v
            for k, v in inputs.items()
        }

        # Stream tokens to stdout (and optionally to a callback).
        if token_cb is not None:
            streamer = _CallbackStreamer(
                self._processor.tokenizer,
                token_cb,
                skip_prompt=True,
                skip_special_tokens=True,
            )
        else:
            streamer = TextStreamer(
                self._processor.tokenizer,
                skip_prompt=True,
                skip_special_tokens=True,
            )

        t0 = time.time()
        with torch.inference_mode():
            generated_ids = self._model.generate(
                **inputs,
                max_new_tokens=4096,
                do_sample=False,
                repetition_penalty=1.1,
                streamer=streamer,
            )
        elapsed = time.time() - t0

        # Trim the prompt tokens from the output
        prompt_len = inputs["input_ids"].shape[1]
        trimmed = generated_ids[:, prompt_len:]
        n_new = trimmed.shape[1]
        print(f"\n  [LightOnParser] {n_new} tokens in {elapsed:.1f}s ({n_new/elapsed:.1f} tok/s)")

        result: str = self._processor.tokenizer.batch_decode(
            trimmed,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )[0]

        return result.strip()

    # ------------------------------------------------------------------
    # Document-level entry point
    # ------------------------------------------------------------------

    def parse_pages(self, images: list[Image.Image], progress_cb=None, token_cb=None) -> str:
        """
        OCR a list of page images and concatenate their Markdown output.

        Args:
            images:      Ordered list of page images (from ``base_parser.pdf_to_images``).
            progress_cb: Optional callable(page: int, total: int, phase: str)
                         called when a page starts and when it finishes.
            token_cb:    Optional callable(text: str) called with each streamed token chunk.

        Returns:
            Full document Markdown with page separators.
        """
        parts: list[str] = []
        total = len(images)
        for i, img in enumerate(images, 1):
            print(f"  [LightOnParser] Page {i}/{total} — generating…")
            if progress_cb is not None:
                progress_cb(i, total, "start")
            md = self.parse_image(img, token_cb=token_cb)
            parts.append(md)
            if i < total and token_cb is not None:
                token_cb("\n\n---\n\n")
            if progress_cb is not None:
                progress_cb(i, total, "done")

        return "\n\n---\n\n".join(parts)
