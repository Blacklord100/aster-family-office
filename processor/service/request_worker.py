"""One disposable process per document; parent kills its entire group at deadline."""
import base64
import json
import sys
from .classifier import RelevanceClassifier
from .config import Settings
from .documents import DocumentError, parse_document
from .pipeline import process


def main():
    request = json.load(sys.stdin)
    settings = Settings(**request['settings'])
    try:
        document = parse_document(base64.b64decode(request['data'], validate=True),
                                  request['filename'], request['mime'], settings)
        result = process(document, request['document_id'], request['mode'], settings, RelevanceClassifier())
        print(result.model_dump_json())
    except DocumentError as exc:
        print(json.dumps({'inputError': str(exc)}))


if __name__ == '__main__':
    main()
