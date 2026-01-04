#!/usr/bin/env python3
"""
Document parser using Docling for OCR and text extraction.
Supports: images (OCR), PDFs, Word docs, Excel, PowerPoint
"""

import sys
import json
import os
from pathlib import Path

def parse_document(file_path: str) -> dict:
    """Parse a document and return extracted text."""
    try:
        from docling.document_converter import DocumentConverter
        from docling.datamodel.base_models import InputFormat

        path = Path(file_path)
        if not path.exists():
            return {"error": f"File not found: {file_path}"}

        # Initialize converter
        converter = DocumentConverter()

        # Convert document
        result = converter.convert(file_path)

        # Extract text content
        text = result.document.export_to_markdown()

        return {
            "success": True,
            "text": text,
            "filename": path.name,
            "pages": len(result.document.pages) if hasattr(result.document, 'pages') else 1
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "filename": Path(file_path).name if file_path else "unknown"
        }

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: parse_document.py <file_path>"}))
        sys.exit(1)

    file_path = sys.argv[1]
    result = parse_document(file_path)
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
